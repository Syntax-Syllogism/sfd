import { refreshTableMetadata } from "./table-cache.mjs";
// @ts-check
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { effectsExceeding } from "../../packages/sfd-plugin/validate.mjs";
import { pluginFingerprint } from "./protocol.mjs";
import { failure } from "./envelope.mjs";
/** @typedef {import('./discover.mjs').PluginInfo} PluginInfo */
/** @typedef {{child: import('node:child_process').ChildProcess, fingerprint: string, pending: Map<number, any>, ready: Promise<any>, timer?: NodeJS.Timeout, active: number, operations: any[], problems: string[], rss?: number}} WorkerState */
/** @param {{discover: (force?: boolean) => PluginInfo[], workerPath?: string, idleMs?: number, env?: NodeJS.ProcessEnv, log?: (...args: any[]) => void, startTimeoutMs?: number, abortTimeoutMs?: number}} config */
export function createSupervisor({ discover, workerPath = fileURLToPath(new URL("./worker.mjs", import.meta.url)), idleMs = 30 * 60_000, env = process.env, log = console.error, startTimeoutMs = 30_000, abortTimeoutMs = 5000 }) {
  /** @type {Map<string, WorkerState>} */
  const workers = new Map();
  let sequence = 0;
  let closed = false;
  /** @param {WorkerState} state @param {string} [code] */
  function stop(state, code = "worker-crashed") {
    for (const [root, worker] of workers) if (worker === state) workers.delete(root);
    for (const pending of state.pending.values()) pending.finish(failure(code, `Plugin worker stopped (${code})`));
    state.pending.clear();
    clearTimeout(state.timer);
    state.child.send?.({ t: "shutdown" }, () => {});
    const timer = setTimeout(() => state.child.kill(), 2000);
    timer.unref();
    state.child.once("exit", () => clearTimeout(timer));
  }
  /** @param {WorkerState} state */
  function armIdle(state) {
    clearTimeout(state.timer);
    if (state.active) return;
    state.timer = setTimeout(() => {
      for (const [root, worker] of workers) if (worker === state) workers.delete(root);
      stop(state, "worker-idle");
    }, idleMs);
    state.timer.unref();
  }
  /** @param {WorkerState} state @param {any} message @param {{onEvent?: (event: any) => void, signal?: AbortSignal, descriptor?: any, onPlan?: (plan: any) => any, timeoutMs?: number}} [options] @returns {Promise<any>} */
  function request(state, message, { onEvent, signal, descriptor, onPlan, timeoutMs } = {}) {
    if (signal?.aborted) return Promise.resolve(failure("aborted", "Operation aborted"));
    const id = ++sequence;
    return new Promise(resolve => {
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const abort = () => {
        state.child.send({ t: "abort", id }, () => {});
        timer = setTimeout(() => {
          for (const [root, worker] of workers) if (worker === state) workers.delete(root);
          state.child.kill();
        }, abortTimeoutMs);
        timer.unref();
      };
      const finish = (/** @type {any} */ result) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        state.pending.delete(id);
        resolve(result);
      };
      state.pending.set(id, { finish, onEvent, descriptor, onPlan });
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs) timer = setTimeout(() => { finish(failure("worker-start-timeout", "Plugin worker did not start in time")); stop(state); }, timeoutMs);
      state.child.send({ ...message, id }, error => { if (error) finish(failure("worker-crashed", error.message)); });
    });
  }
  function refresh(force = false) {
    const plugins = discover(force);
    for (const [root, state] of workers) {
      const plugin = plugins.find(p => p.root === root);
      if (!plugin || pluginFingerprint([plugin]) !== state.fingerprint) { workers.delete(root); stop(state, "plugin-changed"); }
    }
    return plugins;
  }
  /** @param {PluginInfo} plugin */
  function start(plugin) {
    let state = workers.get(plugin.root);
    if (state) return state;
    const child = fork(workerPath, [], { serialization: "advanced", env: { ...env, SFD_PLUGIN_ROOT: plugin.root }, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    if (child.stderr) {
      child.stderr.once("data", () => log("plugin stderr", { source: "plugin", root: plugin.root }));
      child.stderr.resume();
    }
    state = { child, fingerprint: pluginFingerprint([plugin]), pending: new Map(), ready: Promise.resolve(), active: 0, operations: [], problems: [] };
    const worker = state;
    workers.set(plugin.root, worker);
    child.on("message", message => {
      const msg = /** @type {any} */ (message);
      if (typeof msg.rss === "number") worker.rss = msg.rss;
      const pending = worker.pending.get(msg.id);
      if (!pending) return;
      if (msg.t === "progress" || msg.t === "notice") {
        pending.onEvent?.(msg.t === "progress" ? { event: "progress", ...msg.event } : { event: "notice", message: msg.message });
      } else if (msg.t === "plan") {
        let valid = false;
        try { valid = Boolean(msg.plan && !effectsExceeding(pending.descriptor.effects, msg.plan.effects).length); } catch {}
        if (valid && pending.onPlan) {
          try { pending.onPlan(msg.plan); }
          catch (e) {
            const error = /** @type {any} */ (e);
            pending.finish({ policyError: { ...error, name: error.name, message: error.message } });
            valid = false;
          }
        }
        child.send({ t: valid ? "approve" : "reject-plan", id: msg.id }, () => {});
      } else if (msg.t === "result") {
        const { t, id, rss, ...result } = msg;
        pending.finish(result);
      } else pending.finish(msg);
    });
    const died = () => {
      if (workers.get(plugin.root) === worker) workers.delete(plugin.root);
      clearTimeout(worker.timer);
      for (const pending of [...worker.pending.values()]) pending.finish(failure("worker-crashed", "Plugin worker crashed"));
    };
    child.on("exit", died);
    child.on("error", error => { log(error.message); died(); });
    worker.ready = request(worker, { t: "describe" }, { timeoutMs: startTimeoutMs }).then(reply => {
      worker.operations = reply.operations ?? [];
      worker.problems = reply.problems ?? (reply.ok === false ? [reply.message] : []);
      armIdle(worker);
      return reply;
    });
    return worker;
  }
  /** @param {PluginInfo} plugin */
  async function describePlugin(plugin) {
    if (closed) return { operations: [], problems: ["Supervisor is shut down"] };
    if (plugin.problems.length) return { operations: [], problems: plugin.problems };
    const worker = start(plugin);
    return worker.ready;
  }
  return {
    refresh,
    describe: describePlugin,
    async status() {
      return refresh().map(plugin => {
        const worker = workers.get(plugin.root);
        return { name: plugin.name, worker: worker ? (worker.active ? "running" : "idle") : "stopped", pid: worker?.child.pid, rss: worker?.rss };
      });
    },
    async list() {
      const plugins = refresh(true);
      const result = [];
      const owners = new Map();
      for (const plugin of plugins) {
        const described = await describePlugin(plugin);
        const problems = [...plugin.problems, ...(described.problems ?? [])];
        for (const op of described.operations ?? []) {
          if (owners.has(op.id)) problems.push(`Duplicate operation ${op.id}; first declared by ${owners.get(op.id)}`);
          else owners.set(op.id, plugin.name);
        }
        const worker = workers.get(plugin.root);
        if (worker) {
          const stats = await request(worker, { t: "stats" }, { timeoutMs: startTimeoutMs });
          worker.rss = stats.rss;
        }
        result.push({ ...plugin, operations: described.operations ?? [], problems: [...new Set(problems)],
          worker: worker ? (worker.active ? "running" : "idle") : "stopped", pid: worker?.child.pid, rss: worker?.rss });
      }
      refreshTableMetadata(result, env);
      return result;
    },
    /** @param {PluginInfo} plugin @param {any} req @param {{onEvent?: (event: any) => void, signal?: AbortSignal, descriptor: any, onPlan?: (plan: any) => any}} options */
    async call(plugin, req, options) {
      if (closed) return failure("worker-crashed", "Supervisor is shut down");
      if (plugin.problems.length) return failure("invalid-plugin", plugin.problems.join("; "));
      const worker = start(plugin);
      worker.active++;
      clearTimeout(worker.timer);
      try {
        const described = await worker.ready;
        if (described.ok === false) return described;
        if (worker.problems.length) return failure("invalid-plugin", worker.problems.join("; "));
        return await request(worker, { ...req, t: "call" }, options);
      } finally { worker.active--; if (workers.get(plugin.root) === worker) armIdle(worker); }
    },
    /** @param {string} username */
    authChanged(username) { for (const worker of workers.values()) worker.child.send({ t: "auth-changed", username }, () => {}); },
    shutdown() { closed = true; for (const worker of workers.values()) stop(worker); workers.clear(); }
  };
}
