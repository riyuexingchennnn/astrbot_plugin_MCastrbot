// Fairy Minecraft 连接层：登录、重连、状态采集、聊天和受控行为。
const mineflayer = require('mineflayer');
const EventEmitter = require('events');
const config = require('./config');

// 把可能抛异常的状态读取包起来。26.1.2 协议下 mineflayer 的部分字段
// （health / food）解析不完整，会返回 undefined，这里统一兜底。
function safe(fn, fallback = null) {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

class FairyBot extends EventEmitter {
  constructor() {
    super();
    this.bot = null;
    this.startedAt = Date.now();
    this.reconnectCount = 0;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.chatLog = [];
    this.status = 'starting'; // starting | connecting | online | reconnecting | stopped
    this.lastError = null;
    this.lastKick = null;
    this.lastDisconnect = null;
    this.onlineSince = null;
    this.connectingSince = null;
    this.totalOnlineMs = 0;
    this.observedPlayers = new Set();
    this.stopping = false;
    this.recentConversations = new Map();
  }

  start() {
    this.connect();
    return this;
  }

  connect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.status = this.reconnectCount === 0 ? 'connecting' : 'reconnecting';
    this.connectingSince = Date.now();

    const opt = {
      host: config.server.host,
      port: config.server.port,
      username: config.bot.username,
      auth: config.bot.auth,
      version: config.bot.version,
      viewDistance: config.bot.viewDistance,
      // 关掉不必要的特性以降低开销
      hideErrors: true,
    };

    this.log('sys', `正在连接 ${config.server.host}:${config.server.port} 用户=${config.bot.username} 版本=${config.bot.version}`);

    let bot;
    try {
      bot = mineflayer.createBot(opt);
    } catch (e) {
      this.lastError = `createBot 失败: ${e.message}`;
      this.log('error', this.lastError);
      this.scheduleReconnect();
      return;
    }
    this.bot = bot;
    this.wire(bot);
  }

  wire(bot) {
    bot.on('login', () => {
      this.log('sys', '握手完成，已通过登录校验');
    });

    bot.on('spawn', () => {
      const first = this.status !== 'online';
      this.status = 'online';
      this.onlineSince = Date.now();
      if (first) {
        this.reconnectCount = 0; // 连上就重置退避
        this.log('sys', '已进入世界');
      }
      this.ensureKeepAlive();
      this.ensureViewer();
      this.ensureLogin();
    });

    bot.on('end', (reason) => {
      this.status = 'stopped';
      this.lastDisconnect = reason || '未知原因';
      if (this.onlineSince) {
        this.totalOnlineMs += Date.now() - this.onlineSince;
        this.onlineSince = null;
      }
      this.stopKeepAlive();
      this.teardownLogin();
      // 关键：渲染器绑在具体的 bot 实例上。实例一死，它还连着旧连接，
      // 新区块永远送不到浏览器。必须关掉并允许重连后重新挂载。
      this.teardownViewer();
      this.log('sys', `连接结束: ${this.lastDisconnect}`);
      if (!this.stopping) this.scheduleReconnect();
    });

    bot.on('kicked', (reason) => {
      this.lastKick = safe(() => JSON.stringify(reason), String(reason));
      this.log('warn', `被服务器踢出: ${this.lastKick}`);
    });

    bot.on('error', (err) => {
      this.lastError = err?.message || String(err);
      this.log('error', `错误: ${this.lastError}`);
    });

    bot.on('message', (jsonMsg) => {
      const text = safe(() => jsonMsg.toString(), '');
      if (!text || !text.trim()) return;
      this.pushChat('server', text.trim());
    });

    bot.on('chat', (username, message) => {
      this.receiveConversation('public', username, message);
    });

    bot.on('whisper', (username, message) => {
      this.receiveConversation('tell', username, message);
    });

    bot.on('playerJoined', (player) => {
      const name = safe(() => player.username, '未知');
      this.observedPlayers.add(name);
      this.pushChat('join', `${name} 加入了游戏`);
    });

    bot.on('playerLeft', (player) => {
      const name = safe(() => player.username, '未知');
      this.pushChat('leave', `${name} 离开了游戏`);
    });

    bot.on('death', () => {
      this.log('warn', '机器人被击杀，等待重生');
    });

    bot.on('health', () => {
      // 26.1.2 下 health 可能为 undefined，这里只是触发状态刷新
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectCount += 1;
    const delay = Math.min(
      config.reconnect.baseDelayMs * Math.pow(config.reconnect.factor, this.reconnectCount - 1),
      config.reconnect.maxDelayMs
    );
    const secs = Math.round(delay / 1000);
    this.status = 'reconnecting';
    this.log('sys', `将在 ${secs} 秒后重连（第 ${this.reconnectCount} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  ensureKeepAlive() {
    if (!config.keepAlive.enabled) return;
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {
      const bot = this.bot;
      if (!bot || !bot.entity) return;
      try {
        // 只做视角微动，不移动位置，避免掉进坑里或触发物理异常
        bot.look(bot.entity.yaw + 0.05, bot.entity.pitch, true).catch(() => {});
      } catch (e) {
        // 忽略：保活失败不该影响主流程
      }
    }, config.keepAlive.intervalMs);
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  // ---- 登录模组（loginsystem）自动登录 ----
  // 服务器装了 loginsystem，未登录的玩家会被丢进等待区并失明。
  // 这里在 spawn 之后自动发 /login；若服务端提示未注册，则改发 /register。
  ensureLogin() {
    if (!config.login.enabled) return;
    const pw = config.login.password;
    const bot = this.bot;
    if (!bot) return;

    this.teardownLogin();

    let done = false;
    let tries = 0;

    const onMsg = (text) => {
      if (!text) return;
      if (/注册成功|登录成功|已经登录/.test(text)) {
        done = true;
        this.log('sys', '登录模组：已通过');
        // 登录通过之后再切模式，否则服务器会拒绝指令
        this.applyRestingMode();
        this.teardownLogin();
      } else if (/未注册|请先注册|not registered/i.test(text)) {
        this.log('sys', '登录模组：未注册，改发注册指令');
        safe(() => bot.chat(`/register ${pw} ${pw}`));
      } else if (/密码错误|incorrect password/i.test(text)) {
        this.log('warn', '登录模组：密码错误，已停止重试');
        done = true;
        this.teardownLogin();
      }
    };

    const tick = () => {
      this.loginTimer = null;
      if (done) return;
      if (tries >= config.login.retries) {
        this.log('warn', '登录模组：重试次数用尽，仍未确认登录');
        // 未确认登录时不要发需要权限的指令。
        this.teardownLogin();
        return;
      }
      tries += 1;
      safe(() => bot.chat(`/login ${pw}`));
      this.loginTimer = setTimeout(tick, config.login.retryDelayMs);
    };

    this.loginMsgHandler = onMsg;
    bot.on('messagestr', onMsg);
    this.loginTimer = setTimeout(tick, config.login.delayMs);
  }

  teardownLogin() {
    if (this.loginTimer) {
      clearTimeout(this.loginTimer);
      this.loginTimer = null;
    }
    if (this.loginMsgHandler && this.bot) {
      safe(() => this.bot.removeListener('messagestr', this.loginMsgHandler));
    }
    this.loginMsgHandler = null;
  }

  // 切到常驻模式。观察者模式下机器人不占睡觉人数，也不参与实体碰撞，
  // 挂机时对服务器的干扰最小。登录成功之后调用。
  applyRestingMode() {
    const mode = config.restingMode;
    if (!mode) return;
    setTimeout(() => {
      const bot = this.bot;
      if (!bot || !bot.entity) return;
      safe(() => bot.chat(`/gamemode ${mode}`));
      this.log('sys', `已请求切换到 ${mode} 模式`);
    }, 1500);
  }

  pushChat(kind, text) {
    const item = { at: Date.now(), kind, text: text.slice(0, 300) };
    this.chatLog.push(item);
    if (this.chatLog.length > config.chatHistoryLimit) {
      this.chatLog.splice(0, this.chatLog.length - config.chatHistoryLimit);
    }
    this.emit('chat', item);
  }

  receiveConversation(channel, username, message) {
    if (!['public', 'tell'].includes(channel) || !username || username.toLowerCase() === config.bot.username.toLowerCase() || !message?.trim()) return;
    // 仅接受当前在线玩家，避免 <Server> 一类系统广播进入对话流水线。
    if (!Object.keys(this.bot?.players || {}).some(
      name => name.toLowerCase() === username.toLowerCase()
    )) return;
    const body = message.trim().slice(0, 500);
    const key = `${channel}|${username.toLowerCase()}|${body}`;
    const now = Date.now();
    if (now - (this.recentConversations.get(key) || 0) < 1500) return;
    this.recentConversations.set(key, now);
    if (this.recentConversations.size > 200) {
      for (const [k, t] of this.recentConversations) {
        if (now - t > 3000) this.recentConversations.delete(k);
      }
    }
    const item = { at: now, channel, username, text: body };
    this.emit('conversation', item);
  }

  sendChat(text, target = null) {
    if (this.status !== 'online' || !this.bot) throw new Error('MC 机器人不在线');
    const clean = String(text).replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
    if (!clean) throw new Error('消息为空');
    if (target && !/^[A-Za-z0-9_]{1,16}$/.test(target)) throw new Error('玩家名无效');
    if (!target && clean.startsWith('/')) throw new Error('不允许发送命令');
    const line = target ? `/msg ${target} ${clean}` : clean;
    if (line.length > 240) throw new Error('消息或私聊指令超过 240 字符');
    this.bot.chat(line);
    this.pushChat('outgoing', target ? `[to ${target}] ${clean}` : clean);
  }

  async lookAtPlayer(username) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new Error('玩家名无效');
    const entity = this.bot?.players?.[username]?.entity;
    if (this.status !== 'online' || !entity) throw new Error('玩家不在机器人视野内');
    await this.bot.lookAt(entity.position.offset(0, 1.6, 0), true);
    return { ok: true, username };
  }

  log(level, text) {
    const line = `[${level}] ${text}`;
    this.emit('log', line);
  }

  // Web 面板消费的状态快照
  snapshot() {
    const bot = this.bot;
    const online = this.status === 'online';
    const now = Date.now();

    let players = [];
    if (bot && bot.players) {
      for (const [name, p] of Object.entries(bot.players)) {
        players.push({
          name,
          uuid: safe(() => p.uuid, null),
          ping: safe(() => p.ping, null),
          isSelf: name === config.bot.username,
        });
      }
    }

    const pos = bot && bot.entity ? safe(() => bot.entity.position, null) : null;

    return {
      generatedAt: now,
      bot: {
        username: config.bot.username,
        version: bot?.version || config.bot.version || '自动',
        status: this.status,
        online,
        onlineDurationMs: online && this.onlineSince ? now - this.onlineSince : 0,
        totalOnlineMs: this.totalOnlineMs + (online && this.onlineSince ? now - this.onlineSince : 0),
        processUptimeMs: now - this.startedAt,
        reconnectCount: this.reconnectCount,
        lastError: this.lastError,
        lastKick: this.lastKick,
        lastDisconnect: this.lastDisconnect,
      },
      server: {
        host: config.server.host,
        port: config.server.port,
      },
      player: {
        uuid: safe(() => bot.player.uuid, null),
        position: pos
          ? { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2) }
          : null,
        dimension: safe(() => bot.game.dimension, null),
        gameMode: safe(() => bot.game.gameMode, null),
        // 26.1.2 协议下这两个字段可能缺失，面板会显示为「协议不支持」
        health: safe(() => bot.health, null),
        food: safe(() => bot.food, null),
        experienceLevel: safe(() => bot.experience?.level, null),
        timeOfDay: safe(() => bot.time.timeOfDay, null),
        isRaining: safe(() => bot.isRaining, null),
      },
      world: {
        playerCount: players.length,
        players,
        entityCount: bot && bot.entities ? Object.keys(bot.entities).length : 0,
      },
      chat: this.chatLog.slice(-40).reverse(),
    };
  }

  // 传送到指定坐标。机器人是 op 且已被模组豁免，可直接发指令
  async goto(x, y, z) {
    const bot = this.bot;
    if (!bot || this.status !== 'online') {
      return { ok: false, error: '机器人当前不在线' };
    }
    try {
      bot.chat(`/tp ${config.bot.username} ${x} ${y} ${z}`);
      await new Promise(r => setTimeout(r, 3000));
      const pos = safe(() => bot.entity.position, null);
      return {
        ok: true,
        target: { x, y, z },
        actual: pos ? { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) } : null,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 扫描周围方块。目的：识别玩家建造痕迹与自然结构
  scan(radius = 16) {
    const bot = this.bot;
    if (!bot || this.status !== 'online' || !bot.entity) {
      return { ok: false, error: '机器人当前不在线' };
    }
    const center = bot.entity.position;
    const hist = {};          // 方块名 -> 数量
    const types = new Set();  // 出现的方块种类集合
    let scanned = 0;
    const py = Math.floor(center.y);

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const p = center.offset(dx, dy, dz);
          let b;
          try {
            b = bot.blockAt(p);
          } catch (e) { continue; }
          if (!b || !b.name || b.name === 'air') continue;
          scanned++;
          hist[b.name] = (hist[b.name] || 0) + 1;
          types.add(b.name);
        }
      }
    }

    // 玩家建造痕迹特征方块
    const BUILD_MARKERS = {
      容器: ['chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest'],
      工作站: ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'enchanting_table',
        'brewing_stand', 'cauldron', 'grindstone', 'smithing_table', 'stonecutter', 'loom',
        'cartography_table', 'fletching_table', 'composter', 'lectern', 'beacon', 'conduit'],
      光源: ['torch', 'wall_torch', 'lantern', 'soul_lantern', 'soul_torch', 'campfire',
        'soul_campfire', 'glowstone', 'sea_lantern', 'shroomlight', 'end_rod', 'redstone_lamp'],
      建材: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
        'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks',
        'warped_planks', 'stone_bricks', 'bricks', 'glass', 'glass_pane', 'white_wool', 'cobblestone'],
      农业: ['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem',
        'sugar_cane', 'water'],
      装饰: ['flower_pot', 'painting', 'item_frame', 'banner', 'white_banner', 'bed',
        'white_bed', 'red_bed', 'sign', 'oak_sign', 'bookshelf', 'jukebox', 'note_block'],
      红石: ['redstone_wire', 'repeater', 'comparator', 'piston', 'sticky_piston', 'observer',
        'hopper', 'dropper', 'dispenser', 'lever', 'stone_button', 'rail', 'powered_rail'],
      传送: ['nether_portal', 'end_portal', 'obsidian', 'respawn_anchor', 'lodestone'],
    };

    const found = {};
    for (const [cat, names] of Object.entries(BUILD_MARKERS)) {
      const hits = {};
      for (const n of names) {
        for (const [k, v] of Object.entries(hist)) {
          if (k === n || k.endsWith('_' + n) || k.startsWith(n + '_')) {
            hits[k] = (hits[k] || 0) + v;
          }
        }
      }
      if (Object.keys(hits).length) found[cat] = hits;
    }

    const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 40);

    return {
      ok: true,
      position: { x: +center.x.toFixed(1), y: +center.y.toFixed(1), z: +center.z.toFixed(1) },
      dimension: safe(() => bot.game.dimension, null),
      radius,
      scannedBlocks: scanned,
      distinctTypes: types.size,
      topBlocks: top.map(([name, count]) => ({ name, count })),
      buildMarkers: found,
    };
  }

  // 读取周围容器内容。
  // 观察者模式无法开箱，因此临时切创造模式，读完立刻切回。
  async readContainers(radius = 24) {
    const bot = this.bot;
    if (!bot || this.status !== 'online' || !bot.entity) {
      return { ok: false, error: '机器人当前不在线' };
    }

    const mcData = require('minecraft-data')(bot.version);
    const CONTAINERS = ['chest', 'trapped_chest', 'barrel', 'shulker_box',
      'hopper', 'dispenser', 'dropper', 'furnace', 'blast_furnace', 'smoker', 'brewing_stand'];

    const ids = [];
    for (const n of CONTAINERS) {
      if (mcData.blocksByName[n]) ids.push(mcData.blocksByName[n].id);
    }
    // 各种颜色的潜影盒
    for (const n of Object.keys(mcData.blocksByName)) {
      if (n.endsWith('_shulker_box') && !ids.includes(mcData.blocksByName[n].id)) {
        ids.push(mcData.blocksByName[n].id);
      }
    }

    const origin = this.status;
    const results = [];
    let switched = false;

    try {
      // 切创造模式
      bot.chat('/gamemode creative');
      switched = true;
      await new Promise(r => setTimeout(r, 1500));

      const positions = bot.findBlocks({
        matching: ids,
        maxDistance: radius,
        count: 200,
      });

      this.log('sys', `找到 ${positions.length} 个容器方块，开始逐个读取`);

      for (const p of positions) {
        const block = bot.blockAt(p);
        if (!block) continue;
        let win = null;
        try {
          // 开箱有距离限制，先传送到箱子正上方
          bot.chat(`/tp ${config.bot.username} ${p.x + 0.5} ${p.y + 1} ${p.z + 0.5}`);
          await new Promise(r => setTimeout(r, 900));

          const b2 = bot.blockAt(p);
          if (!b2) { results.push({ type: block.name, x: p.x, y: p.y, z: p.z, error: '传送后区块未就绪' }); continue; }

          win = await bot.openContainer(b2);
          await new Promise(r => setTimeout(r, 350));
          const items = win.containerItems();
          const agg = {};
          for (const it of items) {
            const key = it.name;
            if (!agg[key]) agg[key] = { name: key, count: 0, displayName: it.displayName || null, ench: 0 };
            agg[key].count += it.count;
            if (it.enchants && Object.keys(it.enchants).length) agg[key].ench = Object.keys(it.enchants).length;
          }
          results.push({
            type: block.name,
            x: p.x, y: p.y, z: p.z,
            kinds: Object.keys(agg).length,
            totalItems: items.reduce((s, i) => s + i.count, 0),
            items: Object.values(agg).sort((a, b) => b.count - a.count),
          });
        } catch (e) {
          results.push({ type: block.name, x: p.x, y: p.y, z: p.z, error: e.message });
        } finally {
          try { if (win) win.close(); } catch (e) { /* 忽略 */ }
          await new Promise(r => setTimeout(r, 150));
        }
      }
    } catch (e) {
      this.log('error', `读取容器失败: ${e.message}`);
      return { ok: false, error: e.message, partial: results };
    } finally {
      // 无论成败都切回观察者
      if (switched) {
        try {
          bot.chat('/gamemode spectator');
          await new Promise(r => setTimeout(r, 1200));
        } catch (e) { /* 忽略 */ }
      }
    }

    const pos = safe(() => bot.entity.position, null);
    return {
      ok: true,
      position: pos ? { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) } : null,
      dimension: safe(() => bot.game.dimension, null),
      radius,
      containerCount: results.length,
      containers: results,
      restoredMode: safe(() => bot.game.gameMode, null),
    };
  }

  // 探测某一竖列的地表，用于选址
  column(x, z, y0 = 60, y1 = 140) {
    const bot = this.bot;
    if (!bot || this.status !== 'online' || !bot.entity) {
      return { ok: false, error: '机器人当前不在线' };
    }
    const { Vec3 } = require('vec3');
    const hits = [];
    for (let y = y1; y >= y0; y--) {
      let b;
      try { b = bot.blockAt(new Vec3(x, y, z)); } catch (e) { continue; }
      if (!b || !b.name) continue;
      if (['air', 'cave_air', 'void_air'].includes(b.name)) continue;
      hits.push({ y, name: b.name });
      if (hits.length >= 10) break;
    }
    return { ok: true, x, z, top: hits };
  }

  // 执行一条服务器指令，并回收服务器返回的消息
  async runCommand(cmd) {
    const bot = this.bot;
    if (!bot || this.status !== 'online') {
      return { ok: false, error: '机器人当前不在线' };
    }
    const line = cmd.startsWith('/') ? cmd : '/' + cmd;
    const captured = [];
    const onMsg = (msg) => captured.push(msg);
    bot.on('messagestr', onMsg);
    try {
      bot.chat(line);
      // 服务器回包有明显延迟，700ms 太短会把上一条的回复算到本条头上
      await new Promise(r => setTimeout(r, 1300));
    } catch (e) {
      bot.removeListener('messagestr', onMsg);
      return { ok: false, error: e.message, command: line };
    }
    bot.removeListener('messagestr', onMsg);
    return { ok: true, command: line, reply: captured.slice(-6) };
  }

  // 关闭并解绑渲染器，供重连时重新挂载
  teardownViewer() {
    const bot = this.bot;
    if (bot && bot.viewer && typeof bot.viewer.close === 'function') {
      try { bot.viewer.close(); } catch (e) { /* 忽略 */ }
    }
    this.viewerStarted = false;
  }

  // 挂载渲染器。只在首次进入世界时启动，之后复用。
  ensureViewer() {
    if (!config.viewer.enabled) return;
    if (this.viewerStarted) return;
    const bot = this.bot;
    if (!bot) return;
    try {
      const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
      this.viewerStarted = true;
      setTimeout(() => {
        try {
          mineflayerViewer(bot, {
            port: config.viewer.port,
            firstPerson: config.viewer.firstPerson,
            viewDistance: config.viewer.renderDistance,
          });
          this.log('sys', `渲染器已挂载，浏览器访问 http://<本机IP>:${config.viewer.port}`);
        } catch (e) {
          this.viewerStarted = false;
          this.log('error', `渲染器启动失败: ${e.message}`);
        }
      }, 2000);
    } catch (e) {
      this.log('error', `渲染器加载失败: ${e.message}（是否漏跑 scripts-restore-viewer.sh？）`);
    }
  }

  // 设定机位：先传送，再转向目标点
  async setCamera({ x, y, z, look, fly }) {
    const bot = this.bot;
    if (!bot || this.status !== 'online' || !bot.entity) {
      return { ok: false, error: '机器人当前不在线' };
    }
    const { Vec3 } = require('vec3');

    // 观察者/创造模式允许飞行。不打开飞行标志位的话，
    // 服务端会按重力把机器人拽到地面，空中机位就摆不成。
    const wantFly = fly !== false;
    if (wantFly && bot.creative && typeof bot.creative.startFlying === 'function') {
      try { await bot.creative.startFlying(); } catch (e) { /* 忽略 */ }
    }

    if ([x, y, z].every(v => typeof v === 'number')) {
      bot.chat(`/tp ${config.bot.username} ${x} ${y} ${z}`);
      await new Promise(r => setTimeout(r, 1300));
    }

    if (wantFly && bot.creative && typeof bot.creative.startFlying === 'function') {
      try { await bot.creative.startFlying(); } catch (e) { /* 忽略 */ }
      await new Promise(r => setTimeout(r, 500));
    }

    if (look && [look.x, look.y, look.z].every(v => typeof v === 'number')) {
      try {
        await bot.lookAt(new Vec3(look.x, look.y, look.z), true);
      } catch (e) { /* 忽略 */ }
      await new Promise(r => setTimeout(r, 400));
    }
    const p = safe(() => bot.entity.position, null);
    return {
      ok: true,
      position: p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } : null,
      yaw: safe(() => bot.entity.yaw, null),
      pitch: safe(() => bot.entity.pitch, null),
      flying: safe(() => bot.entity?.flying ?? bot.creative?.flying, null),
      viewerPort: config.viewer.enabled ? config.viewer.port : null,
    };
  }

  // 冻结/解冻物理。观察者模式下 mineflayer 仍会施加重力，
  // 导致机器人无法停在半空。拍照前冻结即可悬停。
  setPhysics(enabled) {
    const bot = this.bot;
    if (!bot || !bot.physics) return { ok: false, error: '物理模块不可用' };
    bot.physics.enabled = !!enabled;
    return { ok: true, physicsEnabled: bot.physics.enabled };
  }

  stop() {
    this.stopping = true;
    this.stopKeepAlive();
    this.teardownLogin();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.bot?.quit('服务停止');
    } catch (e) {
      // 忽略
    }
    this.status = 'stopped';
  }
}

module.exports = { FairyBot };
