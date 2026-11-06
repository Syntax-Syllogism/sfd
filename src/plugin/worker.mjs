// @ts-check
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateOperationModule, effectsExceeding } from "../../packages/sfd-plugin/validate.mjs";
import { errorEnvelope, failure, success } from "./envelope.mjs";
console.log = console.error;
const root = process.env.SFD_PLUGIN_ROOT ?? "";
const req = createRequire(join(root, "package.json"));
/** @type {Map<string, Promise<any>>} */
const connections = new Map();
/** @type {Map<number, AbortController>} */
const calls = new Map();
/** @type {any} */
let mod;
/** @type {string[]} */
let problems = [];
try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const loaded = await import(pathToFileURL(resolve(root, pkg.sfd.operations)).href);
  mod = loaded.default ?? loaded;
  problems = validateOperationModule(mod).filter(p => !p.startsWith("warning: "));
} catch (e) { problems = [errorEnvelope(e).message]; }
/** @param {any} message */
const send = message => { if (process.connected) process.send?.(message); };
/** @param {any} org */
async function connection(org) {
  if (!connections.has(org.username)) {
    const pending = (async () => {
      let core;
      try { core = req("@salesforce/core"); }
      catch (e) {
        throw Object.assign(new Error("Cannot load the plugin's @salesforce/core"), { code: "missing-salesforce-core", actions: ["Add @salesforce/core to the plugin's dependencies"] });
      }
      const authInfo = await core.AuthInfo.create({ username: org.username });
      return core.Connection.create({ authInfo });
    })();
    connections.set(org.username, pending);
    pending.catch(() => { if (connections.get(org.username) === pending) connections.delete(org.username); });
  }
  const conn = await connections.get(org.username);
  if (org.apiVersion) conn.setApiVersion(org.apiVersion);
  return conn;
}
/** @param {any} msg */
async function call(msg) {
  if (problems.length) return failure("invalid-plugin", problems.join("; "));
  const op = mod.operations.find((/** @type {import("../../packages/sfd-plugin/index.js").Operation} */ o) => o.descriptor.id === msg.operation);
  if (!op) return failure("unknown-operation", msg.operation);
  const controller = new AbortController();
  calls.set(msg.id, controller);
  /** @type {string[]} */
  const warnings = [];
  try {
    const parsed = op.descriptor.optionsSchema.safeParse(msg.options ?? {});
    if (!parsed.success) return failure("invalid-options", (parsed.error.issues ?? []).map((/** @type {{path?: (string | number)[], message: string}} */ i) => `${i.path?.join(".") ?? ""}: ${i.message}`).join("; ") || String(parsed.error));
    if (!["run", "plan", "apply"].includes(msg.mode) || (msg.mode === "plan" && op.kind === "read")) return failure("usage", "--plan requires a write operation");
    const ctx = { signal: controller.signal, org: msg.org, projectRoot: msg.projectRoot,
      resolvePath: (/** @type {string} */ p) => resolve(msg.cwd, p),
      onProgress: (/** @type {import("../../packages/sfd-plugin/index.js").ProgressEvent} */ event) => send({ t: "progress", id: msg.id, event }),
      notice: (/** @type {string} */ message) => { warnings.push(message); send({ t: "notice", id: msg.id, message }); } };
    for (let attempt = 0; ; attempt++) {
      let started = false;
      try {
        controller.signal.throwIfAborted();
        const conn = msg.org ? await connection(msg.org) : undefined;
        controller.signal.throwIfAborted();
        started = true;
        if (op.kind === "read") return success(await op.run(conn, parsed.data, ctx), warnings);
        const plan = await op.plan(conn, parsed.data, ctx);
        if (!plan || typeof plan !== "object") return failure("invalid-plan", "Plan must be an object");
        if (effectsExceeding(op.descriptor.effects, plan.effects).length) return failure("plan-exceeds-effects", "Plan exceeds declared effects ceiling");
        if (msg.mode === "plan") return { ...success(plan, warnings), plan };
        // Ask the host to validate this exact plan before applying it.
        send({ t: "plan", id: msg.id, plan });
        await new Promise((resolve, reject) => {
          approvals.set(msg.id, { resolve, reject });
          if (controller.signal.aborted) reject(controller.signal.reason);
        });
        controller.signal.throwIfAborted();
        return { ...success(await op.apply(conn, plan, ctx), warnings), plan };
      } catch (e) {
        const error = /** @type {any} */ (e);
        if (!["INVALID_SESSION_ID", "INVALID_AUTH_HEADER"].includes(error?.errorCode ?? error?.name)) throw e;
        if (msg.org) connections.delete(msg.org.username);
        if (attempt || (started && op.descriptor.retry !== "safe")) throw e;
      }
    }
  } catch (e) { return errorEnvelope(e, op.descriptor.retry); }
  finally { calls.delete(msg.id); approvals.delete(msg.id); }
}
/** @type {Map<number, {resolve: (value?: any) => void, reject: (error: any) => void}>} */
const approvals = new Map();
process.on("message", async message => {
  const msg = /** @type {any} */ (message);
  try {
    if (msg.t === "shutdown") process.exit(0);
    if (msg.t === "auth-changed") { connections.clear(); return; }
    if (msg.t === "abort") { calls.get(msg.id)?.abort(); approvals.get(msg.id)?.reject(new Error("Operation aborted")); return; }
    if (msg.t === "approve") { approvals.get(msg.id)?.resolve(); return; }
    if (msg.t === "reject-plan") { approvals.get(msg.id)?.reject(Object.assign(new Error("Host rejected plan"), { code: "plan-exceeds-effects" })); return; }
    if (msg.t === "stats") { send({ t: "stats", id: msg.id, rss: process.memoryUsage().rss }); return; }
    if (msg.t === "describe") {
      send({ t: "described", id: msg.id, problems, apiVersion: mod?.apiVersion,
        operations: problems.length ? [] : mod.operations.map((/** @type {import("../../packages/sfd-plugin/index.js").Operation} */ op) => {
          const { optionsSchema, ...descriptor } = op.descriptor;
          const shape = /** @type {any} */ (optionsSchema).shape;
          return { ...descriptor, kind: op.kind, jsonSchema: null,
            optionKeys: shape ? Object.keys(shape) : undefined };
        }) });
    }
    if (msg.t === "call") send({ t: "result", id: msg.id, ...await call(msg), rss: process.memoryUsage().rss });
  } catch (e) { send({ t: "result", id: msg.id, ...errorEnvelope(e) }); }
});
process.on("disconnect", () => process.exit(0));
process.on("uncaughtException", error => { send({ t: "fatal", error: errorEnvelope(error) }); process.exit(1); });
