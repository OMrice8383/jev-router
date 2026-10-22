'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const MODES = ['free-with-go', 'go-only', 'none'];
const modePath = () => path.join(os.homedir(), '.jev-router', 'orca-launch', 'harness-mode.json');
function validate(mode) {
  // ASVS 1.2.5: fixed enum, no user input interpolated into shell commands.
  if (!MODES.includes(mode)) throw new Error('Invalid mode');
}
function readMode(file = modePath()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version === 1 && MODES.includes(value.mode)) return value.mode;
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
  }
  return 'free-with-go';
}
function local(action, mode, file = modePath()) {
  let changed = false;
  try {
    if (action === 'set') {
      validate(mode);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${require('node:crypto').randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify({ version: 1, mode, at: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, file);
        changed = true;
      } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    const actual = readMode(file);
    return { ok: action !== 'set' || actual === mode, changed, mode: actual };
  } catch (error) { return { ok: false, changed, error: error.message }; }
}
function remote(host, action, mode) {
  const source = fs.readFileSync(__filename, 'utf8');
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'node', '-', action, '--local'];
  if (action === 'set') args.push(mode);
  const result = spawnSync('ssh', args, { input: source, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
  try {
    const value = JSON.parse(result.stdout);
    if (typeof value.ok !== 'boolean' || typeof value.changed !== 'boolean') throw new Error('Invalid readback');
    return { ...value, ok: result.status === 0 && value.ok, exitCode: result.status };
  } catch {
    // An interrupted transport cannot prove whether the remote write happened.
    return { ok: false, changed: null, exitCode: result.status, error: result.error ? result.error.code : 'SSH failed or invalid readback' };
  }
}
function control(action, mode, { runLocal = local, runRemote = remote } = {}) {
  if (!['get', 'set'].includes(action)) throw new Error('Use get or set');
  if (action === 'set') validate(mode);
  const machines = [
    { host: 'Desktop', ...runLocal(action, mode) },
    ...['deep-dev2', 'deep-dev'].map(host => ({ host, ...runRemote(host, action, mode) })),
  ];
  return { ok: machines.every(item => item.ok), machines };
}
if (!module.parent) {
  try {
    const args = process.argv.slice(2);
    const action = args[0];
    const mode = args.find(arg => MODES.includes(arg));
    if (!['get', 'set'].includes(action) || args.some((arg, i) => i > 0 && arg !== '--local' && !MODES.includes(arg))) throw new Error('Use get or set <free-with-go|go-only|none> [--local]');
    if (action === 'set') validate(mode);
    const result = args.includes('--local') ? local(action, mode) : control(action, mode);
    if (!args.includes('--local')) {
      result.logPath = path.join(path.dirname(modePath()), 'logs', 'harness-mode.jsonl');
      try {
        fs.mkdirSync(path.dirname(result.logPath), { recursive: true });
        fs.appendFileSync(result.logPath, JSON.stringify({ at: new Date().toISOString(), action, ...result }) + '\n', { mode: 0o600 });
      } catch { result.logError = 'Could not write operation log'; }
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
module.exports = { MODES, modePath, readMode, local, control };
