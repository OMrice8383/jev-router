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
  "   const started=Date.now();const capture=p.call.shape==='run';let err='',bytes=0,sessionId;",
  "   // The prompt is already in argv. Never hand the child an open stdin: `opencode run <prompt>` waits for stdin EOF and produces nothing until it arrives.",
  "   // The run shape gets its own server (`--standalone`): a shared background service keeps the config it started with and silently drops OPENCODE_CONFIG_CONTENT (deep-dev2 2026-10-22), so the selected model would not run.",
  "   const childArgs=capture&&!p.args.includes('--standalone')?[p.args[0],'--standalone',...p.args.slice(1)]:p.args;",
  "   const fi=capture?childArgs.indexOf('--format'):-1;",
  "   const jsonMode=capture&&(fi<0||childArgs[fi+1]==='json');",
  "   if(fi<0&&capture)childArgs.splice(1,0,'--format','json');",
  "   const texts=[];",
  "   const c=spawn(p.executable,childArgs,{env:p.env,stdio:capture?['ignore','pipe','pipe']:'inherit',windowsHide:false});",
  "   activeChild=c;",
  "   if(capture&&jsonMode){",
  "    let buf='';",
  "    c.stdout.on('data',d=>{buf+=d.toString();let nl;while((nl=buf.indexOf('\\n'))>=0){const line=buf.slice(0,nl);buf=buf.slice(nl+1);let ev;try{ev=JSON.parse(line)}catch{continue}if(ev&&ev.sessionID)sessionId=ev.sessionID;if(ev&&ev.type==='text'&&ev.part&&typeof ev.part.text==='string')texts.push(ev.part.text);if(ev&&ev.type==='error'&&ev.error)err+=(typeof ev.error.message==='string'?ev.error.message:JSON.stringify(ev.error))+'\\n';}});",
  "    c.stderr.on('data',d=>{err+=d.toString();process.stderr.write(d)});",
  "   }else if(capture){c.stdout.on('data',d=>{bytes+=d.length;process.stdout.write(d)});c.stderr.on('data',d=>{err+=d.toString();process.stderr.write(d)});}",
  "   c.on('error',e=>{activeChild=null;resolve({code:1,kind:'network',spawnFailed:true,latencyMs:Date.now()-started})});",
  "   c.on('exit',(code,sig)=>{activeChild=null;const exit=code??(sig?1:0);let out='';",
  "    if(capture&&jsonMode){for(let i=0;i<texts.length-1;i++)process.stderr.write(texts[i]+'\\n');out=texts.length?texts[texts.length-1]:'';if(out&&!out.endsWith('\\n'))out+='\\n';process.stdout.write(out);}",
  "    const silent=capture&&exit===0&&!out.trim();",
  "    resolve({code:silent?1:exit,kind:silent?'no_output':mod.classifyHarnessFailure(err),latencyMs:Date.now()-started,silent,sessionId:sessionId||null})});",
  "  });",
  "  const runPi=()=>new Promise(resolve=>{",
  "   const c=spawn(process.execPath,[__filename,'pi',...piArgs],{env,stdio:['ignore','inherit','inherit'],windowsHide:false});",
  "   activeChild=c;",
  "   c.on('error',e=>{activeChild=null;console.error('[Jev] Pi fallback failed: '+e.code);resolve(1)});",
  "   c.on('exit',(code,sig)=>{activeChild=null;resolve(code??(sig?1:0))});",
  "  });",
  "  // Pi takes the prompt from argv (`pi -p <text>`). A bare `-p` whose text came from stdin must gain it here,",
  "  // or the re-entry runs Pi with an empty message: exit 0, no output.",
  "  const piArgs=(()=>{",
  "   if(piPrint<0)return argv.slice();",
  "   const a=[];for(let i=0;i<argv.length;i++){if(argv[i]==='-p'||argv[i]==='--print'){if(argv[i+1]&&!argv[i+1].startsWith('-'))i++;a.push('-p');continue;}a.push(argv[i]);}",
  "   if(prompt!==undefined&&prompt!=='')a.push(prompt);",
  "   return a;",
  "  })();",
  "  const mode=await mod.readHarnessMode(env);",
  "  const plan=await mod.resolveHarnessLaunch({env,args:argv,stdinPrompt,mode});",
  "  harnessLog(plan);",
  "  if(env.JEV_ORCA_PROBE==='1'){console.log(JSON.stringify({kind:'implementation',harness:plan.kind==='opencode'?'opencode':plan.harness,shape:plan.kind==='opencode'?plan.call.shape:undefined,executable:plan.kind==='opencode'?plan.executable:undefined,args:plan.kind==='opencode'?plan.args:undefined,droppedArgs:plan.kind==='opencode'?plan.call.dropped:undefined,record:plan.record}));return;}",
  "  // Walk every candidate (four today, each judged on its own record) before handing over, always sequentially",
  "  // and never twice into the same workspace.",
  "  const excluded=[];",
  "  let current=plan;",
  "  for(let attempt=1;attempt<=5;attempt++){",
  "   if(current.kind!=='opencode'){",
  "    harnessLog(current,{attempt,handoff:'pi'});",
  "    const piCode=await runPi();",
  "    log({event:'harness_launch',attempt,harness:current.harness,launchOk:true,exitCode:piCode});",
  "    process.exitCode=piCode;return;",
  "   }",
  "   const r=await execOpenCode(current);",
  "   log({event:'harness_launch',attempt,candidate:current.record.candidate,plannedModel:current.record.plannedModel,shape:current.call.shape,launchOk:r.spawnFailed!==true,exitCode:r.code,failureKind:r.kind,latencyMs:r.latencyMs,droppedArgs:current.call.dropped,session:r.sessionId||null,silentOutput:r.silent===true});",
  "   if(r.code===0){process.exitCode=0;return;}",
  "   const changed=spawnSync('git',['status','--porcelain'],{cwd:process.cwd(),encoding:'utf8',windowsHide:true});",
  "   const dirty=(changed.stdout||'').trim();",
  "   const decision=mod.retryDecision(r.kind,current.call.shape,dirty!=='');",
  "   // Only a classified capacity failure is written back; auth, network and no_output never are.",
  "   if(r.kind==='quota'||r.kind==='congestion')await mod.recordHarnessFailure(current.record.candidate,r.kind,{env,scope:current.record.scope||undefined});",
  "   if(decision==='handoff'){log({event:'harness_handoff',attempt,candidate:current.record.candidate,reason:'workspace_dirty',handoff:'pi',changedFiles:dirty.split(/\\r?\\n/).filter(Boolean)});console.error('[Jev] OpenCode stopped ('+r.kind+') with local changes; nothing was retried. Hand this worktree to Pi after review.');process.exitCode=r.code;return;}",
  "   if(decision==='stop'){process.exitCode=r.code;return;}",
  "   if(decision==='fallback'){",
  "    const piCode=await runPi();",
  "    log({event:'harness_launch',attempt:attempt+1,harness:'pi',handoff:'pi',retryReason:r.kind,launchOk:true,exitCode:piCode});",
  "    process.exitCode=piCode;return;",
  "   }",
  "   // decision==='retry': the failure was a capacity loss, the workspace is clean, so one more candidate runs.",
  "   excluded.push(current.record.candidate);",
  "   current=await mod.resolveHarnessLaunch({env,args:argv,stdinPrompt,mode,exclude:excluded});",
  "   harnessLog(current,{retryReason:r.kind,attempt:attempt+1});",
  "  }",
  "  console.error('[Jev] every candidate failed; nothing was retried a fifth time.');",
  "  process.exitCode=1;",
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
