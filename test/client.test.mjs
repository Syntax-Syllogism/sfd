import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { call, isRunning, startDaemon, DaemonError } from "../src/client.mjs";
import { startServer } from "../src/server.mjs";
import { paths } from "../src/paths.mjs";

const bin = fileURLToPath(new URL("../bin/sfd.mjs", import.meta.url));
function environment() {
  const dir = mkdtempSync(join(tmpdir(), "sfd-client-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@salesforce/cli", version: "test" }));
  return { ...process.env, SFD_RUNTIME_DIR: dir, SFD_SF_ROOT: dir,
    SFD_HANDLERS_MODULE: fileURLToPath(new URL("./fixtures/stub-handlers.mjs", import.meta.url)) };
}
function cli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

test("client preserves a multibyte response split between writes", async t => {
  const env = environment();
  const server = net.createServer(conn => {
    conn.once("data", () => {
      const bytes = Buffer.from(JSON.stringify({ status: 0, result: "café ☕" }));
      const split = bytes.indexOf(Buffer.from("é")) + 1;
      conn.write(bytes.subarray(0, split));
      setTimeout(() => conn.end(bytes.subarray(split)), 20);
    });
  });
  await new Promise(r => server.listen(paths(env).socket, r));
  t.after(() => server.close());
  assert.equal((await call("echo", {}, { env, autoStart: false })).result, "café ☕");
});

test("unresponsive sockets time out for operations, probes and CLI with exit 3", async t => {
  const env = { ...environment(), SFD_TIMEOUT_SECONDS: "0.05" };
  const connections = new Set();
  const server = net.createServer(conn => { connections.add(conn); conn.on("data", () => {}); });
  await new Promise(r => server.listen(paths(env).socket, r));
  t.after(() => { for (const conn of connections) conn.destroy(); server.close(); });
  await assert.rejects(call("query", {}, { env, autoStart: false }), DaemonError);
  await assert.rejects(isRunning(env), /timed out/);
  const result = await cli(["status"], env);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /timed out/);
});

for (const command of ["status", "start", "reload", "stop"]) {
  test(`${command} handles a daemon with a different protocol`, async t => {
    const env = environment();
    const old = await startServer({ socket: paths(env).socket, version: "old", handlers: {} });
    t.after(async () => { old.drain("test"); await cli(["stop"], env); });
    const result = await cli([command, "--json"], env);
    assert.equal(result.status, 0, result.stderr);
    if (command === "status") assert.equal(JSON.parse(result.stdout).running, true);
    if (command === "start") assert.equal(await isRunning(env), true);
    if (command === "reload") assert.match(result.stdout, /reloaded/);
    if (command === "stop") assert.equal(await isRunning(env), false);
  });
}


test("client parses fragmented NDJSON events and the final response", async t => {
  const env = environment();
  const server = net.createServer(conn => conn.once("data", () => {
    conn.write('{"event":"progress","phase":"sta');
    setTimeout(() => conn.end('rt"}\n{"event":"notice","message":"hi"}\n{"status":0,"result":"done"}\n'), 10);
  }));
  await new Promise(r => server.listen(paths(env).socket, r)); t.after(() => server.close());
  const events = [];
  assert.equal((await call("stream", {}, {env, autoStart:false, onEvent:event => events.push(event)})).result, "done");
  assert.deepEqual(events, [{event:"progress",phase:"start"},{event:"notice",message:"hi"}]);
});


test("daemon spawn truncates the separate boot log", async t => {
  const env = environment();
  const p = paths(env);
  const boot = join(p.dir, "sfd.boot.log");
  writeFileSync(boot, "old startup error");
  startDaemon(env);
  t.after(async () => { await cli(["stop"], env); });
  assert.equal(readFileSync(boot, "utf8"), "");
});

test("unsafe runtime directory reports daemon error", { skip: process.platform === "win32" }, async () => {
  const env = environment();
  const link = `${env.SFD_RUNTIME_DIR}-link`;
  symlinkSync(env.SFD_RUNTIME_DIR, link);
  const result = await cli(["status"], { ...env, SFD_RUNTIME_DIR: link });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /not a directory/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
