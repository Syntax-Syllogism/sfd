// Daemon entry point. The client spawns this detached; it is not meant to be run by hand.
import { readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { PROTOCOL, VERSION } from "./version.mjs";
import { AlreadyRunning, startServer } from "./server.mjs";
import { paths } from "./paths.mjs";
import { findSfRoot, sfInfo } from "./sf-root.mjs";
import { pathToFileURL } from "node:url";

const log = (...args) => console.error(new Date().toISOString(), ...args);
const p = paths();
const sf = sfInfo(findSfRoot());

// SFD_HANDLERS_MODULE swaps in stub handlers for tests that must not touch an org.
// import() needs a file URL for absolute Windows paths such as C:\\...
const handlersModule = process.env.SFD_HANDLERS_MODULE ? pathToFileURL(process.env.SFD_HANDLERS_MODULE).href : "./handlers.mjs";
const { createHandlers } = await import(handlersModule);
const handlers = createHandlers(sf.root);

// An sf upgrade rewrites its package.json; finish in-flight work and let the next call start fresh.
const isStale = () => {
  try { return statSync(`${sf.root}/package.json`).mtimeMs !== sf.mtimeMs; } catch { return true; }
};

try {
  await startServer({
    socket: p.socket,
    version: PROTOCOL,
    handlers,
    idleMs: Number(process.env.SFD_IDLE_MINUTES ?? 60) * 60_000,
    isStale,
    onExit: reason => {
      log(`exiting (${reason})`);
      try { if (readFileSync(p.pid, "utf8").trim() === String(process.pid)) unlinkSync(p.pid); } catch {}
      setTimeout(() => process.exit(0), 100);
    }
  });
} catch (e) {
  if (e instanceof AlreadyRunning) {
    log("another sfd daemon is already running; exiting");
    process.exit(0);
  }
  throw e;
}

writeFileSync(p.pid, String(process.pid));
log(`sfd ${VERSION} listening on ${p.socket} (pid ${process.pid}, sf ${sf.version})`);
