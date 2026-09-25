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
  modes: () => bot.behavior.modes(),
  entities: ({ radius }) => bot.behavior.entities(radius),
  nearby_blocks: ({ block, radius }) => bot.behavior.nearbyBlocks(block, radius),
  craftable: ({ item, count }) => bot.behavior.craftable(item, count),
  attack_entity: ({ entityId }) => bot.behavior.attackEntity(entityId),
  attack_player: ({ username }) => bot.behavior.attackPlayer(username),
  set_mode: ({ mode, username }) => bot.behavior.setMode(mode, username),
  set_auto_combat: ({ enabled }) => {
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
    return bot.behavior.setAutoCombat(enabled);
  },
  collect: ({ block, count }) => bot.behavior.collect(block, count),
  craft_recipe: ({ item, count }) => bot.behavior.craftRecipe(item, count),
  smelt_item: ({ item, count, fuel, fuelCount }) => bot.behavior.smeltItem(item, count, fuel, fuelCount),
  clear_furnace: () => bot.behavior.clearFurnace(),
  place_here: ({ item, x, y, z }) => bot.behavior.placeHere(item, x, y, z),
  use_on_entity: ({ entityId, item }) => bot.behavior.useOnEntity(entityId, item),
  use_on_block: ({ x, y, z, item }) => bot.behavior.useOnBlock(x, y, z, item),
  give_player: ({ username, item, count }) => bot.behavior.givePlayer(username, item, count),
  discard: ({ item, count }) => bot.behavior.discard(item, count),
  sleep: () => bot.behavior.sleep(),
  inventory: () => bot.behavior.inventory(),
  eat: ({ item }) => bot.behavior.eat(item),
  equip_item: ({ item, destination }) => bot.behavior.equipItem(item, destination),
  view_chest: () => bot.behavior.viewChest(),
  take_from_chest: ({ item, count }) => bot.behavior.takeFromChest(item, count),
  put_in_chest: ({ item, count }) => bot.behavior.putInChest(item, count),
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
