import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtempSync, cpSync, rmSync, utimesSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSupervisor } from "../src/plugin/supervisor.mjs";
import { discoverPlugins } from "../src/plugin/discover.mjs";
import { createPluginHandler } from "../src/plugin/handler.mjs";
import { checkPolicy, DEFAULT_POLICY } from "../src/policy.mjs";
import { serial, metadataSuggestion } from "../src/handlers.mjs";

function fixture(t, config = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "sfd-plugin-"));
  const root = resolve(dir, "echo");
  cpSync(resolve("test/fixtures/plugins/echo"), root, { recursive: true });
  const env = { ...process.env, SFD_PLUGIN_PATHS_ONLY: "1", SFD_PLUGIN_PATHS: root };
  const discover = () => discoverPlugins({ env });
  const supervisor = createSupervisor({ discover, env, ...config });
  const handler = createPluginHandler({ supervisor, projectQueue: serial(), suggest: metadataSuggestion,
    policyCheck: config.policyCheck,
    resolveOrg: async alias => ({ username: alias, apiVersion: "62.0", type: "unknown" }) });
  const call = (operation, options = {}, extra = {}, transport) => handler({ operation: `echo.${operation}`, options, cwd: dir, mode: "apply", ...extra }, transport);
  t.after(() => { supervisor.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  return { supervisor, call, root, dir, env };
}

test("worker describes and reuses its process; validates options and envelopes paged data", async t => {
  const { call, supervisor } = fixture(t);
  assert.equal((await supervisor.status())[0].worker, "stopped");
  const first = await call("say", { text: "hi" });
  assert.equal(first.data.text, "hi");
  assert.equal((await call("say")).data.pid, first.data.pid);
  assert.equal((await call("say", { invalid: true })).code, "invalid-options");
  const page = await call("paged");
  assert.equal(page.total, 2); assert.equal(page.truncated, true);
  const list = await supervisor.list();
  assert.ok(list[0].rss > 0); assert.equal(list[0].worker, "idle");
  assert.ok(list[0].operations.every(d => !("optionsSchema" in d)));
  const unknown = await call("sa"); assert.equal(unknown.code, "unknown-operation"); assert.match(unknown.message, /echo.say/);
});

test("write plans preview without applying, reject overreach, and apply only an approved plan", async t => {
  const { call } = fixture(t);
  assert.equal((await call("write", { n: 4 }, { mode: "plan" })).data.n, 4);
  assert.equal((await call("say")).data.applied, 0);
  assert.equal((await call("write", { n: 5 })).data.n, 5);
  assert.equal((await call("overreach")).code, "plan-exceeds-effects");
  assert.equal((await call("overreach", {}, { mode: "plan" })).code, "plan-exceeds-effects");
  assert.equal((await call("say")).data.applied, 1);
  assert.equal((await call("say", {}, { mode: "plan" })).code, "usage");
});

test("connections cache by username, invalidate on auth changes, retry safe sessions only", async t => {
  const { call, supervisor } = fixture(t);
  assert.equal((await call("whoami")).code, "usage");
  const first = await call("whoami", {}, { targetOrg: "user" });
  assert.equal(first.data.username, "user");
  assert.equal((await call("whoami", {}, { targetOrg: "user" })).data.build, first.data.build);
  supervisor.authChanged();
  assert.ok((await call("whoami", {}, { targetOrg: "user" })).data.build > first.data.build);
  assert.equal((await call("retry", { key: "one" }, { targetOrg: "user" })).ok, true);
  assert.equal((await call("unsafe", {}, { targetOrg: "user" })).ok, false);
});

test("missing plugin-owned Salesforce library produces actionable error", async t => {
  const { call, root } = fixture(t);
  rmSync(resolve(root, "node_modules"), { recursive: true });
  const result = await call("whoami", {}, { targetOrg: "user" });
  assert.equal(result.code, "missing-salesforce-core");
  assert.match(result.actions[0], /dependencies/);
});

test("progress streams and cooperative cancellation aborts the operation", async t => {
  const { call } = fixture(t);
  const controller = new AbortController();
  const events = [];
  const result = await call("slow", { ms: 10000 }, {}, { signal: controller.signal, emit: event => { events.push(event); controller.abort(); } });
  assert.equal(result.code, "aborted"); assert.equal(events[0].phase, "wait");
});

test("crashed and uncooperative workers fail their call and respawn", async t => {
  const { call } = fixture(t, { abortTimeoutMs: 50 });
  const pid = (await call("say")).data.pid;
  assert.equal((await call("crash")).code, "worker-crashed");
  assert.notEqual((await call("say")).data.pid, pid);
  const controller = new AbortController();
  const pending = call("hang", {}, {}, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  assert.equal((await pending).code, "worker-crashed"); clearTimeout(timer);
  assert.equal((await call("say")).ok, true);
});

test("idle workers stop, changed source and package versions restart workers", async t => {
  const { call, root } = fixture(t, { idleMs: 100 });
  const first = (await call("say")).data.pid;
  await new Promise(resolve => setTimeout(resolve, 250));
  const second = (await call("say")).data.pid;
  assert.notEqual(second, first);
  const future = new Date(Date.now() + 2000); utimesSync(resolve(root, "ops.mjs"), future, future);
  const third = (await call("say")).data.pid; assert.notEqual(third, second);
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"))); pkg.version = "1.0.1";
  writeFileSync(resolve(root, "package.json"), JSON.stringify(pkg));
  assert.notEqual((await call("say")).data.pid, third);
});

test("project operations share the host queue and require a project", async t => {
  const { call, dir } = fixture(t);
  assert.equal((await call("project")).code, "no-project");
  writeFileSync(resolve(dir, "sfdx-project.json"), "{}");
  const results = await Promise.all([call("project"), call("project")]);
  for (const result of results) { assert.equal(result.data.maximum, 1); assert.equal(result.data.projectRoot, dir); }
});

test("duplicate ids use discovery order and are reported in list", async t => {
  const { root, dir, env, supervisor, call } = fixture(t);
  const other = resolve(dir, "other"); cpSync(root, other, { recursive: true });
  const pkg = JSON.parse(readFileSync(resolve(other, "package.json"))); pkg.name = "other";
  writeFileSync(resolve(other, "package.json"), JSON.stringify(pkg));
  const { delimiter } = await import("node:path"); env.SFD_PLUGIN_PATHS += delimiter + other;
  const pid = (await call("say")).data.pid;
  const list = await supervisor.list();
  assert.equal(list[0].pid, pid); assert.match(list[1].problems.join(" "), /Duplicate operation echo.say/);
});

test("malformed modules are listed and cannot run", async t => {
  const { root, call, supervisor } = fixture(t);
  writeFileSync(resolve(root, "ops.mjs"), "export default {apiVersion: 9, operations: []};");
  assert.equal((await call("say")).code, "invalid-plugin");
  assert.match((await supervisor.list())[0].problems.join(" "), /unsupported/);
});


test("removed plugin roots fail clearly and invalidate discovery", async t => {
  const { call, root, supervisor } = fixture(t);
  await call("say"); rmSync(root, {recursive:true, force:true});
  assert.equal((await call("say")).code, "plugin-missing");
  assert.deepEqual(await supervisor.list(), []);
});

test("worker start timeout is bounded and the next request can recover", async t => {
  const { call, root } = fixture(t, { startTimeoutMs: 300 });
  const original = readFileSync(resolve(root,"ops.mjs"),"utf8");
  writeFileSync(resolve(root,"ops.mjs"), "await new Promise(resolve => setTimeout(resolve, 10000));\n" + original);
  assert.equal((await call("say")).code, "worker-start-timeout");
  writeFileSync(resolve(root,"ops.mjs"), original);
  assert.equal((await call("say")).ok, true);
});


test("concurrent calls share one warm worker and carry multi-megabyte data", async t => {
  const { call } = fixture(t);
  const text = "x".repeat(2 * 1024 * 1024);
  const [large, small] = await Promise.all([call("say",{text}), call("say",{text:"small"})]);
  assert.equal(large.data.text, text); assert.equal(large.data.pid, small.data.pid);
});

test("host rejects a buggy worker's excessive plan before allowing apply", async t => {
  const dir = mkdtempSync(resolve(tmpdir(), "sfd-buggy-"));
  const workerPath = resolve(dir,"worker.mjs");
  writeFileSync(workerPath, `
    process.on("message", msg => {
      if (msg.t === "describe") process.send({t:"described",id:msg.id,operations:[],problems:[]});
      if (msg.t === "call") process.send({t:"plan",id:msg.id,plan:{effects:["destructive"]}});
      if (msg.t === "approve") process.send({t:"result",id:msg.id,ok:true,data:"applied"});
      if (msg.t === "reject-plan") process.send({t:"result",id:msg.id,ok:false,code:"plan-exceeds-effects"});
      if (msg.t === "shutdown") process.exit(0);
    });
  `);
  const { supervisor, root } = fixture(t,{workerPath});
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const plugin = discoverPlugins({env:{SFD_PLUGIN_PATHS_ONLY:"1",SFD_PLUGIN_PATHS:root}})[0];
  const result = await supervisor.call(plugin,{operation:"buggy.write",mode:"apply"},{descriptor:{effects:["org-write"]}});
  assert.equal(result.code,"plan-exceeds-effects");
});


test("production plugin writes gate the exact worker plan and preview supplies confirmation", async t => {
  const dir = mkdtempSync(resolve(tmpdir(), "sfd-plugin-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { call, root } = fixture(t, { policyCheck: input => checkPolicy({ ...input, policy: DEFAULT_POLICY, runtimeDir: dir }) });
  const modulePath = resolve(root, "ops.mjs");
  writeFileSync(modulePath, readFileSync(modulePath, "utf8").replace('let applied = 0;', 'let applied = 0; let revision = 0;').replace('return { effects, summary:', 'return { revision, effects, summary:').replace('read("say",', 'read("revision", async () => ++revision), read("say",'));
  let approval;
  await assert.rejects(call("write", { n: 4 }), e => { approval = e; return e.exitCode === 4; });
  assert.equal((await call("say")).data.applied, 0);
  const preview = await call("write", { n: 4 }, { mode: "plan" });
  assert.equal(preview.policy.hash, approval.hash);
  assert.equal(preview.policy.decision, "ask");
  await assert.rejects(call("write", { n: 5 }, { confirm: approval.hash }), { name: "ApprovalRequired" });
  assert.equal((await call("say")).data.applied, 0);
  await call("revision");
  await assert.rejects(call("write", { n: 4 }, { confirm: approval.hash }), { name: "ApprovalRequired" });
  const revised = await call("write", { n: 4 }, { mode: "plan" });
  assert.notEqual(revised.policy.hash, approval.hash);
  assert.equal((await call("write", { n: 4 }, { confirm: revised.policy.hash })).data.n, 4);
  assert.equal((await call("say")).data.applied, 1);
  await assert.rejects(call("write", { n: 4 }, { confirm: approval.hash }), { name: "ApprovalRequired" });
});


test("failure reports carry through read, plan and apply", async t => {
  const { call } = fixture(t);
  assert.equal((await call("failures", { count: 2 })).failures, 2);
  assert.equal((await call("partial", { planCount: 2 }, { mode: "plan" })).failures, 2);
  assert.equal((await call("partial", { planCount: 2, applyCount: 3 })).failures, 3);
  assert.equal((await call("partial", { planCount: 2 })).failures, 2);
  for (const options of [{}, { planCount: 2, applyCount: 0 }]) {
    assert.equal("failures" in await call("partial", options), false);
  }
  for (const count of [-1, 1.5]) {
    assert.equal((await call("failures", { count })).code, "invalid-failures");
    assert.equal((await call("partial", { planCount: count })).code, "invalid-failures");
    assert.equal((await call("partial", { applyCount: count })).code, "invalid-failures");
  }
});

test("safe auth retries discard failure reports from the failed attempt", async t => {
  const { call } = fixture(t);
  for (const errorCode of ["INVALID_SESSION_ID", "INVALID_AUTH_HEADER"]) {
    const result = await call("retry", { key: errorCode, count: 2, errorCode }, { targetOrg: "user" });
    assert.equal(result.ok, true);
    assert.equal("failures" in result, false);
  }
});
