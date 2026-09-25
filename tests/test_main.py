import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


def load_plugin(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    from astrbot_plugin_MCastrbot.main import MCAstrBot, MinecraftEvent
    from astrbot.api.event import MessageChain
    from astrbot.api.platform import AstrBotMessage, MessageMember, MessageType
    return MCAstrBot, MinecraftEvent, MessageChain, AstrBotMessage, MessageMember, MessageType


def test_only_body_wakes_and_channel_is_preserved(monkeypatch, tmp_path):
    MCAstrBot, _, _, _, _, _ = load_plugin(monkeypatch, tmp_path)
    events = []
    plugin = object.__new__(MCAstrBot)
    plugin.config = {"bot_name": "Fairy", "wake_keywords": ["Fairy"]}
    plugin.context = SimpleNamespace(get_event_queue=lambda: SimpleNamespace(put_nowait=events.append))

    async def receive(channel, username, text):
        await plugin._receive({"channel": channel, "username": username, "text": text})

    asyncio.run(receive("public", "FairyFan", "你好"))
    assert events == []
    asyncio.run(receive("public", "Alex", "fAiRy 你好"))
    assert len(events) == 1
    assert events[0].mc_channel == "public"
    assert events[0].message_str == "fAiRy 你好"
    asyncio.run(receive("tell", "Alex", "请问 FaIrY 在吗"))
    assert len(events) == 2 and events[1].mc_channel == "tell"
    asyncio.run(receive("ask", "Alex", "Fairy"))
    assert len(events) == 2
    plugin.config["wake_keywords"] = []
    asyncio.run(receive("public", "Alex", "没有唤醒词"))
    assert len(events) == 3
    del plugin.config["wake_keywords"]
    asyncio.run(receive("tell", "Alex", "默认不需要唤醒词"))
    assert len(events) == 4


def test_existing_segmentation_values_are_migrated_once(monkeypatch, tmp_path):
    MCAstrBot, *_ = load_plugin(monkeypatch, tmp_path)

    class Config(dict):
        def save_config(self):
            self.saved = True

    config = Config(segmentation={"split_threshold": 150}, split_threshold=80,
                    split_mode="length", segmentation_migrated=False)
    plugin = object.__new__(MCAstrBot)
    plugin.config = config
    plugin._migrate_segmentation_config()

    assert config["segmentation"]["split_threshold"] == 80
    assert config["segmentation"]["split_mode"] == "length"
    assert config["segmentation_migrated"] is True
    assert config.saved

    config["split_threshold"] = 10
    plugin._migrate_segmentation_config()
    assert config["segmentation"]["split_threshold"] == 80


def test_send_streaming_delivers_text_once_and_skips_empty(monkeypatch, tmp_path):
    _, MinecraftEvent, MessageChain, AstrBotMessage, MessageMember, MessageType = load_plugin(monkeypatch, tmp_path)
    message = AstrBotMessage()
    message.message_str = "Fairy"
    message.session_id = "Alex"
    message.sender = MessageMember("Alex", "Alex")
    message.type = MessageType.FRIEND_MESSAGE
    plugin = SimpleNamespace(send_mc_text=AsyncMock())
    event = MinecraftEvent(message, plugin, "tell", "Alex")

    async def chunks():
        yield MessageChain().message("你好")
        yield SimpleNamespace(type="break")
        yield MessageChain().message("，Fairy")

    async def empty_chunks():
        yield MessageChain()

    async def run():
        with patch("astrbot.core.platform.astr_message_event.Metric.upload", new_callable=AsyncMock):
            await event.send_streaming(chunks())
            await event.send(MessageChain())
            await event.send_streaming(empty_chunks())

    asyncio.run(run())
    plugin.send_mc_text.assert_awaited_once_with("你好，Fairy", "Alex")


def test_llm_action_permissions_require_both_switches_and_admin(monkeypatch, tmp_path):
    MCAstrBot, *_ = load_plugin(monkeypatch, tmp_path)
    plugin = object.__new__(MCAstrBot)
    plugin.config = {
        "allow_llm_actions": True,
        "allow_admin_llm_actions": True,
        "admin_ids": ["Alex"],
    }
    event = SimpleNamespace(
        mc_sender="alex",
        get_platform_name=lambda: "minecraft",
        get_sender_id=lambda: "alex",
    )
    assert plugin._can_use_llm_actions(event)
    plugin.config["allow_llm_actions"] = False
    assert not plugin._can_use_llm_actions(event)
    plugin.config["allow_llm_actions"] = True
    plugin.config["allow_admin_llm_actions"] = False
    assert not plugin._can_use_llm_actions(event)
    plugin.config["allow_admin_llm_actions"] = True
    event.mc_sender = "Bob"
    assert not plugin._can_use_llm_actions(event)
    event.mc_sender = "Alex"
    event.get_platform_name = lambda: "other"
    assert not plugin._can_use_llm_actions(event)


def test_llm_tools_return_results_to_agent_instead_of_sending_them(monkeypatch, tmp_path):
    MCAstrBot, *_ = load_plugin(monkeypatch, tmp_path)
    plugin = object.__new__(MCAstrBot)
    plugin._can_use_llm_actions = lambda event: True
    plugin.rpc = AsyncMock(side_effect=[
        {"ok": True},
        {"ok": True, "topBlocks": [{"name": "stone", "count": 5}]},
        {"ok": True},
    ])
    plugin._validate_goto = AsyncMock(return_value={"x": 1, "y": 2, "z": 3})
    event = SimpleNamespace()

    async def run():
        assert await plugin.mc_observe_player(event, "Alex") == "已看向玩家"
        scan = await plugin.mc_scan_surroundings(event, 8)
        assert json.loads(scan)["topBlocks"][0]["name"] == "stone"
        assert json.loads(await plugin.mc_move_nearby(event, 1, 2, 3))["ok"]

    asyncio.run(run())
