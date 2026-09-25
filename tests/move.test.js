const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function bridgeWithLimit(maxMoveDistance) {
  const replies = [];
  const moves = [];
  const actions = [];
  let onLine;
  class FakeBot {
    constructor() {
      this.bot = { entity: { position: { x: 10, y: 20, z: 30 } } };
      this.behavior = {
        status: () => ({ mode: 'idle' }),
        setMode: (mode, username) => { actions.push(['mode', mode, username]); return { mode }; },
        setAutoCombat: enabled => { actions.push(['combat', enabled]); return { autoCombat: enabled }; },
        attackEntity: id => { actions.push(['attack', id]); return { ok: true, entityId: id }; },
        collect: (block, count) => { actions.push(['collect', block, count]); return { ok: true }; },
        sleep: () => ({ ok: true }),
        inventory: () => { actions.push(['inventory']); return { ok: true, items: [] }; },
        eat: item => { actions.push(['eat', item]); return { ok: true }; },
        equipItem: (item, destination) => { actions.push(['equip', item, destination]); return { ok: true }; },
        viewChest: () => { actions.push(['view_chest']); return { ok: true, items: [] }; },
        takeFromChest: (item, count) => { actions.push(['take_from_chest', item, count]); return { ok: true }; },
        store: () => ({ ok: true }),
        fetch: () => ({ ok: true }),
      };
      for (const method of ['modes', 'entities', 'nearbyBlocks', 'craftable', 'attackPlayer',
        'craftRecipe', 'smeltItem', 'clearFurnace', 'placeHere', 'useOnEntity', 'useOnBlock',
        'givePlayer', 'discard', 'putInChest']) {
        this.behavior[method] = (...args) => { actions.push([method, ...args]); return { ok: true }; };
      }
    }
    on() {}
    start() {}
    goto(...coords) { moves.push(coords); return { ok: true }; }
    runCommand(text) { actions.push(['command', text]); return { ok: true }; }
  }
  const fakeProcess = {
    stdin: { on() {} },
    stdout: { write(line) { replies.push(JSON.parse(line)); } },
    on() {},
  };
  const code = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  vm.runInNewContext(code, {
    require(name) {
      if (name === 'readline') return { createInterface: () => ({ on: (_, callback) => { onLine = callback; } }) };
      if (name === './mc_bot') return { FairyBot: FakeBot };
      if (name === './config') return { maxMoveDistance };
      throw new Error(`意外依赖: ${name}`);
    },
    process: fakeProcess,
  });
  return { onLine, replies, moves, actions };
}

test('桥接 goto 受配置距离限制，并允许范围内移动', async () => {
  const bridge = bridgeWithLimit(32);
  await bridge.onLine(JSON.stringify({ id: 1, action: 'goto', args: { x: 43, y: 20, z: 30 } }));
  assert.match(bridge.replies[0].error, /超出 32 格/);
  assert.equal(bridge.moves.length, 0);
  await bridge.onLine(JSON.stringify({ id: 2, action: 'goto', args: { x: 42, y: 20, z: 30 } }));
  assert.equal(bridge.replies[1].data.ok, true);
  assert.equal(bridge.moves.length, 1);
  await bridge.onLine(JSON.stringify({ id: 3, action: 'goto', args: { x: null, y: 20, z: 30 } }));
  assert.match(bridge.replies[2].error, /坐标无效/);
});

test('桥接 goto 的独立硬上限为 512 格', async () => {
  const bridge = bridgeWithLimit(1000);
  await bridge.onLine(JSON.stringify({ id: 1, action: 'goto', args: { x: 523, y: 20, z: 30 } }));
  assert.match(bridge.replies[0].error, /超出 512 格/);
  assert.equal(bridge.moves.length, 0);
});

test('桥接行为工具路由到控制器并验证布尔参数', async () => {
  const bridge = bridgeWithLimit(32);
  await bridge.onLine(JSON.stringify({ id: 1, action: 'set_mode', args: { mode: 'auto', username: 'Alex' } }));
  await bridge.onLine(JSON.stringify({ id: 2, action: 'set_auto_combat', args: { enabled: false } }));
  await bridge.onLine(JSON.stringify({ id: 3, action: 'collect', args: { block: 'oak_log', count: 2 } }));
  await bridge.onLine(JSON.stringify({ id: 4, action: 'set_auto_combat', args: { enabled: 'false' } }));
  assert.deepEqual(bridge.actions, [['mode', 'auto', 'Alex'], ['combat', false], ['collect', 'oak_log', 2]]);
  assert.deepEqual(bridge.replies.slice(0, 3).map(reply => reply.data),
    [{ mode: 'auto' }, { autoCombat: false }, { ok: true }]);
  assert.match(bridge.replies[3].error, /布尔值/);
});

test('桥接指定攻击实体并发送管理员命令', async () => {
  const bridge = bridgeWithLimit(32);
  await bridge.onLine(JSON.stringify({ id: 1, action: 'attack_entity', args: { entityId: 9 } }));
  await bridge.onLine(JSON.stringify({ id: 2, action: 'command', args: { text: '/gamemode creative' } }));
  assert.deepEqual(bridge.actions, [['attack', 9], ['command', '/gamemode creative']]);
  assert.deepEqual(bridge.replies.map(reply => reply.data), [{ ok: true, entityId: 9 }, { ok: true }]);
});

test('桥接进食、背包、装备与容器工具', async () => {
  const bridge = bridgeWithLimit(32);
  for (const [id, action, args] of [
    [1, 'inventory', {}],
    [2, 'eat', { item: 'cooked_beef' }],
    [3, 'equip_item', { item: 'iron_sword', destination: 'hand' }],
    [4, 'view_chest', {}],
    [5, 'take_from_chest', { item: 'bread', count: 3 }],
  ]) {
    await bridge.onLine(JSON.stringify({ id, action, args }));
  }
  assert.deepEqual(bridge.actions, [
    ['inventory'], ['eat', 'cooked_beef'], ['equip', 'iron_sword', 'hand'],
    ['view_chest'], ['take_from_chest', 'bread', 3],
  ]);
  assert.ok(bridge.replies.every(reply => reply.data.ok));
});

test('bridge routes added agent tools with their arguments', async () => {
  const bridge = bridgeWithLimit(32);
  const cases = [
    ['modes', {}, ['modes']],
    ['entities', { radius: 8 }, ['entities', 8]],
    ['nearby_blocks', { block: 'stone', radius: 6 }, ['nearbyBlocks', 'stone', 6]],
    ['craftable', { item: 'stick', count: 2 }, ['craftable', 'stick', 2]],
    ['attack_player', { username: 'Alex' }, ['attackPlayer', 'Alex']],
    ['craft_recipe', { item: 'stick', count: 2 }, ['craftRecipe', 'stick', 2]],
    ['smelt_item', { item: 'iron_ore', count: 2, fuel: 'coal', fuelCount: 1 },
      ['smeltItem', 'iron_ore', 2, 'coal', 1]],
    ['clear_furnace', {}, ['clearFurnace']],
    ['place_here', { item: 'stone', x: 1, y: 2, z: 3 }, ['placeHere', 'stone', 1, 2, 3]],
    ['use_on_entity', { entityId: 9, item: 'bone' }, ['useOnEntity', 9, 'bone']],
    ['use_on_block', { x: 1, y: 2, z: 3, item: 'bucket' }, ['useOnBlock', 1, 2, 3, 'bucket']],
    ['give_player', { username: 'Alex', item: 'bread', count: 2 }, ['givePlayer', 'Alex', 'bread', 2]],
    ['discard', { item: 'dirt', count: 3 }, ['discard', 'dirt', 3]],
    ['put_in_chest', { item: 'dirt', count: 3 }, ['putInChest', 'dirt', 3]],
  ];
  for (const [id, [action, args]] of cases.entries()) {
    await bridge.onLine(JSON.stringify({ id, action, args }));
  }
  assert.deepEqual(bridge.actions, cases.map(([, , expected]) => expected));
  assert.ok(bridge.replies.every(reply => reply.data.ok));
});
