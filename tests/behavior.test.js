const test = require('node:test');
const assert = require('node:assert/strict');
const { BehaviorController } = require('../behavior');
const Vec3 = require('vec3');

function setup() {
  const calls = [];
  const playerEntity = { id: 4, type: 'player', username: 'Alex', position: { x: 2, y: 64, z: 2 } };
  const hostile = { id: 8, type: 'hostile', position: { x: 3, y: 64, z: 3 } };
  const neutral = { id: 9, type: 'mob', name: 'cow', position: { x: 4, y: 64, z: 4 } };
  let entities = [hostile];
  const bot = {
    username: 'Fairy',
    entity: { position: { distanceTo: () => 4 } },
    game: { gameMode: 'survival' },
    players: { Alex: { entity: playerEntity } },
    entities: { 4: playerEntity, 8: hostile, 9: neutral, 10: { id: 10, type: 'other', position: { x: 5 } } },
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

test('LLM can select a nearby mob or player while auto combat still targets hostiles', async () => {
  const { bot, controller, calls } = setup();
  controller.setMode('auto', 'Alex');
  assert.deepEqual(controller.status().nearbyEntities.map(entity => entity.id), [4, 8, 9]);
  assert.deepEqual((await controller.attackEntity(9)).entityId, 9);
  controller.tick(bot);
  assert.deepEqual(calls.filter(([kind]) => kind === 'attack'), [['attack', 9]]);
  controller.manualAttackUntil = 0;
  controller.tick(bot);
  assert.deepEqual(calls.filter(([kind]) => kind === 'attack'), [['attack', 9], ['attack', 8]]);
  assert.deepEqual((await controller.attackEntity(4)).name, 'Alex');
  await assert.rejects(controller.attackEntity(10), /可攻击/);
  await assert.rejects(controller.attackEntity(999), /可攻击/);
  bot.entity.position.distanceTo = () => 17;
  await assert.rejects(controller.attackEntity(4), /16 格/);
});

test('idle manual attack changes to survival and restores resting mode when done', async () => {
  const { bot, controller, calls } = setup();
  bot.game.gameMode = 'spectator';
  bot.chat = line => {
    calls.push(['chat', line]);
    bot.game.gameMode = line.split(' ')[1];
  };
  await controller.attackEntity(9);
  assert.deepEqual(calls.filter(([kind]) => kind === 'chat'), [['chat', '/gamemode survival']]);
  controller.manualAttackUntil = 0;
  controller.tick(bot);
  assert.deepEqual(calls.filter(([kind]) => kind === 'chat'),
    [['chat', '/gamemode survival'], ['chat', '/gamemode spectator']]);
});

test('a later explicit game mode command is not overwritten when manual attack ends', async () => {
  const { bot, controller, calls } = setup();
  bot.game.gameMode = 'spectator';
  bot.chat = line => {
    calls.push(['chat', line]);
    bot.game.gameMode = line.split(' ')[1];
  };
  await controller.attackEntity(9);
  bot.game.gameMode = 'creative';
  controller.tick(bot);
  assert.equal(bot.game.gameMode, 'creative');
  assert.deepEqual(calls.filter(([kind]) => kind === 'chat'), [['chat', '/gamemode survival']]);
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
      { name: 'cooked_beef', type: 4, count: 10 },
      { name: 'iron_sword', type: 2, count: 1 },
      { name: 'diamond_sword', type: 3, count: 1 },
    ],
    withdraw: async (type, _metadata, count) => withdrawn.push([type, count]),
    close: () => { closed++; },
  };
  bot.openContainer = async () => chest;
  assert.deepEqual((await controller.fetch()).fetched, ['diamond_sword', 'cooked_beef']);
  assert.deepEqual(withdrawn, [[3, 1], [4, 10]]);
  assert.deepEqual((await controller.viewChest()).items[0], { name: 'bread', count: 20 });
  assert.deepEqual(await controller.takeFromChest('bread', 3), { ok: true, item: 'bread', count: 3 });
  assert.deepEqual(withdrawn, [[3, 1], [4, 10], [1, 3]]);
  assert.equal(closed, 3);
  await assert.rejects(controller.takeFromChest('bread', 65), /1 到 64/);
});

test('auto eating follows food priority and named eating accepts any inventory item', async () => {
  const { bot, controller, calls } = setup();
  const items = [
    { name: 'bread', count: 2, slot: 2 },
    { name: 'cooked_beef', count: 1, slot: 3 },
    { name: 'potion', count: 1, slot: 4 },
  ];
  bot.inventory.items = () => items;
  bot.food = 10;
  bot.equip = async (item, destination) => calls.push(['equip', item.name, destination]);
  bot.consume = async () => { calls.push(['consume']); bot.food = 16; };
  assert.equal(controller.preferredFood(bot).name, 'cooked_beef');
  assert.deepEqual(controller.inventory().items[0], { name: 'bread', count: 2, slot: 2 });
  controller.setMode('auto', 'Alex');
  controller.tick(bot);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(([kind]) => kind === 'equip'), [['equip', 'cooked_beef', 'hand']]);
  assert.deepEqual(await controller.eat('potion'), { ok: true, item: 'potion', food: 16 });
  assert.deepEqual(calls.filter(([kind]) => kind === 'equip'),
    [['equip', 'cooked_beef', 'hand'], ['equip', 'potion', 'hand']]);
  await assert.rejects(controller.eat('missing_food'), /背包里没有/);
});

test('equip tool selects inventory item and validates destination', async () => {
  const { bot, controller, calls } = setup();
  bot.inventory.items = () => [{ name: 'iron_sword', count: 1, slot: 3 }];
  bot.equip = async (item, destination) => calls.push(['equip', item.name, destination]);
  assert.deepEqual(await controller.equipItem('iron_sword', 'hand'),
    { ok: true, item: 'iron_sword', destination: 'hand' });
  assert.deepEqual(calls.filter(([kind]) => kind === 'equip'), [['equip', 'iron_sword', 'hand']]);
  await assert.rejects(controller.equipItem('iron_sword', 'invalid'), /装备位置无效/);
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

test('query tools expose nearby entities, blocks, recipes and current modes', () => {
  const { bot, controller } = setup();
  bot.version = '1.21.4';
  bot.findBlocks = () => [new Vec3(1, 64, 2)];
  bot.findBlock = () => null;
  bot.recipesFor = () => [{ result: { count: 4 }, requiresTable: false }];
  assert.equal(controller.modes().gameMode, 'survival');
  assert.deepEqual(controller.entities().entities.map(entity => entity.id), [4, 8, 9, 10]);
  assert.deepEqual(controller.nearbyBlocks('stone').positions, [{ x: 1, y: 64, z: 2 }]);
  assert.equal(controller.craftable('oak_planks').craftable, true);
  assert.throws(() => controller.nearbyBlocks('stone', 17));
});

test('crafting, placement and interactions invoke Mineflayer with checked targets', async () => {
  const { bot, controller, calls } = setup();
  bot.version = '1.21.4';
  bot.entity.position = new Vec3(0, 64, 0);
  bot.entities[9].position = new Vec3(1, 64, 0);
  bot.inventory.items = () => [{ name: 'cobblestone', type: 1, count: 4 }];
  bot.findBlock = () => null;
  bot.recipesFor = () => [{ result: { count: 4 }, requiresTable: false }];
  bot.craft = async (_recipe, times, table) => calls.push(['craft', times, table]);
  bot.blockAt = pos => ({ name: pos.y === 63 ? 'stone' : 'air', position: pos });
  bot.equip = async item => calls.push(['equip', item.name]);
  bot.placeBlock = async (support, face) => calls.push(['place', support.position.y, face.y]);
  bot.useOn = async entity => calls.push(['use_entity', entity.id]);
  bot.activateBlock = async block => calls.push(['use_block', block.name]);
  assert.equal((await controller.craftRecipe('oak_planks', 3)).count, 4);
  assert.deepEqual(await controller.placeHere('cobblestone', 1, 64, 0),
    { ok: true, block: 'cobblestone', position: { x: 1, y: 64, z: 0 } });
  assert.equal((await controller.useOnEntity(9, 'cobblestone')).entityId, 9);
  assert.equal((await controller.useOnBlock(1, 63, 0)).block, 'stone');
  assert.deepEqual(calls.filter(([kind]) => kind === 'place'), [['place', 63, 1]]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'use_entity'), [['use_entity', 9]]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'use_block'), [['use_block', 'stone']]);
  await assert.rejects(controller.placeHere('cobblestone', 30, 64, 0));
});

test('smelting waits for output and closes furnace; clearing takes remaining slots', async () => {
  const { bot, controller, calls } = setup();
  bot.version = '1.21.4';
  bot.pathfinder.goto = async () => {};
  bot.findBlock = () => ({ position: new Vec3(1, 64, 1) });
  bot.blockAt = () => ({ name: 'furnace' });
  bot.inventory.items = () => [
    { name: 'iron_ore', type: 1, count: 2 },
    { name: 'coal', type: 2, count: 1 },
  ];
  let ready = false;
  const furnace = {
    inputItem: () => null,
    fuelItem: () => null,
    outputItem: () => ready ? { name: 'iron_ingot', count: 2 } : null,
    putInput: async (_type, _meta, count) => calls.push(['input', count]),
    putFuel: async (_type, _meta, count) => { calls.push(['fuel', count]); ready = true; },
    takeOutput: async () => { calls.push(['output']); ready = false; },
    close: () => calls.push(['close']),
  };
  bot.openFurnace = async () => furnace;
  assert.equal((await controller.smeltItem('iron_ore', 2)).item, 'iron_ingot');
  assert.deepEqual(calls.filter(([kind]) => ['input', 'fuel', 'output', 'close'].includes(kind)),
    [['input', 2], ['fuel', 1], ['output'], ['close']]);
  ready = true;
  await assert.rejects(controller.smeltItem('iron_ore', 2));
  assert.deepEqual((await controller.clearFurnace()).taken,
    [{ slot: 'output', item: 'iron_ingot', count: 2 }]);
  assert.equal(calls.filter(([kind]) => kind === 'close').length, 3);
});

test('giving, discarding and depositing transfer only the requested item', async () => {
  const { bot, controller, calls } = setup();
  bot.version = '1.21.4';
  bot.inventory.items = () => [
    { name: 'bread', type: 1, count: 5 },
    { name: 'dirt', type: 2, count: 8 },
  ];
  bot.pathfinder.goto = async () => {};
  bot.toss = async (type, _metadata, count) => calls.push(['toss', type, count]);
  bot.findBlock = () => ({ position: new Vec3(1, 64, 1) });
  bot.blockAt = () => ({ name: 'chest' });
  const chest = {
    deposit: async (type, _metadata, count) => calls.push(['deposit', type, count]),
    close: () => calls.push(['close']),
  };
  bot.openContainer = async () => chest;
  assert.equal((await controller.givePlayer('Alex', 'bread', 2)).droppedNearPlayer, true);
  assert.equal((await controller.discard('dirt', 3)).count, 3);
  assert.equal((await controller.putInChest('bread', 4)).count, 4);
  assert.deepEqual(calls.filter(([kind]) => ['toss', 'deposit'].includes(kind)),
    [['toss', 1, 2], ['toss', 2, 3], ['deposit', 1, 4]]);
  assert.equal(calls.filter(([kind]) => kind === 'close').length, 1);
  await assert.rejects(controller.givePlayer('Alex', 'bread', 6));
});
