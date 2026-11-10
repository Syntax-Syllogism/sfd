import net from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { isPipe } from "./paths.mjs";

// Newline-delimited JSON over a Unix socket: one request and one response per connection.
// Responses are {status: 0, result} | {status: 1, name, message} | {restart: true}.

export class AlreadyRunning extends Error {}

/** @typedef {import("./types.js").Response} Response */
/** @typedef {import("./types.js").Transport} Transport */

/**
 * @param {string} socket
 * @returns {Promise<boolean>}
 */
function probe(socket) {
  return new Promise(resolve => {
    const s = net.connect(socket, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

/**
 * @param {net.Server} server
 * @param {string} socket
 * @returns {Promise<void>}
 */
function listenOnce(server, socket) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => { server.off("error", reject); resolve(); });
  });
}

/** @type {import("./types.js").Logger} */
const noopLog = { info() {}, warn() {}, child() { return this; } };

/**
 * @typedef {object} ServerOptions
 * @property {string} socket
 * @property {string} version Protocol version; requests with another `v` get `{restart: true}`.
 * @property {Record<string, import("./types.js").Handler>} handlers
 * @property {import("./types.js").Logger} [log]
 * @property {number} [idleMs]
 * @property {number} [maxRequestBytes]
 * @property {number} [readTimeoutMs]
 * @property {() => boolean} [isStale]
 * @property {(reason: string) => void} [onExit]
 */

/** @param {ServerOptions} options */
export async function startServer({ socket, version, handlers, log = noopLog, idleMs = 60 * 60_000, maxRequestBytes = 8 * 1024 * 1024, readTimeoutMs = 30_000, isStale = () => false, onExit = () => {} }) {
  let seq = 0;
  let active = 0;
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;
  /** @type {string | undefined} */
  let draining;
  let exited = false;

  const maybeExit = () => {
    if (draining && active === 0 && !exited) {
      exited = true;
      onExit(draining);
    }
  };

  // Stop accepting connections and free the socket path right away, so a replacement
  // daemon can bind it, but let in-flight requests (deploys, test runs) finish.
  /** @param {string} reason */
  const drain = reason => {
    if (draining) return;
    draining = reason;
    clearTimeout(idleTimer);
    server.close();
    if (!isPipe(socket)) try { unlinkSync(socket); } catch {}
    maybeExit();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => active === 0 && drain("idle"), idleMs);
    idleTimer.unref?.();
  };

  /**
   * @param {unknown} req
   * @returns {req is import("./types.js").RequestEnvelope}
   */
  const isRequest = req => req !== null && typeof req === "object" && !Array.isArray(req) && typeof /** @type {{op?: unknown}} */ (req).op === "string";

  /**
   * @param {unknown} req
   * @param {Transport} transport
   * @returns {Promise<Response>}
   */
  async function respond(req, transport) {
    if (!isRequest(req)) return { status: 1, name: "BadRequest", message: "Malformed sfd request" };
    if (req.op === "stop") return { status: 0, result: { stopping: true } };
    if (req.v !== version) return { restart: true };
    // `v` matched the protocol string, so the envelope is a complete request.
    const request = /** @type {import("./types.js").Request} */ (req);
    const handler = Object.hasOwn(handlers, req.op) ? handlers[req.op] : undefined;
    if (typeof handler !== "function") return { status: 1, name: "UnknownOperation", message: `Unknown operation: ${req.op}` };
    try {
      return { status: 0, result: await handler(request, transport) };
    } catch (e) {
      return { status: 1, name: e.name ?? "Error", message: e.message ?? String(e), errorCode: e.errorCode, ...(e.exitCode === 4 ? { exitCode: 4, approvalRequired: e.approvalRequired, effect: e.effect, orgType: e.orgType, summary: e.summary, plan: e.plan } : {}), ...(e.trace ? { trace: e.trace } : {}), ...(req.raw && e.actions ? { actions: e.actions } : {}) };
    }
  }

  const server = net.createServer(conn => {
    conn.setEncoding("utf8");
    let buf = "";
    const readTimer = setTimeout(() => conn.destroy(), readTimeoutMs);
    conn.once("close", () => clearTimeout(readTimer));
    conn.on("error", () => {});
    conn.on("data", async chunk => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      const line = nl < 0 ? buf : buf.slice(0, nl);
      if (Buffer.byteLength(line) > maxRequestBytes) {
        conn.removeAllListeners("data");
        log.warn("rejected request", { error: "BadRequest" });
        conn.end(JSON.stringify({ status: 1, name: "BadRequest", message: "Request too large" }) + "\n");
        return;
      }
      if (nl < 0) return;
      clearTimeout(readTimer);
      conn.removeAllListeners("data");
      active++;
      clearTimeout(idleTimer);
      /** @type {unknown} */
      let req;
      /** @type {Response | undefined} */
      let res;
      try {
        try { req = JSON.parse(line); } catch { req = undefined; }
        const valid = isRequest(req);
        const reqId = valid ? `r${++seq}` : undefined;
        const t0 = performance.now();
        const controller = new AbortController();
        let responded = false;
        conn.once("close", () => { if (!responded) controller.abort(); });
        res = await respond(req, {
          signal: controller.signal,
          log: log.child({ reqId }),
          emit: (/** @type {unknown} */ event) => { if (!conn.destroyed) conn.write(JSON.stringify(event) + "\n"); }
        });
        let output;
        try { output = JSON.stringify(res); }
        catch (e) { res = { status: 1, name: "SerializeError", message: e.message }; output = JSON.stringify(res); }
        responded = true;
        conn.end(output + "\n");
        // `valid` came from isRequest(req), but a reassigned `let` does not keep the narrowing.
        const envelope = /** @type {import("./types.js").RequestEnvelope} */ (req);
        if (valid) log.info("request", { reqId, op: envelope.op, org: typeof envelope.org === "string" ? envelope.org : undefined, qLen: typeof envelope.q === "string" ? envelope.q.length : undefined, ms: Math.round(performance.now() - t0), status: res.status ?? (res.restart ? "restart" : undefined), error: res.name, aborted: controller.signal.aborted });
        else log.warn("rejected request", { error: "BadRequest" });
      } finally {
        active--;
        if (isRequest(req) && req.op === "stop") drain("stop");
        else if (res?.restart) drain("version");
        else if (isStale()) drain("stale");
        if (draining) maybeExit();
        else if (active === 0) armIdle();
      }
    });
  });

  try {
    await listenOnce(server, socket);
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    if (await probe(socket)) throw new AlreadyRunning("sfd is already running");
    // A named pipe disappears with its owner, so only a Unix socket file can be stale.
    if (isPipe(socket)) throw e;
    unlinkSync(socket);
    await listenOnce(server, socket);
  }
  if (!isPipe(socket)) chmodSync(socket, 0o600);
  armIdle();
  return { server, drain };
}
