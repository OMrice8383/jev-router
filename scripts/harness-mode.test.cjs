'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MODES, local, readMode, control } = require('./harness-mode.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'harness-mode.json');
}
test('missing and invalid files default to free-with-go', t => {
  const file = fixture(t);
  assert.equal(readMode(file), 'free-with-go');
  for (const value of ['broken', 'null', '{}', '{"version":2,"mode":"none"}', '{"version":1,"mode":"bogus"}']) {
    fs.writeFileSync(file, value);
    assert.equal(readMode(file), 'free-with-go');
  }
});
for (const mode of MODES) test(`atomic set/get ${mode}`, t => {
  const file = fixture(t);
  assert.deepEqual(local('set', mode, file), { ok: true, changed: true, mode });
  assert.deepEqual(local('get', undefined, file), { ok: true, changed: false, mode });
  const bytes = fs.readFileSync(file);
  assert.equal(bytes[0], 123);
  const value = JSON.parse(bytes);
  assert.deepEqual(Object.keys(value).sort(), ['at', 'mode', 'version']);
  assert.ok(Number.isFinite(Date.parse(value.at)));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['harness-mode.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('invalid enum rejected before any host changes', () => {
  let calls = 0;
  assert.throws(() => control('set', 'none;evil', { runLocal: () => calls++ }), /Invalid mode/);
  assert.equal(calls, 0);
});
test('partial failures retain changed machine and unknown transport state', () => {
  const result = control('set', 'none', {
    runLocal: () => ({ ok: true, changed: true, mode: 'none' }),
    runRemote: host => host === 'deep-dev2' ? { ok: false, changed: true, error: 'Readback failed' } : { ok: false, changed: null, exitCode: 255 },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.machines.map(value => value.changed), [true, true, null]);
  assert.equal(result.machines[2].host, 'deep-dev');
});
test('all hosts readback for each mode', () => {
  for (const mode of MODES) {
    const result = control('set', mode, { runLocal: () => ({ ok: true, changed: true, mode }), runRemote: () => ({ ok: true, changed: true, mode }) });
    assert.equal(result.ok, true);
    assert.equal(result.machines.length, 3);
    assert.ok(result.machines.every(value => value.mode === mode));
  }
});
test('CLI invalid value has real nonzero exit and JSON', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'harness-mode.cjs'), 'set', 'bad'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});
