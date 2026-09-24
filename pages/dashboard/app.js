const bridge = window.AstrBotPluginPage;
const $ = id => document.getElementById(id);
const fmt = time => new Date(time).toLocaleTimeString('zh-CN', {hour12:false});

function rows(container, items, render) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '暂无记录'; container.append(empty); return;
  }
  for (const item of [...items].reverse()) {
    const line = document.createElement('div'); line.className = 'item';
    const time = document.createElement('time'); time.textContent = fmt(item.at || Date.now());
    const body = document.createElement('span'); body.textContent = render(item);
    line.append(time, body); container.append(line);
  }
}

async function refresh() {
  try {
    const data = await bridge.apiGet('status');
    const snap = data.snapshot || {}, bot = snap.bot || {}, server = snap.server || {}, player = snap.player || {}, world = snap.world || {};
    $('online').textContent = bot.online ? '● 在线' : `● ${bot.status || '离线'}`;
    $('online').classList.toggle('ok', !!bot.online);
    $('server').textContent = server.host ? `${server.host}:${server.port}` : '—';
    $('bot').textContent = bot.username || '—';
    $('position').textContent = player.position ? `${player.position.x}, ${player.position.y}, ${player.position.z} · ${player.dimension || '未知维度'}` : '—';
    $('players').textContent = (world.players || []).map(p => p.name).join('、') || '—';
    rows($('chat'), data.chat || [], item => item.text || '');
    rows($('logs'), data.logs || [], item => item.line || '');
  } catch (error) {
    $('online').textContent = '● 面板通信失败'; $('online').classList.remove('ok');
  }
}

async function post(endpoint, body, resultId) {
  $(resultId).textContent = '处理中…';
  try {
    const result = await bridge.apiPost(endpoint, body);
    $(resultId).textContent = result.ok === false ? (result.error || JSON.stringify(result))
      : result.actual ? `已完成，当前位置 ${JSON.stringify(result.actual)}`
      : result.topBlocks ? `扫描 ${result.scannedBlocks} 个方块，主要类型：${result.topBlocks.slice(0, 8).map(([name, count]) => `${name} ${count}`).join('、')}`
      : '已完成';
    await refresh();
  } catch (error) { $(resultId).textContent = error.message || String(error); }
}

$('say-form').addEventListener('submit', async event => {
  event.preventDefault();
  await post('say', {text:$('message').value, target:$('target').value.trim()}, 'say-result');
  if ($('say-result').textContent === '已完成') $('message').value = '';
});
$('look-form').addEventListener('submit', event => { event.preventDefault(); post('action', {action:'look_at_player',args:{username:$('look-player').value.trim()}}, 'action-result'); });
$('scan').addEventListener('click', () => post('action', {action:'scan',args:{radius:12}}, 'action-result'));
$('goto-form').addEventListener('submit', event => { event.preventDefault(); post('action', {action:'goto',args:{x:Number($('x').value),y:Number($('y').value),z:Number($('z').value)}}, 'action-result'); });
await bridge.ready();
await refresh();
setInterval(refresh, 5000);
