// Add the explicit-implementation harness boundary to the existing Windows/Linux launchers.
// The selection itself lives in the deployed runtime; this only routes `launch.cjs implementation`.
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.JEV_ROUTER_HOME || path.join(require('node:os').homedir(), '.jev-router');
const file = path.join(home, 'orca-launch', 'launch.cjs');
const original = fs.readFileSync(file, 'utf8');
if (original.includes('resolveHarnessLaunch')) { console.log('harness selection already enabled'); process.exit(0); }

const known = "if(!['claude','pi'].includes(kind))throw Error('Unknown agent');";
const marker = " const inspect=";
if (original.split(known).length !== 2) throw Error('Expected exactly one agent check; file unchanged');
if (original.split(marker).length !== 2) throw Error('Expected exactly one inspect block; file unchanged');

// Reuse the launcher's own inherited stdio and exit handling: an OpenCode child runs in place,
// a Pi/Claude fallback re-enters this same file with the resolved kind so its existing path is untouched.
const hook = ` if(kind==='implementation'){
  const {resolveHarnessLaunch}=await import(require('node:url').pathToFileURL(path.join(runtime,'dist/runtime/index.js')).href);
  const plan=await resolveHarnessLaunch({env,args});
  log({event:'harness',requestedRole:'implementation',selected:plan.record.selected,candidate:plan.record.candidate,requestedModel:plan.record.requestedModel,appliedModel:plan.record.appliedModel,effort:plan.record.effort,reasons:plan.record.reasons,rejected:plan.record.rejected,quota:plan.record.quota,fallback:plan.record.fallback});
  if(plan.kind==='opencode'){
   if(env.JEV_ORCA_PROBE==='1'){console.log(JSON.stringify({kind:'implementation',harness:'opencode',executable:plan.executable,args:plan.args,record:plan.record}));return;}
   const code=await new Promise(resolve=>{const p=spawn(plan.executable,[...plan.args],{env:plan.env,stdio:'inherit',windowsHide:false});p.on('error',e=>{console.error('[Jev] OpenCode launch failed: '+e.code);resolve(1)});p.on('exit',(c,s)=>resolve(c??(s?1:0)))});
   log({event:'harness_outcome',candidate:plan.record.candidate,exitCode:code});
   process.exitCode=code;return;
  }
  run(process.execPath,[__filename,plan.harness,...args],env);return;
 }
`;

const updated = original.replace(known, "if(!['claude','pi','implementation'].includes(kind))throw Error('Unknown agent');").replace(marker, hook + marker);
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
fs.copyFileSync(file, file + '.bak-harness-' + stamp, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(file, updated);
console.log('harness selection enabled (backup: launch.cjs.bak-harness-' + stamp + ')');
