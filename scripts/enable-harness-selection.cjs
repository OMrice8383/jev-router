// Add (or refresh) the explicit-implementation harness boundary in the existing Windows/Linux launchers.
// The selection itself lives in the deployed runtime; this only routes `launch.cjs implementation`.
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.JEV_ROUTER_HOME || path.join(require('node:os').homedir(), '.jev-router');
const file = path.join(home, 'orca-launch', 'launch.cjs');
const original = fs.readFileSync(file, 'utf8');

const start = original.indexOf(" if(kind==='implementation'){");
const marker = " const inspect=";
const end = original.indexOf(marker);
if (end < 0) throw Error('Expected exactly one inspect block; file unchanged');

const hook = [
  " if(kind==='implementation'){",
  "  const url=require('node:url');",
  "  const mod=await import(url.pathToFileURL(path.join(runtime,'dist/runtime/index.js')).href);",
  "  const argv=args.slice();",
  "  const piPrint=argv.findIndex(a=>a==='-p'||a==='--print');",
  "  const inlinePrompt=piPrint>=0&&argv[piPrint+1]&&!argv[piPrint+1].startsWith('-')?argv[piPrint+1]:undefined;",
  "  let stdinPrompt;",
  "  if(piPrint>=0&&!inlinePrompt&&!process.stdin.isTTY){try{stdinPrompt=fs.readFileSync(0,'utf8')}catch{}}",
  "  const prompt=(inlinePrompt??stdinPrompt);",
  "  const harnessLog=(p,extra)=>log(Object.assign({event:'harness',requestedRole:'implementation',selected:p.record.selected,candidate:p.record.candidate,plannedModel:p.record.plannedModel,appliedModel:null,effort:null,reasons:p.record.reasons,rejected:p.record.rejected,quota:p.record.quota,scope:p.record.scope,hard:p.record.hard,fallback:p.record.fallback},extra||{}));",
  "  let activeChild=null;",
  "  const cancel=()=>{try{activeChild?.kill('SIGTERM')}catch{}};",
  "  process.once('SIGINT',()=>{log({event:'harness_cancel',signal:'SIGINT',signalled:activeChild!==null});cancel();process.exit(130)});",
  "  process.once('SIGTERM',()=>{log({event:'harness_cancel',signal:'SIGTERM',signalled:activeChild!==null});cancel();process.exit(143)});",
  "  const execOpenCode=(p)=>new Promise(resolve=>{",
  "   const started=Date.now();const capture=p.call.shape==='run';let err='',bytes=0;",
  "   // The prompt is already in argv. Never hand the child an open stdin: `opencode run <prompt>` waits for stdin EOF and produces nothing until it arrives.",
  "   const c=spawn(p.executable,[...p.args],{env:p.env,stdio:capture?['ignore','pipe','pipe']:'inherit',windowsHide:false});",
  "   activeChild=c;",
  "   if(capture){c.stdout.on('data',d=>{bytes+=d.length;process.stdout.write(d)});c.stderr.on('data',d=>{err+=d.toString();process.stderr.write(d)});}",
  "   c.on('error',e=>{activeChild=null;resolve({code:1,kind:'network',spawnFailed:true,latencyMs:Date.now()-started})});",
  "   c.on('exit',(code,sig)=>{activeChild=null;const exit=code??(sig?1:0);const silent=capture&&exit===0&&bytes===0;resolve({code:silent?1:exit,kind:silent?'no_output':mod.classifyHarnessFailure(err),latencyMs:Date.now()-started,silent})});",
  "  });",
  "  const runPi=()=>new Promise(resolve=>{",
  "   const a=[];for(let i=0;i<argv.length;i++){if(argv[i]==='-p'||argv[i]==='--print'){if(argv[i+1]&&!argv[i+1].startsWith('-'))i++;a.push('-p');continue;}a.push(argv[i]);}",
  "   if(!a.includes('-p'))a.push('-p');",
  "   const c=spawn(process.execPath,[__filename,'pi',...a],{env,stdio:['pipe','inherit','inherit'],windowsHide:false});",
  "   activeChild=c;",
  "   c.on('error',e=>{activeChild=null;console.error('[Jev] Pi fallback failed: '+e.code);resolve(1)});",
  "   c.on('exit',(code,sig)=>{activeChild=null;resolve(code??(sig?1:0))});",
  "   c.stdin.end(prompt===undefined?'':prompt);",
  "  });",
  "  const plan=await mod.resolveHarnessLaunch({env,args:argv,stdinPrompt});",
  "  harnessLog(plan);",
  "  if(plan.kind!=='opencode'){run(process.execPath,[__filename,plan.harness,...args],env);return;}",
  "  if(env.JEV_ORCA_PROBE==='1'){console.log(JSON.stringify({kind:'implementation',harness:'opencode',shape:plan.call.shape,executable:plan.executable,args:plan.args,droppedArgs:plan.call.dropped,record:plan.record}));return;}",
  "  const first=await execOpenCode(plan);",
  "  log({event:'harness_launch',attempt:1,candidate:plan.record.candidate,plannedModel:plan.record.plannedModel,shape:plan.call.shape,launchOk:first.spawnFailed!==true,exitCode:first.code,failureKind:first.kind,latencyMs:first.latencyMs,droppedArgs:plan.call.dropped});",
  "  if(first.code===0){process.exitCode=0;return;}",
  "  const changed=spawnSync('git',['status','--porcelain'],{cwd:process.cwd(),encoding:'utf8',windowsHide:true});",
  "  const dirty=(changed.stdout||'').trim();",
  "  const decision=mod.retryDecision(first.kind,plan.call.shape,dirty!=='');",
  "  if(decision==='stop'){process.exitCode=first.code;return;}",
  "  await mod.recordHarnessFailure(plan.record.candidate,first.kind,{env,scope:plan.record.scope||undefined});",
  "  if(decision==='handoff'){log({event:'harness_handoff',candidate:plan.record.candidate,reason:'workspace_dirty',handoff:'pi',changedFiles:dirty.split(/\\r?\\n/).filter(Boolean)});console.error('[Jev] OpenCode stopped ('+first.kind+') with local changes; nothing was retried. Hand this worktree to Pi after review.');process.exitCode=first.code;return;}",
  "  const second=await mod.resolveHarnessLaunch({env,args:argv,stdinPrompt,exclude:[plan.record.candidate]});",
  "  harnessLog(second,{retryReason:first.kind});",
  "  if(second.kind==='opencode'){const r=await execOpenCode(second);log({event:'harness_launch',attempt:2,candidate:second.record.candidate,plannedModel:second.record.plannedModel,shape:second.call.shape,launchOk:r.spawnFailed!==true,exitCode:r.code,failureKind:r.kind,latencyMs:r.latencyMs,droppedArgs:second.call.dropped});process.exitCode=r.code;return;}",
  "  const piCode=await runPi();",
  "  log({event:'harness_launch',attempt:2,harness:second.harness,launchOk:true,exitCode:piCode});",
  "  process.exitCode=piCode;return;",
  " }",
  "",
].join('\n');

let updated;
if (start >= 0) {
  updated = original.slice(0, start) + hook + original.slice(end);
  updated = updated.replace("if(!['claude','pi','implementation'].includes(kind))throw Error('Unknown agent');", "if(!['claude','pi','implementation'].includes(kind))throw Error('Unknown agent');");
} else {
  const known = "if(!['claude','pi'].includes(kind))throw Error('Unknown agent');";
  if (original.split(known).length !== 2) throw Error('Expected exactly one agent check; file unchanged');
  if (original.split(marker).length !== 2) throw Error('Expected exactly one inspect block; file unchanged');
  updated = original.replace(known, "if(!['claude','pi','implementation'].includes(kind))throw Error('Unknown agent');").replace(marker, hook + marker);
}

if (updated === original) {
  console.log('harness selection already up to date');
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
fs.copyFileSync(file, file + '.bak-harness-' + stamp, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(file, updated);
console.log('harness selection enabled (backup: launch.cjs.bak-harness-' + stamp + ')');
