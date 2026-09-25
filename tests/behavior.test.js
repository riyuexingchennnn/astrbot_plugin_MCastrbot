const test = require('node:test');
const assert = require('node:assert/strict');
const { BehaviorController } = require('../behavior');

function setup() {
  const calls = [];
  const playerEntity = { id: 4, position: { x: 2, y: 64, z: 2 } };
  const hostile = { id: 8, type: 'hostile', position: { x: 3, y: 64, z: 3 } };
  let entities = [hostile];
  const bot = {
    username: 'Fairy',
    entity: { position: { distanceTo: () => 4 } },
    game: { gameMode: 'survival' },
    players: { Alex: { entity: playerEntity } },
    inventory: { items: () => [] },
    pathfinder: { setGoal: goal => calls.push(['goal', goal]) },
    pvp: { attack: entity => calls.push(['attack', entity.id]), stop: () => calls.push(['stop']) },
    nearestEntity: filter => entities.find(filter),
    chat: line => calls.push(['chat', line]),
  };
  const owner = { bot, status: 'online', log: () => {} };
  const controller = new BehaviorController(owner);
  return { bot, controller, calls, clearHostiles: () => { entities = []; } };
}

test('auto attacks hostiles, resumes following, and idle stops autonomous actions', () => {
  const { bot, controller, calls, clearHostiles } = setup();
  assert.equal(controller.setMode('auto', 'Alex').mode, 'auto');
  controller.tick(bot);
  assert.deepEqual(calls.filter(([kind]) => kind === 'attack'), [['attack', 8]]);
  clearHostiles();
  controller.tick(bot);
  assert.equal(calls.filter(([kind, goal]) => kind === 'goal' && goal).length, 1);
  controller.setMode('idle');
  controller.tick(bot);
  assert.equal(controller.status().mode, 'idle');
  assert.equal(calls.filter(([kind, goal]) => kind === 'goal' && goal).length, 1);
});

test('follow mode excludes combat and requires a valid target', () => {
  const { bot, controller, calls } = setup();
  assert.throws(() => controller.setMode('auto', '../server'), /玩家名/);
  controller.setMode('follow', 'Alex');
  controller.tick(bot);
  assert.equal(calls.filter(([kind]) => kind === 'attack').length, 0);
  assert.equal(calls.filter(([kind, goal]) => kind === 'goal' && goal).length, 1);
});

test('auto combat can be disabled without disabling following', () => {
  const { bot, controller, calls } = setup();
  controller.setMode('auto', 'Alex');
  controller.setAutoCombat(false);
  controller.tick(bot);
  assert.equal(calls.filter(([kind]) => kind === 'attack').length, 0);
  assert.equal(calls.filter(([kind, goal]) => kind === 'goal' && goal).length, 1);
});

test('follow catches up to a distant online player with a throttled teleport', () => {
  const { bot, controller, calls, clearHostiles } = setup();
  clearHostiles();
  bot.entity.position.distanceTo = () => 20;
  controller.setMode('follow', 'Alex');
  controller.tick(bot);
  controller.tick(bot);
  assert.deepEqual(calls.filter(([kind, line]) => kind === 'chat' && line.startsWith('/tp')),
    [['chat', '/tp Fairy Alex']]);
});

test('one-shot collection uses a bounded block search and returns the collected count', async () => {
  const { bot, controller } = setup();
  bot.version = '1.21.4';
  bot.findBlocks = query => {
    assert.equal(query.maxDistance, 16);
    assert.equal(query.count, 2);
    return [{ x: 1 }, { x: 2 }];
  };
  bot.blockAt = position => ({ name: 'oak_log', position });
  bot.collectBlock = { collect: async blocks => assert.equal(blocks.length, 2) };
  assert.deepEqual(await controller.collect('oak_log', 2), { ok: true, block: 'oak_log', count: 2 });
  assert.equal(controller.status().task, null);
  await assert.rejects(controller.collect('oak_log', 17), /1 到 16/);
});

test('one-shot chest actions close the container and return supplies', async () => {
  const { bot, controller } = setup();
  bot.version = '1.21.4';
  bot.pathfinder.goto = async () => {};
  bot.findBlock = () => ({ position: { x: 1, y: 64, z: 1 } });
  bot.blockAt = () => ({ name: 'chest' });
  const withdrawn = [];
  let closed = 0;
  const chest = {
    containerItems: () => [
      { name: 'bread', type: 1, count: 20 },
      { name: 'iron_sword', type: 2, count: 1 },
      { name: 'diamond_sword', type: 3, count: 1 },
    ],
    withdraw: async (type, _metadata, count) => withdrawn.push([type, count]),
    close: () => { closed++; },
  };
  bot.openContainer = async () => chest;
  assert.deepEqual((await controller.fetch()).fetched, ['diamond_sword', 'bread']);
  assert.deepEqual(withdrawn, [[3, 1], [1, 16]]);
  assert.equal(closed, 1);
});

test('idle one-shot task temporarily enters survival and restores resting mode', async () => {
  const { bot, controller, calls } = setup();
  bot.game.gameMode = 'spectator';
  bot.chat = line => {
    calls.push(['chat', line]);
    bot.game.gameMode = line.split(' ')[1];
  };
  const result = await controller.runTask('probe', async () => ({ ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.filter(([kind]) => kind === 'chat'),
    [['chat', '/gamemode survival'], ['chat', '/gamemode spectator']]);
});
