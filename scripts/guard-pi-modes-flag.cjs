// `--modes` is an option of the pi-agent-modes extension. A launcher that appends it unconditionally
// kills every PM-intake Pi start, because those callers pass `--no-extensions` and Pi then exits 1
// with "Unknown option: --modes". Add it only when extensions are still loaded.
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.JEV_ROUTER_HOME || path.join(require('node:os').homedir(), '.jev-router');
const file = path.join(home, 'orca-launch', 'launch.cjs');
const original = fs.readFileSync(file, 'utf8');
const from = "  if(!final.some(a=>a==='--modes'||a.startsWith('--modes=')))final.push('--modes','build');";
const to =
  "  // --modes is provided by the pi-agent-modes extension; with --no-extensions Pi rejects it.\n  if(!final.includes('--no-extensions')&&!final.some(a=>a==='--modes'||a.startsWith('--modes=')))final.push('--modes','build');";
if (original.includes(to)) {
  console.log('modes guard already present');
  process.exit(0);
}
if (original.split(from).length !== 2) {
  console.error('expected exactly one unconditional --modes line; file unchanged');
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
fs.copyFileSync(file, `${file}.bak-modesguard-${stamp}`, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(file, original.replace(from, to));
console.log(`modes guard applied (backup: launch.cjs.bak-modesguard-${stamp})`);
