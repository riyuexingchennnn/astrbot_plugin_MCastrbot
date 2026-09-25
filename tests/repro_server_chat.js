// 可单独运行：node tests/repro_server_chat.js
// 真实服务器抓包；原始抓包日期未提供（样本收录：2026-09-25）。click_event 内容在原始片段中省略。
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const minecraftData = require('minecraft-data');
const injectMineflayerChat = require('mineflayer/lib/plugins/chat');
const { FairyBot } = require('../mc_bot');

const client = new EventEmitter();
client.registry = minecraftData('1.21.4');
client._client = new EventEmitter();
client.supportFeature = name => client.registry.supportFeature(name);
injectMineflayerChat(client, {});
client.players = { ProbeZZ: { username: 'ProbeZZ' } };

const bot = new FairyBot();
bot.bot = client;
bot.wire(client);
const conversations = [];
bot.on('conversation', item => conversations.push(item));

function receive(payload) {
  client._client.emit('systemChat', { formattedMessage: JSON.stringify(payload), positionId: 1 });
}

receive({ translate: '<%s> %s', with: [
  { extra: ['ProbeZZ'], text: '', insertion: 'ProbeZZ', click_event: {} },
  { text: 'probe-hello' },
] });
assert.equal(conversations.length, 1);
assert.equal(conversations[0].username, 'ProbeZZ');
assert.equal(bot.chatLog.length, 1);
console.log(`真实公屏抓包：conversation=${conversations.length}，username=${conversations[0].username}，面板条目=${bot.chatLog.length}`);

receive({ color: 'yellow', text: '请登录或注册' });
assert.equal(conversations.length, 1);
console.log('真实系统抓包：新增 conversation=0');

// <Server> 的原始 JSON 未提供，这里验证广播外观不会产生 conversation。
receive({ text: '<Server> Fairy 公告' });
assert.equal(conversations.length, 1);
assert.equal(bot.chatLog.length, 3);
console.log(`<Server> 广播：新增 conversation=0，面板条目=${bot.chatLog.length}`);
