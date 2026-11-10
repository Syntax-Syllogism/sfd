import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrace } from "../src/handlers.mjs";
import { fixture, deferred, logFixture } from "./fixtures/sf-modules.mjs";

test("test disconnect observes late rejection and logs the run id", async () => {
  const { handlers, state, calls, messages } = fixture();
  const run = deferred();
  const started = deferred();
  state.testRun = () => { started.resolve(); return run.promise; };
  const controller = new AbortController();
  const request = handlers.test({ org: "dev" }, { signal: controller.signal });
  await started.promise;
  calls.runs[0][3].report({ testRunId: "707test" });
  controller.abort();
  await assert.rejects(request, { name: "Aborted" });
  assert.match(messages[0], /test.*dev.*707test/);
  run.reject(new Error("late failure"));
  await new Promise(resolve => setImmediate(resolve));
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
  assert.deepEqual(calls.runs[0].slice(0, 3), [{ level: "RunLocalTests" }, false, false]);
  assert.equal(typeof calls.runs[0][3].report, "function");
  assert.deepEqual(calls.runs[0].slice(4), [undefined, 3600000]);
  assert.deepEqual(calls.runs[1].slice(0, 3), [{ level: "RunSpecifiedTests" }, true, false]);
  assert.deepEqual(calls.runs[1].slice(4), [undefined, 120000]);
});

test("synchronous tests use only the sync payload and runner, preserving failures and coverage", async () => {
  for (const codeCoverage of [false, true]) {
    const { handlers, calls, state } = fixture();
    state.testResult = {
      summary: { outcome: "Failed", testRunId: "", testsRan: 1, passing: 0, failing: 1 },
      tests: [{ fullName: "A.setup", outcome: "Fail", message: "setup failed", stackTrace: "Class.A.setup: line 2" }],
      codecoverage: [{ name: "A", percentage: "80%", uncoveredLines: [2] }]
    };
    const result = await handlers.test({ synchronous: true, tests: ["A.one", "A.two"], classNames: ["A", "A"], codeCoverage, waitMinutes: 2 });
    assert.deepEqual(calls.syncPayloads, [["RunSpecifiedTests", "A.one,A.two", "A"]]);
    assert.deepEqual(calls.syncRuns, [[{ tests: "A.one,A.two", classNames: "A" }, codeCoverage]]);
    assert.deepEqual(calls.payloads, []);
    assert.deepEqual(calls.runs, []);
    assert.equal(result.testRunId, "");
    assert.equal(result.failing, 1);
    assert.deepEqual(result.failures, [{ name: "A.setup", outcome: "Fail", message: "setup failed", stackTrace: "Class.A.setup: line 2" }]);
    assert.deepEqual(result.coverage, state.testResult.codecoverage);
    await handlers.test({ synchronous: true, classNames: ["A", "A"] });
    assert.deepEqual(calls.syncPayloads[1], ["RunSpecifiedTests", undefined, "A"]);
  }
});

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
  for (const synchronous of [false, true]) for (const failing of [0, 1]) {
    const { handlers, state, logState, events, calls } = logFixture();
    state.beforeRun = () => assert.ok(events.some(e => e.type === "TraceFlag" && e.method === "create"));
    state.testResult = { summary: { failing }, tests: [] };
    logState.rows = [{ Id: "07L000000000001", Operation: "test" }];
    const summary = await handlers.test({ logs: true, synchronous, classNames: ["A"] });
    assert.equal(summary.logs[0].id, "07L000000000001");
    assert.equal(Boolean(summary.logs[0].body), Boolean(failing));
    assert.equal(summary.trace.action, "created");
    assert.equal(calls.runs.length, Number(!synchronous));
    assert.equal(calls.syncRuns.length, Number(synchronous));
    const q = events.find(e => typeof e === "string" && e.includes("FROM ApexLog") && e.includes("LIMIT 10"));
    assert.match(q, /LogUserId = '005000000000001' AND StartTime >= .* AND StartTime <= .*LIMIT 10$/);
    assert.doesNotMatch(q, /NOT IN/);
    assert.equal(events.filter(e => e.url).length, failing);
  }
  const { handlers, events } = logFixture();
  await handlers.test({ logs: true, noTrace: true });
  assert.equal(events.some(e => e.type === "TraceFlag"), false);
});

test("test --logs snapshots existing IDs before either run path and excludes them before the result cap", async () => {
  for (const synchronous of [false, true]) {
    const { handlers, state, logState, events } = logFixture();
    logState.before = [{ Id: "07L000000000001" }, { Id: "07L000000000002" }];
    logState.rows = [{ Id: "07L000000000003" }];
    state.beforeRun = () => {
      const queries = events.filter(e => typeof e === "string" && e.includes("FROM ApexLog"));
      assert.equal(queries.length, 1);
      assert.match(queries[0], /^SELECT Id FROM ApexLog WHERE LogUserId = '005000000000001' AND StartTime >= \S+ ORDER BY StartTime DESC LIMIT 200$/);
      assert.ok(events.findIndex(e => e.type === "TraceFlag" && e.method === "create") < events.indexOf(queries[0]));
    };
    const summary = await handlers.test({ logs: true, synchronous, classNames: ["A"] });
    const queries = events.filter(e => typeof e === "string" && e.includes("FROM ApexLog"));
    assert.equal(queries.length, 2);
    assert.match(queries[1], / AND Id NOT IN \('07L000000000001', '07L000000000002'\) ORDER BY StartTime DESC LIMIT 10$/);
    assert.equal(queries[0].match(/StartTime >= (\S+)/)[1], queries[1].match(/StartTime >= (\S+)/)[1]);
    assert.deepEqual(summary.logs, [{ id: "07L000000000003" }]);
  }
});

test("test without --logs makes no ApexLog queries on either run path", async () => {
  for (const synchronous of [false, true]) {
    const { handlers, events } = logFixture();
    const summary = await handlers.test({ synchronous, classNames: ["A"] });
    assert.equal(events.length, 0);
    assert.equal(summary.logs, undefined);
  }
});

test("test --logs snapshot failures stop the run and preserve the trace notice", async () => {
  for (const synchronous of [false, true]) {
    const { handlers, conn, calls } = logFixture();
    conn.query = async () => { throw new Error("cannot snapshot logs"); };
    await assert.rejects(handlers.test({ logs: true, synchronous, classNames: ["A"] }),
      e => e.message === "cannot snapshot logs" && e.trace?.action === "created");
    assert.equal(calls.runs.length + calls.syncRuns.length, 0);
  }
});

test("test --logs uses whole-second UTC bounds enclosing the run across midnight", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T23:59:59.900Z") });
  const { handlers, state, events } = logFixture();
  state.beforeRun = () => t.mock.timers.tick(200);
  await handlers.test({ logs: true, noTrace: true });
  const query = events.find(e => typeof e === "string" && e.includes("FROM ApexLog") && e.includes("LIMIT 10"));
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
    if (query.startsWith("SELECT Id FROM ApexLog")) return { records: [] };
    const bounds = query.match(/StartTime >= (\S+) AND StartTime <= (\S+)/);
    assert.ok(bounds, query);
    for (const bound of bounds.slice(1)) assert.match(bound, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    return { records: rows.filter(row => Date.parse(row.StartTime) >= Date.parse(bounds[1]) && Date.parse(row.StartTime) <= Date.parse(bounds[2])) };
  };
  const summary = await handlers.test({ logs: true, noTrace: true });
  assert.deepEqual(summary.logs, ["lower", "server-behind", "server-ahead", "upper"].map(id => ({ id })));
});

test("a TraceFlag notice survives a missing latest log or failed log query", async () => {
  const { handlers, conn } = logFixture();
  await assert.rejects(handlers.logGet({ id: "latest" }), e => e.trace?.action === "created" && /No debug logs/.test(e.message));
  await handlers.reload();
  conn.query = async () => { throw new Error("cannot list"); };
  await assert.rejects(handlers.logs({}), e => e.trace?.action === "created" && /cannot list/.test(e.message));
});
