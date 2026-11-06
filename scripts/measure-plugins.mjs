// Development benchmark; not included in the npm files list. No real org calls.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { call } from "../src/client.mjs";
import { discoverPlugins } from "../src/plugin/discover.mjs";
import fixture from "../test/fixtures/plugins/echo/ops.mjs";

const dir = mkdtempSync(join(tmpdir(), "sfd-measure-"));
writeFileSync(join(dir, "package.json"), '{"name":"@salesforce/cli","version":"fixture"}');
const env = { ...process.env, SFD_RUNTIME_DIR: dir, SFD_SF_ROOT: dir,
  SFD_HANDLERS_MODULE: resolve("test/fixtures/stub-handlers.mjs"), SFD_PLUGIN_PATHS_ONLY: "1",
  SFD_PLUGIN_PATHS: resolve("test/fixtures/plugins/echo") };
const request = (operation = "echo.say", targetOrg) => call("plugin", {
  operation, options: {text:"hi"}, cwd: dir, mode:"apply", targetOrg
}, {env});
async function timed(fn) { const start = performance.now(); await fn(); return +(performance.now()-start).toFixed(3); }
const stats = async () => (await call("pluginList", {}, {env})).result[0].rss / 1024 / 1024;
const results = { node:process.version, platform:process.platform, installedEligible:discoverPlugins().map(p => p.name) };
try {
  await call("ping", {}, {env}); // Exclude daemon startup from worker timing.
  results.firstCliCallMs = await timed(() => {
    const cli = spawnSync(process.execPath, [resolve("bin/sfd.mjs"), "op", "echo.say", "--options-json", '{"text":"hi"}'], {env,encoding:"utf8"});
    if (cli.status !== 0) throw new Error(cli.stderr);
  });
  results.rss1MiB = await stats();
  results.warmIpcMs = (await timed(async () => { for(let n=1;n<10;n++) await request(); })) / 9;
  results.rss10MiB = await stats();
  for(let n=10;n<100;n++) await request();
  results.rss100MiB = await stats();
  results.firstOrgCallMs = await timed(() => request("echo.whoami", "fixture"));
  results.warmOrgCallMs = await timed(() => request("echo.whoami", "fixture"));
  const op = fixture.operations.find(o => o.descriptor.id === "echo.say");
  results.directMs = (await timed(async () => {
    for(let n=0;n<100;n++) await op.run(undefined, {text:"hi"}, {resolvePath:p => resolve(dir,p)});
  })) / 100;
  results.warmCliMs = (await timed(() => {
    for(let n=0;n<10;n++) {
      const cli=spawnSync(process.execPath,[resolve("bin/sfd.mjs"),"op","echo.say"],{env,encoding:"utf8"});
      if(cli.status!==0) throw new Error(cli.stderr);
    }
  })) / 10;
  // A separate fresh worker measures spawn+import without a CLI process.
  await call("stop", {}, {env,autoStart:false});
  await new Promise(r => setTimeout(r,150));
  await call("ping", {}, {env});
  results.firstIpcCallMs = await timed(() => request());
  console.log(JSON.stringify(results,null,2));
} finally {
  try { await call("stop", {}, {env,autoStart:false}); } catch {}
  rmSync(dir,{recursive:true,force:true});
}
