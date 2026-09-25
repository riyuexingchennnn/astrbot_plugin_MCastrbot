import asyncio
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
