// Install the same small audit hook into the existing Windows/Linux launchers.
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.JEV_ROUTER_HOME || path.join(require('node:os').homedir(), '.jev-router');
const file = path.join(home, 'orca-launch', 'launch.cjs');
const original = fs.readFileSync(file, 'utf8');
if (original.includes('prepareLaunchAudit')) { console.log('launch audit already enabled'); process.exit(0); }
const marker = " if(kind==='pi'){\n";
if (original.split(marker).length !== 2) throw Error('Expected exactly one Pi launch branch; file unchanged');
const hook = ` const {prepareLaunchAudit}=await import(require('node:url').pathToFileURL(path.join(runtime,'dist/runtime/index.js')).href);
 env.JEV_ROUTER_LAUNCH_ID=await prepareLaunchAudit(kind,env);
 if(kind==='claude')env.ANTHROPIC_CUSTOM_HEADERS=[...(env.ANTHROPIC_CUSTOM_HEADERS||'').split(/\\r?\\n/).filter(s=>s&&!/^x-jev-router-launch-id:/i.test(s)),'x-jev-router-launch-id: '+env.JEV_ROUTER_LAUNCH_ID].join('\\n');
`;
const updated = original.replace(marker, hook + marker).replace('kind,orcaTerminal:', 'kind,launchId:env.JEV_ROUTER_LAUNCH_ID??null,orcaTerminal:');
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
fs.copyFileSync(file, file + '.bak-audit-' + stamp, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(file, updated);
console.log('launch audit enabled (backup saved)');
