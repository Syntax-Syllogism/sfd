import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, builtinEffects, decide, loadPolicy, policyLoader, effectiveOrgType, confirmHash, issueConfirm, consumeConfirm, checkPolicy } from "../src/policy.mjs";
import { createHandlers } from "../src/handlers.mjs";
import { handle } from "../src/hooks.mjs";

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "sfd-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("default decision matrix and strictest decision", () => {
  for (const type of ["scratch", "sandbox", "production", "unknown"]) {
    for (const effect of ["read", "local-write", "org-write", "destructive"]) {
      const expected = type === "scratch" || ["read", "local-write"].includes(effect) || type === "sandbox" && effect === "org-write" ? "allow" : "ask";
      assert.equal(decide([effect], type).decision, expected, `${type}/${effect}`);
    }
  }
  const policy = structuredClone(DEFAULT_POLICY);
  policy.rules.production.read = "deny";
  assert.deepEqual(decide(["org-write", "read"], "unknown", policy), { decision: "deny", effect: "read" });
});

test("policy validates files, merges defaults, resolves overrides, and reloads changes", t => {
  const dir = temporary(t), file = join(dir, "policy.json"), env = { SFD_POLICY: file };
  assert.deepEqual(loadPolicy({ env }), DEFAULT_POLICY);
  const get = policyLoader({ env });
  assert.equal(get().rules.production.read, "allow");
  writeFileSync(file, JSON.stringify({ version: 1, rules: { production: { read: "deny" } }, orgs: { uat: "production", user: "sandbox" } }));
  const policy = get();
  assert.equal(policy.rules.production.read, "deny");
  assert.equal(policy.rules.scratch.read, "allow");
  assert.equal(effectiveOrgType("scratch", policy, "user", "uat"), "sandbox");
  assert.equal(effectiveOrgType("scratch", policy, "other", "uat"), "production");
  for (const text of ["bad", "null", '{"version":2}', '{"version":1,"rules":{"production":{"read":"bad"}}}', '{"version":1,"orgs":{"x":"unknown"}}', '{"version":1,"rules":{"__proto__":{}}}']) {
    writeFileSync(file, text);
    assert.throws(() => loadPolicy({ env }), { name: "UsageError" });
  }
});

test("builtin effects cover commands and REST defaults", () => {
  for (const op of ["query", "describe", "listMetadataTypes", "listMetadata", "logs", "logGet", "org", "orgList", "tracking", "ping", "status", "test"]) assert.deepEqual(builtinEffects(op), ["read"]);
  assert.deepEqual(builtinEffects("retrieve"), ["local-write"]);
  for (const op of ["apex", "deploy"]) assert.deepEqual(builtinEffects(op, { checkOnly: true }), ["org-write"]);
  for (const method of ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]) assert.deepEqual(builtinEffects("rest", { method }), [method === "DELETE" ? "destructive" : ["GET", "HEAD"].includes(method) ? "read" : "org-write"]);
  assert.deepEqual(builtinEffects("rest", { body: {} }), ["org-write"]);
});

test("confirmation hashes bind nested inputs and tokens expire and are single use", t => {
  const dir = temporary(t);
  const hash = confirmHash({ b: [1, { y: 2, x: 3 }], a: 1 });
  assert.equal(hash, confirmHash({ a: 1, b: [1, { x: 3, y: 2 }] }));
  issueConfirm(dir, hash);
  assert.equal(consumeConfirm(dir, "000000000000"), false);
  assert.equal(consumeConfirm(dir, hash), true);
  assert.equal(consumeConfirm(dir, hash), false);
  issueConfirm(dir, hash);
  assert.equal(consumeConfirm(dir, hash, Date.now() + 600001), false);
  issueConfirm(dir, hash);
  const path = join(dir, "confirm", hash), old = new Date(Date.now() - 300000);
  utimesSync(path, old, old);
  assert.ok(Date.parse(issueConfirm(dir, hash)) < Date.now() + 301000);
  assert.throws(() => consumeConfirm(dir, "../escape"), { name: "UsageError" });
});

function fixture(t, { fields = {}, sandbox = false, fails = false } = {}) {
  const dir = temporary(t), env = { SFD_RUNTIME_DIR: dir, SFD_POLICY: join(dir, "policy.json") };
  const calls = { queries: 0, writes: 0 };
  const conn = { instanceUrl: "https://example.test", getApiVersion: () => "67.0", query: async () => {
    calls.queries++;
    if (fails) throw Error("offline");
    return { records: [{ IsSandbox: sandbox }] };
  } };
  const modules = {
    "@salesforce/core": { Org: { create: async () => ({ getUsername: () => "user", getOrgId: () => "id", getConnection: () => conn }) },
      AuthInfo: { create: async () => ({ getFields: () => fields }) }, StateAggregator: { clearInstanceAsync: async () => {} } },
    "@salesforce/kit": {},
    "@salesforce/apex-node": { ExecuteService: class { async executeAnonymous() { calls.writes++; return { success: true, compiled: true }; } } }
  };
  const handlers = createHandlers(undefined, { home: dir, env, load: name => modules[name] });
  return { handlers, calls, dir, env };
}

test("production apex requires exact single-use confirmation and reports org type", async t => {
  const f = fixture(t);
  const args = { org: "prod", body: "doWork();" };
  let approval;
  await assert.rejects(f.handlers.apex(args), e => { approval = e; return e.exitCode === 4 && e.name === "ApprovalRequired"; });
  assert.equal(f.calls.writes, 0);
  await assert.rejects(f.handlers.apex({ ...args, body: "different();", confirm: approval.hash }), { name: "ApprovalRequired" });
  assert.equal(f.calls.writes, 0);
  await f.handlers.apex({ ...args, confirm: approval.hash });
  assert.equal(f.calls.writes, 1);
  await assert.rejects(f.handlers.apex({ ...args, confirm: approval.hash }), { name: "ApprovalRequired" });
  assert.equal((await f.handlers.org({ org: "prod" })).type, "production");
  assert.equal(f.calls.queries, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "org-types.json"))), { user: "production", prod: "production", $usernames: { prod: "user" } });
  await f.handlers.reload();
  await f.handlers.org({ org: "prod" });
  assert.equal(f.calls.queries, 2);
  mkdirSync(join(f.dir, ".sfdx"));
  writeFileSync(join(f.dir, ".sfdx", "login.json"), "{}");
  await f.handlers.org({ org: "prod" });
  assert.equal(f.calls.queries, 3);
});

for (const [type, options] of [["scratch", { fields: { expirationDate: "2099-01-01" } }], ["scratch", { fields: { devHubUsername: "hub" } }], ["sandbox", { sandbox: true }], ["unknown", { fails: true }]]) test(`org type ${type}`, async t => {
  const f = fixture(t, options);
  assert.equal((await f.handlers.org({ org: "dev" })).type, type);
  if (type === "unknown") await assert.rejects(f.handlers.apex({ org: "dev", body: "x" }), { name: "ApprovalRequired" });
  else await f.handlers.apex({ org: "dev", body: "x" });
});

test("deny has no hash and read restrictions apply", async t => {
  const f = fixture(t);
  writeFileSync(f.env.SFD_POLICY, JSON.stringify({ version: 1, rules: { production: { "org-write": "deny", read: "deny" } } }));
  await assert.rejects(f.handlers.apex({ org: "prod", body: "x" }), e => e.exitCode === 4 && e.hash === undefined && e.name === "PolicyDenied");
  await assert.rejects(f.handlers.org({ org: "prod" }), { name: "PolicyDenied" });
});

test("plan approval is bound to recomputed plan and preview never consumes", t => {
  const dir = temporary(t);
  const input = { operation: "example.write", username: "user", options: {}, effects: ["org-write"], orgType: "production", policy: DEFAULT_POLICY, runtimeDir: dir, plan: { summary: "write one", effects: ["org-write"] } };
  const preview = checkPolicy({ ...input, preview: true });
  assert.equal(preview.decision, "ask");
  assert.throws(() => checkPolicy({ ...input, plan: { ...input.plan, summary: "write two" }, confirm: preview.hash }), { name: "ApprovalRequired" });
  checkPolicy({ ...input, confirm: preview.hash });
  assert.throws(() => checkPolicy({ ...input, confirm: preview.hash }), { name: "ApprovalRequired" });
});

test("hooks ask for risky calls in lists, env prefixes, PowerShell and invalid policy", t => {
  const dir = temporary(t), env = { SFD_RUNTIME_DIR: dir, SFD_POLICY: join(dir, "policy.json") };
  writeFileSync(join(dir, "org-types.json"), JSON.stringify({ dev: "scratch", prod: "production" }));
  for (const agent of ["claude", "codex"]) {
    const check = (command, overrides = {}) => JSON.parse(handle(agent, JSON.stringify({ tool_name: "Bash", tool_input: { command } }), { ...env, ...overrides }, "linux")).hookSpecificOutput;
    for (const command of ["sf project deploy start -d force-app -o prod", "sf project deploy start -d force-app", "sf data query -q 'SELECT Id'; sf apex run -f x -o prod", "SF_TARGET_ORG=prod sf apex run -f x"]) assert.equal(check(command).permissionDecision, "ask");
    assert.notEqual(check("sf project deploy start -d force-app -o dev").permissionDecision, "ask");
    assert.equal(check("sf project deploy start -d force-app -o prod", { SFD_HOOK_SHELL: "powershell" }).permissionDecision, "ask");
    writeFileSync(env.SFD_POLICY, "bad");
    assert.equal(check("sf data query -q 'SELECT Id'").permissionDecision, "ask");
    rmSync(env.SFD_POLICY);
  }
});


test("hook username overrides take precedence over cached alias types and alias overrides", t => {
  const dir = temporary(t), policyFile = join(dir, "policy.json");
  writeFileSync(join(dir, "org-types.json"), JSON.stringify({ uat: "scratch", $usernames: { uat: "user" } }));
  writeFileSync(policyFile, JSON.stringify({ version: 1, orgs: { uat: "scratch", user: "production" } }));
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "sf project deploy start -d src -o uat" } });
  assert.equal(JSON.parse(handle("codex", input, { SFD_RUNTIME_DIR: dir, SFD_POLICY: policyFile }, "linux")).hookSpecificOutput.permissionDecision, "ask");
});
