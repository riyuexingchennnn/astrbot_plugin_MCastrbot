const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function bridgeWithLimit(maxMoveDistance) {
  const replies = [];
  const moves = [];
  let onLine;
  class FakeBot {
    constructor() {
      this.bot = { entity: { position: { x: 10, y: 20, z: 30 } } };
    }
    on() {}
    start() {}
    goto(...coords) { moves.push(coords); return { ok: true }; }
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
  return { onLine, replies, moves };
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
