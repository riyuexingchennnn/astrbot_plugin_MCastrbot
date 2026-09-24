const bridge = window.AstrBotPluginPage;
const $ = id => document.getElementById(id);
const statusMap = {
  online: '在线', connecting: '连接中', reconnecting: '重连中',
  stopped: '已断开', starting: '启动中', bridge_stopped: '桥接已断开',
  bridge_error: '桥接启动失败',
};

function fmtDur(ms) {
  if (!ms || ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  if (days) return `${days}天${hours}小时${minutes}分`;
  if (hours) return `${hours}小时${minutes}分${rest}秒`;
  if (minutes) return `${minutes}分${rest}秒`;
  return `${rest}秒`;
}

function fmtTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0')).join(':');
}

function txt(id, value) {
  $(id).textContent = value === null || value === undefined || value === '' ? '-' : String(value);
}

function emptyRow(list, message) {
  const row = document.createElement('li');
  row.className = 'muted';
  row.textContent = message;
  list.replaceChildren(row);
}

function appendRow(list, { time, body, kind = '', self = false }) {
  const row = document.createElement('li');
  if (kind) row.className = `kind-${kind}`;
  const clock = document.createElement('span');
  clock.className = 't';
  clock.textContent = time;
  const text = document.createElement('span');
  text.className = self ? 'txt self' : 'txt';
  text.textContent = body;
  row.append(clock, text);
  list.append(row);
}

function renderPlayers(players) {
  const list = $('players');
  list.replaceChildren();
  if (!players.length) return emptyRow(list, '当前无玩家');
  for (const player of players) {
    appendRow(list, {
      time: player.ping == null ? '-' : `${player.ping}ms`,
      body: `${player.name}${player.isSelf ? ' （本体）' : ''}`,
      self: !!player.isSelf,
    });
  }
}

function renderChat(chat) {
  const list = $('chat');
  list.replaceChildren();
  if (!chat.length) return emptyRow(list, '暂无消息');
  for (const item of chat) {
    appendRow(list, { time: fmtTime(item.at), body: item.text || '', kind: item.kind || '' });
  }
}

function renderLogs(logs) {
  const list = $('logs');
  list.replaceChildren();
  if (!logs.length) return emptyRow(list, '暂无日志');
  for (const item of [...logs].reverse()) {
    const match = String(item.line || '').match(/^\[(\w+)\]\s*(.*)$/);
    appendRow(list, {
      time: fmtTime(item.at),
      body: match ? match[2] : String(item.line || ''),
      kind: match ? match[1] : 'sys',
    });
  }
}

async function refresh() {
  try {
    const data = await bridge.apiGet('status');
    const snapshot = data.snapshot || {};
    const bot = snapshot.bot || {};
    const server = snapshot.server || {};
    const player = snapshot.player || {};
    const world = snapshot.world || {};
    const state = bot.status || 'stopped';
    const badge = $('badge');
    badge.className = `badge ${state === 'online' ? 'ok' : ['connecting', 'reconnecting', 'starting'].includes(state) ? 'warn' : 'bad'}`;
    txt('badgeText', statusMap[state] || state);

    txt('username', bot.username);
    txt('status', statusMap[state] || state);
    txt('onlineDur', fmtDur(bot.onlineDurationMs));
    txt('totalDur', fmtDur(bot.totalOnlineMs));
    txt('reconnect', bot.reconnectCount);
    txt('uptime', fmtDur(bot.processUptimeMs));

    const address = server.host ? `${server.host}:${server.port}` : '-';
    txt('addr', address);
    txt('target', address);
    txt('ver', bot.version);
    if (bot.username) $('pageTitle').textContent = `🎮 ${bot.username} 监控面板`;

    txt('pos', player.position ? `${player.position.x}, ${player.position.y}, ${player.position.z}` : '-');
    txt('dim', player.dimension);
    txt('mode', player.gameMode);
    txt('health', player.health == null ? '协议不支持' : `${player.health}/20`);
    txt('food', player.food == null ? '协议不支持' : `${player.food}/20`);
    txt('entities', world.entityCount);
    txt('pcount', world.playerCount);
    txt('tod', player.timeOfDay);
    txt('weather', player.isRaining == null ? '-' : player.isRaining ? '下雨' : '晴朗');

    txt('lastError', bot.lastError || '无');
    txt('lastKick', bot.lastKick || '无');
    txt('lastDisc', bot.lastDisconnect || '无');
    renderPlayers(world.players || []);
    renderChat(snapshot.chat || []);
    renderLogs(data.logs || []);
    txt('updated', `更新于 ${fmtTime(Date.now())}`);
  } catch (_) {
    $('badge').className = 'badge bad';
    txt('badgeText', '面板失联');
  }
}

await bridge.ready();
await refresh();
setInterval(refresh, 2000);
