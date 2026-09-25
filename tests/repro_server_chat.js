// 可单独运行：node tests/repro_server_chat.js
const assert = require('node:assert/strict');
const ChatMessage = require('prismarine-chat')(require('minecraft-data')('1.21.4'));
const { FairyBot } = require('../mc_bot');

const bot = new FairyBot();
bot.bot = { players: { Alex: { username: 'Alex' } } };
const conversations = [];
bot.on('conversation', item => conversations.push(item));

bot.parseConversation(new ChatMessage({ translate: 'chat.type.text', with: ['aLeX', 'Fairy 测试公聊'] }));
assert.equal(conversations.length, 1);
console.log(`在线玩家（大小写不敏感）：conversation=${conversations.length}，username=${conversations[0].username}`);

bot.parseConversation(new ChatMessage({ translate: 'commands.teleport.success.entity.single', with: ['Alex', 'Fairy'] }));
assert.equal(conversations.length, 1);
console.log('传送广播：新增 conversation=0');

bot.parseConversation(new ChatMessage({ translate: 'chat.type.text', with: ['Server', 'Fairy 广播'] }));
assert.equal(conversations.length, 1);
console.log('<Server> 消息：新增 conversation=0');
