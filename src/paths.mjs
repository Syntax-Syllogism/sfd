import { mkdirSync, chmodSync, lstatSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** @type {Map<string, string>} */
const cache = new Map();

export class RuntimeDirError extends Error {}

// Unix socket paths are capped near 108 bytes, so keep the runtime dir short.
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function runtimeDir(env = process.env, platform = process.platform) {
  const key = JSON.stringify([platform, env.SFD_RUNTIME_DIR ?? null, env.XDG_RUNTIME_DIR ?? null, env.LOCALAPPDATA ?? null]);
  if (cache.has(key)) return /** @type {string} */ (cache.get(key));
  const base = platform === "win32"
    ? env.SFD_RUNTIME_DIR ?? join(env.LOCALAPPDATA ?? tmpdir(), "sfd")
    : env.SFD_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? tmpdir(), `sfd-${process.getuid?.() ?? "user"}`);
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    if (platform !== "win32") {
      const st = lstatSync(base);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("is not a directory; remove it");
      if (process.getuid && st.uid !== process.getuid()) throw new Error(`is owned by uid ${st.uid}; remove it or set SFD_RUNTIME_DIR`);
      chmodSync(base, 0o700);
      if (lstatSync(base).mode & 0o077) throw new Error("is accessible by group or others");
    }
  } catch (e) {
    throw new RuntimeDirError(`sfd runtime dir ${base}: ${e instanceof Error ? e.message : String(e)}`);
  }
  cache.set(key, base);
  return base;
}

export function resetPathsCache() { cache.clear(); }

// Windows has no Unix sockets in the filesystem; the daemon listens on a named pipe instead.
// Pipe names are machine-wide, so derive one per user and runtime dir.
/**
 * @param {string} dir
 * @param {NodeJS.Platform} [platform]
 */
export function socketPath(dir, platform = process.platform) {
  if (platform !== "win32") return join(dir, "sfd.sock");
  const id = createHash("sha256").update(`${userInfo().username}\0${dir.toLowerCase()}`).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\sfd-${id}`;
}

/** @param {string} socket */
export function isPipe(socket) {
  return socket.startsWith("\\\\.\\pipe\\");
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
export function paths(env = process.env, platform = process.platform) {
  const dir = runtimeDir(env, platform);
  return { dir, socket: socketPath(dir, platform), log: join(dir, "sfd.log"), pid: join(dir, "sfd.pid") };
}
