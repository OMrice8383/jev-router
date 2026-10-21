// Apply only the task-aware routing fields. Existing credentials, providers and model IDs stay untouched.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const patch = require('../examples/task-aware-policy-patch.json');
const home = process.env.JEV_ROUTER_HOME || path.join(os.homedir(), '.jev-router');
const policyFile = path.join(home, 'policy.json');
const settingsFile = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'settings.json');
const raw = fs.readFileSync(policyFile, 'utf8');
const policy = JSON.parse(raw.replace(/^\uFEFF/, ''));
for (const name of ['claude', 'pi']) {
  if (!policy.policies[name] || !policy.candidates[patch[name].default]) throw Error('Expected the existing Claude/Pi subscription policies; no file changed');
  policy.policies[name] = { ...policy.policies[name], ...patch[name], switch: { ...policy.policies[name].switch, cache_penalty: true, prefer_effort_over_model: true } };
}
for (const [id, candidate] of Object.entries(policy.candidates)) {
  if (/astra|fable/i.test(id + ' ' + candidate.model)) throw Error('Disabled model is still a candidate; no file changed');
  candidate.default_effort = id === 'claude-haiku' ? 'low' : 'medium';
}
const settingsRaw = fs.readFileSync(settingsFile, 'utf8');
const settings = JSON.parse(settingsRaw.replace(/^\uFEFF/, ''));
settings.defaultModel = policy.candidates['pi-sol'].pi?.model || policy.candidates['pi-sol'].model;
settings.defaultThinkingLevel = 'medium';
settings.enabledModels = settings.enabledModels?.filter(model => !/astra|fable/i.test(model));
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
function save(file, original, value) {
  if (JSON.stringify(JSON.parse(original.replace(/^\uFEFF/, ''))) === JSON.stringify(value)) return false;
  if (fs.readFileSync(file, 'utf8') !== original) throw Error('Configuration changed during preparation; retry without overwriting it');
  fs.copyFileSync(file, file + '.bak-task-aware-' + stamp, fs.constants.COPYFILE_EXCL);
  const temp = file + '.task-aware-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: fs.statSync(file).mode });
  fs.renameSync(temp, file);
  return true;
}
console.log(JSON.stringify({ host: os.hostname(), policyChanged: save(policyFile, raw, policy), settingsChanged: save(settingsFile, settingsRaw, settings) }));
