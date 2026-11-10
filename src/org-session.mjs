// Daemon-wide Salesforce org state: cached orgs and connections, auth-change
// invalidation, org safety types, metadata describes, TraceFlags and API usage.
// Docs: docs/auth-cache.md, docs/request-limits.md, docs/debug-logs.md.
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.mjs";
import { writeOrgTypes } from "./policy.mjs";
import { withBackoff, LIMIT_ERRORS } from "./limit.mjs";
import { asArray } from "./format.mjs";
import { ensureTrace, serial } from "./sf-util.mjs";

/** @typedef {import("./types.js").SfConnection} SfConnection */
/** @typedef {import("./types.js").SfOrg} SfOrg */
/** @typedef {import("./types.js").TraceUser} User */
/** @typedef {import("./types.js").Trace} Trace */
/** @typedef {import("./types.js").MetadataTypeInfo} MetadataTypeInfo */
/** @typedef {import("./types.js").WithConnOptions} WithConnOptions */

const SESSION_ERRORS = new Set(["INVALID_SESSION_ID", "INVALID_AUTH_HEADER"]);

/** @param {string} home */
export function authStamp(home) {
  const stamp = (/** @type {string} */ path) => { try { const s = statSync(path); return [s.mtimeMs, s.size]; } catch { return null; } };
  /** @type {string[]} */
  let names;
  try { names = readdirSync(join(home, ".sfdx")).filter(name => name.endsWith(".json")).sort(); }
  catch { names = []; }
  // Auth file contents change on token refresh; only the filename set matters here.
  return JSON.stringify([names, ...[ [".sfdx", "alias.json"], [".sf", "alias.json"],
    [".sf", "config.json"], [".sfdx", "sfdx-config.json"] ].map(parts => stamp(join(home, ...parts)))]);
}

export function rwlock() {
  let readers = 0, writing = false;
  /** @type {{ write: boolean, start: () => Promise<void> }[]} */
  const waiting = [];
  function drain() {
    if (writing || readers || !waiting.length) return;
    if (waiting[0].write) { writing = true; waiting.shift().start(); return; }
    while (waiting.length && !waiting[0].write) { readers++; waiting.shift().start(); }
  }
  /**
   * @template T
   * @param {boolean} write
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function run(write, fn) {
    return new Promise((resolve, reject) => {
      waiting.push({ write, start: async () => {
        try { resolve(await fn()); } catch (error) { reject(error); }
        finally { if (write) writing = false; else readers--; drain(); }
      } });
      // Admit concurrent readers only until a writer is queued.
      if (!write && !writing && !waiting.some(item => item.write)) {
        while (waiting.length) { readers++; waiting.shift().start(); }
      } else drain();
    });
  }
  return {
    /** @type {<T>(fn: () => Promise<T>) => Promise<T>} */
    read: fn => run(false, fn),
    /** @type {<T>(fn: () => Promise<T>) => Promise<T>} */
    write: fn => run(true, fn)
  };
}

/**
 * @typedef {object} OrgSessionOptions
 * @property {any} core The loaded `@salesforce/core` module.
 * @property {string} home
 * @property {NodeJS.ProcessEnv} env
 * @property {(username?: string) => void} [onAuthChanged]
 */
/**
 * @param {OrgSessionOptions} options
 * @returns {import("./types.js").OrgSession}
 */
export function createOrgSession({ core, home, env, onAuthChanged = () => {} }) {
  /** @type {Map<string | undefined, Promise<SfOrg>>} */
  const orgs = new Map();
  /** @type {Map<string, { used: number, limit: number }>} */
  const apiUsage = new Map();
  /** @type {Map<string, Promise<string>>} */
  const safetyTypes = new Map();
  /** @type {Record<string, string>} */
  const cachedTypes = Object.create(null);
  /** @type {Record<string, string>} */
  const cachedUsernames = Object.create(null);
  const runtimeDir = () => paths(env).dir;
  /** @type {string | undefined} */
  let lastWritten;
  /** @param {Record<string, unknown>} entries */
  function persistOrgTypes(entries) {
    const text = JSON.stringify(entries);
    if (text === lastWritten) return;
    try {
      writeOrgTypes(runtimeDir(), entries);
      lastWritten = text;
    } catch (e) { console.error(`sfd: could not write org types: ${e.message}`); }
  }
  function clearSafetyTypes() {
    safetyTypes.clear();
    for (const key of Object.keys(cachedTypes)) delete cachedTypes[key];
    for (const key of Object.keys(cachedUsernames)) delete cachedUsernames[key];
    persistOrgTypes(cachedTypes);
  }
  /** @type {Map<string | undefined, Map<string, Promise<MetadataTypeInfo[]>>>} */
  const typeCache = new Map();
  /** @type {Map<string | undefined, Trace & { userId: string }>} */
  const traces = new Map();
  const traceQueue = serial();
  /** @type {(conn: SfConnection, alias: string | undefined, user: User, noTrace: boolean | undefined) => Promise<(Trace & { username: string }) | undefined> | undefined} */
  const traceFor = (conn, alias, user, noTrace) => noTrace ? undefined : traceQueue(async () => {
    const cached = traces.get(alias);
    if (cached?.userId === user.id && Date.parse(cached.expires) > Date.now() + 300000) return undefined;
    const trace = await ensureTrace(conn, user.id);
    traces.set(alias, { ...trace, userId: user.id });
    return trace.action === "existing" ? undefined : { ...trace, username: user.username };
  });
  let stamp = authStamp(home);

  const lock = rwlock();
  /** @type {Map<string | undefined, string>} */
  const usernames = new Map();
  /**
   * @param {"all" | { alias?: string, username?: string }} scope
   * @param {string} [observedStamp]
   */
  async function invalidate(scope, observedStamp) {
    return lock.write(async () => {
      if (observedStamp !== undefined && observedStamp === stamp) return;
      if (scope === "all") {
        onAuthChanged();
        orgs.clear(); usernames.clear(); traces.clear(); typeCache.clear(); apiUsage.clear();
        clearSafetyTypes();
        await core.StateAggregator.clearInstanceAsync();
        if (observedStamp !== undefined) stamp = observedStamp;
      } else {
        const { alias, username } = scope;
        onAuthChanged(username);
        const keys = new Set([alias, username]);
        if (username) for (const [key, value] of usernames) if (value === username) keys.add(key);
        for (const key of keys) { orgs.delete(key); usernames.delete(key); traces.delete(key); typeCache.delete(key); }
      }
    });
  }
  async function refreshIfAuthChanged() {
    const now = authStamp(home);
    if (now !== stamp) await invalidate("all", now);
  }

  /**
   * @param {string | undefined} alias
   * @returns {Promise<SfOrg>}
   */
  async function getOrg(alias) {
    await refreshIfAuthChanged();
    return lock.read(async () => {
      if (!orgs.has(alias)) {
        const pending = core.Org.create({ aliasOrUsername: alias });
        orgs.set(alias, pending);
        pending.catch(() => { if (orgs.get(alias) === pending) orgs.delete(alias); });
      }
      const org = await /** @type {Promise<SfOrg>} */ (orgs.get(alias));
      usernames.set(alias, org.getUsername());
      return org;
    });
  }

  // Only retry an operation after it starts when its caller declares it safe.
  /**
   * @template T
   * @param {string | undefined} alias
   * @param {(conn: SfConnection, org: SfOrg) => T | Promise<T>} fn
   * @param {WithConnOptions} [options]
   * @returns {Promise<T>}
   */
  async function withConn(alias, fn, { retry = false, backoff = retry, write = "write", deployId } = {}) {
    /** @type {(conn: SfConnection, org: SfOrg) => Promise<T>} */
    const invoke = async (conn, org) => {
      try {
        return await (backoff ? withBackoff(() => fn(conn, org)) : fn(conn, org));
      } catch (error) {
        const code = error.errorCode ?? error.name;
        const usage = conn.limitInfo?.apiUsage;
        if (LIMIT_ERRORS.has(code)) {
          if (!error.message.includes(code)) error.message = `${code}: ${error.message}`;
          if (usage) error.message += ` (API usage ${usage.used}/${usage.limit})`;
        }
        throw error;
      } finally {
        if (conn.limitInfo?.apiUsage) apiUsage.set(alias ?? org.getUsername(), { ...conn.limitInfo.apiUsage });
      }
    };
    let started = false;
    /** @type {SfOrg | undefined} */
    let org;
    try {
      org = await getOrg(alias);
      const conn = org.getConnection();
      started = true;
      return await invoke(conn, org);
    } catch (e) {
      if (!SESSION_ERRORS.has(e.errorCode ?? e.name)) throw e;
      await invalidate({ alias, username: org?.getUsername() });
      if (started && !retry) {
        const guidance = write === "retrieve"
          ? "Local files may or may not have changed. Check the local project; re-running retrieve is safe."
          : `The change may or may not have been applied. Check the org${deployId?.() ? ` (deploy ID: ${deployId()})` : " (e.g. deploy status or records)"}, then run the command again.`;
        throw Object.assign(new Error(`Salesforce session expired during ${write}. ${guidance} The cached connection was invalidated and will be refreshed on the next command.`),
          { name: "SessionExpired", errorCode: e.errorCode ?? e.name });
      }
      org = await getOrg(alias);
      return await invoke(org.getConnection(), org);
    }
  }

  /** @param {string | undefined} alias */
  async function orgType(alias) {
    const org = await getOrg(alias);
    const username = org.getUsername();
    if (!safetyTypes.has(username)) {
      const pending = (async () => {
        try {
          const auth = await core.AuthInfo.create({ username });
          const fields = auth.getFields();
          if (fields.expirationDate || fields.devHubUsername) return "scratch";
          const result = await withConn(alias, conn => conn.query("SELECT IsSandbox, OrganizationType, TrialExpirationDate FROM Organization"), { retry: true });
          const row = result.records?.[0];
          return row?.IsSandbox === true ? "sandbox" : row?.IsSandbox === false ? "production" : "unknown";
        } catch { return "unknown"; }
      })();
      safetyTypes.set(username, pending);
    }
    const type = /** @type {string} */ (await safetyTypes.get(username));
    cachedTypes[username] = type;
    if (alias) { cachedTypes[alias] = type; cachedUsernames[alias] = username; }
    persistOrgTypes({ ...cachedTypes, $usernames: cachedUsernames });
    return type;
  }

  /**
   * @param {string | undefined} alias
   * @param {SfConnection} conn
   */
  async function metadataTypes(alias, conn) {
    const apiVersion = conn.getApiVersion();
    let versions = typeCache.get(alias);
    if (!versions) typeCache.set(alias, versions = new Map());
    const cached = versions.has(apiVersion);
    if (!cached) {
      /** @type {Promise<MetadataTypeInfo[]>} */
      const pending = conn.metadata.describe(apiVersion).then((/** @type {any} */ result) => asArray(result.metadataObjects)
        .map((/** @type {any} */ t) => ({ name: t.xmlName, inFolder: Boolean(t.inFolder), children: asArray(t.childXmlNames) }))
        .sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name)));
      versions.set(apiVersion, pending);
      pending.catch(() => { if (versions.get(apiVersion) === pending) versions.delete(apiVersion); });
    }
    return { types: /** @type {MetadataTypeInfo[]} */ (await versions.get(apiVersion)), apiVersion, cached };
  }

  return {
    getOrg, withConn, orgType, metadataTypes, traceFor, invalidate, refreshIfAuthChanged, runtimeDir,
    cachedOrgs: () => [...orgs.keys()],
    forgetOrg: key => { orgs.delete(key); },
    cachedType: username => cachedTypes[username],
    apiUsage: () => Object.fromEntries(apiUsage),
    sizes: () => ({ orgs: orgs.size, traces: traces.size, typeCache: typeCache.size, safetyTypes: safetyTypes.size })
  };
}
