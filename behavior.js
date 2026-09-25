// 自主行为与一次性任务。只通过 bridge.js 的白名单暴露给 AstrBot。
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const collectblock = require('mineflayer-collectblock').plugin;
const armorManager = require('mineflayer-armor-manager');
const minecraftData = require('minecraft-data');
const config = require('./config');

const MODES = new Set(['idle', 'auto', 'follow']);
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const SWORD_RANK = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
const MANUAL_ATTACK_MS = 30000;

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
    if (this.mode === 'auto' && typeof bot.food === 'number' && bot.food < 17 &&
        bot.inventory?.items().some(item => item.name === 'bread')) {
      this.eat().catch(error => this.owner.log('warn', `自动进食失败: ${error.message}`));
      return;
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

  async eat() {
    return this.runTask('eat', async (bot, check) => {
      const bread = bot.inventory.items().find(item => item.name === 'bread');
      if (!bread) throw new Error('背包里没有面包');
      await bot.equip(bread, 'hand');
      check();
      await bot.consume();
      return { ok: true, food: bot.food ?? null };
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

  async fetch() {
    return this.withChest('fetch', async (_bot, chest, check) => {
      const items = chest.containerItems();
      const rank = name => SWORD_RANK.findIndex(material => name.startsWith(material + '_'));
      const best = suffix => items.filter(item => item.name.endsWith(suffix))
        .sort((a, b) => rank(b.name) - rank(a.name))[0];
      const chosen = [best('_sword'), best('_pickaxe'), best('_axe')];
      const bread = items.find(item => item.name === 'bread');
      if (bread) chosen.push(bread);
      const fetched = [];
      for (const item of chosen.filter(Boolean)) {
        check();
        await chest.withdraw(item.type, null, item.name === 'bread' ? Math.min(item.count, 16) : 1);
        fetched.push(item.name);
      }
      return { ok: true, fetched };
    });
  }
}

module.exports = { BehaviorController };
