import { mkdirSync, chmodSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Unix socket paths are capped near 108 bytes, so keep the runtime dir short.
export function runtimeDir(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const base = env.SFD_RUNTIME_DIR ?? join(env.LOCALAPPDATA ?? tmpdir(), "sfd");
    mkdirSync(base, { recursive: true });
    return base;
  }
  const base = env.SFD_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? tmpdir(), `sfd-${process.getuid()}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  return base;
}

// Windows has no Unix sockets in the filesystem; the daemon listens on a named pipe instead.
// Pipe names are machine-wide, so derive one per user and runtime dir.
export function socketPath(dir, platform = process.platform) {
  if (platform !== "win32") return join(dir, "sfd.sock");
  const id = createHash("sha256").update(`${userInfo().username}\0${dir.toLowerCase()}`).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\sfd-${id}`;
}

export function isPipe(socket) {
  return socket.startsWith("\\\\.\\pipe\\");
}

export function paths(env = process.env, platform = process.platform) {
  const dir = runtimeDir(env, platform);
  return { dir, socket: socketPath(dir, platform), log: join(dir, "sfd.log"), pid: join(dir, "sfd.pid") };
}
