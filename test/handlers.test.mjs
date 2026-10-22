import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, ensureTrace } from "../src/handlers.mjs";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "sfd-handler-"));
  const calls = { orgs: 0, clears: 0, builds: [], deploys: [], tracking: 0, payloads: [], runs: [], retrieves: [], polls: [], trackingOptions: [], changes: [], deletes: 0, retrieveTracking: 0 };
  const state = { success: true, tracks: true, active: 0, maxActive: 0, size: 1, conflicts: [], rows: [], deletedFiles: [] };
  const conn = { query: async () => ({ totalSize: 0, done: true, records: [] }) };
  const projectFile = join(home, "sfdx-project.json");
  writeFileSync(projectFile, JSON.stringify({ sourceApiVersion: "66.0", packageDirectories: ["one"] }));
  let cachedProject;
  const modules = {
    "@salesforce/core": {
      Org: { create: async () => { calls.orgs++; return {
        getConnection: () => conn, tracksSource: async () => state.tracks
      }; } },
      StateAggregator: { clearInstanceAsync: async () => { calls.clears++; } },
      SfProject: {
        clearInstances: () => { cachedProject = undefined; },
        resolve: async () => cachedProject ??= (() => {
          const config = JSON.parse(readFileSync(projectFile, "utf8"));
          return { getDefaultPackage: () => ({ fullPath: join(home, "one") }), getUniquePackageDirectories: () => config.packageDirectories.map(fullPath => ({ fullPath })),
            getSfProjectJson: () => ({ get: key => config[key] }) };
        })()
      }
    },
    "@salesforce/kit": { Duration: { seconds: n => n * 1000, minutes: n => n * 60000 } },
    "@salesforce/source-deploy-retrieve": { ComponentSetBuilder: { build: async options => {
      calls.builds.push(options);
      return { size: state.size, has: c => c.fullName === "Foo", retrieve: async options => {
        calls.retrieves.push(options);
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        return { pollStatus: async options => {
          calls.polls.push(options);
          await new Promise(resolve => setTimeout(resolve, 5));
          state.active--;
          return { response: { success: state.success, status: state.success ? "Succeeded" : "Failed" }, getFileResponses: () => [] };
        } };
      }, deploy: async options => {
        calls.deploys.push(options);
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        return { pollStatus: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          state.active--;
          return { response: { success: state.success } };
        } };
      } };
    } } },
    "@salesforce/source-tracking": { SourceTracking: { create: async options => {
      calls.trackingOptions.push(options);
      return {
        getConflicts: async () => state.conflicts,
        getStatus: async options => { assert.equal(state.active, 0); calls.changes.push(options); return state.rows.filter(r => options[r.origin]); },
        maybeApplyRemoteDeletesToLocal: async responses => {
          assert.equal(responses, true);
          calls.deletes++;
          return { componentSetFromNonDeletes: await modules["@salesforce/source-deploy-retrieve"].ComponentSetBuilder.build({ remote: true }), fileResponsesFromDelete: state.deletedFiles };
        },
        updateTrackingFromRetrieve: async () => { calls.retrieveTracking++; },
        updateTrackingFromDeploy: async () => { calls.tracking++; }
      };
    } } },
    "@salesforce/apex-node": { TestService: class {
      async buildAsyncPayload(...args) { calls.payloads.push(args); return { level: args[0] }; }
      async runTestAsynchronous(...args) { state.beforeRun?.(); calls.runs.push(args); return state.testResult ?? { summary: {} }; }
    } }
  };
  return { handlers: createHandlers(undefined, { home, load: name => {
    assert.ok(modules[name], name); return modules[name];
  } }), conn, calls, state, home, projectFile };
}

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

test("auth stamp changes reload cached org state", async () => {
  const { handlers, home, calls } = fixture();
  await handlers.query({ org: "one" });
  await handlers.query({ org: "one" });
  assert.equal(calls.orgs, 1);
  mkdirSync(join(home, ".sfdx"));
  await handlers.query({ org: "one" });
  const alias = join(home, ".sfdx", "alias.json");
  writeFileSync(alias, "{}");
  await handlers.query({ org: "one" });
  utimesSync(alias, new Date(), new Date(Date.now() + 10000));
  await handlers.query({ org: "one" });
  assert.equal(calls.orgs, 4);
  assert.equal(calls.clears, 3);
});

test("queries fetch every page beyond 100,000 rows, including tooling and deleted records", async () => {
  for (const tooling of [false, true]) {
    const { handlers, conn } = fixture();
    const api = tooling ? (conn.tooling = {}) : conn;
    api.query = async (q, options) => {
      assert.equal(options.scanAll, true);
      return { totalSize: 100002, done: false, records: Array.from({ length: 100000 }, () => ({ Id: "first" })), nextRecordsUrl: "page2" };
    };
    const pages = [];
    api.queryMore = async url => {
      pages.push(url);
      return { done: url === "page3", records: [{ Id: url }], nextRecordsUrl: url === "page2" ? "page3" : undefined };
    };
    const result = await handlers.query({ q: "SELECT Id FROM Account", tooling, all: true });
    assert.equal(result.records.length, 100002);
    assert.equal(result.done, true);
    assert.deepEqual(pages, ["page2", "page3"]);
  }
});

test("an incomplete query without a continuation fails explicitly", async () => {
  const { handlers, conn } = fixture();
  conn.query = async () => ({ done: false, records: [] });
  await assert.rejects(handlers.query({}), /Incomplete query/);
});

test("deploy options omit test keys unless requested and tests imply their level", async () => {
  const { handlers, calls } = fixture();
  await handlers.deploy({});
  assert.deepEqual(calls.deploys[0].apiOptions, { checkOnly: false, rollbackOnError: true });
  await handlers.deploy({ tests: ["One", "Two"] });
  assert.deepEqual(calls.deploys[1].apiOptions, { checkOnly: false, rollbackOnError: true, testLevel: "RunSpecifiedTests", runTests: ["One", "Two"] });
  await handlers.deploy({ testLevel: "RunLocalTests" });
  assert.equal(calls.deploys[2].apiOptions.testLevel, "RunLocalTests");
  assert.equal(Object.hasOwn(calls.deploys[2].apiOptions, "runTests"), false);
});

test("concurrent deploys serialize and read fresh project configuration", async () => {
  const { handlers, calls, state, projectFile } = fixture();
  await Promise.all([handlers.deploy({ metadata: ["ApexClass"] }), handlers.deploy({})]);
  assert.equal(state.maxActive, 1);
  writeFileSync(projectFile, JSON.stringify({ sourceApiVersion: "67.0", packageDirectories: ["two"] }));
  await handlers.deploy({ metadata: ["ApexClass"] });
  assert.equal(calls.builds[0].sourceapiversion, "66.0");
  assert.equal(calls.builds[2].sourceapiversion, "67.0");
  assert.deepEqual(calls.builds[2].metadata.directoryPaths, ["two"]);
});

test("source tracking updates only after successful real deploys to tracking orgs", async () => {
  for (const success of [false, true]) for (const checkOnly of [false, true]) for (const tracks of [false, true]) {
    const { handlers, calls, state } = fixture();
    Object.assign(state, { success, tracks });
    await handlers.deploy({ checkOnly });
    assert.equal(calls.tracking, Number(success && !checkOnly && tracks));
  }
});

test("test defaults and CSV selectors match apex-node payload arguments", async () => {
  const { handlers, calls } = fixture();
  await handlers.test({});
  await handlers.test({ tests: ["A.one", "B.two"], classNames: ["A", "B"], suiteNames: ["S", "T"], codeCoverage: true, waitMinutes: 2 });
  await handlers.test({ testLevel: "RunAllTestsInOrg" });
  assert.deepEqual(calls.payloads, [
    ["RunLocalTests", undefined, undefined, undefined],
    ["RunSpecifiedTests", "A.one,B.two", "A,B", "S,T"],
    ["RunAllTestsInOrg", undefined, undefined, undefined]
  ]);
  assert.deepEqual(calls.runs[0], [{ level: "RunLocalTests" }, false, false, undefined, undefined, 3600000]);
  assert.deepEqual(calls.runs[1], [{ level: "RunSpecifiedTests" }, true, false, undefined, undefined, 120000]);
});


test("retrieve builds selectors, merges source, polls and updates tracking only on success", async () => {
  for (const tracks of [false, true]) for (const success of [false, true]) {
    const { handlers, calls, state, home } = fixture();
    Object.assign(state, { tracks, success });
    const result = await handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"], waitMinutes: 7 });
    assert.equal(result.success, success);
    assert.deepEqual(calls.builds[0].metadata, { metadataEntries: ["ApexClass:Foo"], directoryPaths: ["one"] });
    assert.equal(calls.builds[0].sourceapiversion, "66.0");
    assert.equal(calls.retrieves[0].output, join(home, "one"));
    assert.equal(calls.retrieves[0].merge, true);
    assert.equal(calls.retrieves[0].format, "source");
    assert.deepEqual(calls.polls[0], { frequency: 2000, timeout: 420000 });
    assert.equal(calls.retrieveTracking, Number(tracks && success));
    assert.ok(calls.trackingOptions.every(o => !o.subscribeSDREvents && o.ignoreLocalCache));
  }
  const { handlers, calls, home } = fixture();
  await handlers.retrieve({ projectDir: home, manifest: "/package.xml" });
  assert.deepEqual(calls.builds[0].manifest, { manifestPath: "/package.xml", directoryPaths: ["one"] });
  await handlers.retrieve({ projectDir: home, sourcePaths: ["/classes"] });
  assert.deepEqual(calls.builds[1].sourcepath, ["/classes"]);
});

test("retrieve refuses selected conflicts before writes, and ignore-conflicts bypasses refusal", async () => {
  const { handlers, state, calls, home } = fixture();
  state.conflicts = [{ type: "ApexClass", name: "Foo", filenames: [join(home, "Foo.cls")] }];
  const conflict = await handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"] });
  assert.equal(conflict.success, false);
  assert.equal(conflict.conflicts[0].path, "Foo.cls");
  assert.equal(conflict.conflicts[0].state, "Conflict");
  assert.equal(calls.retrieves.length, 0);
  await handlers.retrieve({ projectDir: home });
  assert.equal(calls.deletes, 0);
  await handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"], ignoreConflicts: true });
  assert.equal(calls.retrieves.length, 1);
  state.conflicts[0].name = "Unselected";
  await handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"] });
  assert.equal(calls.retrieves.length, 2);
});

test("retrieve handles remote changes, deletions, empty sets and non-tracked orgs", async () => {
  const { handlers, state, calls, home } = fixture();
  await handlers.retrieve({ projectDir: home });
  assert.equal(calls.deletes, 1);
  assert.equal(calls.retrieveTracking, 1);
  state.size = 0;
  const empty = await handlers.retrieve({ projectDir: home });
  assert.equal(empty.success, true);
  assert.equal(empty.message, "No remote changes to retrieve.");
  state.deletedFiles = [{ state: "Deleted", type: "ApexClass", fullName: "Old", filePath: join(home, "Old.cls") }];
  const deleted = await handlers.retrieve({ projectDir: home });
  assert.equal(deleted.files[0].state, "Deleted");
  assert.equal(deleted.files[0].path, "Old.cls");
  assert.equal(calls.retrieves.length, 1);
  await assert.rejects(handlers.retrieve({ projectDir: home, metadata: ["Missing"] }), /Nothing to retrieve/);
  state.tracks = false;
  await assert.rejects(handlers.retrieve({ projectDir: home }), { name: "UsageError" });
});

test("tracking resolves status rows, filters origins, includes deletions and reports conflicts", async () => {
  const { handlers, state, calls, home } = fixture();
  state.rows = [
    { state: "add", origin: "local", type: "ApexClass", fullName: "New", filePath: join(home, "New.cls") },
    { state: "delete", origin: "remote", type: "ApexClass", fullName: "Old" },
    { state: "modify", origin: "local", ignored: true, type: "ApexClass", fullName: "Ignored" }
  ];
  state.conflicts = Array.from({ length: 2 }, () => ({ type: "ApexClass", name: "Foo", filenames: ["Foo.cls"] }));
  const result = await handlers.tracking({ projectDir: home });
  assert.equal(result.local.length, 1);
  assert.equal(result.local[0].path, "New.cls");
  assert.equal(result.remote[0].state, "delete");
  assert.equal(result.conflicts[0].fullName, "Foo");
  assert.equal((await handlers.tracking({ projectDir: home, local: true })).remote.length, 0);
  assert.equal((await handlers.tracking({ projectDir: home, remote: true })).local.length, 0);
  assert.deepEqual(calls.changes, [{ local: true, remote: true }, { local: true, remote: false }, { local: false, remote: true }]);
  const conflicts = await handlers.tracking({ projectDir: home, conflicts: true });
  assert.deepEqual(conflicts.local, []);
  assert.equal(conflicts.conflicts.length, 1);
  assert.equal(calls.changes.length, 3);
  state.tracks = false;
  await assert.rejects(handlers.tracking({ projectDir: home }), { name: "UsageError" });
});

test("retrieves, tracking and deploys share the project queue", async () => {
  const { handlers, state, home } = fixture();
  await Promise.all([handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"] }), handlers.deploy({}), handlers.tracking({ projectDir: home })]);
  assert.equal(state.maxActive, 1);
});


function logFixture() {
  const f = fixture();
  const events = [];
  const state = { flags: [], levels: [], rows: [], failWrite: false };
  f.conn.getAuthInfoFields = () => ({ userId: "005000000000001", username: "agent@example.com" });
  f.conn.getApiVersion = () => "67.0";
  f.conn.request = async (url, options) => { events.push({ url, options }); return "x|USER_DEBUG|[1]|DEBUG|hello"; };
  f.conn.query = async q => { events.push(q); return { records: state.rows }; };
  f.conn.tooling = {
    query: async q => { events.push(q); return { records: q.includes("FROM TraceFlag") ? state.flags : state.levels }; },
    sobject: type => Object.fromEntries(["create", "update"].map(method => [method, async values => {
      events.push({ type, method, values });
      return { success: !state.failWrite, id: type === "DebugLevel" ? "7dl" : "7tf", errors: ["denied"] };
    }]))
  };
  return { ...f, logState: state, events };
}

test("TraceFlags create the compact DebugLevel, extend expiring flags and leave active flags alone", async () => {
  for (const expiry of [null, -1, 60000, 1800000]) {
    const { conn, logState, events } = logFixture();
    if (expiry !== null) logState.flags = [{ Id: "7tf", StartDate: new Date(Date.now() - 1000).toISOString(), ExpirationDate: new Date(Date.now() + expiry).toISOString() }];
    const result = await ensureTrace(conn, "005000000000001");
    assert.equal(result.action, expiry === null ? "created" : expiry > 300000 ? "existing" : "extended");
    const writes = events.filter(e => e.method);
    assert.equal(writes.length, expiry === null ? 2 : expiry > 300000 ? 0 : 1);
    if (writes.length) {
      const write = writes.at(-1);
      assert.equal(write.type, "TraceFlag");
      assert.equal(Date.parse(write.values.ExpirationDate) - Date.parse(write.values.StartDate), 1800000);
    }
    if (expiry === null) {
      assert.equal(writes[0].values.ApexCode, "FINE");
      assert.equal(writes[0].values.Workflow, "INFO");
      assert.equal(writes[1].values.DebugLevelId, "7dl");
      assert.equal(writes[1].values.LogType, "DEVELOPER_LOG");
    }
  }
  const { conn, logState, events } = logFixture();
  logState.levels = [{ Id: "existing-level" }];
  await ensureTrace(conn, "005");
  assert.equal(events.filter(e => e.method).length, 1);
  logState.failWrite = true;
  await assert.rejects(ensureTrace(conn, "005"), /Cannot enable debug logging/);
});

test("trace cache serializes concurrent setup and clears after reload and auth changes", async () => {
  const { handlers, events, home } = logFixture();
  const results = await Promise.all([handlers.logs({ org: "dev" }), handlers.logs({ org: "dev" })]);
  assert.equal(results.filter(r => r.trace).length, 1);
  assert.equal(events.filter(e => typeof e === "string" && e.includes("FROM TraceFlag")).length, 1);
  await handlers.reload();
  await handlers.logs({ org: "dev" });
  mkdirSync(join(home, ".sfdx"));
  await handlers.logs({ org: "dev" });
  assert.equal(events.filter(e => typeof e === "string" && e.includes("FROM TraceFlag")).length, 3);
});

test("logs escape user filters; latest selects authenticated user and bodies request text", async () => {
  const { handlers, logState, events } = logFixture();
  logState.rows = [{ Id: "07L000000000001", Operation: "test", Status: "Failed", LogLength: 100, DurationMilliseconds: 30 }];
  await handlers.logs({ count: 2, user: "o'hara\\example", noTrace: true });
  assert.match(events[0], /Username = 'o\\'hara\\\\example'.*LIMIT 2$/);
  const log = await handlers.logGet({ id: "latest", noTrace: true });
  assert.match(events[1], /WHERE LogUserId = '005000000000001'/);
  assert.deepEqual(events[2], { url: "/services/data/v67.0/sobjects/ApexLog/07L000000000001/Body", options: { responseType: "text" } });
  assert.equal(log.operation, "test");
  assert.match(log.body, /USER_DEBUG/);
  await handlers.logGet({ id: "07L000000000001", noTrace: true });
  await assert.rejects(handlers.logGet({ id: "bad'", noTrace: true }), { name: "UsageError" });
  for (const count of [0, -1, 1.5, NaN]) await assert.rejects(handlers.logs({ count }), { name: "UsageError" });
  logState.rows = [];
  await assert.rejects(handlers.logGet({ id: "latest", noTrace: true }), /No debug logs/);
});

test("test --logs enables tracing before the run; failures get bodies and passes get IDs", async () => {
  for (const failing of [0, 1]) {
    const { handlers, state, logState, events, calls } = logFixture();
    state.beforeRun = () => assert.ok(events.some(e => e.type === "TraceFlag" && e.method === "create"));
    state.testResult = { summary: { failing }, tests: [] };
    logState.rows = [{ Id: "07L000000000001", Operation: "test" }];
    const summary = await handlers.test({ logs: true });
    assert.equal(summary.logs[0].id, "07L000000000001");
    assert.equal(Boolean(summary.logs[0].body), Boolean(failing));
    assert.equal(summary.trace.action, "created");
    assert.equal(calls.runs.length, 1);
    const q = events.find(e => typeof e === "string" && e.includes("FROM ApexLog"));
    assert.match(q, /LogUserId = '005000000000001' AND StartTime >= .* AND StartTime <= .*LIMIT 10$/);
    assert.equal(events.filter(e => e.url).length, failing);
  }
  const { handlers, events } = logFixture();
  await handlers.test({ logs: true, noTrace: true });
  assert.equal(events.some(e => e.type === "TraceFlag"), false);
});


test("test --logs uses whole-second UTC bounds enclosing the run across midnight", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T23:59:59.900Z") });
  const { handlers, state, events } = logFixture();
  state.beforeRun = () => t.mock.timers.tick(200);
  await handlers.test({ logs: true, noTrace: true });
  const query = events.find(e => typeof e === "string" && e.includes("FROM ApexLog"));
  assert.match(query, /StartTime >= 2026-10-22T23:54:59Z AND StartTime <= 2026-10-23T00:05:01Z ORDER BY/);
});

test("test --logs includes clock-skew boundaries and excludes logs outside the padded window", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T23:59:59.900Z") });
  const { handlers, conn, state } = logFixture();
  state.beforeRun = () => t.mock.timers.tick(200);
  const rows = [
    { Id: "before", StartTime: "2026-10-22T23:54:58.999Z" },
    { Id: "lower", StartTime: "2026-10-22T23:54:59Z" },
    { Id: "server-behind", StartTime: "2026-10-22T23:54:59.900Z" },
    { Id: "server-ahead", StartTime: "2026-10-23T00:05:00.100Z" },
    { Id: "upper", StartTime: "2026-10-23T00:05:01Z" },
    { Id: "after", StartTime: "2026-10-23T00:05:01.001Z" }
  ];
  conn.query = async query => {
    const bounds = query.match(/StartTime >= (\S+) AND StartTime <= (\S+)/);
    assert.ok(bounds, query);
    for (const bound of bounds.slice(1)) assert.match(bound, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    return { records: rows.filter(row => Date.parse(row.StartTime) >= Date.parse(bounds[1]) && Date.parse(row.StartTime) <= Date.parse(bounds[2])) };
  };
  const summary = await handlers.test({ logs: true, noTrace: true });
  assert.deepEqual(summary.logs, ["lower", "server-behind", "server-ahead", "upper"].map(id => ({ id })));
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


test("a TraceFlag notice survives a missing latest log or failed log query", async () => {
  const { handlers, conn } = logFixture();
  await assert.rejects(handlers.logGet({ id: "latest" }), e => e.trace?.action === "created" && /No debug logs/.test(e.message));
  await handlers.reload();
  conn.query = async () => { throw new Error("cannot list"); };
  await assert.rejects(handlers.logs({}), e => e.trace?.action === "created" && /cannot list/.test(e.message));
});


test("query limits stop paging and slice records while preserving server metadata", async () => {
  for (const tooling of [false, true]) for (const raw of [false, true]) {
    for (const limit of [undefined, 1, 2, 3, 5, 6, 9]) {
      const { handlers, conn } = fixture();
      const api = tooling ? (conn.tooling = {}) : conn;
      const record = id => ({ attributes: { type: "Account" }, Id: id });
      api.query = async () => ({ totalSize: 6, done: false, records: [record(1), record(2)], nextRecordsUrl: "2" });
      const pages = [];
      api.queryMore = async url => {
        pages.push(url);
        const page = Number(url);
        return { done: page === 3, records: [record(page * 2 - 1), record(page * 2)], nextRecordsUrl: page === 2 ? "3" : undefined };
      };
      const result = await handlers.query({ q: "SELECT Id FROM Account", limit, tooling, raw });
      const shown = Math.min(limit ?? 6, 6);
      assert.deepEqual(result.records.map(r => r.Id), Array.from({ length: shown }, (_, i) => i + 1));
      assert.equal(result.totalSize, 6);
      assert.equal(result.truncated, shown < 6 ? true : undefined);
      assert.equal(pages.length, Math.ceil(shown / 2) - 1);
      assert.equal(result.done, shown > 4);
      assert.equal(result.nextRecordsUrl, shown <= 2 ? "2" : shown <= 4 ? "3" : undefined);
      assert.equal(Boolean(result.records[0].attributes), raw);
    }
  }
});

function orgListFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "sfd-org-list-"));
  mkdirSync(join(home, ".sfdx"));
  const fields = new Map();
  const aliases = new Map();
  const defaults = {};
  const calls = { creates: [], refreshes: [], queries: [], clears: 0 };
  const behavior = new Map();
  let listingError;
  const core = {
    AuthInfo: {
      listAllAuthorizations: async () => {
        if (listingError) throw listingError;
        return [...fields.keys()].map(username => ({ username, accessToken: "list-secret" }));
      },
      create: async ({ username }) => {
        const data = fields.get(username);
        if (data.unreadable) throw new Error("secret auth failure");
        return { getFields: decrypt => {
          if (decrypt && data.decryptFails) throw new Error("cannot decrypt");
          return { username, ...data };
        } };
      }
    },
    ConfigAggregator: { create: async () => ({ reload: async () => {}, getPropertyValue: key => defaults[key] }) },
    StateAggregator: {
      getInstance: async () => ({ aliases: { getAll: username => aliases.get(username) ?? [] } }),
      clearInstanceAsync: async () => { calls.clears++; }
    },
    Org: { create: async ({ aliasOrUsername: username }) => {
      calls.creates.push(username);
      return {
        refreshAuth: async () => { calls.refreshes.push(username); return behavior.get(username)?.(); },
        getConnection: () => ({ query: async query => {
          calls.queries.push({ username, query });
          return behavior.get(username)?.() ?? { records: [] };
        } })
      };
    } }
  };
  const handlers = createHandlers("unused", { home, load: name => name === "@salesforce/core" ? core : {} });
  t.after(async () => { const { rmSync } = await import("node:fs"); rmSync(home, { recursive: true, force: true }); });
  return { handlers, fields, aliases, defaults, calls, behavior, home, setListingError: error => { listingError = error; } };
}

test("org list reads local primary users, resolves aliases/defaults, filters expiry and allows only public fields", async t => {
  const f = orgListFixture(t);
  f.fields.set("primary", { orgId: "00D000000000001AAA", instanceUrl: "https://example", isDevHub: true,
    accessToken: "access-secret", refreshToken: "refresh-secret", clientSecret: "client-secret" });
  f.fields.set("secondary", { orgId: "00D000000000001AAA" });
  f.fields.set("default-secondary", { orgId: "00D000000000001AAA", isSandbox: true, decryptFails: true });
  f.fields.set("unreadable", { unreadable: true });
  f.fields.set("expired", { expirationDate: "2000-01-01", devHubUsername: "primary" });
  f.fields.set("scratch", { expirationDate: "2099-01-01" });
  writeFileSync(join(f.home, ".sfdx", "00D000000000001AAA.json"), JSON.stringify({ usernames: ["primary", "secondary", "default-secondary"] }));
  f.aliases.set("primary", ["hub"]);
  f.aliases.set("default-secondary", ["dev", "other"]);
  f.defaults["target-org"] = "other";
  f.defaults["target-dev-hub"] = "primary";
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const result = await f.handlers.orgList({});
  assert.equal(result.hiddenExpired, 1);
  assert.deepEqual(result.orgs.map(o => o.username), ["scratch", "default-secondary", "primary"]);
  assert.equal(result.orgs.find(o => o.username === "default-secondary").isDefault, true);
  assert.equal(result.orgs.find(o => o.username === "default-secondary").type, "Sandbox");
  assert.deepEqual(result.orgs.find(o => o.username === "primary"), {
    alias: "hub", username: "primary", orgId: "00D000000000001AAA", instanceUrl: "https://example",
    type: "DevHub", isDefault: false, isDefaultDevHub: true
  });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify([result, warnings]), /access-secret|refresh-secret|client-secret|list-secret|secret auth failure|accessToken|refreshToken|clientSecret/);
  assert.deepEqual(f.calls.creates, []);
  assert.equal((await f.handlers.orgList({ all: true })).orgs.length, 4);
  assert.deepEqual((await f.handlers.orgList({ all: true })).orgs.find(o => o.username === "expired").expired, true);
});

test("org list handles absent auth and invalidates state for login/logout stamps", async t => {
  const f = orgListFixture(t);
  f.setListingError(Object.assign(new Error(), { name: "NoAuthInfoFound" }));
  assert.deepEqual(await f.handlers.orgList({}), { orgs: [], hiddenExpired: 0 });
  f.setListingError(new Error("unexpected"));
  await assert.rejects(f.handlers.orgList({}), /unexpected/);
  f.setListingError(undefined);
  f.fields.set("first", {});
  await f.handlers.orgList({ status: true });
  assert.equal(f.calls.creates.length, 1);
  writeFileSync(join(f.home, ".sfdx", "new-user.json"), "{}");
  const future = new Date(Date.now() + 10000);
  utimesSync(join(f.home, ".sfdx"), future, future);
  f.fields.delete("first");
  f.fields.set("second", {});
  const result = await f.handlers.orgList({});
  assert.equal(f.calls.clears, 1);
  assert.equal(result.orgs[0].username, "second");
});

test("org list checks connections concurrently, bounds hangs and retries failed refreshes", async t => {
  const f = orgListFixture(t);
  for (const name of ["hanging", "working", "broken"]) f.fields.set(name, {});
  f.behavior.set("hanging", () => new Promise(() => {}));
  f.behavior.set("broken", () => { throw Object.assign(new Error("secret"), { name: "RefreshTokenAuthError" }); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const resultPromise = f.handlers.orgList({ status: true });
  // Let the async auth/Org.create steps settle before advancing the deadline.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.refreshes.sort(), ["broken", "hanging", "working"]);
  t.mock.timers.tick(10000);
  const result = await resultPromise;
  assert.deepEqual(result.orgs.map(o => [o.username, o.status]), [
    ["broken", "RefreshTokenAuthError"], ["hanging", "Timeout"], ["working", "Connected"]
  ]);
  f.behavior.delete("hanging");
  f.behavior.delete("broken");
  await f.handlers.orgList({ status: true });
  assert.equal(f.calls.creates.filter(name => name === "working").length, 1);
  assert.equal(f.calls.creates.filter(name => name === "broken").length, 2);
  assert.equal(f.calls.creates.filter(name => name === "hanging").length, 2);
});

test("org list queries each Dev Hub once and uses live scratch status before filtering", async t => {
  const f = orgListFixture(t);
  for (const [username, orgId, hub] of [["active", "00D000000000001AAA", "hub"], ["expired", "00D000000000002AAA", "hub"], ["offline", "00D000000000003AAA", "bad-hub"]]) {
    f.fields.set(username, { orgId, expirationDate: "2099-01-01", devHubUsername: hub });
  }
  f.behavior.set("hub", () => ({ records: [
    { ScratchOrg: "00D000000000001", Status: "Active", ExpirationDate: "2099-02-01" },
    { ScratchOrg: "00D000000000002", Status: "Expired", ExpirationDate: "2000-01-01" }
  ] }));
  f.behavior.set("bad-hub", () => { throw new Error("unavailable"); });
  const result = await f.handlers.orgList({ status: true });
  assert.equal(f.calls.queries.length, 2);
  assert.match(f.calls.queries.find(q => q.username === "hub").query, /IN \('00D000000000001','00D000000000002'\)/);
  assert.deepEqual(f.calls.refreshes, []);
  assert.equal(result.hiddenExpired, 1);
  assert.equal(result.orgs.find(o => o.username === "active").status, "Active");
  assert.equal(result.orgs.find(o => o.username === "active").expirationDate, "2099-02-01");
  assert.equal(result.orgs.find(o => o.username === "offline").status, undefined);
});

function metadataFixture() {
  const fixtureData = fixture();
  const { conn, calls } = fixtureData;
  calls.describes = [];
  calls.lists = [];
  conn.getApiVersion = () => "67.0";
  conn.metadata = {
    describe: async version => {
      calls.describes.push(version);
      return { metadataObjects: [
        ...["Flow", "Layout", "ApexClass", "ApexTrigger", "CustomObject", "PermissionSet", "CustomMetadata"].map(xmlName => ({ xmlName })),
        ...["Report", "Dashboard", "Document", "EmailTemplate"].map(xmlName => ({ xmlName, inFolder: true })),
        { xmlName: "Parent", childXmlNames: "Child" }
      ] };
    },
    list: async (queries, version) => {
      calls.lists.push({ queries, version });
      return queries.flatMap(({ type }) => [{ type, fullName: "Z" }, { type, fullName: "A" }]);
    }
  };
  return fixtureData;
}

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

test("metadata members batch seven types into three queries per call and remain live", async () => {
  const { handlers, calls } = metadataFixture();
  const types = ["Flow", "Layout", "ApexClass", "ApexTrigger", "CustomObject", "PermissionSet", "CustomMetadata"];
  const result = await handlers.listMetadata({ org: "dev", types });
  assert.deepEqual(calls.lists.map(c => c.queries.length), [3, 3, 1]);
  assert.ok(calls.lists.every(c => c.version === "67.0"));
  assert.deepEqual(result.groups.map(g => g.type), types);
  assert.ok(result.groups.every(g => g.members.map(m => m.fullName).join() === "A,Z"));
  await handlers.listMetadata({ org: "dev", types: ["Flow"] });
  assert.equal(calls.lists.length, 4);
  assert.equal(calls.describes.length, 1);
});

test("folder listing uses folder types, respects explicit folders and normalizes API responses", async () => {
  const { handlers, conn, calls } = metadataFixture();
  for (const [type, folderType] of [["Report", "ReportFolder"], ["Dashboard", "DashboardFolder"], ["Document", "DocumentFolder"], ["EmailTemplate", "EmailFolder"]]) {
    conn.metadata.list = async queries => {
      assert.deepEqual(queries, [{ type: folderType }]);
      return { type: folderType, fullName: "Public", id: "excluded", lastModifiedByName: "User" };
    };
    const { groups } = await handlers.listMetadata({ types: [type] });
    assert.equal(groups[0].folders, true);
    assert.equal(groups[0].folderType, folderType);
    assert.equal(groups[0].members[0].fullName, "Public");
    assert.equal(groups[0].members[0].id, undefined);
  }
  conn.metadata.list = async queries => {
    assert.deepEqual(queries, [{ type: "Report", folder: "Public" }]);
    return undefined;
  };
  assert.deepEqual((await handlers.listMetadata({ types: ["Report"], folder: "Public" })).groups,
    [{ type: "Report", members: [] }]);
  const describe = conn.metadata.describe;
  conn.metadata.describe = async version => {
    const result = await describe(version);
    result.metadataObjects.push({ xmlName: "EmailTemplateFolder" });
    return result;
  };
  await handlers.reload();
  conn.metadata.list = async queries => { assert.deepEqual(queries, [{ type: "EmailTemplateFolder" }]); return []; };
  await handlers.listMetadata({ types: ["EmailTemplate"] });
  assert.equal(calls.describes.length, 2);
});

test("metadata rejects unknown types with helpful suggestions before listing", async () => {
  const { handlers, calls } = metadataFixture();
  for (const type of ["ApexClas", "apexclass", "ApexCl", "ApexClaxs"]) {
    await assert.rejects(handlers.listMetadata({ types: [type] }), error => error.name === "UsageError" && /Did you mean ApexClass/.test(error.message));
  }
  await assert.rejects(handlers.listMetadata({ types: ["NotAType"] }), { name: "UsageError" });
  await assert.rejects(handlers.listMetadata({ types: [] }), { name: "UsageError" });
  await assert.rejects(handlers.listMetadata({ types: ["Flow", "Layout"], folder: "x" }), { name: "UsageError" });
  assert.equal(calls.lists.length, 0);
  await handlers.listMetadata({ types: ["Child"] });
  assert.equal(calls.lists.length, 1);
});
