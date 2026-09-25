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
    plugin.config = {"bot_name": "Fairy", "wake_keywords": ["Fairy"], "public_auto_reply": True}
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


def test_public_auto_reply_defaults_off_but_explicit_setting_is_respected(monkeypatch, tmp_path):
    MCAstrBot, *_ = load_plugin(monkeypatch, tmp_path)
    events = []
    plugin = object.__new__(MCAstrBot)
    plugin.config = {"bot_name": "Fairy", "wake_keywords": []}
    plugin.context = SimpleNamespace(get_event_queue=lambda: SimpleNamespace(put_nowait=events.append))

    async def receive(channel):
        await plugin._receive({"channel": channel, "username": "Alex", "text": "你好"})

    asyncio.run(receive("public"))
    assert events == []
    asyncio.run(receive("tell"))
    assert len(events) == 1
    plugin.config["public_auto_reply"] = True
    asyncio.run(receive("public"))
    assert len(events) == 2


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


def test_mc_global_prompt_only_applies_to_minecraft(monkeypatch, tmp_path):
    MCAstrBot, *_ = load_plugin(monkeypatch, tmp_path)
    plugin = object.__new__(MCAstrBot)
    plugin.config = {"mc_global_prompt": "  你是 MC 世界里的机器人。  "}
    req = SimpleNamespace(system_prompt="原有提示词")
    mc_event = SimpleNamespace(get_platform_name=lambda: "minecraft")
    other_event = SimpleNamespace(get_platform_name=lambda: "other")

    async def run():
        await plugin.add_mc_global_prompt(other_event, req)
        assert req.system_prompt == "原有提示词"
        await plugin.add_mc_global_prompt(mc_event, req)
        assert req.system_prompt == "原有提示词\n\n你是 MC 世界里的机器人。"

    asyncio.run(run())


def test_public_tool_sends_once_and_admin_command_uses_separate_rpc(monkeypatch, tmp_path):
    MCAstrBot, MinecraftEvent, MessageChain, AstrBotMessage, MessageMember, MessageType = load_plugin(monkeypatch, tmp_path)
    plugin = object.__new__(MCAstrBot)
    plugin._can_use_llm_actions = lambda event: True
    plugin.send_mc_text = AsyncMock()
    plugin.rpc = AsyncMock(return_value={"ok": True, "reply": ["模式已更改"]})
    message = AstrBotMessage()
    message.message_str = "Fairy"
    message.session_id = "mc-world"
    message.sender = MessageMember("Alex", "Alex")
    message.type = MessageType.GROUP_MESSAGE
    event = MinecraftEvent(message, plugin, "public", "Alex")

    async def run():
        with patch("astrbot.core.platform.astr_message_event.Metric.upload", new_callable=AsyncMock):
            assert await plugin.mc_send_public(event, "你好，大家") == "已发送到 Minecraft 公屏。"
            await event.send(MessageChain().message("重复回复"))
        command_result = await plugin.mc_send_public(event, "/gamemode creative")
        assert json.loads(command_result)["reply"] == ["模式已更改"]
        assert json.loads(await plugin.mc_attack_entity(event, 9))["ok"]

    asyncio.run(run())
    plugin.send_mc_text.assert_awaited_once_with("你好，大家")
    assert plugin.rpc.await_args_list[0].args == ("command", {"text": "/gamemode creative"})
    assert plugin.rpc.await_args_list[1].args == ("attack_entity", {"entityId": 9})


def test_public_and_attack_tools_reject_non_admin(monkeypatch, tmp_path):
    MCAstrBot, *_ = load_plugin(monkeypatch, tmp_path)
    plugin = object.__new__(MCAstrBot)
    plugin._can_use_llm_actions = lambda event: False
    plugin.send_mc_text = AsyncMock()
    plugin.rpc = AsyncMock()

    async def run():
        assert "无权" in await plugin.mc_send_public(SimpleNamespace(), "/gamemode creative")
        assert "无权" in await plugin.mc_attack_entity(SimpleNamespace(), 9)

    asyncio.run(run())
    plugin.send_mc_text.assert_not_awaited()
    plugin.rpc.assert_not_awaited()


def test_inventory_food_equipment_and_chest_tools_use_admin_rpc(monkeypatch, tmp_path):
    MCAstrBot, *_ = load_plugin(monkeypatch, tmp_path)
    plugin = object.__new__(MCAstrBot)
    plugin._can_use_llm_actions = lambda event: True
    plugin.rpc = AsyncMock(return_value={"ok": True})
    event = SimpleNamespace()

    async def run():
        await plugin.mc_inventory(event)
        await plugin.mc_eat(event, "potion")
        await plugin.mc_equip_item(event, "iron_sword", "hand")
        await plugin.mc_view_chest(event)
        await plugin.mc_take_from_chest(event, "bread", 3)

    asyncio.run(run())
    assert [call.args[:2] for call in plugin.rpc.await_args_list] == [
        ("inventory", {}),
        ("eat", {"item": "potion"}),
        ("equip_item", {"item": "iron_sword", "destination": "hand"}),
        ("view_chest", {}),
        ("take_from_chest", {"item": "bread", "count": 3}),
    ]


def test_added_agent_tools_route_rpc_and_require_admin(monkeypatch, tmp_path):
    MCAstrBot, *_ = load_plugin(monkeypatch, tmp_path)
    plugin = object.__new__(MCAstrBot)
    plugin._can_use_llm_actions = lambda event: True
    plugin.rpc = AsyncMock(return_value={"ok": True})
    event = SimpleNamespace()

    async def run():
        await plugin.mc_stats(event)
        await plugin.mc_modes(event)
        await plugin.mc_entities(event, 8)
        await plugin.mc_nearby_blocks(event, "stone", 6)
        await plugin.mc_craftable(event, "stick", 2)
        await plugin.mc_attack_player(event, "Alex")
        await plugin.mc_craft_recipe(event, "stick", 2)
        await plugin.mc_smelt_item(event, "iron_ore", 2, "coal", 1)
        await plugin.mc_clear_furnace(event)
        await plugin.mc_place_here(event, "stone", 1, 2, 3)
        await plugin.mc_use_on_entity(event, 9, "bone")
        await plugin.mc_use_on_block(event, 1, 2, 3, "bucket")
        await plugin.mc_go_to_bed(event)
        await plugin.mc_put_in_chest(event, "dirt", 3)
        await plugin.mc_discard(event, "dirt", 3)
        await plugin.mc_give_player(event, "Alex", "bread", 2)

    asyncio.run(run())
    assert [call.args[0] for call in plugin.rpc.await_args_list] == [
        "behavior_status", "modes", "entities", "nearby_blocks", "craftable",
        "attack_player", "craft_recipe", "smelt_item", "clear_furnace", "place_here",
        "use_on_entity", "use_on_block", "sleep", "put_in_chest", "discard", "give_player",
    ]
    assert plugin.rpc.await_args_list[7].kwargs["timeout"] == 120
    plugin._can_use_llm_actions = lambda event: False
    async def denied():
        assert "无权" in await plugin.mc_place_here(event, "stone", 1, 2, 3)
        assert "无权" in await plugin.mc_attack_player(event, "Alex")
    asyncio.run(denied())
    assert plugin.rpc.await_count == 16
