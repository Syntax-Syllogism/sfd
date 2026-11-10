// Daemon entry point. The client spawns this detached; it is not meant to be run by hand.
import { readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { PROTOCOL, VERSION } from "./version.mjs";
import { AlreadyRunning, startServer } from "./server.mjs";
import { paths } from "./paths.mjs";
import { findSfRoot, sfInfo } from "./sf-root.mjs";
import { pathToFileURL } from "node:url";

import { createLogger } from "./log.mjs";
import { createDiscovery } from "./plugin/discover.mjs";
import { createSupervisor } from "./plugin/supervisor.mjs";

const p = paths();
const log = createLogger({ file: p.log });
const exit = async (/** @type {number} */ code) => { await Promise.race([log.close(), new Promise(resolve => setTimeout(resolve, 1000))]); process.exit(code); };
const cleanupPid = () => { try { if (readFileSync(p.pid, "utf8").trim() === String(process.pid)) unlinkSync(p.pid); } catch {} };
const sf = sfInfo(findSfRoot());

// SFD_HANDLERS_MODULE swaps in stub handlers for tests that must not touch an org.
// import() needs a file URL for absolute Windows paths such as C:\\...
const handlersModule = process.env.SFD_HANDLERS_MODULE ? pathToFileURL(process.env.SFD_HANDLERS_MODULE).href : "./handlers.mjs";
const { createHandlers } = await import(handlersModule);
const configuredIdle = Number(process.env.SFD_PLUGIN_IDLE_MINUTES ?? 30);
const supervisor = createSupervisor({ discover: createDiscovery(), idleMs: (Number.isFinite(configuredIdle) && configuredIdle > 0 ? configuredIdle : 30) * 60_000, log: log.warn });
const handlers = createHandlers(sf.root, { supervisor, log: log.warn, onAuthChanged: (/** @type {string} */ username) => supervisor.authChanged(username) });
handlers.pluginList = () => supervisor.list();
const status = handlers.status;
handlers.status = async (/** @type {import("./types.js").Request} */ req) => ({ ...await status(req), plugins: await supervisor.status() });

// An sf upgrade rewrites its package.json; finish in-flight work and let the next call start fresh.
const isStale = () => {
  try { return statSync(`${sf.root}/package.json`).mtimeMs !== sf.mtimeMs; } catch { return true; }
};

try {
  const configuredMaxBytes = Number(process.env.SFD_MAX_REQUEST_BYTES);
  const srv = await startServer({
    socket: p.socket,
    version: PROTOCOL,
    handlers,
    log,
    maxRequestBytes: Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0 ? configuredMaxBytes : undefined,
    idleMs: Number(process.env.SFD_IDLE_MINUTES ?? 60) * 60_000,
    isStale,
    onExit: (/** @type {string} */ reason) => {
      supervisor.shutdown();
      log.info(`exiting (${reason})`);
      cleanupPid();
      void exit(0);
    }
  });
  let signalled = false;
  const onSignal = (/** @type {string} */ sig) => {
    if (signalled) { log.warn(`${sig} again; exiting now`); cleanupPid(); void exit(1); }
    signalled = true;
    log.info(`${sig}: draining`);
    srv.drain("signal");
    setTimeout(() => { log.warn("drain deadline passed; exiting"); cleanupPid(); void exit(0); }, 10_000).unref();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
} catch (e) {
  if (e instanceof AlreadyRunning) {
    log.info("another sfd daemon is already running; exiting");
    await exit(0);
  }
  throw e;
}

writeFileSync(p.pid, String(process.pid));
process.on("unhandledRejection", reason => log.error("unhandled rejection", { error: reason }));
process.on("uncaughtException", error => log.error("uncaught exception", { error }));
log.info(`sfd ${VERSION} listening on ${p.socket} (pid ${process.pid}, sf ${sf.version})`);
