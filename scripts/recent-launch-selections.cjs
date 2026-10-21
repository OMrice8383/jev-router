// Latest actual launch selection for each working directory. No credentials are read.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.JEV_ROUTER_HOME || path.join(require('node:os').homedir(), '.jev-router');
const dir = path.join(root, 'orca-launch', 'selections');
const latest = new Map();
if (fs.existsSync(dir)) for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
  const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const key = row.host + '\0' + row.cwd;
  if (!latest.has(key) || row.selectedAt > latest.get(key).selectedAt) latest.set(key, row);
}
for (const row of [...latest.values()].sort((a, b) => a.cwd.localeCompare(b.cwd))) console.log(JSON.stringify(row));
