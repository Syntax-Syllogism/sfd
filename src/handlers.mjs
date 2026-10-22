import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sfRequire } from "./sf-root.mjs";
import { compactDescribe, compactQuery, summarizeDeploy, summarizeTests } from "./format.mjs";

const SESSION_ERRORS = new Set(["INVALID_SESSION_ID", "INVALID_AUTH_HEADER"]);

function authStamp(home) {
  // A login, logout or alias change touches ~/.sfdx or alias.json; reload org state when it does.
  const stamp = path => { try { return statSync(path).mtimeMs; } catch { return 0; } };
  return `${stamp(join(home, ".sfdx"))}:${stamp(join(home, ".sfdx", "alias.json"))}`;
}

// One queue for operations that touch the local project (deploy and source tracking):
// SDR and source-tracking keep process-wide state, so they must not interleave.
function serial() {
  let tail = Promise.resolve();
  return fn => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function createHandlers(sfRoot, { home = homedir(), load = sfRequire(sfRoot) } = {}) {
  const req = load;
  const core = req("@salesforce/core");
  const { Duration } = req("@salesforce/kit");
  const lazy = name => { let mod; return () => (mod ??= req(name)); };
  const sdr = lazy("@salesforce/source-deploy-retrieve");
  const apex = lazy("@salesforce/apex-node");
  const tracking = lazy("@salesforce/source-tracking");
  const projectQueue = serial();

  const orgs = new Map();
  let stamp = authStamp(home);

  async function getOrg(alias) {
    const now = authStamp(home);
    if (now !== stamp) {
      stamp = now;
      orgs.clear();
      await core.StateAggregator.clearInstanceAsync();
    }
    if (!orgs.has(alias)) {
      const pending = core.Org.create({ aliasOrUsername: alias });
      orgs.set(alias, pending);
      pending.catch(() => orgs.delete(alias));
    }
    return orgs.get(alias);
  }

  // Run fn with a cached connection; on an expired or revoked session, rebuild it once.
  async function withConn(alias, fn) {
    try {
      const org = await getOrg(alias);
      return await fn(org.getConnection(), org);
    } catch (e) {
      if (!SESSION_ERRORS.has(e.errorCode ?? e.name)) throw e;
      orgs.delete(alias);
      const org = await getOrg(alias);
      return fn(org.getConnection(), org);
    }
  }

  return {
    ping: async () => ({ pong: true }),

    status: async () => ({
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      orgs: [...orgs.keys()]
    }),

    reload: async () => {
      orgs.clear();
      await core.StateAggregator.clearInstanceAsync();
      return { reloaded: true };
    },

    org: ({ org }) => withConn(org, (conn, o) => ({
      alias: org, username: o.getUsername(), orgId: o.getOrgId(), instanceUrl: conn.instanceUrl, apiVersion: conn.getApiVersion()
    })),

    query: ({ org, q, tooling, all, raw }) => withConn(org, async conn => {
      const api = tooling ? conn.tooling : conn;
      const result = await api.query(q, { scanAll: Boolean(all) });
      while (!result.done) {
        if (!result.nextRecordsUrl) throw new Error("Incomplete query result: missing nextRecordsUrl.");
        const page = await api.queryMore(result.nextRecordsUrl);
        result.records.push(...page.records);
        result.done = page.done;
        result.nextRecordsUrl = page.nextRecordsUrl;
      }
      return raw ? result : compactQuery(result);
    }),

    apex: ({ org, body }) => withConn(org, conn => new (apex().ExecuteService)(conn).executeAnonymous({ apexCode: body })),

    rest: ({ org, method, url, body, headers }) => withConn(org, conn => conn.request({
      method, url, body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers }
    })),

    describe: ({ org, sobject, tooling, raw }) => withConn(org, async conn => {
      const d = await (tooling ? conn.tooling : conn).describe(sobject);
      return raw ? d : compactDescribe(d);
    }),

    deploy: ({ org, projectDir, sourcePaths, metadata, checkOnly, testLevel, tests, waitMinutes = 33 }) =>
      projectQueue(() => withConn(org, async (conn, o) => {
        const { ComponentSetBuilder } = sdr();
        core.SfProject.clearInstances();
        const project = await core.SfProject.resolve(projectDir);
        const packageDirs = project.getUniquePackageDirectories().map(d => d.fullPath);
        const cs = await ComponentSetBuilder.build({
          projectDir,
          sourceapiversion: project.getSfProjectJson().get("sourceApiVersion"),
          sourcepath: sourcePaths?.length ? sourcePaths : undefined,
          metadata: metadata?.length ? { metadataEntries: metadata, directoryPaths: packageDirs } : undefined
        });
        if (cs.size === 0) throw new Error("Nothing to deploy: no source components matched.");
        // The Metadata API serializes undefined as the string "undefined", so only set what was asked.
        const apiOptions = { checkOnly: Boolean(checkOnly), rollbackOnError: true };
        if (tests?.length) Object.assign(apiOptions, { testLevel: "RunSpecifiedTests", runTests: tests });
        if (testLevel) apiOptions.testLevel = testLevel;
        const deploy = await cs.deploy({ usernameOrConnection: conn, apiOptions });
        const result = await deploy.pollStatus({ frequency: Duration.seconds(2), timeout: Duration.minutes(waitMinutes) });
        // Keep scratch-org source tracking in step, as `sf project deploy start` does.
        if (result.response.success && !checkOnly && (await o.tracksSource())) {
          const st = await tracking().SourceTracking.create({ org: o, project });
          await st.updateTrackingFromDeploy(result);
        }
        return summarizeDeploy(result.response);
      })),

    test: ({ org, classNames, tests, suiteNames, testLevel, codeCoverage, waitMinutes = 60 }) => withConn(org, async conn => {
      const { TestService } = apex();
      const service = new TestService(conn);
      const level = testLevel ?? (classNames?.length || tests?.length || suiteNames?.length ? "RunSpecifiedTests" : "RunLocalTests");
      // apex-node takes comma-separated strings, as the sf flags do.
      const csv = list => (list?.length ? list.join(",") : undefined);
      const payload = await service.buildAsyncPayload(level, csv(tests), csv(classNames), csv(suiteNames));
      const result = await service.runTestAsynchronous(payload, Boolean(codeCoverage), false, undefined, undefined, Duration.minutes(waitMinutes));
      return summarizeTests(result);
    })
  };
}
