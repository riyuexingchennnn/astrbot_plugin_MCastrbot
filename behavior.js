// 自主行为与一次性任务。只通过 bridge.js 的白名单暴露给 AstrBot。
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const collectblock = require('mineflayer-collectblock').plugin;
const armorManager = require('mineflayer-armor-manager');
const minecraftData = require('minecraft-data');
const { Vec3 } = require('vec3');
const config = require('./config');

const MODES = new Set(['idle', 'auto', 'follow']);
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const SWORD_RANK = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
const MANUAL_ATTACK_MS = 30000;
const AUTO_FOOD_PRIORITY = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
  'cooked_chicken', 'cooked_rabbit', 'cooked_salmon', 'cooked_cod',
  'baked_potato', 'bread', 'rabbit_stew', 'mushroom_stew',
  'beetroot_soup', 'pumpkin_pie', 'apple', 'carrot', 'beetroot',
  'potato', 'melon_slice', 'sweet_berries', 'glow_berries',
  'cookie', 'dried_kelp', 'honey_bottle', 'beef', 'porkchop', 'mutton',
  'rabbit', 'cod', 'salmon', 'tropical_fish',
];
const ITEM_NAME = /^[a-z0-9_]+$/;
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

function itemNameOrThrow(name) {
  if (typeof name !== 'string' || !ITEM_NAME.test(name)) throw new Error('物品名无效');
  return name;
}

function countOrThrow(count, max = 64) {
  if (!Number.isInteger(count) || count < 1 || count > max) throw new Error(`数量须为 1 到 ${max}`);
  return count;
}

function isAttackable(entity) {
  return entity && entity.position && ['hostile', 'mob', 'animal', 'player'].includes(entity.type);
}

class BehaviorController {
  constructor(owner) {
    this.owner = owner;
    this.mode = 'idle';
    this.target = null;
    this.autoCombat = true;
    this.task = null;
    this.taskSerial = 0;
    this.timer = null;
    this.followedEntity = null;
    this.attackedEntity = null;
    this.manualAttackEntity = null;
    this.manualAttackUntil = 0;
    this.manualRestoreMode = null;
    this.spectatorWarned = false;
    this.lastTimeAge = null;
    this.tpsSamples = [];
    this.authReady = !config.login.enabled;
    this.lastCatchupAt = 0;
  }

  attach(bot) {
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(armorManager);
  }

  spawn(bot) {
    const data = minecraftData(bot.version);
    const movements = new Movements(bot, data);
    movements.canDig = false;
    movements.allow1by1towers = false;
    bot.pathfinder.setMovements(movements);
    Promise.resolve().then(() => bot.armorManager?.equipAll?.())
      .catch(error => this.owner.log('warn', `装备护甲失败: ${error.message}`));
    this.lastTimeAge = null;
    this.tpsSamples = [];
    this.authReady = !config.login.enabled;
    this.stopTimer();
    this.timer = setInterval(() => {
      try { this.tick(bot); } catch (error) {
        this.owner.log('warn', `自主行为执行失败: ${error.message}`);
      }
    }, 1000);
  }

  end(bot) {
    this.stopTimer();
    if (this.task && bot?.collectBlock?.cancelTask) {
      try { Promise.resolve(bot.collectBlock.cancelTask()).catch(() => {}); } catch (_) { /* 断线中 */ }
    }
    this.taskSerial++;
    this.task = null;
    this.authReady = false;
    this.tpsSamples = [];
    this.stopMovement(bot);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  online() {
    const bot = this.owner.bot;
    if (!bot || this.owner.status !== 'online' || !bot.entity) throw new Error('机器人当前不在线');
    if (!this.authReady) throw new Error('机器人尚未完成登录 Mod 认证');
    return bot;
  }

  stopMovement(bot) {
    try { bot?.pvp?.stop(); } catch (_) { /* 断线时可能已卸载 */ }
    try { bot?.pathfinder?.setGoal(null); } catch (_) { /* 同上 */ }
    this.followedEntity = null;
    this.attackedEntity = null;
    this.manualAttackEntity = null;
    this.manualAttackUntil = 0;
    this.manualRestoreMode = null;
  }

  requestSurvival(bot) {
    if (bot.game?.gameMode !== 'survival') {
      bot.chat('/gamemode survival');
      this.owner.log('sys', '自主行为已请求切换到 survival 游戏模式');
    }
  }

  setMode(mode, username = '') {
    const bot = this.online();
    mode = typeof mode === 'string' ? mode.trim().toLowerCase() : mode;
    username = typeof username === 'string' ? username.trim() : username;
    if (!MODES.has(mode)) throw new Error('行为模式只能是 idle、auto 或 follow');
    if (mode !== 'idle') {
      if (!PLAYER_NAME.test(username)) throw new Error('auto/follow 模式需要有效的目标玩家名');
      if (username.toLowerCase() === bot.username.toLowerCase()) throw new Error('不能跟随机器人自己');
    }
    this.taskSerial++;
    if (this.task && bot.collectBlock?.cancelTask) {
      try { Promise.resolve(bot.collectBlock.cancelTask()).catch(() => {}); } catch (_) { /* 任务仍会检查取消标记 */ }
    }
    this.task = null;
    this.stopMovement(bot);
    this.mode = mode;
    this.target = mode === 'idle' ? null : username;
    this.lastCatchupAt = 0;
    if (mode === 'idle') {
      if (config.restingMode) bot.chat(`/gamemode ${config.restingMode}`);
    } else {
      this.requestSurvival(bot);
    }
    this.owner.log('sys', `行为模式: ${mode}${this.target ? `，目标 ${this.target}` : ''}`);
    return this.status();
  }

  setAutoCombat(enabled) {
    const bot = this.online();
    this.autoCombat = enabled;
    if (!enabled && this.attackedEntity && this.manualAttackEntity === null) this.stopMovement(bot);
    return this.status();
  }

  nearbyEntities(bot, radius = 16) {
    if (!bot?.entity?.position) return [];
    return Object.values(bot.entities || {})
      .filter(entity => entity !== bot.entity && isAttackable(entity))
      .map(entity => ({
        id: entity.id,
        name: entity.username || entity.displayName || entity.name || entity.type,
        type: entity.type,
        distance: bot.entity.position.distanceTo(entity.position),
      }))
      .filter(entity => Number.isInteger(entity.id) && Number.isFinite(entity.distance) && entity.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 20)
      .map(entity => ({ ...entity, distance: +entity.distance.toFixed(1) }));
  }

  preferredFood(bot) {
    const items = bot.inventory?.items() || [];
    for (const name of AUTO_FOOD_PRIORITY) {
      const item = items.find(candidate => candidate.name === name);
      if (item) return item;
    }
    return null;
  }

  async attackEntity(entityId) {
    const bot = this.online();
    if (this.task) throw new Error(`正在执行 ${this.task}，请稍后再试`);
    const id = Number(entityId);
    if (!Number.isSafeInteger(id)) throw new Error('实体 ID 无效');
    const entity = bot.entities?.[id];
    if (!isAttackable(entity) || entity === bot.entity) throw new Error('目标不是可攻击的实体');
    const distance = bot.entity.position.distanceTo(entity.position);
    if (!Number.isFinite(distance) || distance > 16) throw new Error('目标不在 16 格攻击范围内');
    const serial = ++this.taskSerial;
    const restoreMode = bot.game?.gameMode !== 'survival' && this.mode === 'idle'
      ? (bot.game?.gameMode || config.restingMode) : null;
    this.stopMovement(bot);
    try {
      if (bot.game?.gameMode !== 'survival') {
        bot.chat('/gamemode survival');
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (serial !== this.taskSerial || bot !== this.owner.bot || this.owner.status !== 'online') {
          throw new Error('指定攻击已取消或机器人已断线');
        }
        if (bot.game?.gameMode && bot.game.gameMode !== 'survival') {
          throw new Error('指定攻击需要 survival 游戏模式和 /gamemode 权限');
        }
      }
      if (bot.entities?.[id] !== entity || bot.entity.position.distanceTo(entity.position) > 16) {
        throw new Error('目标已离开攻击范围');
      }
      const sword = bot.inventory?.items().filter(item => item.name.endsWith('_sword'))
        .sort((a, b) => SWORD_RANK.indexOf(b.name.replace('_sword', '')) - SWORD_RANK.indexOf(a.name.replace('_sword', '')))[0];
      if (sword) bot.equip(sword, 'hand').catch(error => this.owner.log('warn', `装备剑失败: ${error.message}`));
      await bot.pvp.attack(entity);
      if (serial !== this.taskSerial || bot !== this.owner.bot || this.owner.status !== 'online') {
        this.stopMovement(bot);
        throw new Error('指定攻击已取消或机器人已断线');
      }
      this.attackedEntity = id;
      this.manualAttackEntity = id;
      this.manualAttackUntil = Date.now() + MANUAL_ATTACK_MS;
      this.manualRestoreMode = restoreMode;
      return { ok: true, entityId: id, name: entity.username || entity.displayName || entity.name || entity.type, durationSeconds: 30 };
    } catch (error) {
      if (serial === this.taskSerial && bot === this.owner.bot && restoreMode &&
          (!bot.game?.gameMode || bot.game.gameMode === 'survival')) {
        bot.chat(`/gamemode ${restoreMode}`);
      }
      throw error;
    }
  }

  async attackPlayer(username) {
    const bot = this.online();
    if (typeof username !== 'string' || !PLAYER_NAME.test(username)) throw new Error('玩家名无效');
    const player = Object.entries(bot.players || {}).find(([name]) => name.toLowerCase() === username.toLowerCase())?.[1];
    if (!player?.entity) throw new Error('玩家不在视野内');
    return this.attackEntity(player.entity.id);
  }

  status() {
    const bot = this.owner.bot;
    return {
      ok: true,
      mode: this.mode,
      target: this.target,
      autoCombat: this.autoCombat,
      manualAttackEntity: this.manualAttackEntity,
      nearbyEntities: this.nearbyEntities(bot),
      task: this.task,
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      tps: this.tpsSamples.length ? Math.round(this.tpsSamples.reduce((sum, value) => sum + value, 0) / this.tpsSamples.length) : null,
      gameMode: bot?.game?.gameMode ?? null,
      authenticated: this.authReady,
    };
  }

  tick(bot) {
    const age = bot.time?.age;
    if (Number.isFinite(age) && this.lastTimeAge !== null) {
      this.tpsSamples.push(Math.max(0, Math.min(20, age - this.lastTimeAge)));
      if (this.tpsSamples.length > 20) this.tpsSamples.shift();
    }
    this.lastTimeAge = Number.isFinite(age) ? age : null;
    if (bot !== this.owner.bot || this.owner.status !== 'online' || !this.authReady || this.task) return;
    if (this.manualAttackEntity !== null) {
      const entity = bot.entities?.[this.manualAttackEntity];
      const attacking = !('target' in bot.pvp) || bot.pvp.target === entity;
      if (entity && entity.isValid !== false && attacking &&
          (!bot.game?.gameMode || bot.game.gameMode === 'survival') && Date.now() < this.manualAttackUntil) return;
      const restoreMode = this.manualRestoreMode;
      this.stopMovement(bot);
      if (restoreMode && (!bot.game?.gameMode || bot.game.gameMode === 'survival')) {
        bot.chat(`/gamemode ${restoreMode}`);
      }
    }
    if (this.mode === 'idle') return;
    if (bot.game?.gameMode && bot.game.gameMode !== 'survival') {
      if (!this.spectatorWarned) {
        this.owner.log('warn', '自主行为需要 survival 游戏模式及 /gamemode 权限');
        this.spectatorWarned = true;
      }
      return;
    }
    this.spectatorWarned = false;
    if (this.mode === 'auto' && typeof bot.food === 'number' && bot.food < 17) {
      const food = this.preferredFood(bot);
      if (food) {
        this.eat(food.name).catch(error => this.owner.log('warn', `自动进食失败: ${error.message}`));
        return;
      }
    }
    if (this.mode === 'auto' && this.autoCombat) {
      const mob = bot.nearestEntity(entity => entity.type === 'hostile' && entity.position &&
        bot.entity.position.distanceTo(entity.position) <= 8);
      if (mob) {
        if (this.attackedEntity !== mob.id) {
          const sword = bot.inventory?.items().filter(item => item.name.endsWith('_sword'))
            .sort((a, b) => SWORD_RANK.indexOf(b.name.replace('_sword', '')) - SWORD_RANK.indexOf(a.name.replace('_sword', '')))[0];
          if (sword) bot.equip(sword, 'hand').catch(error => this.owner.log('warn', `装备剑失败: ${error.message}`));
          bot.pvp.attack(mob);
          this.attackedEntity = mob.id;
          this.followedEntity = null;
        }
        return;
      }
    }
    if (this.attackedEntity) this.stopMovement(bot);
    const entry = Object.entries(bot.players || {}).find(([name]) => name.toLowerCase() === this.target.toLowerCase());
    const player = entry?.[1];
    if (player && (!player.entity || bot.entity.position.distanceTo(player.entity.position) >= 16)) {
      if (this.followedEntity) this.stopMovement(bot);
      if (Date.now() - this.lastCatchupAt >= 15000) {
        bot.chat(`/tp ${bot.username} ${entry[0]}`);
        this.lastCatchupAt = Date.now();
        this.owner.log('sys', `跟随目标超出视野，已请求传送到 ${entry[0]}`);
      }
      return;
    }
    if (!player?.entity) {
      if (this.followedEntity) this.stopMovement(bot);
      return;
    }
    if (this.followedEntity !== player.entity.id) {
      bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2.5), true);
      this.followedEntity = player.entity.id;
    }
  }

  async runTask(name, operation) {
    const bot = this.online();
    if (this.task) throw new Error(`正在执行 ${this.task}，请稍后再试`);
    this.stopMovement(bot);
    this.task = name;
    const serial = ++this.taskSerial;
    const check = () => {
      if (serial !== this.taskSerial || bot !== this.owner.bot || this.owner.status !== 'online') {
        throw new Error('任务已取消或机器人已断线');
      }
    };
    try {
      if (bot.game?.gameMode !== 'survival') {
        bot.chat('/gamemode survival');
        await new Promise(resolve => setTimeout(resolve, 1500));
        check();
        if (bot.game?.gameMode && bot.game.gameMode !== 'survival') {
          throw new Error('执行此任务需要 survival 游戏模式和 /gamemode 权限');
        }
      }
      const result = await operation(bot, check);
      check();
      return result;
    } finally {
      if (serial === this.taskSerial) {
        this.task = null;
        this.stopMovement(bot);
        if (this.mode === 'idle' && config.restingMode && bot.game?.gameMode !== config.restingMode) {
          bot.chat(`/gamemode ${config.restingMode}`);
        }
      }
    }
  }

  async collect(blockName, count = 1) {
    if (!/^[a-z0-9_]+$/.test(blockName)) throw new Error('方块名无效');
    if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('数量须为 1 到 16');
    return this.runTask('collect', async (bot, check) => {
      const blockType = minecraftData(bot.version).blocksByName[blockName];
      if (!blockType) throw new Error(`当前版本没有方块 ${blockName}`);
      const positions = bot.findBlocks({ matching: blockType.id, maxDistance: 16, count });
      if (!positions.length) throw new Error('附近没有找到这种方块');
      const blocks = positions.map(position => bot.blockAt(position)).filter(Boolean);
      check();
      await bot.collectBlock.collect(blocks);
      check();
      return { ok: true, block: blockName, count: blocks.length };
    });
  }

  async sleep() {
    return this.runTask('sleep', async (bot, check) => {
      const beds = Object.values(minecraftData(bot.version).blocksByName).filter(block => block.name.endsWith('_bed'));
      const bed = bot.findBlock({ matching: beds.map(block => block.id), maxDistance: 16 });
      if (!bed) throw new Error('附近找不到床');
      await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1));
      check();
      await bot.sleep(bot.blockAt(bed.position));
      return { ok: true, sleeping: true };
    });
  }

  inventory() {
    const bot = this.online();
    return {
      ok: true,
      food: bot.food ?? null,
      heldItem: bot.heldItem?.name ?? null,
      items: bot.inventory.items().map(item => ({ name: item.name, count: item.count, slot: item.slot })),
    };
  }

  entities(radius = 16) {
    const bot = this.online();
    if (!Number.isInteger(radius) || radius < 1 || radius > 32) throw new Error('查询半径须为 1 到 32');
    return {
      ok: true,
      entities: Object.values(bot.entities || {})
        .filter(entity => entity !== bot.entity && entity?.position)
        .map(entity => ({
          id: entity.id,
          name: entity.username || entity.displayName || entity.name || entity.type || 'unknown',
          type: entity.type || 'unknown',
          distance: bot.entity.position.distanceTo(entity.position),
        }))
        .filter(entity => Number.isInteger(entity.id) && Number.isFinite(entity.distance) && entity.distance <= radius)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 50)
        .map(entity => ({ ...entity, distance: +entity.distance.toFixed(1) })),
    };
  }

  modes() {
    const bot = this.online();
    return { ok: true, mode: this.mode, target: this.target, autoCombat: this.autoCombat,
      gameMode: bot.game?.gameMode ?? null, available: [...MODES] };
  }

  nearbyBlocks(blockName, radius = 8) {
    const bot = this.online();
    itemNameOrThrow(blockName);
    if (!Number.isInteger(radius) || radius < 1 || radius > 16) throw new Error('查询半径须为 1 到 16');
    const data = minecraftData(bot.version).blocksByName[blockName];
    if (!data) throw new Error(`当前版本没有方块 ${blockName}`);
    const positions = bot.findBlocks({ matching: data.id, maxDistance: radius, count: 20 });
    return { ok: true, block: blockName, positions: positions.map(({ x, y, z }) => ({ x, y, z })) };
  }

  craftable(itemName, count = 1) {
    const bot = this.online();
    itemNameOrThrow(itemName);
    countOrThrow(count, 64);
    const data = minecraftData(bot.version);
    const item = data.itemsByName[itemName];
    if (!item) throw new Error(`当前版本没有物品 ${itemName}`);
    const tableType = data.blocksByName.crafting_table?.id;
    const table = tableType == null ? null : bot.findBlock({ matching: tableType, maxDistance: 6 });
    const recipes = bot.recipesFor(item.id, null, count, table);
    return { ok: true, item: itemName, count, craftable: recipes.length > 0,
      recipes: recipes.slice(0, 5).map(recipe => ({ resultCount: recipe.result.count, requiresTable: !!recipe.requiresTable })),
      craftingTableNearby: !!table };
  }

  async eat(itemName = '') {
    if (itemName && (typeof itemName !== 'string' || !ITEM_NAME.test(itemName))) throw new Error('物品名无效');
    return this.runTask('eat', async (bot, check) => {
      const item = itemName
        ? bot.inventory.items().find(candidate => candidate.name === itemName)
        : this.preferredFood(bot);
      if (!item) throw new Error(itemName ? `背包里没有 ${itemName}` : '背包里没有可自动食用的食物');
      await bot.equip(item, 'hand');
      check();
      await bot.consume();
      return { ok: true, item: item.name, food: bot.food ?? null };
    });
  }

  async equipItem(itemName, destination = 'hand') {
    if (typeof itemName !== 'string' || !ITEM_NAME.test(itemName)) throw new Error('物品名无效');
    if (!['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(destination)) {
      throw new Error('装备位置无效');
    }
    return this.runTask('equip', async (bot, check) => {
      const item = bot.inventory.items().find(candidate => candidate.name === itemName);
      if (!item) throw new Error(`背包里没有 ${itemName}`);
      await bot.equip(item, destination);
      check();
      return { ok: true, item: itemName, destination };
    });
  }

  async discard(itemName, count = 1) {
    itemNameOrThrow(itemName);
    countOrThrow(count);
    return this.runTask('discard', async (bot, check) => {
      const stacks = bot.inventory.items().filter(item => item.name === itemName);
      const available = stacks.reduce((sum, item) => sum + item.count, 0);
      if (available < count) throw new Error(`背包中 ${itemName} 不足 ${count} 个`);
      check();
      await bot.toss(stacks[0].type, null, count);
      return { ok: true, item: itemName, count };
    });
  }

  async givePlayer(username, itemName, count = 1) {
    if (typeof username !== 'string' || !PLAYER_NAME.test(username)) throw new Error('玩家名无效');
    itemNameOrThrow(itemName);
    countOrThrow(count);
    return this.runTask('give_player', async (bot, check) => {
      const entry = Object.entries(bot.players || {}).find(([name]) => name.toLowerCase() === username.toLowerCase());
      const entity = entry?.[1]?.entity;
      if (!entity || bot.entity.position.distanceTo(entity.position) > 16) throw new Error('玩家不在 16 格内');
      const stacks = bot.inventory.items().filter(item => item.name === itemName);
      if (stacks.reduce((sum, item) => sum + item.count, 0) < count) throw new Error(`背包中 ${itemName} 不足 ${count} 个`);
      await bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
      check();
      if (bot.entity.position.distanceTo(entity.position) > 4) throw new Error('玩家已离开交付范围');
      await bot.toss(stacks[0].type, null, count);
      return { ok: true, player: entry[0], item: itemName, count, droppedNearPlayer: true };
    });
  }

  async craftRecipe(itemName, count = 1) {
    itemNameOrThrow(itemName);
    countOrThrow(count, 16);
    return this.runTask('craft', async (bot, check) => {
      const data = minecraftData(bot.version);
      const item = data.itemsByName[itemName];
      if (!item) throw new Error(`当前版本没有物品 ${itemName}`);
      const tableType = data.blocksByName.crafting_table?.id;
      const table = tableType == null ? null : bot.findBlock({ matching: tableType, maxDistance: 6 });
      const recipe = bot.recipesFor(item.id, null, count, table)[0];
      if (!recipe) throw new Error(`材料不足或附近没有合成台，无法合成 ${itemName}`);
      if (recipe.requiresTable) {
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
        check();
      }
      const times = Math.ceil(count / recipe.result.count);
      await bot.craft(recipe, times, recipe.requiresTable ? table : null);
      return { ok: true, item: itemName, count: times * recipe.result.count, usedTable: !!recipe.requiresTable };
    });
  }

  async placeHere(itemName, x, y, z) {
    itemNameOrThrow(itemName);
    const coords = [x, y, z];
    if (!coords.every(Number.isInteger)) throw new Error('放置坐标须为整数');
    return this.runTask('place_block', async (bot, check) => {
      const target = new Vec3(x, y, z);
      if (bot.entity.position.distanceTo(target) > 4.5) throw new Error('放置位置超出 4.5 格交互范围');
      if (!minecraftData(bot.version).blocksByName[itemName]) throw new Error(`${itemName} 不是当前版本的方块`);
      const item = bot.inventory.items().find(candidate => candidate.name === itemName);
      if (!item) throw new Error(`背包里没有 ${itemName}`);
      const current = bot.blockAt(target);
      if (!current || !AIR_BLOCKS.has(current.name)) throw new Error('目标位置不是空气方块');
      const faces = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)];
      const support = faces.map(face => ({ face, block: bot.blockAt(target.minus(face)) }))
        .find(({ block }) => block && !AIR_BLOCKS.has(block.name));
      if (!support) throw new Error('目标位置旁没有可依附的方块');
      await bot.equip(item, 'hand');
      check();
      await bot.placeBlock(support.block, support.face);
      return { ok: true, block: itemName, position: { x, y, z } };
    });
  }

  async useOnEntity(entityId, itemName = '') {
    if (itemName) itemNameOrThrow(itemName);
    if (!Number.isSafeInteger(entityId)) throw new Error('实体 ID 无效');
    return this.runTask('use_on_entity', async (bot, check) => {
      const entity = bot.entities?.[entityId];
      if (!entity?.position || bot.entity.position.distanceTo(entity.position) > 4.5) throw new Error('实体不在 4.5 格交互范围内');
      if (itemName) {
        const item = bot.inventory.items().find(candidate => candidate.name === itemName);
        if (!item) throw new Error(`背包里没有 ${itemName}`);
        await bot.equip(item, 'hand');
        check();
      }
      await bot.useOn(entity);
      return { ok: true, entityId, item: itemName || bot.heldItem?.name || null };
    });
  }

  async useOnBlock(x, y, z, itemName = '') {
    if (itemName) itemNameOrThrow(itemName);
    if (![x, y, z].every(Number.isInteger)) throw new Error('交互坐标须为整数');
    return this.runTask('use_on_block', async (bot, check) => {
      const position = new Vec3(x, y, z);
      if (bot.entity.position.distanceTo(position) > 4.5) throw new Error('方块不在 4.5 格交互范围内');
      const block = bot.blockAt(position);
      if (!block || AIR_BLOCKS.has(block.name)) throw new Error('目标位置没有方块');
      if (itemName) {
        const item = bot.inventory.items().find(candidate => candidate.name === itemName);
        if (!item) throw new Error(`背包里没有 ${itemName}`);
        await bot.equip(item, 'hand');
        check();
      }
      await bot.activateBlock(block);
      return { ok: true, block: block.name, position: { x, y, z }, item: itemName || bot.heldItem?.name || null };
    });
  }

  async withChest(name, operation) {
    return this.runTask(name, async (bot, check) => {
      const data = minecraftData(bot.version);
      const ids = ['chest', 'trapped_chest', 'barrel'].map(n => data.blocksByName[n]?.id).filter(Boolean);
      const block = bot.findBlock({ matching: ids, maxDistance: 16 });
      if (!block) throw new Error('附近找不到箱子或木桶');
      await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
      check();
      const chest = await bot.openContainer(bot.blockAt(block.position));
      try {
        check();
        return await operation(bot, chest, check);
      } finally {
        chest.close();
      }
    });
  }

  async store() {
    return this.withChest('store', async (bot, chest, check) => {
      let stored = 0;
      for (const item of bot.inventory.items()) {
        check();
        await chest.deposit(item.type, null, item.count);
        stored += item.count;
      }
      return { ok: true, stored };
    });
  }

  async putInChest(itemName, count = 1) {
    itemNameOrThrow(itemName);
    countOrThrow(count);
    return this.withChest('put_in_chest', async (bot, chest, check) => {
      const stacks = bot.inventory.items().filter(item => item.name === itemName);
      if (stacks.reduce((sum, item) => sum + item.count, 0) < count) throw new Error(`背包中 ${itemName} 不足 ${count} 个`);
      check();
      await chest.deposit(stacks[0].type, null, count);
      return { ok: true, item: itemName, count };
    });
  }

  async withFurnace(name, operation) {
    return this.runTask(name, async (bot, check) => {
      const blocks = minecraftData(bot.version).blocksByName;
      const ids = ['furnace', 'blast_furnace', 'smoker'].map(type => blocks[type]?.id).filter(id => id != null);
      const position = bot.findBlock({ matching: ids, maxDistance: 16 });
      if (!position) throw new Error('附近找不到熔炉、烟熏炉或高炉');
      await bot.pathfinder.goto(new goals.GoalNear(position.position.x, position.position.y, position.position.z, 2));
      check();
      const furnace = await bot.openFurnace(bot.blockAt(position.position));
      try {
        check();
        return await operation(bot, furnace, check);
      } finally {
        furnace.close();
      }
    });
  }

  async smeltItem(itemName, count = 1, fuelName = 'coal', fuelCount = 1) {
    itemNameOrThrow(itemName);
    itemNameOrThrow(fuelName);
    countOrThrow(count, 8);
    countOrThrow(fuelCount, 16);
    return this.withFurnace('smelt', async (bot, furnace, check) => {
      const items = bot.inventory.items();
      const input = items.find(item => item.name === itemName);
      const fuel = items.find(item => item.name === fuelName);
      const inputAvailable = items.filter(item => item.name === itemName).reduce((sum, item) => sum + item.count, 0);
      const fuelAvailable = items.filter(item => item.name === fuelName).reduce((sum, item) => sum + item.count, 0);
      if (inputAvailable < count) {
        throw new Error(`背包中 ${itemName} 不足 ${count} 个`);
      }
      if (fuelAvailable < fuelCount || (itemName === fuelName && inputAvailable < count + fuelCount)) {
        throw new Error(`背包中 ${fuelName} 不足 ${fuelCount} 个`);
      }
      if (furnace.inputItem() || furnace.fuelItem() || furnace.outputItem()) {
        throw new Error('熔炉已有物品，请先清理');
      }
      check();
      await furnace.putInput(input.type, null, count);
      check();
      await furnace.putFuel(fuel.type, null, fuelCount);
      const deadline = Date.now() + Math.min(95000, count * 11000 + 10000);
      while (Date.now() < deadline) {
        check();
        const output = furnace.outputItem();
        if (output && output.count >= count) {
          await furnace.takeOutput();
          return { ok: true, item: output.name, count: output.count, input: itemName,
            fuel: fuelName, fuelCount };
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const partial = furnace.outputItem();
      if (partial) {
        check();
        await furnace.takeOutput();
      }
      throw new Error(`熔炼超时：已取出 ${partial?.count || 0} 个产物；剩余材料可用清理熔炉工具取回`);
    });
  }

  async clearFurnace() {
    return this.withFurnace('clear_furnace', async (_bot, furnace, check) => {
      const taken = [];
      for (const [slot, getter, take] of [
        ['output', 'outputItem', 'takeOutput'],
        ['input', 'inputItem', 'takeInput'],
        ['fuel', 'fuelItem', 'takeFuel'],
      ]) {
        const item = furnace[getter]();
        if (!item) continue;
        check();
        await furnace[take]();
        taken.push({ slot, item: item.name, count: item.count });
      }
      return { ok: true, taken };
    });
  }

  async viewChest() {
    return this.withChest('view_chest', async (_bot, chest) => ({
      ok: true,
      items: chest.containerItems().map(item => ({ name: item.name, count: item.count })),
    }));
  }

  async takeFromChest(itemName, count = 1) {
    if (typeof itemName !== 'string' || !ITEM_NAME.test(itemName)) throw new Error('物品名无效');
    if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('数量须为 1 到 64');
    return this.withChest('take_from_chest', async (_bot, chest, check) => {
      const matches = chest.containerItems().filter(item => item.name === itemName);
      const available = matches.reduce((sum, item) => sum + item.count, 0);
      if (!available) throw new Error(`附近容器里没有 ${itemName}`);
      const taken = Math.min(count, available);
      check();
      await chest.withdraw(matches[0].type, null, taken);
      return { ok: true, item: itemName, count: taken };
    });
  }

  async fetch() {
    return this.withChest('fetch', async (_bot, chest, check) => {
      const items = chest.containerItems();
      const rank = name => SWORD_RANK.findIndex(material => name.startsWith(material + '_'));
      const best = suffix => items.filter(item => item.name.endsWith(suffix))
        .sort((a, b) => rank(b.name) - rank(a.name))[0];
      const chosen = [best('_sword'), best('_pickaxe'), best('_axe')];
      const food = AUTO_FOOD_PRIORITY.map(name => items.find(item => item.name === name)).find(Boolean);
      if (food) chosen.push(food);
      const fetched = [];
      for (const item of chosen.filter(Boolean)) {
        check();
        await chest.withdraw(item.type, null, item === food ? Math.min(item.count, 16) : 1);
        fetched.push(item.name);
      }
      return { ok: true, fetched };
    });
  }
}

module.exports = { BehaviorController };
