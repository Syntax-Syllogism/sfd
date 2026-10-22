import { mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unix socket paths are capped near 108 bytes, so keep the runtime dir short.
export function runtimeDir(env = process.env) {
  const base = env.SFD_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? tmpdir(), `sfd-${process.getuid()}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  return base;
}

export function paths(env = process.env) {
  const dir = runtimeDir(env);
  return { dir, socket: join(dir, "sfd.sock"), log: join(dir, "sfd.log"), pid: join(dir, "sfd.pid") };
}
