// 可单独运行：node tests/repro_server_chat.js
const assert = require('node:assert/strict');
const { FairyBot } = require('../mc_bot');

const bot = new FairyBot();
bot.bot = { players: { Alex: { username: 'Alex' } } };
const conversations = [];
bot.on('conversation', item => conversations.push(item));

bot.parseConversation('<Server> 测试广播');
assert.equal(conversations.length, 0);
console.log('Server 广播：conversation 数量 = 0');

bot.parseConversation('<aLeX> 测试公聊');
assert.equal(conversations.length, 1);
assert.equal(conversations[0].username, 'aLeX');
console.log(`在线玩家：conversation 数量 = ${conversations.length}，username = ${conversations[0].username}`);
