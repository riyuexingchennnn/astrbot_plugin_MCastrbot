// AstrBot 子进程协议：stdin/stdout 每行一条 JSON，绝不开放未鉴权 HTTP 端口。
const readline = require('readline');
const { FairyBot } = require('./mc_bot');

const bot = new FairyBot();
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
bot.on('conversation', (message) => output({ type: 'conversation', data: message }));
bot.on('log', (line) => output({ type: 'log', line }));
bot.on('chat', (item) => output({ type: 'chat', data: item }));

const allowed = {
  snapshot: () => bot.snapshot(),
  say: ({ text, target }) => { bot.sendChat(text, target || null); return { ok: true }; },
  look_at_player: ({ username }) => bot.lookAtPlayer(username),
  scan: ({ radius }) => bot.scan(Math.max(1, Math.min(24, Number(radius) || 12))),
  goto: ({ x, y, z }) => {
    const coords = [x, y, z].map(Number);
    if (!coords.every(Number.isFinite) || coords.some(n => Math.abs(n) > 30000000)) {
      throw new Error('坐标无效');
    }
    return bot.goto(...coords);
  },
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let id;
  try {
    const req = JSON.parse(line);
    id = req.id;
    if (!Object.hasOwn(allowed, req.action)) throw new Error('不支持的操作');
    const data = await allowed[req.action](req.args || {});
    output({ type: 'reply', id, data });
  } catch (error) {
    output({ type: 'reply', id, error: error.message || String(error) });
  }
});

process.stdin.on('end', () => { bot.stop(); process.exit(0); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { bot.stop(); process.exit(0); });
}
bot.start();
