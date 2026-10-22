import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./usage-error.mjs";
import { sfRequire } from "./sf-root.mjs";
import { compactDescribe, compactQuery, summarizeDeploy, summarizeTests, summarizeRetrieve, summarizeChanges } from "./format.mjs";

const soqlString = value => `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const LOG_FIELDS = "Id, LogUser.Username, Operation, Request, Status, LogLength, StartTime, DurationMilliseconds";
const LOG_CLOCK_SKEW_MS = 5 * 60 * 1000;

async function currentUser(conn) {
  const fields = conn.getAuthInfoFields?.();
  if (fields?.userId) return { id: fields.userId, username: fields.username ?? fields.userId };
  const identity = await conn.identity();
  return { id: identity.user_id, username: identity.username };
}

function logCount(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new UsageError("Log count must be a positive integer.");
  return count;
}

async function logRows(conn, where = "", count = 10) {
  return (await conn.query(`SELECT ${LOG_FIELDS} FROM ApexLog ${where ? `WHERE ${where}` : ""} ORDER BY StartTime DESC LIMIT ${logCount(count)}`)).records;
}

async function logBody(conn, row) {
  const body = await conn.request(`/services/data/v${conn.getApiVersion()}/sobjects/ApexLog/${row.Id}/Body`, { responseType: "text" });
  return { id: row.Id, operation: row.Operation, status: row.Status, startTime: row.StartTime,
    length: row.LogLength, duration: row.DurationMilliseconds, body };
}

// Preserve the org-write notice even when the subsequent operation fails.
async function afterTrace(trace, fn) {
  try { return { ...await fn(), ...(trace ? { trace } : {}) }; }
  catch (error) {
    if (trace) error.trace = trace;
    throw error;
  }
}

export async function ensureTrace(conn, userId) {
  const now = Date.now();
  const flags = await conn.tooling.query(`SELECT Id, ExpirationDate, StartDate FROM TraceFlag WHERE TracedEntityId = ${soqlString(userId)} AND LogType = 'DEVELOPER_LOG'`);
  const flag = flags.records.find(f => Date.parse(f.StartDate) <= now && Date.parse(f.ExpirationDate) > now + 300000) ?? flags.records[0];
  if (flag && Date.parse(flag.StartDate) <= now && Date.parse(flag.ExpirationDate) > now + 300000) {
    return { action: "existing", id: flag.Id, expires: flag.ExpirationDate };
  }
  const dates = { StartDate: new Date(now).toISOString(), ExpirationDate: new Date(now + 1800000).toISOString() };
  let result;
  if (flag) {
    result = await conn.tooling.sobject("TraceFlag").update({ Id: flag.Id, ...dates });
  } else {
    const levels = await conn.tooling.query("SELECT Id FROM DebugLevel WHERE DeveloperName = 'SFD' LIMIT 1");
    let levelId = levels.records[0]?.Id;
    if (!levelId) {
      const level = await conn.tooling.sobject("DebugLevel").create({ DeveloperName: "SFD", MasterLabel: "SFD",
        ApexCode: "FINE", ApexProfiling: "INFO", Callout: "INFO", Database: "INFO", System: "DEBUG",
        Validation: "INFO", Visualforce: "NONE", Workflow: "INFO", Wave: "NONE", Nba: "NONE" });
      if (!level.success) throw new Error(`Cannot create debug level: ${JSON.stringify(level.errors)}`);
      levelId = level.id;
    }
    result = await conn.tooling.sobject("TraceFlag").create({ TracedEntityId: userId, LogType: "DEVELOPER_LOG", DebugLevelId: levelId, ...dates });
  }
  if (!result.success) throw new Error(`Cannot enable debug logging: ${JSON.stringify(result.errors)}`);
  return { action: flag ? "extended" : "created", id: flag?.Id ?? result.id, expires: dates.ExpirationDate };
}

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
  const traces = new Map();
  const traceQueue = serial();
  const traceFor = (conn, alias, user, noTrace) => noTrace ? undefined : traceQueue(async () => {
    const cached = traces.get(alias);
    if (cached?.userId === user.id && Date.parse(cached.expires) > Date.now() + 300000) return undefined;
    const trace = await ensureTrace(conn, user.id);
    traces.set(alias, { ...trace, userId: user.id });
    return trace.action === "existing" ? undefined : { ...trace, username: user.username };
  });
  let stamp = authStamp(home);

  async function getOrg(alias) {
    const now = authStamp(home);
    if (now !== stamp) {
      stamp = now;
      orgs.clear();
      traces.clear();
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
      traces.delete(alias);
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
      traces.clear();
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

    retrieve: ({ org, projectDir, sourcePaths, metadata, manifest, ignoreConflicts = false, waitMinutes = 33 }) =>
      projectQueue(() => withConn(org, async (conn, o) => {
        core.SfProject.clearInstances();
        const project = await core.SfProject.resolve(projectDir);
        const tracked = await o.tracksSource();
        const changesOnly = !sourcePaths?.length && !metadata?.length && !manifest;
        if (changesOnly && !tracked) throw new UsageError("retrieve needs -d, -m or -x on an org without source tracking.");
        // Handle conflicts and tracking explicitly: daemon requests must not leave lifecycle listeners behind.
        const st = tracked ? await tracking().SourceTracking.create({ org: o, project, ignoreConflicts, ignoreLocalCache: true }) : undefined;
        const conflicts = st && !ignoreConflicts ? await st.getConflicts() : [];
        let cs;
        let deletedFiles = [];
        const refusal = entries => ({ success: false, status: "Conflicts", files: [], warnings: [], conflicts: summarizeChanges(entries, projectDir, "Conflict") });
        if (changesOnly) {
          // Remote deletes write to disk, so refuse before asking STL to apply any of them.
          if (conflicts.length) return refusal(conflicts);
          const targets = await st.maybeApplyRemoteDeletesToLocal(true);
          cs = targets.componentSetFromNonDeletes;
          deletedFiles = targets.fileResponsesFromDelete;
        } else {
          const packageDirs = project.getUniquePackageDirectories().map(d => d.fullPath);
          cs = await sdr().ComponentSetBuilder.build({
            projectDir,
            sourceapiversion: project.getSfProjectJson().get("sourceApiVersion"),
            sourcepath: sourcePaths?.length ? sourcePaths : undefined,
            metadata: metadata?.length ? { metadataEntries: metadata, directoryPaths: packageDirs } : undefined,
            ...(manifest ? { manifest: { manifestPath: manifest, directoryPaths: packageDirs } } : {})
          });
          const selectedConflicts = conflicts.filter(c => cs.has({ type: c.type, fullName: c.name }));
          if (selectedConflicts.length) return refusal(selectedConflicts);
        }
        if (cs.size === 0) {
          if (!changesOnly) throw new Error("Nothing to retrieve: no components matched.");
          return { success: true, status: "Succeeded", files: summarizeChanges(deletedFiles, projectDir), warnings: [], conflicts: [],
            ...(!deletedFiles.length ? { message: "No remote changes to retrieve." } : {}) };
        }
        const retrieve = await cs.retrieve({ usernameOrConnection: conn, output: project.getDefaultPackage().fullPath, merge: true, format: "source" });
        const result = await retrieve.pollStatus({ frequency: Duration.seconds(2), timeout: Duration.minutes(waitMinutes) });
        if (st && result.response.success) await st.updateTrackingFromRetrieve(result);
        const summary = summarizeRetrieve(result, projectDir);
        summary.files.unshift(...summarizeChanges(deletedFiles, projectDir));
        return summary;
      })),

    tracking: ({ org, projectDir, local = false, remote = false, conflicts: conflictsOnly = false }) =>
      projectQueue(() => withConn(org, async (conn, o) => {
        if (!(await o.tracksSource())) throw new UsageError("tracking requires an org with source tracking.");
        core.SfProject.clearInstances();
        const project = await core.SfProject.resolve(projectDir);
        const st = await tracking().SourceTracking.create({ org: o, project, ignoreLocalCache: true });
        const rows = conflictsOnly ? [] : await st.getStatus({ local: !remote, remote: !local });
        return {
          local: summarizeChanges(rows.filter(r => r.origin === "local" && !r.ignored), projectDir),
          remote: summarizeChanges(rows.filter(r => r.origin === "remote" && !r.ignored), projectDir),
          conflicts: summarizeChanges(await st.getConflicts(), projectDir, "Conflict")
        };
      })),

    logs: ({ org, count = 10, user, noTrace }) => withConn(org, async conn => {
      logCount(count);
      const trace = await traceFor(conn, org, await currentUser(conn), noTrace);
      return afterTrace(trace, async () => ({
        records: await logRows(conn, user ? `LogUser.Username = ${soqlString(user)}` : "", count)
      }));
    }),

    logGet: ({ org, id, noTrace }) => withConn(org, async conn => {
      if (id !== "latest" && !/^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(id)) throw new UsageError("logs get needs an ApexLog ID or latest.");
      const user = await currentUser(conn);
      const trace = await traceFor(conn, org, user, noTrace);
      return afterTrace(trace, async () => {
        const rows = await logRows(conn, id === "latest" ? `LogUserId = ${soqlString(user.id)}` : `Id = ${soqlString(id)}`, 1);
        if (!rows.length) throw new Error("No debug logs found.");
        return logBody(conn, rows[0]);
      });
    }),

    test: ({ org, classNames, tests, suiteNames, testLevel, codeCoverage, logs, noTrace, waitMinutes = 60 }) => withConn(org, async conn => {
      const user = logs ? await currentUser(conn) : undefined;
      const trace = logs ? await traceFor(conn, org, user, noTrace) : undefined;
      return afterTrace(trace, async () => {
        const { TestService } = apex();
        const service = new TestService(conn);
        const level = testLevel ?? (classNames?.length || tests?.length || suiteNames?.length ? "RunSpecifiedTests" : "RunLocalTests");
        // apex-node takes comma-separated strings, as the sf flags do.
        const csv = list => (list?.length ? list.join(",") : undefined);
        const payload = await service.buildAsyncPayload(level, csv(tests), csv(classNames), csv(suiteNames));
        const startedAt = new Date(Math.floor((Date.now() - LOG_CLOCK_SKEW_MS) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
        const result = await service.runTestAsynchronous(payload, Boolean(codeCoverage), false, undefined, undefined, Duration.minutes(waitMinutes));
        const summary = summarizeTests(result);
        if (logs) {
          // Pad both bounds for clock skew, rounding outward to whole-second SOQL literals.
          const finishedAt = new Date(Math.ceil((Date.now() + LOG_CLOCK_SKEW_MS) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
          const rows = await logRows(conn, `LogUserId = ${soqlString(user.id)} AND StartTime >= ${startedAt} AND StartTime <= ${finishedAt}`, 10);
          summary.logs = summary.failing > 0 || summary.failures.length || summary.setupFailures.length
            ? await Promise.all(rows.map(row => logBody(conn, row))) : rows.map(row => ({ id: row.Id }));
        }
        return summary;
      });
    })
  };
}
