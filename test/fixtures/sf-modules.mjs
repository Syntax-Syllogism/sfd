// Salesforce library stand-ins for the handler, org-session and ops tests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers } from "../../src/handlers.mjs";

export function fixture() {
  const home = mkdtempSync(join(tmpdir(), "sfd-handler-"));
  const calls = { orgs: 0, clears: 0, builds: [], deploys: [], tracking: 0, payloads: [], runs: [], syncPayloads: [], syncRuns: [], retrieves: [], polls: [], trackingOptions: [], changes: [], deletes: 0, retrieveTracking: 0 };
  const messages = [];
  const state = { success: true, tracks: true, active: 0, maxActive: 0, size: 1, conflicts: [], rows: [], deletedFiles: [] };
  const conn = { query: async () => ({ totalSize: 0, done: true, records: [] }) };
  const projectFile = join(home, "sfdx-project.json");
  writeFileSync(projectFile, JSON.stringify({ sourceApiVersion: "66.0", packageDirectories: ["one"] }));
  let cachedProject;
  const modules = {
    "@salesforce/core": {
      Org: { create: async ({ aliasOrUsername }) => { calls.orgs++; await state.createOrg?.(aliasOrUsername); return {
        getUsername: () => state.username?.(aliasOrUsername) ?? "fixture", getOrgId: () => "org-id", getConnection: () => conn, tracksSource: async () => state.tracks
      }; } },
      AuthInfo: { create: async () => ({ getFields: () => ({ devHubUsername: "hub" }) }) },
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
        return { id: "retrieve-123", pollStatus: async options => {
          calls.polls.push(options);
          await state.retrievePoll?.();
          await new Promise(resolve => setTimeout(resolve, 5));
          state.active--;
          return { response: { success: state.success, status: state.success ? "Succeeded" : "Failed" }, getFileResponses: () => [] };
        } };
      }, deploy: async options => {
        calls.deploys.push(options);
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        return { id: "deploy-123", pollStatus: async () => {
          await state.deployPoll?.();
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
    "@salesforce/apex-node": { ExecuteService: class { async executeAnonymous() { return state.execute?.() ?? { success: true }; } }, TestService: class {
      async buildSyncPayload(...args) { calls.syncPayloads.push(args); return { tests: args[1], classNames: args[2] }; }
      async runTestSynchronous(...args) { state.beforeRun?.(); calls.syncRuns.push(args); return state.testResult ?? { summary: {} }; }
      async buildAsyncPayload(...args) { calls.payloads.push(args); return { level: args[0] }; }
      async runTestAsynchronous(...args) { state.beforeRun?.(); calls.runs.push(args); return await state.testRun?.() ?? state.testResult ?? { summary: {} }; }
    } }
  };
  return { handlers: createHandlers(undefined, { home, log: message => messages.push(message), env: { SFD_RUNTIME_DIR: join(home, "runtime"), SFD_POLICY: join(home, "policy.json") }, load: name => {
    assert.ok(modules[name], name); return modules[name];
  } }), conn, calls, state, home, projectFile, messages };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function logFixture() {
  const f = fixture();
  const events = [];
  const state = { flags: [], levels: [], before: [], rows: [], failWrite: false };
  f.conn.getAuthInfoFields = () => ({ userId: "005000000000001", username: "agent@example.com" });
  f.conn.getApiVersion = () => "67.0";
  f.conn.request = async (url, options) => { events.push({ url, options }); return "x|USER_DEBUG|[1]|DEBUG|hello"; };
  f.conn.query = async q => { events.push(q); return { records: q.startsWith("SELECT Id FROM ApexLog") ? state.before : state.rows }; };
  f.conn.tooling = {
    query: async q => { events.push(q); return { records: q.includes("FROM TraceFlag") ? state.flags : state.levels }; },
    sobject: type => Object.fromEntries(["create", "update"].map(method => [method, async values => {
      events.push({ type, method, values });
      return { success: !state.failWrite, id: type === "DebugLevel" ? "7dl" : "7tf", errors: ["denied"] };
    }]))
  };
  return { ...f, logState: state, events };
}

export function orgListFixture(t) {
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
        getOrgId: () => calls.hubId,
        getUsername: () => username,
        refreshAuth: async () => { calls.refreshes.push(username); return behavior.get(username)?.(); },
        getConnection: () => ({ getApiVersion: () => "68.0", query: async query => {
          calls.queries.push({ username, query });
          return behavior.get(username)?.() ?? { records: [] };
        } })
      };
    } }
  };
  const warnings = [];
  const handlers = createHandlers("unused", { home, log: message => warnings.push(message), env: { SFD_RUNTIME_DIR: join(home, "runtime"), SFD_POLICY: join(home, "policy.json") }, load: name => name === "@salesforce/core" ? core : {} });
  t.after(async () => { const { rmSync } = await import("node:fs"); rmSync(home, { recursive: true, force: true }); });
  return { handlers, fields, aliases, defaults, calls, behavior, home, warnings, setListingError: error => { listingError = error; } };
}

export function metadataFixture() {
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

export const sfCapture = name => JSON.parse(readFileSync(new URL(`./sf-json/${name}.json`, import.meta.url), 'utf8'));
