import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, logFixture, metadataFixture } from "./fixtures/sf-modules.mjs";

test("session expiry retries once; other errors do not retry", async () => {
  for (const code of ["INVALID_SESSION_ID", "INVALID_AUTH_HEADER", "OTHER"]) {
    const { handlers, conn, calls } = fixture();
    let attempts = 0;
    conn.query = async () => {
      if (++attempts === 1) throw Object.assign(new Error(code), { errorCode: code });
      return { done: true, records: [] };
    };
    if (code === "OTHER") await assert.rejects(handlers.query({}), /OTHER/);
    else await handlers.query({});
    assert.equal(attempts, code === "OTHER" ? 1 : 2);
    assert.equal(calls.orgs, attempts);
  }
  const { handlers, conn, calls } = fixture();
  conn.query = async () => { throw Object.assign(new Error("expired"), { name: "INVALID_SESSION_ID" }); };
  await assert.rejects(handlers.query({}), /expired/);
  assert.equal(calls.orgs, 2);
});

test("session expiry does not repeat writes and invalidates the connection", async () => {
  const expired = () => Object.assign(new Error("expired"), { errorCode: "INVALID_SESSION_ID" });
  for (const operation of ["apex", "rest", "deploy", "retrieve"]) {
    const { handlers, conn, calls, state } = fixture();
    let attempts = 0;
    const fail = () => { attempts++; throw expired(); };
    state.execute = fail;
    conn.request = fail;
    state.deployPoll = fail;
    if (operation === "retrieve") state.tracks = false;
    if (operation === "retrieve") {
      // Fail after the retrieve is submitted, during polling.
      state.retrievePoll = fail;
    }
    const args = operation === "rest" ? { method: "POST" } : operation === "retrieve" ? { metadata: ["ApexClass:Foo"] } : {};
    await assert.rejects(handlers[operation](args), error => {
      assert.equal(error.name, "SessionExpired");
      assert.equal(error.errorCode, "INVALID_SESSION_ID");
      assert.match(error.message, /may or may not/);
      if (operation === "deploy") assert.match(error.message, /deploy-123/);
      return true;
    });
    assert.equal(attempts, 1);
    if (operation === "deploy") assert.equal(calls.deploys.length, 1);
    if (operation === "retrieve") assert.equal(calls.retrieves.length, 1);
    const before = calls.orgs;
    state.execute = undefined;
    await handlers.apex({});
    assert.equal(calls.orgs, before + 1);
  }
});

test("read describe and REST methods retry once, including default method classification", async () => {
  for (const [operation, args] of [["describe", { raw: true }], ["rest", { method: "GET" }], ["rest", { method: "HEAD" }], ["rest", {}]]) {
    const { handlers, conn } = fixture();
    let attempts = 0;
    const read = async () => {
      if (++attempts === 1) throw Object.assign(new Error("expired"), { name: "INVALID_AUTH_HEADER" });
      return operation === "describe" ? { fields: [] } : {};
    };
    conn.describe = read;
    conn.request = read;
    await handlers[operation](args);
    assert.equal(attempts, 2);
  }
});

test("org creation session failure retries before a write starts", async () => {
  const { handlers, state, calls } = fixture();
  state.createOrg = () => { if (calls.orgs === 1) throw Object.assign(new Error("expired"), { errorCode: "INVALID_SESSION_ID" }); };
  let attempts = 0;
  state.execute = () => { attempts++; return { success: true }; };
  await handlers.apex({});
  assert.equal(calls.orgs, 2);
  assert.equal(attempts, 1);
});

test("auth stamp tracks logins, aliases and configuration, not token refreshes", async () => {
  const { handlers, home, calls } = fixture();
  const dir = join(home, ".sfdx");
  mkdirSync(dir);
  const user = join(dir, "user.json");
  writeFileSync(user, "{}");
  await handlers.query({ org: "one" });
  writeFileSync(user, "refreshed token");
  await handlers.query({ org: "one" });
  assert.equal(calls.orgs, 1);
  const added = join(dir, "new@x.json");
  writeFileSync(added, "{}");
  await handlers.query({ org: "one" });
  rmSync(added);
  await handlers.query({ org: "one" });
  writeFileSync(join(dir, "alias.json"), "{}");
  await handlers.query({ org: "one" });
  mkdirSync(join(home, ".sf"));
  writeFileSync(join(home, ".sf", "config.json"), "{}");
  await handlers.query({ org: "one" });
  writeFileSync(join(home, ".sf", "alias.json"), "{}");
  await handlers.query({ org: "one" });
  assert.equal(calls.clears, 6);
  assert.equal(calls.orgs, 6);
});

test("reload waits for org creation and blocks later readers", async () => {
  const { handlers, state, calls } = fixture();
  let release;
  state.createOrg = () => new Promise(resolve => { release = resolve; });
  const first = handlers.query({ org: "a" });
  await new Promise(resolve => setImmediate(resolve));
  const reload = handlers.reload();
  const second = handlers.query({ org: "b" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.orgs, 1);
  assert.equal(calls.clears, 0);
  state.createOrg = undefined;
  release();
  await Promise.all([first, reload, second]);
  assert.equal(calls.clears, 1);
  assert.equal(calls.orgs, 2);
  await handlers.query({ org: "a" });
  assert.equal(calls.orgs, 3);
  assert.throws(() => handlers.clearProjects(), /outside projectQueue/);
});

test("session errors preserve other connections and safety types", async () => {
  const { handlers, state, conn, calls } = fixture();
  state.username = alias => alias;
  conn.getApiVersion = () => "67.0";
  await handlers.org({ org: "a" });
  await handlers.org({ org: "b" });
  let attempts = 0;
  conn.query = async () => {
    if (attempts++ === 0) throw Object.assign(new Error("expired"), { errorCode: "INVALID_SESSION_ID" });
    return { done: true, records: [] };
  };
  await handlers.query({ org: "a" });
  const count = calls.orgs;
  await handlers.org({ org: "b" });
  assert.equal(calls.orgs, count);
  assert.equal(handlers.sizes().safetyTypes, 2);
});

test("cache sizes remain bounded under repeated invalidation", async () => {
  const { handlers, state, conn, home } = fixture();
  state.username = alias => alias;
  mkdirSync(join(home, ".sfdx"));
  let fail = false, baseline;
  conn.query = async () => {
    if (fail) { fail = false; throw Object.assign(new Error("expired"), { errorCode: "INVALID_SESSION_ID" }); }
    return { done: true, records: [] };
  };
  for (let i = 0; i < 5000; i++) {
    if (i && i % 500 === 0) await handlers.reload();
    if (i && i % 1000 === 0) writeFileSync(join(home, ".sfdx", `login${i}.json`), "{}");
    fail = i % 50 === 0;
    await handlers.query({ org: `org${i % 20}` });
    if (i === 999 && global.gc) { global.gc(); baseline = process.memoryUsage().heapUsed; }
  }
  for (const size of Object.values(handlers.sizes())) assert.ok(size <= 20);
  if (global.gc) { global.gc(); assert.ok(process.memoryUsage().heapUsed - baseline < 20 * 1024 * 1024); }
});

test("trace cache serializes concurrent setup and clears after reload and auth changes", async () => {
  const { handlers, events, home } = logFixture();
  const results = await Promise.all([handlers.logs({ org: "dev" }), handlers.logs({ org: "dev" })]);
  assert.equal(results.filter(r => r.trace).length, 1);
  assert.equal(events.filter(e => typeof e === "string" && e.includes("FROM TraceFlag")).length, 1);
  await handlers.reload();
  await handlers.logs({ org: "dev" });
  mkdirSync(join(home, ".sfdx"));
  writeFileSync(join(home, ".sfdx", "new.json"), "{}");
  await handlers.logs({ org: "dev" });
  assert.equal(events.filter(e => typeof e === "string" && e.includes("FROM TraceFlag")).length, 3);
});

test("trace cache rechecks near expiry, retries after a failed write, and resets on session expiry", async () => {
  const { handlers, conn, logState, events } = logFixture();
  logState.failWrite = true;
  await assert.rejects(handlers.logs({ org: "dev" }), /Cannot create debug level/);
  logState.failWrite = false;
  await handlers.logs({ org: "dev" });
  let reads = 0;
  const query = conn.query;
  conn.query = async (...args) => {
    if (++reads === 1) throw Object.assign(new Error("expired"), { errorCode: "INVALID_SESSION_ID" });
    return query(...args);
  };
  await handlers.logs({ org: "dev" });
  const count = () => events.filter(e => typeof e === "string" && e.includes("FROM TraceFlag")).length;
  assert.equal(count(), 3);
  const now = Date.now;
  try {
    Date.now = () => now() + 26 * 60000;
    await handlers.logs({ org: "dev" });
    assert.equal(count(), 4);
  } finally { Date.now = now; }
});

test("metadata descriptions cache by org/version and reset on reload and auth changes", async () => {
  const { handlers, calls, conn, home } = metadataFixture();
  const first = await handlers.listMetadataTypes({ org: "dev" });
  assert.equal(first.cached, false);
  assert.equal(first.apiVersion, "67.0");
  assert.deepEqual(first.types.find(t => t.name === "Parent").children, ["Child"]);
  assert.deepEqual(first.types.map(t => t.name), first.types.map(t => t.name).sort());
  assert.equal((await handlers.listMetadataTypes({ org: "dev" })).cached, true);
  assert.equal(calls.describes.length, 1);
  await handlers.listMetadataTypes({ org: "other" });
  conn.getApiVersion = () => "68.0";
  await handlers.listMetadataTypes({ org: "dev" });
  assert.deepEqual(calls.describes, ["67.0", "67.0", "68.0"]);
  await handlers.reload();
  assert.equal((await handlers.listMetadataTypes({ org: "dev" })).cached, false);
  mkdirSync(join(home, ".sfdx"));
  writeFileSync(join(home, ".sfdx", "new.json"), "{}");
  assert.equal((await handlers.listMetadataTypes({ org: "dev" })).cached, false);
  assert.equal(calls.describes.length, 5);
});

test("failed metadata describes retry; simultaneous requests share a pending describe", async () => {
  const { handlers, conn, calls } = metadataFixture();
  const describe = conn.metadata.describe;
  conn.metadata.describe = async () => { throw new Error("unavailable"); };
  await assert.rejects(handlers.listMetadataTypes({}), /unavailable/);
  conn.metadata.describe = describe;
  await Promise.all([handlers.listMetadataTypes({}), handlers.listMetadataTypes({})]);
  assert.equal(calls.describes.length, 1);
});

test("org type cache is written only on change and reload clears it once", async () => {
  const { handlers, home } = fixture();
  const file = join(home, "runtime", "org-types.json");
  await handlers.deploy({ org: "alias" });
  assert.deepEqual(JSON.parse(readFileSync(file)), { fixture: "scratch", alias: "scratch", $usernames: { alias: "fixture" } });
  const inode = statSync(file).ino;
  await handlers.deploy({ org: "alias" });
  assert.equal(statSync(file).ino, inode);
  await handlers.reload();
  assert.deepEqual(JSON.parse(readFileSync(file)), {});
  const cleared = statSync(file).ino;
  await handlers.reload();
  assert.equal(statSync(file).ino, cleared);
});

test("failed org type writes do not fail requests and are retried", async () => {
  const { handlers, home } = fixture();
  const file = join(home, "runtime", "org-types.json");
  mkdirSync(file, { recursive: true });
  await handlers.deploy({ org: "alias" });
  rmSync(file, { recursive: true });
  await handlers.deploy({ org: "alias" });
  assert.equal(JSON.parse(readFileSync(file)).alias, "scratch");
});

test("limit retries apply to reads and usage is reported and cleared", async t => {
  const { handlers, conn, state } = fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  conn.limitInfo = { apiUsage: { used: 42, limit: 100 } };
  let attempts = 0;
  const failure = () => Object.assign(new Error("quota"), { errorCode: "REQUEST_LIMIT_EXCEEDED" });
  conn.query = async () => { if (++attempts === 1) throw failure(); return { done: true, records: [] }; };
  const pending = handlers.query({ org: "dev" });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1300);
  await pending;
  assert.equal(attempts, 2);
  assert.deepEqual((await handlers.status()).apiUsage, { dev: { used: 42, limit: 100 } });
  attempts = 0;
  state.execute = () => { attempts++; throw failure(); };
  await assert.rejects(handlers.apex({ org: "dev" }), /REQUEST_LIMIT_EXCEEDED.*42\/100/);
  assert.equal(attempts, 1);
  await handlers.reload();
  assert.deepEqual((await handlers.status()).apiUsage, {});
});
