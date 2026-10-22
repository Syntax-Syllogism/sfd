import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers } from "../src/handlers.mjs";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "sfd-handler-"));
  const calls = { orgs: 0, clears: 0, builds: [], deploys: [], tracking: 0, payloads: [], runs: [] };
  const state = { success: true, tracks: true, active: 0, maxActive: 0 };
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
          return { getUniquePackageDirectories: () => config.packageDirectories.map(fullPath => ({ fullPath })),
            getSfProjectJson: () => ({ get: key => config[key] }) };
        })()
      }
    },
    "@salesforce/kit": { Duration: { seconds: n => n * 1000, minutes: n => n * 60000 } },
    "@salesforce/source-deploy-retrieve": { ComponentSetBuilder: { build: async options => {
      calls.builds.push(options);
      return { size: 1, deploy: async options => {
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
    "@salesforce/source-tracking": { SourceTracking: { create: async () => ({
      updateTrackingFromDeploy: async () => { calls.tracking++; }
    }) } },
    "@salesforce/apex-node": { TestService: class {
      async buildAsyncPayload(...args) { calls.payloads.push(args); return { level: args[0] }; }
      async runTestAsynchronous(...args) { calls.runs.push(args); return { summary: {} }; }
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
