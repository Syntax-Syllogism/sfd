import net from "node:net";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.mjs";
import { PROTOCOL } from "./version.mjs";

export { VERSION } from "./version.mjs";

export class DaemonError extends Error {}

function send(socket, req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    conn.setEncoding("utf8");
    const timer = setTimeout(() => conn.destroy(new DaemonError(`sfd request timed out after ${timeoutMs / 1000} seconds.`)), timeoutMs);
    conn.on("close", () => clearTimeout(timer));
    let buf = "";
    conn.on("connect", () => conn.write(JSON.stringify(req) + "\n"));
    conn.on("data", chunk => (buf += chunk));
    conn.on("end", () => {
      try { resolve(JSON.parse(buf)); } catch { reject(new DaemonError(`Bad response from sfd: ${buf.slice(0, 200)}`)); }
    });
    conn.on("error", reject);
  });
}

export function startDaemon(env = process.env) {
  const p = paths(env);
  const out = openSync(p.log, "a");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./daemon.mjs", import.meta.url))], {
    detached: true, windowsHide: true, stdio: ["ignore", out, out], env
  });
  child.unref();
}

async function waitForSocket(socket, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await send(socket, { op: "ping", v: PROTOCOL }, Math.max(1, Math.min(3000, deadline - Date.now())));
    } catch (e) {
      if (Date.now() > deadline) throw new DaemonError(`sfd did not start within ${timeoutMs} ms (${e.code ?? e.message}); see the daemon log.`);
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

// Send one request, starting the daemon if needed and replacing it once on a version mismatch.
export async function call(op, args = {}, { env = process.env, autoStart = true, startTimeoutMs = 30_000 } = {}) {
  const p = paths(env);
  const req = { ...args, op, v: PROTOCOL };
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      const configured = Number(env.SFD_TIMEOUT_SECONDS);
      const health = ["ping", "status", "stop", "reload"].includes(op);
      const waitMinutes = args.waitMinutes ?? (["deploy", "retrieve"].includes(op) ? 33 : op === "test" ? 60 : 0);
      const timeoutMs = Number.isFinite(configured) && configured > 0
        ? configured * 1000
        : health ? 3000 : Math.max(120_000, waitMinutes * 60_000 + 60_000);
      res = await send(p.socket, req, timeoutMs);
    } catch (e) {
      if (!autoStart || !["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
      startDaemon(env);
      await waitForSocket(p.socket, startTimeoutMs);
      continue;
    }
    if (!res.restart) return res;
    // The old daemon is draining and has freed the socket path; start ours.
    startDaemon(env);
    await waitForSocket(p.socket, startTimeoutMs);
  }
  throw new DaemonError("sfd kept asking for a restart; run `sfd stop` and retry.");
}

export async function isRunning(env = process.env) {
  try {
    await call("ping", {}, { env, autoStart: false });
    return true;
  } catch (e) {
    if (["ENOENT", "ECONNREFUSED"].includes(e.code)) return false;
    throw e;
  }
}
