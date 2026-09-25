const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const minecraftData = require('minecraft-data');
const injectMineflayerChat = require('mineflayer/lib/plugins/chat');
const { FairyBot } = require('../mc_bot');

// 真实服务器抓包；原始抓包日期未提供（样本收录：2026-09-25）。click_event 的内部字段在提供的样本中
// 以 {...} 省略，测试只用空对象占位，其余字段及结构照录。
const playerChatPacket = {
  translate: '<%s> %s',
  with: [
    { extra: ['ProbeZZ'], text: '', insertion: 'ProbeZZ', click_event: {} },
    { text: 'probe-hello' },
  ],
};
// 同一服务器抓到的系统消息；原始抓包日期未提供（样本收录：2026-09-25）。
const systemPacket = { color: 'yellow', text: '请登录或注册' };

function wiredBot() {
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
  return { bot, client, conversations };
}

function serverPacket(client, payload) {
  client._client.emit('systemChat', { formattedMessage: JSON.stringify(payload), positionId: 1 });
}

test('captured player chat reaches conversation through mineflayer chat event', () => {
  const { bot, client, conversations } = wiredBot();
  serverPacket(client, playerChatPacket);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].channel, 'public');
  assert.equal(conversations[0].username, 'ProbeZZ');
  assert.equal(conversations[0].text, 'probe-hello');
  assert.equal(bot.chatLog.length, 1);
  assert.deepEqual(bot.chatLog.map(item => item.kind), ['server']);
  console.log(`真实公屏抓包：conversation=${conversations.length}，username=${conversations[0].username}，面板条目=${bot.chatLog.length}`);
});

test('captured system message and Server announcement never become conversations', () => {
  const { bot, client, conversations } = wiredBot();
  serverPacket(client, systemPacket);
  // <Server> 是系统广播外观的回归场景；服务器抓包未提供其原始 JSON。
  serverPacket(client, { text: '<Server> Fairy 公告' });
  assert.equal(conversations.length, 0);
  assert.equal(bot.chatLog.length, 2);
  assert.deepEqual(bot.chatLog.map(item => item.kind), ['server', 'server']);
  console.log(`真实系统抓包及 <Server>：conversation=${conversations.length}，面板条目=${bot.chatLog.length}`);
});

test('only online players are accepted, case insensitive, on both channels', () => {
  const { client, conversations } = wiredBot();
  client.emit('chat', 'pRoBeZz', 'hello');
  client.emit('chat', 'Offline', 'hello');
  client.emit('whisper', 'pRoBeZz', 'secret-whisper');
  client.emit('whisper', 'Offline', 'secret-whisper');
  assert.deepEqual(conversations.map(item => [item.channel, item.username]), [
    ['public', 'pRoBeZz'],
    ['tell', 'pRoBeZz'],
  ]);
});

test('public and tell replies keep their channel', () => {
  const bot = new FairyBot();
  const sent = [];
  bot.status = 'online';
  bot.bot = { chat: line => sent.push(line) };
  bot.sendChat('hello');
  bot.sendChat('secret', 'ProbeZZ');
  assert.deepEqual(sent, ['hello', '/msg ProbeZZ secret']);
  assert.throws(() => bot.sendChat('/op ProbeZZ'), /不允许发送命令/);
  assert.throws(() => bot.sendChat('x'.repeat(241)), /240/);
});
