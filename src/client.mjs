import net from "node:net";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.mjs";
import { PROTOCOL } from "./version.mjs";

export { VERSION } from "./version.mjs";

export class DaemonError extends Error {}

/** @typedef {import("./types.js").Request} Request */
/** @typedef {import("./types.js").Response} Response */
/** @typedef {(event: import("./types.js").ProgressEvent) => void} EventListener */

/**
 * @param {string} socket
 * @param {Request} req
 * @param {number} timeoutMs
 * @param {EventListener} [onEvent]
 * @returns {Promise<Response>}
 */
function send(socket, req, timeoutMs, onEvent) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    conn.setEncoding("utf8");
    const timer = setTimeout(() => conn.destroy(new DaemonError(`sfd request timed out after ${timeoutMs / 1000} seconds.`)), timeoutMs);
    conn.on("close", () => clearTimeout(timer));
    let buf = "";
    conn.on("connect", () => conn.write(JSON.stringify(req) + "\n"));
    /** @type {Response | undefined} */
    let response;
    /** @type {unknown} */
    let parseError;
    const parseLine = (/** @type {string} */ line) => {
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object" && "event" in value) onEvent?.(value);
        else response = value;
      } catch (e) { parseError = e; }
    };
    conn.on("data", chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) parseLine(line);
      }
    });
    conn.on("end", () => {
      if (buf.trim()) parseLine(buf);
      if (parseError || response === undefined) reject(new DaemonError(`Bad response from sfd: ${buf.slice(0, 200)}`));
      else resolve(response);
    });
    conn.on("error", reject);
  });
}

/** @param {NodeJS.ProcessEnv} [env] */
export function startDaemon(env = process.env) {
  const p = paths(env);
  const out = openSync(join(p.dir, "sfd.boot.log"), "w");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./daemon.mjs", import.meta.url))], {
    detached: true, windowsHide: true, stdio: ["ignore", out, out], env
  });
  child.unref();
  closeSync(out);
}

/**
 * @param {string} socket
 * @param {number} timeoutMs
 */
async function waitForSocket(socket, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await send(socket, { op: "ping", v: PROTOCOL }, Math.max(1, Math.min(3000, deadline - Date.now())));
    } catch (e) {
      if (Date.now() > deadline) throw new DaemonError(`sfd did not start within ${timeoutMs} ms (${e.code ?? e.message}); see sfd.boot.log in the runtime directory.`);
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

/**
 * @typedef {object} CallOptions
 * @property {NodeJS.ProcessEnv} [env]
 * @property {boolean} [autoStart]
 * @property {number} [startTimeoutMs]
 * @property {EventListener} [onEvent]
 */

// Send one request, starting the daemon if needed and replacing it once on a version mismatch.
/**
 * @param {string} op
 * @param {Record<string, unknown> & { waitMinutes?: number }} [args]
 * @param {CallOptions} [options]
 * @returns {Promise<import("./types.js").OkResponse | import("./types.js").ErrorResponse>}
 */
export async function call(op, args = {}, { env = process.env, autoStart = true, startTimeoutMs = 30_000, onEvent } = {}) {
  const p = paths(env);
  /** @type {Request} */
  const req = { ...args, op, v: PROTOCOL };
  for (let attempt = 0; attempt < 3; attempt++) {
    /** @type {Response} */
    let res;
    try {
      const configured = Number(env.SFD_TIMEOUT_SECONDS);
      const health = ["ping", "status", "stop", "reload"].includes(op);
      const waitMinutes = args.waitMinutes ?? (["deploy", "retrieve"].includes(op) ? 33 : op === "test" ? 60 : 0);
      const timeoutMs = Number.isFinite(configured) && configured > 0
        ? configured * 1000
        : health ? 3000 : Math.max(120_000, waitMinutes * 60_000 + 60_000);
      res = await send(p.socket, req, timeoutMs, onEvent);
    } catch (e) {
      if (!autoStart || !["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
      startDaemon(env);
      await waitForSocket(p.socket, startTimeoutMs);
      continue;
    }
    // Without strictNullChecks, `!res.restart` does not narrow the union.
    if (!res.restart) return /** @type {import("./types.js").OkResponse | import("./types.js").ErrorResponse} */ (res);
    // The old daemon is draining and has freed the socket path; start ours.
    startDaemon(env);
    await waitForSocket(p.socket, startTimeoutMs);
  }
  throw new DaemonError("sfd kept asking for a restart; run `sfd stop` and retry.");
}

/** @param {NodeJS.ProcessEnv} [env] */
export async function isRunning(env = process.env) {
  try {
    await call("ping", {}, { env, autoStart: false });
    return true;
  } catch (e) {
    if (["ENOENT", "ECONNREFUSED"].includes(e.code)) return false;
    throw e;
  }
}
