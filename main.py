"""Minecraft 会话接入 AstrBot。Node 仅负责 MC 协议，AstrBot 负责对话流水线。"""
from __future__ import annotations

import asyncio
import json
import math
import random
import re
import time
import uuid
from collections import deque
from contextlib import suppress
from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.message_components import At, Plain
from astrbot.api.platform import AstrBotMessage, Group, MessageMember, MessageType, PlatformMetadata
from astrbot.api.star import Context, Star
from astrbot.api.web import error_response, json_response, request
from .reply import filter_reply, split_reply


PLUGIN_NAME = "astrbot_plugin_MCastrbot"
META = PlatformMetadata(
    name="minecraft", description="Minecraft mineflayer 会话", id="minecraft-fairy",
    support_streaming_message=False, support_proactive_message=False,
)


class MinecraftEvent(AstrMessageEvent):
    def __init__(self, message: AstrBotMessage, plugin: "MCAstrBot", channel: str, sender: str):
        super().__init__(message.message_str, message, META, message.session_id)
        self.plugin = plugin
        self.mc_channel = channel
        self.mc_sender = sender

    async def send(self, message: MessageChain) -> None:
        text = message.get_plain_text().strip()
        if not text:
            logger.warning("MC AstrBot: 跳过空回复（消息链无纯文本，玩家=%s）", self.mc_sender)
            return
        target = self.mc_sender if self.mc_channel == "tell" else None
        await self.plugin.send_mc_text(text, target)
        await super().send(message)

    async def send_streaming(self, generator, use_fallback: bool = False) -> None:
        pending = []
        async for message in generator:
            if message is None or getattr(message, "type", None) == "break":
                continue
            text = message.get_plain_text()
            if text:
                pending.append(text)
        if pending:
            await self.send(MessageChain().message("".join(pending)))
        else:
            logger.warning("MC AstrBot: 流式回复无可发送的纯文本（玩家=%s）", self.mc_sender)


class MCAstrBot(Star):
    def __init__(self, context: Context, config: dict):
        super().__init__(context, config)
        self.config = config
        self._migrate_segmentation_config()
        self.proc: asyncio.subprocess.Process | None = None
        self.reader_task: asyncio.Task | None = None
        self.stderr_task: asyncio.Task | None = None
        self.supervisor_task: asyncio.Task | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.write_lock = asyncio.Lock()
        self.recent = deque(maxlen=100)
        self.logs = deque(maxlen=100)
        self.last_snapshot: dict = {"bot": {"status": "starting", "online": False}}
        self.stopping = False
        self.user_stopped = False
        self.bridge_lock = asyncio.Lock()
        context.register_web_api(f"/{PLUGIN_NAME}/status", self.web_status, ["GET"], "MC 状态")
        context.register_web_api(f"/{PLUGIN_NAME}/control", self.web_control, ["POST"], "启停 MC 机器人")
        context.register_web_api(f"/{PLUGIN_NAME}/say", self.web_say, ["POST"], "发送 MC 聊天")
        context.register_web_api(f"/{PLUGIN_NAME}/action", self.web_action, ["POST"], "控制 MC 机器人")

    async def initialize(self) -> None:
        await self.start_bridge()

    def _migrate_segmentation_config(self) -> None:
        """Copy existing flat reply settings into the grouped settings once."""
        if self.config.get("segmentation_migrated"):
            return
        grouped = self.config.get("segmentation")
        if not isinstance(grouped, dict):
            grouped = {}
            self.config["segmentation"] = grouped
        for key in (
            "split_threshold", "split_mode", "split_regex", "split_filter_enabled",
            "split_filter_regex", "split_interval_method", "split_interval_ms",
            "split_log_base",
        ):
            if key in self.config:
                grouped[key] = self.config[key]
        self.config["segmentation_migrated"] = True
        if hasattr(self.config, "save_config"):
            self.config.save_config()

    async def _ensure_node_dependencies(self, directory: Path) -> bool:
        """Install the locked bridge dependencies on the AstrBot host if absent."""
        dependency_check = (
            "require('mineflayer'); require('minecraft-data'); require('vec3'); "
            "require('mineflayer-pathfinder'); require('mineflayer-pvp'); "
            "require('mineflayer-collectblock'); require('mineflayer-armor-manager')"
        )
        try:
            probe = await asyncio.create_subprocess_exec(
                "node", "-e", dependency_check,
                cwd=str(directory), stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            if await probe.wait() == 0:
                return True
        except OSError as exc:
            logger.error("MC AstrBot: 无法运行 Node.js: %s", exc)
            return False

        logger.info("MC AstrBot: 缺少 Node 依赖，正在插件目录执行 npm ci --omit=dev")
        try:
            installer = await asyncio.create_subprocess_exec(
                "npm", "ci", "--omit=dev", "--no-audit", "--no-fund",
                cwd=str(directory), stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            output, _ = await asyncio.wait_for(installer.communicate(), timeout=120)
        except asyncio.TimeoutError:
            installer.kill()
            await installer.wait()
            logger.error("MC AstrBot: npm 依赖安装超时；请在插件目录手动运行 npm ci --omit=dev")
            return False
        except OSError as exc:
            logger.error("MC AstrBot: 无法运行 npm: %s；请在插件目录手动运行 npm ci --omit=dev", exc)
            return False
        if installer.returncode:
            logger.error("MC AstrBot: npm 依赖安装失败（退出码 %s）：%s", installer.returncode, output.decode(errors="replace")[-2000:])
            return False
        probe = await asyncio.create_subprocess_exec(
            "node", "-e", dependency_check, cwd=str(directory),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        _, error = await probe.communicate()
        if probe.returncode:
            logger.error("MC AstrBot: 安装后仍无法加载 Node 依赖：%s", error.decode(errors="replace")[-2000:])
            return False
        logger.info("MC AstrBot: Node 依赖安装完成")
        return True

    async def start_bridge(self) -> bool:
        async with self.bridge_lock:
            if self.stopping:
                raise RuntimeError("MC 插件正在停止")
            self.user_stopped = False
            if self.proc and self.proc.returncode is None:
                return True
            if self.supervisor_task:
                self.supervisor_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self.supervisor_task
                self.supervisor_task = None
            for task in (self.reader_task, self.stderr_task):
                if task:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
            await self._launch_bridge()
            if self.proc:
                if not self.supervisor_task or self.supervisor_task.done():
                    self.supervisor_task = asyncio.create_task(self._supervise_bridge())
                return self.proc.returncode is None
            return False

    async def stop_bridge(self) -> None:
        async with self.bridge_lock:
            self.user_stopped = True
            if self.supervisor_task:
                self.supervisor_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self.supervisor_task
                self.supervisor_task = None
            if self.proc and self.proc.returncode is None:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), 3)
                except asyncio.TimeoutError:
                    self.proc.kill()
                    await self.proc.wait()
            for task in (self.reader_task, self.stderr_task):
                if task:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
            self.proc = None
            self.reader_task = None
            self.stderr_task = None
            self.last_snapshot = {"bot": {"status": "user_stopped", "online": False}}

    async def _launch_bridge(self) -> None:
        import os

        self.proc = None
        host = str(self.config.get("server_host", "127.0.0.1")).strip()
        if not host:
            logger.warning("MC AstrBot: 未配置服务器地址")
            return
        bridge = Path(__file__).with_name("bridge.js")
        if not await self._ensure_node_dependencies(bridge.parent):
            self.last_snapshot["bot"]["status"] = "dependency_error"
            return
        env = dict(os.environ)
        env["MC_ASTRBOT_CONFIG"] = json.dumps({
            "host": host,
            "port": self.config.get("server_port", 25565),
            "username": self.config.get("bot_name", "Fairy"),
            "version": self.config.get("mc_version") or False,
            "auth": self.config.get("mc_auth", "offline"),
            "login_password": self.config.get("login_password", ""),
            "resting_mode": self.config.get("resting_mode", "spectator"),
        }, ensure_ascii=False)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                "node", str(bridge), cwd=str(bridge.parent), env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, OSError) as exc:
            logger.error("MC AstrBot: Node 桥接启动失败: %s", exc)
            self.last_snapshot["bot"]["status"] = "bridge_error"
            return
        self.reader_task = asyncio.create_task(self._read_bridge())
        self.stderr_task = asyncio.create_task(self._read_stderr())
        logger.info("MC AstrBot: 已启动 Minecraft 桥接进程")

    async def _supervise_bridge(self) -> None:
        delay = 5
        while not self.stopping and not self.user_stopped and self.proc:
            await self.proc.wait()
            if self.stopping or self.user_stopped:
                break
            logger.warning("MC AstrBot: 桥接进程退出，%s 秒后重启", delay)
            await asyncio.sleep(delay)
            if self.stopping or self.user_stopped:
                break
            async with self.bridge_lock:
                if self.stopping or self.user_stopped:
                    break
                await self._launch_bridge()
            delay = min(60, delay * 2)

    async def terminate(self) -> None:
        self.stopping = True
        await self.stop_bridge()
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError("MC 桥接已停止"))
        self.pending.clear()

    async def _read_bridge(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            while line := await self.proc.stdout.readline():
                try:
                    packet = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                kind = packet.get("type")
                if kind == "reply":
                    fut = self.pending.get(str(packet.get("id")))
                    if fut and not fut.done():
                        if packet.get("error"):
                            fut.set_exception(RuntimeError(packet["error"]))
                        else:
                            fut.set_result(packet.get("data"))
                elif kind == "conversation":
                    asyncio.create_task(self._receive(packet.get("data") or {}))
                elif kind == "chat":
                    self.recent.append(packet.get("data"))
                elif kind == "log":
                    self.logs.append({"at": int(time.time() * 1000), "line": packet.get("line", "")})
        finally:
            self.last_snapshot = {"bot": {"status": "bridge_stopped", "online": False}}
            for fut in self.pending.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("MC 桥接已断开"))
            if not self.stopping and not self.user_stopped:
                logger.error("MC AstrBot: 桥接进程意外退出，请检查 Node 依赖与日志")

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while line := await self.proc.stderr.readline():
            logger.warning("MC AstrBot bridge: %s", line.decode(errors="replace").rstrip()[:500])

    async def rpc(self, action: str, args: dict | None = None, timeout: float = 10) -> dict:
        if not self.proc or self.proc.returncode is not None or not self.proc.stdin:
            raise RuntimeError("MC 桥接进程未运行")
        ident = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self.pending[ident] = fut
        try:
            payload = json.dumps({"id": ident, "action": action, "args": args or {}}, ensure_ascii=False)
            async with self.write_lock:
                self.proc.stdin.write((payload + "\n").encode())
                await self.proc.stdin.drain()
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(ident, None)

    async def _receive(self, data: dict) -> None:
        channel = data.get("channel")
        sender = str(data.get("username", ""))
        body = str(data.get("text", "")).strip()
        if channel not in ("public", "tell") or not re.fullmatch(r"[A-Za-z0-9_]{1,16}", sender) or not body:
            return
        if channel == "public" and not self.config.get("public_auto_reply", True):
            return
        keywords = self.config.get("wake_keywords", [])
        if keywords and not any(
            isinstance(keyword, str) and keyword and keyword.casefold() in body.casefold()
            for keyword in keywords
        ):
            return
        msg = AstrBotMessage()
        msg.self_id = str(self.config.get("bot_name", "Fairy"))
        msg.sender = MessageMember(sender, sender)
        msg.message_id = uuid.uuid4().hex
        msg.type = MessageType.GROUP_MESSAGE if channel == "public" else MessageType.FRIEND_MESSAGE
        msg.group = Group(group_id="mc-world", group_name="Minecraft 公屏") if channel == "public" else None
        msg.session_id = "mc-world" if channel == "public" else sender
        msg.message_str = body
        msg.message = [At(qq=msg.self_id), Plain(body)]
        msg.raw_message = data
        event = MinecraftEvent(msg, self, channel, sender)
        self.context.get_event_queue().put_nowait(event)

    def is_admin(self, username: str) -> bool:
        name = username.strip().casefold()
        return bool(name) and any(
            isinstance(item, str) and item.strip().casefold() == name
            for item in self.config.get("admin_ids", [])
        )

    def _can_use_llm_actions(self, event: AstrMessageEvent) -> bool:
        sender = getattr(event, "mc_sender", None) or event.get_sender_id()
        return (
            event.get_platform_name() == "minecraft"
            and bool(self.config.get("allow_llm_actions", False))
            and bool(self.config.get("allow_admin_llm_actions", False))
            and self.is_admin(sender)
        )

    async def send_mc_text(self, text: str, target: str | None = None) -> None:
        limit = 240 - (6 + len(target)) if target else 240
        segmented = bool(self.config.get("segmented_reply", True))
        settings = self.config.get("segmentation") or {}
        pieces = split_reply(
            text, segmented,
            int(settings.get("split_threshold", 150)),
            str(settings.get("split_mode", "regex")),
            str(settings.get("split_regex", r".*?[。？！~…\n]+|.+$")),
            limit,
        )
        pieces = filter_reply(
            pieces, segmented and bool(settings.get("split_filter_enabled", False)),
            str(settings.get("split_filter_regex", "")),
        )
        if not pieces:
            logger.warning("MC AstrBot: 跳过空回复（分段或过滤后无文本）")
            return
        for index, piece in enumerate(pieces):
            if index:
                configured_ms = settings.get("split_interval_ms", 900) if segmented else 900
                base_ms = max(0, min(5000, int(configured_ms)))
                method = settings.get("split_interval_method", "fixed") if segmented else "fixed"
                if method == "random":
                    delay_ms = random.uniform(0, base_ms)
                elif method == "logarithmic":
                    log_base = max(1.1, float(settings.get("split_log_base", 1.8)))
                    delay_ms = min(5000, base_ms * math.log(max(2, len(piece)), log_base))
                else:
                    delay_ms = base_ms
                await asyncio.sleep(delay_ms / 1000)
            await self.rpc("say", {"text": piece, "target": target})

    async def web_status(self):
        try:
            self.last_snapshot = await self.rpc("snapshot", timeout=3)
        except Exception:
            pass
        running = bool(not self.user_stopped and self.proc and self.proc.returncode is None)
        return json_response({"running": running, "snapshot": self.last_snapshot, "chat": list(self.recent)[-50:], "logs": list(self.logs)[-50:]})

    async def web_control(self):
        payload = await request.json(default={})
        action = payload.get("action")
        if action not in ("start", "stop"):
            return error_response("不支持的操作")
        try:
            if action == "start":
                if not await self.start_bridge():
                    return error_response("MC 桥接启动失败", status_code=503)
            else:
                await self.stop_bridge()
            return json_response({"running": bool(self.proc and self.proc.returncode is None)})
        except Exception as exc:
            return error_response(str(exc), status_code=503)

    async def web_say(self):
        payload = await request.json(default={})
        text = str(payload.get("text", "")).strip()
        target = payload.get("target") or None
        if not text or len(text) > 2000:
            return error_response("消息长度须为 1–2000 字符")
        if target and not re.fullmatch(r"[A-Za-z0-9_]{1,16}", str(target)):
            return error_response("玩家名无效")
        try:
            await self.send_mc_text(text, target)
            return json_response({"ok": True})
        except Exception as exc:
            return error_response(str(exc), status_code=503)

    async def web_action(self):
        payload = await request.json(default={})
        action = payload.get("action")
        if action not in ("look_at_player", "scan", "goto"):
            return error_response("不支持的操作")
        try:
            args = payload.get("args") or {}
            if action == "goto":
                args = await self._validate_goto(args)
            return json_response(await self.rpc(action, args, timeout=8))
        except Exception as exc:
            return error_response(str(exc), status_code=503)

    async def _validate_goto(self, args: dict) -> dict:
        coords = [float(args[axis]) for axis in ("x", "y", "z")]
        if not all(math.isfinite(value) for value in coords):
            raise ValueError("坐标必须是有限数字")
        snapshot = await self.rpc("snapshot")
        position = snapshot.get("player", {}).get("position")
        if not position:
            raise ValueError("当前无法读取机器人位置")
        distance = math.dist(coords, [position[axis] for axis in ("x", "y", "z")])
        max_distance = 32
        if not math.isfinite(distance) or distance > max_distance:
            raise ValueError(f"目标超出 {max_distance} 格移动范围")
        return dict(zip(("x", "y", "z"), coords))

    @filter.llm_tool(name="mc_observe_player")
    async def mc_observe_player(self, event: AstrMessageEvent, username: str):
        """让 Minecraft 机器人看向视野内的玩家。

        Args:
            username(string): 玩家名
        """
        if not self._can_use_llm_actions(event):
            return "当前会话无权控制 Minecraft 机器人。"
        try:
            result = await self.rpc("look_at_player", {"username": username})
            return "已看向玩家" if result.get("ok") else str(result)
        except Exception as exc:
            return f"看向玩家失败：{exc}"

    @filter.llm_tool(name="mc_scan_surroundings")
    async def mc_scan_surroundings(self, event: AstrMessageEvent, radius: int):
        """扫描 Minecraft 机器人周围的方块并返回统计。

        Args:
            radius(number): 扫描半径，范围 1 到 24
        """
        if not self._can_use_llm_actions(event):
            return "当前会话无权控制 Minecraft 机器人。"
        try:
            result = await self.rpc("scan", {"radius": max(1, min(24, int(radius)))})
            return json.dumps(result, ensure_ascii=False)[:3000]
        except Exception as exc:
            return f"扫描失败：{exc}"

    @filter.llm_tool(name="mc_move_nearby")
    async def mc_move_nearby(self, event: AstrMessageEvent, x: float, y: float, z: float):
        """将 Minecraft 机器人传送到附近坐标，适合观察玩家指定地点。

        Args:
            x(number): 目标 X 坐标
            y(number): 目标 Y 坐标
            z(number): 目标 Z 坐标
        """
        if not self._can_use_llm_actions(event):
            return "当前会话无权控制 Minecraft 机器人。"
        try:
            args = await self._validate_goto({"x": x, "y": y, "z": z})
            result = await self.rpc("goto", args, timeout=8)
            return json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return f"移动失败：{exc}"

    async def _behavior_tool(self, event: AstrMessageEvent, action: str,
                             args: dict | None = None, timeout: float = 10) -> str:
        if not self._can_use_llm_actions(event):
            return "当前会话无权控制 Minecraft 机器人。"
        try:
            result = await self.rpc(action, args or {}, timeout=timeout)
            return json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            return f"Minecraft 操作失败：{exc}"

    @filter.llm_tool(name="mc_behavior_status")
    async def mc_behavior_status(self, event: AstrMessageEvent):
        """查询 Minecraft 机器人的行为模式、目标玩家、任务、血量、饱食度和 TPS。"""
        return await self._behavior_tool(event, "behavior_status")

    @filter.llm_tool(name="mc_set_mode")
    async def mc_set_mode(self, event: AstrMessageEvent, mode: str, username: str = ""):
        """切换机器人行为模式。idle 停止自主动作并等待自然语言指令；auto 自动跟随目标玩家、攻击附近敌对生物并在饥饿时吃面包；follow 只跟随。

        Args:
            mode(string): idle、auto 或 follow
            username(string): auto/follow 的目标玩家名；留空时使用发出指令的玩家
        """
        target = username or (getattr(event, "mc_sender", None) or event.get_sender_id())
        return await self._behavior_tool(event, "set_mode", {"mode": mode, "username": target})

    @filter.llm_tool(name="mc_follow_player")
    async def mc_follow_player(self, event: AstrMessageEvent, username: str):
        """跟随指定 Minecraft 玩家，不主动战斗。

        Args:
            username(string): 要跟随的玩家名
        """
        return await self._behavior_tool(event, "set_mode", {"mode": "follow", "username": username})

    @filter.llm_tool(name="mc_set_auto_combat")
    async def mc_set_auto_combat(self, event: AstrMessageEvent, enabled: bool):
        """开启或关闭 auto 模式中对附近敌对生物的自动战斗。

        Args:
            enabled(boolean): true 开启，false 关闭
        """
        return await self._behavior_tool(event, "set_auto_combat", {"enabled": enabled})

    @filter.llm_tool(name="mc_collect_blocks")
    async def mc_collect_blocks(self, event: AstrMessageEvent, block: str, count: int):
        """收集机器人附近 16 格内指定类型的方块，数量最多 16 个。

        Args:
            block(string): 英文方块 ID，例如 oak_log
            count(number): 收集数量，1 到 16
        """
        return await self._behavior_tool(event, "collect", {"block": block, "count": count}, timeout=120)

    @filter.llm_tool(name="mc_sleep")
    async def mc_sleep(self, event: AstrMessageEvent):
        """寻找附近的床，走过去并睡觉。"""
        return await self._behavior_tool(event, "sleep", timeout=60)

    @filter.llm_tool(name="mc_eat")
    async def mc_eat(self, event: AstrMessageEvent):
        """从背包取面包并吃掉一个。"""
        return await self._behavior_tool(event, "eat", timeout=30)

    @filter.llm_tool(name="mc_store_inventory")
    async def mc_store_inventory(self, event: AstrMessageEvent):
        """走到附近箱子或木桶，把背包中的所有物品存入容器。"""
        return await self._behavior_tool(event, "store", timeout=120)

    @filter.llm_tool(name="mc_fetch_supplies")
    async def mc_fetch_supplies(self, event: AstrMessageEvent):
        """从附近箱子或木桶领取面包、最好的剑、斧和镐。"""
        return await self._behavior_tool(event, "fetch", timeout=90)
