// Composition root: loads the Salesforce libraries, creates the org session and
// turns each built-in descriptor (src/ops/) into a request handler.
import { homedir } from "node:os";
import { policyLoader, checkPolicy } from "./policy.mjs";
import { sfRequire } from "./sf-root.mjs";
import { createPluginHandler } from "./plugin/handler.mjs";
import { createOrgSession } from "./org-session.mjs";
import { ensureTrace, metadataSuggestion, serial, throwIfAborted } from "./sf-util.mjs";
import { ops } from "./ops/index.mjs";

export { ensureTrace, metadataSuggestion, serial };

/** @typedef {import("./types.js").Handler} Handler */
/** @typedef {import("./types.js").BuiltinOp} BuiltinOp */
/** @typedef {import("./types.js").OpContext} OpContext */

/**
 * @typedef {object} HandlerOptions
 * @property {string} [home]
 * @property {(id: string) => any} [load]
 * @property {any} [supervisor]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {(username?: string) => void} [onAuthChanged]
 * @property {(message: string) => void} [log]
 */
/**
 * @param {string} sfRoot
 * @param {HandlerOptions} [options]
 */
export function createHandlers(sfRoot, { home = homedir(), load = sfRequire(sfRoot), supervisor, env = process.env, onAuthChanged = () => {}, log = console.error } = {}) {
  // The Salesforce libraries are loaded from the user's sf install at runtime.
  const core = load("@salesforce/core");
  const { Duration } = load("@salesforce/kit");
  const lazy = (/** @type {string} */ name) => { /** @type {any} */ let mod; return () => (mod ??= load(name)); };
  const sdr = lazy("@salesforce/source-deploy-retrieve");
  const apex = lazy("@salesforce/apex-node");
  const tracking = lazy("@salesforce/source-tracking");
  const enqueueProject = serial();
  let inProjectQueue = false;
  /** @type {<T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>} */
  const projectQueue = (fn, signal) => enqueueProject(async () => {
    throwIfAborted(signal);
    inProjectQueue = true;
    try { return await fn(); } finally { inProjectQueue = false; }
  });
  function clearProjects() {
    if (!inProjectQueue) throw new Error("SfProject.clearInstances outside projectQueue");
    core.SfProject.clearInstances();
  }
  const session = createOrgSession({ core, home, env, onAuthChanged });
  const getPolicy = policyLoader({ home, env });

  const plugin = supervisor && createPluginHandler({ supervisor, projectQueue, refreshAuth: session.refreshIfAuthChanged,
    suggest: metadataSuggestion,
    policyCheck: (/** @type {any} */ input) => checkPolicy({ ...input, policy: getPolicy(), runtimeDir: session.runtimeDir() }),
    resolveOrg: async (/** @type {string | undefined} */ alias) => {
      const org = await session.getOrg(alias);
      const conn = org.getConnection();
      return { alias, username: org.getUsername(), apiVersion: conn.getApiVersion(), instanceUrl: conn.instanceUrl, type: await session.orgType(alias) };
    }
  });

  /**
   * @param {string} operation
   * @param {import("./types.js").Request} args
   * @param {string[]} effects
   */
  async function policyGate(operation, args, effects) {
    const policy = getPolicy();
    // Default reads need no org lookup; custom read restrictions still apply.
    if (effects[0] !== "read" || Object.values(policy.rules).some(row => row.read !== "allow")) {
      const org = await session.withConn(args.org, (_conn, found) => found, { retry: true });
      const { confirm, op, v, raw, ...options } = args;
      checkPolicy({ operation, username: org.getUsername(), alias: args.org, options, effects,
        orgType: await session.orgType(args.org), policy, runtimeDir: session.runtimeDir(), confirm });
    }
    // Default reads always resolve to "allow", so the confirmation store (runtimeDir) is never used here.
    else checkPolicy(/** @type {import("./policy.mjs").PolicyCheck} */ ({ operation, options: {}, effects, policy }));
  }

  // Policy first, then the project queue, then the connection: the order the handlers always used.
  /** @type {(op: BuiltinOp) => Handler} */
  const wrap = op => async (args, transport) => {
    if (op.policy) await policyGate(op.name, args, op.effects(args));
    /** @type {OpContext} */
    const ctx = { session, core, Duration, sdr, apex, tracking, home, getPolicy, clearProjects,
      signal: transport?.signal, emit: transport?.emit, warn: transport?.log?.warn ?? log, state: {} };
    const exec = () => {
      if (op.needsOrg === false) return op.run(ctx, args);
      const retry = (typeof op.retry === "function" ? op.retry(args) : op.retry) === "safe";
      return session.withConn(args.org, (conn, org) => op.run({ ...ctx, conn, org }, args),
        { retry, backoff: op.backoff ?? retry, write: op.write, deployId: () => ctx.state.deployId });
    };
    return op.project ? projectQueue(exec, transport?.signal) : exec();
  };

  /** @type {Record<string, Handler>} */
  const handlers = { ...(plugin ? { plugin } : {}) };
  for (const op of ops) handlers[op.name] = wrap(op);
  Object.defineProperties(handlers, {
    sizes: { value: session.sizes },
    clearProjects: { value: clearProjects }
  });
  return handlers;
}
