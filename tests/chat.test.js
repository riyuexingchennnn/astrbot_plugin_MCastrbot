const test = require('node:test');
const assert = require('node:assert/strict');
const { FairyBot } = require('../mc_bot');
const config = require('../config');

test('public, tell and ask messages are classified and duplicate chat is suppressed', () => {
  const bot = new FairyBot();
  bot.bot = { players: { Alex: { username: 'Alex' } } };
  const received = [];
  bot.on('conversation', item => received.push(item));
  bot.parseConversation('<Alex> hello');
  bot.receiveConversation('public', 'Alex', 'hello');
  bot.parseConversation('[Alex -> Fairy] secret');
  bot.parseConversation('[ask] Alex: help');
  bot.parseConversation('<Fairy> own response');
  assert.deepEqual(received.map(item => item.channel), ['public', 'tell', 'ask']);
  assert.deepEqual(received.map(item => item.username), ['Alex', 'Alex', 'Alex']);
});

test('server broadcasts and departed players never become public conversations', () => {
  const bot = new FairyBot();
  bot.bot = { players: { Alex: { username: 'Alex' } } };
  const received = [];
  const publicChat = [];
  bot.on('conversation', item => received.push(item));
  bot.on('chat', item => { if (item.kind === 'public') publicChat.push(item); });
  bot.parseConversation('<Server> 测试广播');
  bot.parseConversation('<Departed> 已退出');
  bot.parseConversation('<aLeX> 你好');
  bot.parseConversation('<fAiRy> 自己的消息');
  assert.deepEqual(received.map(item => item.username), ['aLeX']);
  assert.equal(publicChat.length, 1);
});

test('custom ask format can route a mod message', () => {
  const previous = config.conversation.askRegex;
  config.conversation.askRegex = '^ASK from (?<username>\\w+): (?<message>.+)$';
  try {
    const bot = new FairyBot();
    const received = [];
    bot.on('conversation', item => received.push(item));
    bot.parseConversation('ASK from Alex: where are you');
    assert.equal(received[0].channel, 'ask');
    assert.equal(received[0].text, 'where are you');
  } finally {
    config.conversation.askRegex = previous;
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
