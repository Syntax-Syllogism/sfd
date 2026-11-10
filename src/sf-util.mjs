// Pure helpers shared by the org session and the built-in operations.
// No Salesforce libraries load here; callers pass connections in.
import { UsageError } from "./usage-error.mjs";
import { orgEntry } from "./sf-json.mjs";

/** @typedef {import("./types.js").SfConnection} SfConnection */
/** @typedef {import("./types.js").TraceUser} User */
/** @typedef {import("./types.js").Trace} Trace */

/** @param {Record<string, any>} row A ScratchOrgInfo record. */
export function scratchDetails(row) {
  return {
    status: row.Status, expirationDate: row.ExpirationDate,
    createdBy: row.CreatedBy?.Username, createdDate: row.CreatedDate,
    signupUsername: row.SignupUsername, edition: row.Edition,
    orgName: row.OrgName, namespace: row.Namespace
  };
}

/**
 * @param {Record<string, any>} fields
 * @param {Record<string, any>} org
 * @param {string | undefined} lastUsed
 */
export function rawListEntry(fields, org, lastUsed) {
  /** @type {Record<string, any>} */
  const result = {
    ...orgEntry(fields), lastUsed, alias: org.alias ?? undefined,
    isDefaultUsername: org.isDefault, isDefaultDevHubUsername: org.isDefaultDevHub,
    isScratch: org.type === "Scratch"
  };
  if (org.isDefault || org.isDefaultDevHub) result.defaultMarker = org.isDefault ? "(U)" : "(D)";
  return result;
}

export const soqlString = (/** @type {unknown} */ value) => `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const LOG_FIELDS = "Id, LogUser.Username, Operation, Request, Status, LogLength, StartTime, DurationMilliseconds";
export const LOG_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * @param {SfConnection} conn
 * @returns {Promise<User>}
 */
export async function currentUser(conn) {
  const fields = conn.getAuthInfoFields?.();
  if (fields?.userId) return { id: fields.userId, username: fields.username ?? fields.userId };
  const identity = await conn.identity();
  return { id: identity.user_id, username: identity.username };
}

/** @param {number} count */
export function logCount(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new UsageError("Log count must be a positive integer.");
  return count;
}

/**
 * @param {SfConnection} conn
 * @param {string} [where]
 * @param {number} [count]
 */
export async function logRows(conn, where = "", count = 10) {
  return (await conn.query(`SELECT ${LOG_FIELDS} FROM ApexLog ${where ? `WHERE ${where}` : ""} ORDER BY StartTime DESC LIMIT ${logCount(count)}`)).records;
}

/**
 * @param {SfConnection} conn
 * @param {Record<string, any>} row An ApexLog record.
 */
export async function logBody(conn, row) {
  const body = await conn.request(`/services/data/v${conn.getApiVersion()}/sobjects/ApexLog/${row.Id}/Body`, { responseType: "text" });
  return { id: row.Id, operation: row.Operation, status: row.Status, startTime: row.StartTime,
    length: row.LogLength, duration: row.DurationMilliseconds, body };
}

// Preserve the org-write notice even when the subsequent operation fails.
/**
 * @template {object} T
 * @param {Trace | undefined} trace
 * @param {() => Promise<T>} fn
 */
export async function afterTrace(trace, fn) {
  try { return { ...await fn(), ...(trace ? { trace } : {}) }; }
  catch (error) {
    if (trace) error.trace = trace;
    throw error;
  }
}

/**
 * @param {SfConnection} conn
 * @param {string} userId
 * @returns {Promise<Trace>}
 */
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

/**
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withDeadline(fn) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      /** @type {Promise<never>} */ (new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(), { name: "Timeout" })), 10000); }))
    ]);
  } finally { clearTimeout(timer); }
}

// One queue for operations that touch the local project (deploy and source tracking):
// SDR and source-tracking keep process-wide state, so they must not interleave.
export function serial() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** @type {<T>(fn: () => T | Promise<T>) => Promise<T>} */
  const enqueue = fn => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
  return enqueue;
}

const abortError = () => Object.assign(new Error("Client disconnected; stopped waiting"), { name: "Aborted" });
export const throwIfAborted = (/** @type {AbortSignal | undefined} */ signal) => { if (signal?.aborted) throw abortError(); };

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @param {() => void} onAbort
 * @returns {Promise<T>}
 */
export function abortable(promise, signal, onAbort) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { onAbort(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** @type {(warn: (message: string) => void, operation: string, org: string | undefined, detail: string) => void} */
export const disconnected = (warn, operation, org, detail) => warn(`client disconnected: ${operation} org ${org ?? "(default)"}; ${detail}`);

/**
 * @param {string} name
 * @param {string[]} names
 */
export function metadataSuggestion(name, names) {
  const input = name.toLowerCase();
  const distance = (/** @type {string} */ candidate) => {
    let row = Array.from({ length: input.length + 1 }, (_, i) => i);
    for (const char of candidate.toLowerCase()) {
      const next = [row[0] + 1];
      for (let i = 1; i <= input.length; i++) {
        next[i] = Math.min(next[i - 1] + 1, row[i] + 1, row[i - 1] + (input[i - 1] === char ? 0 : 1));
      }
      row = next;
    }
    return row[input.length];
  };
  return names.find(n => n.toLowerCase().startsWith(input)) ??
    names.map(name => ({ name, distance: distance(name) })).filter(n => n.distance <= 2)
      .sort((a, b) => a.distance - b.distance)[0]?.name;
}
