import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, socketPath, isPipe } from "../src/paths.mjs";

test("Unix uses a socket file in the runtime dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfd-paths-"));
  const p = paths({ SFD_RUNTIME_DIR: dir }, "linux");
  assert.equal(p.socket, join(dir, "sfd.sock"));
  assert.equal(isPipe(p.socket), false);
});

test("Windows uses a named pipe and never calls process.getuid", t => {
  // Node has no process.getuid on Windows; 0.2.0 crashed with "process.getuid is not a function".
  const getuid = process.getuid;
  process.getuid = undefined;
  t.after(() => { process.getuid = getuid; });
  const dir = mkdtempSync(join(tmpdir(), "sfd-paths-"));
  const p = paths({ SFD_RUNTIME_DIR: dir }, "win32");
  assert.equal(p.dir, dir);
  assert.match(p.socket, /^\\\\\.\\pipe\\sfd-[0-9a-f]{16}$/);
  assert.equal(isPipe(p.socket), true);
  assert.equal(p.log, join(dir, "sfd.log"));
});

test("Windows pipe names differ per runtime dir and ignore case", () => {
  assert.notEqual(socketPath("C:\\a", "win32"), socketPath("C:\\b", "win32"));
  assert.equal(socketPath("C:\\Users\\X\\sfd", "win32"), socketPath("c:\\users\\x\\SFD", "win32"));
});

test("Windows defaults the runtime dir to LOCALAPPDATA", () => {
  const local = mkdtempSync(join(tmpdir(), "sfd-local-"));
  assert.equal(paths({ LOCALAPPDATA: local }, "win32").dir, join(local, "sfd"));
});
