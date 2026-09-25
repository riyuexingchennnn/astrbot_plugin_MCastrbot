const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const ChatMessage = require('prismarine-chat')(require('minecraft-data')('1.21.4'));
const { FairyBot } = require('../mc_bot');
const config = require('../config');

function wiredBot() {
  const bot = new FairyBot();
  const client = new EventEmitter();
  client.players = { Alex: { username: 'Alex' } };
  client.addChatPattern = () => {};
  bot.wire(client);
  bot.bot = client;
  const conversations = [];
  bot.on('conversation', item => conversations.push(item));
  return { bot, client, conversations };
}

test('structured player chat is accepted once, including case-insensitive online name', () => {
  const { client, conversations } = wiredBot();
  const jsonMsg = new ChatMessage({ translate: 'chat.type.text', with: ['aLeX', 'Fairy 你好'] });
  console.log(`ChatMessage.json=${JSON.stringify(jsonMsg.json)}`);
  client.emit('message', jsonMsg);
  client.emit('chat', 'aLeX', 'Fairy 你好');
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].username, 'aLeX');
  assert.equal(conversations[0].text, 'Fairy 你好');
  console.log(`结构化在线玩家聊天：conversation=${conversations.length}，username=${conversations[0].username}`);
});

test('teleport announcement and Server chat are logged but never become conversations', () => {
  const { bot, client, conversations } = wiredBot();
  client.emit('message', new ChatMessage({ translate: 'commands.teleport.success.entity.single', with: ['Alex', 'Fairy'] }));
  client.emit('message', new ChatMessage({ translate: 'chat.type.announcement', with: ['Alex', 'Teleported Alex to Fairy'] }));
  client.emit('message', new ChatMessage({ translate: 'chat.type.text', with: ['Server', 'Fairy hello'] }));
  assert.equal(conversations.length, 0);
  assert.equal(bot.chatLog.length, 3);
  console.log(`传送广播及 <Server>：conversation=${conversations.length}，聊天记录=${bot.chatLog.length}`);
});

test('tell keeps its channel; custom tell pattern is registered without parsing system messages', () => {
  const { client, conversations } = wiredBot();
  client.emit('whisper', 'Alex', 'Fairy secret');
  assert.deepEqual(conversations.map(item => item.channel), ['tell']);
  const previous = config.conversation.tellRegex;
  config.conversation.tellRegex = '^FROM (?<username>\\w+): (?<message>.+)$';
  try {
    const extra = new EventEmitter();
    extra.addChatPattern = (name, pattern, options) => {
      assert.equal(name, 'whisper');
      assert.equal(options.deprecated, true);
      assert.match('FROM Alex: Fairy help', pattern);
    };
    new FairyBot().wire(extra);
  } finally {
    config.conversation.tellRegex = previous;
  }
});

test('chat output is bounded and cannot issue commands from public reply', () => {
  const bot = new FairyBot();
  const sent = [];
  bot.status = 'online';
  bot.bot = { chat: line => sent.push(line) };
  bot.sendChat('hello');
  bot.sendChat('secret', 'Alex');
  assert.deepEqual(sent, ['hello', '/msg Alex secret']);
  assert.throws(() => bot.sendChat('/op Alex'), /不允许发送命令/);
  assert.throws(() => bot.sendChat('x'.repeat(241)), /240/);
});
