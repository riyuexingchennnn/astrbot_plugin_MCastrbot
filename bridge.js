// AstrBot 子进程协议：stdin/stdout 每行一条 JSON，绝不开放未鉴权 HTTP 端口。
const readline = require('readline');
const { FairyBot } = require('./mc_bot');
const config = require('./config');

const bot = new FairyBot();
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
bot.on('conversation', (message) => output({ type: 'conversation', data: message }));
bot.on('log', (line) => output({ type: 'log', line }));
bot.on('chat', (item) => output({ type: 'chat', data: item }));

const allowed = {
  snapshot: () => bot.snapshot(),
  say: ({ text, target }) => { bot.sendChat(text, target || null); return { ok: true }; },
  command: ({ text }) => bot.runCommand(text),
  look_at_player: ({ username }) => bot.lookAtPlayer(username),
  scan: ({ radius }) => bot.scan(Math.max(1, Math.min(24, Number(radius) || 12))),
  behavior_status: () => bot.behavior.status(),
  attack_entity: ({ entityId }) => bot.behavior.attackEntity(entityId),
  set_mode: ({ mode, username }) => bot.behavior.setMode(mode, username),
  set_auto_combat: ({ enabled }) => {
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
    return bot.behavior.setAutoCombat(enabled);
  },
  collect: ({ block, count }) => bot.behavior.collect(block, count),
  sleep: () => bot.behavior.sleep(),
  eat: () => bot.behavior.eat(),
  store: () => bot.behavior.store(),
  fetch: () => bot.behavior.fetch(),
  goto: ({ x, y, z }) => {
    const coords = [x, y, z].map(Number);
    if ([x, y, z].some(value => value == null) || !coords.every(Number.isFinite)) {
      throw new Error('坐标无效');
    }
    const position = bot.bot?.entity?.position;
    if (!position) throw new Error('当前无法读取机器人位置');
    // 桥接层再限制一次移动距离，512 格是独立于配置的硬上限。
    const maxDistance = Math.min(config.maxMoveDistance, 512);
    const [targetX, targetY, targetZ] = coords;
    const distance = Math.hypot(targetX - position.x, targetY - position.y, targetZ - position.z);
    if (!Number.isFinite(distance) || distance > maxDistance) {
      throw new Error(`目标超出 ${maxDistance} 格移动范围`);
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
