import net from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { isPipe } from "./paths.mjs";

// Newline-delimited JSON over a Unix socket: one request and one response per connection.
// Responses are {status: 0, result} | {status: 1, name, message} | {restart: true}.

export class AlreadyRunning extends Error {}

function probe(socket) {
  return new Promise(resolve => {
    const s = net.connect(socket, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

function listenOnce(server, socket) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => { server.off("error", reject); resolve(); });
  });
}

export async function startServer({ socket, version, handlers, idleMs = 60 * 60_000, isStale = () => false, onExit = () => {} }) {
  let active = 0;
  let idleTimer;
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

  async function respond(req) {
    if (req.op === "stop") return { status: 0, result: { stopping: true } };
    if (req.v !== version) return { restart: true };
    const handler = handlers[req.op];
    if (!handler) return { status: 1, name: "UnknownOperation", message: `Unknown operation: ${req.op}` };
    try {
      return { status: 0, result: await handler(req) };
    } catch (e) {
      return { status: 1, name: e.name ?? "Error", message: e.message ?? String(e), errorCode: e.errorCode, ...(e.trace ? { trace: e.trace } : {}) };
    }
  }

  const server = net.createServer(conn => {
    conn.setEncoding("utf8");
    let buf = "";
    conn.on("error", () => {});
    conn.on("data", async chunk => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      conn.removeAllListeners("data");
      active++;
      clearTimeout(idleTimer);
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch { req = {}; }
      const res = await respond(req);
      conn.end(JSON.stringify(res) + "\n");
      active--;
      if (req.op === "stop") drain("stop");
      else if (res.restart) drain("version");
      else if (isStale()) drain("stale");
      if (draining) maybeExit();
      else if (active === 0) armIdle();
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
