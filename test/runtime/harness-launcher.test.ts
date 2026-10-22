import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HARNESS_CANDIDATES } from "../../src/runtime/harness";

// Exercise the generated launcher without starting any CLI, relay or inference.
test.each([
  ["429 quota exhausted", false],
  ["401 unauthorized", false],
  ["ECONNRESET", false],
  ["opaque 400", false],
  ["no_output", false],
  ["opaque 400", true],
] as const)("generated launcher: %s dirty=%s keeps boundary snapshot and hands off safely", async (failure, dirty) => {
  const home = await mkdtemp(join(tmpdir(), "jev-launcher-"));
  const root = join(home, "orca-launch");
  const runtime = join(root, "runtime");
  await mkdir(join(runtime, "dist/runtime"), { recursive: true });
  const source = pathToFileURL(resolve("src/runtime/harness.ts")).href;
  await writeFile(join(runtime, "dist/runtime/index.js"), `export * from ${JSON.stringify(source)};`);
  const at = new Date(Date.now() - 1000).toISOString();
  await writeFile(
    join(root, "harness-status.json"),
    JSON.stringify({
      candidates: Object.fromEntries(
        Object.entries(HARNESS_CANDIDATES).map(([id, candidate]) => [id, { at, ok: true, model: candidate.model }]),
      ),
    }),
  );
  const modePath = join(root, "harness-mode.json");
  await writeFile(modePath, JSON.stringify({ version: 1, mode: "free-with-go", at }));
  const launcher = join(root, "launch.cjs");
  await writeFile(
    launcher,
    `
const fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const env={...process.env},runtime=${JSON.stringify(runtime)},args=['-p','fix parser'];
const events=[],seen=[];const log=e=>events.push(e);
const spawnSync=()=>({stdout:${JSON.stringify(dirty ? " M file.ts" : "")}});
const spawn=(exe,argv,options)=>{
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 seen.push(options.env.JEV_ROUTER_HARNESS||'pi');
 // A user switch during an active boundary must affect only the next boundary.
 fs.writeFileSync(${JSON.stringify(modePath)},JSON.stringify({version:1,mode:'none',at:${JSON.stringify(at)}}));
 setImmediate(()=>{if(options.env.JEV_ROUTER_HARNESS){if(${JSON.stringify(failure)}!=='no_output')child.stderr.emit('data',Buffer.from(${JSON.stringify(failure)}));child.emit('exit',${failure === "no_output" ? 0 : 1})}else{child.emit('exit',0)}});
 return child;
};
(async()=>{
 const kind='implementation';
 if(kind==='implementation'){
 }
 const inspect=false;
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>console.log(JSON.stringify({seen,events})));
`,
  );
  const patched = Bun.spawnSync([process.execPath, resolve("scripts/enable-harness-selection.cjs")], {
    env: { ...process.env, JEV_ROUTER_HOME: home },
  });
  expect(patched.stderr.toString()).toBe("");
  expect(patched.exitCode).toBe(0);
  const run = Bun.spawnSync([process.execPath, launcher], { env: { ...process.env, JEV_ROUTER_HOME: home }, stdin: "ignore" });
  expect(run.exitCode).toBe(dirty ? 1 : 0);
  const result = JSON.parse(run.stdout.toString().trim());
  const expected = dirty
    ? ["opencode-free"]
    : failure.startsWith("429")
      ? [...Object.keys(HARNESS_CANDIDATES), "pi"]
      : ["opencode-free", "pi"];
  expect(result.seen).toEqual(expected);
  expect(result.events.filter((e: { event: string }) => e.event === "harness_launch")).toHaveLength(expected.length);
  const saved = JSON.parse(await readFile(join(root, "harness-status.json"), "utf8"));
  expect(saved.candidates["opencode-go-glm"].model).toBe(HARNESS_CANDIDATES["opencode-go-glm"].model);
  if (!failure.startsWith("429")) expect(saved.candidates["opencode-free"].ok).toBe(true);
});
