import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlreadyRunning, startServer } from "../src/server.mjs";

const socketPath = () => join(mkdtempSync(join(tmpdir(), "sfd-srv-")), "s.sock");

function send(socket, req) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket, () => conn.write(JSON.stringify(req) + "\n"));
    let buf = "";
    conn.on("data", c => (buf += c));
    conn.on("end", () => resolve(JSON.parse(buf)));
    conn.on("error", reject);
  });
}

async function server(t, opts = {}) {
  const socket = socketPath();
  const exits = [];
  const s = await startServer({ socket, version: "1", handlers: {}, onExit: r => exits.push(r), ...opts });
  t.after(() => s.drain("test"));
  return { socket, exits, ...s };
}

test("dispatches to handlers and reports their errors", async t => {
  const handlers = {
    echo: async req => ({ got: req.x }),
    boom: async () => { throw Object.assign(new Error("bad"), { name: "BadThing", errorCode: "E1" }); }
  };
  const { socket } = await server(t, { handlers });
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.deepEqual(await send(socket, { op: "echo", v: "1", x: 5 }), { status: 0, result: { got: 5 } });
  assert.deepEqual(await send(socket, { op: "boom", v: "1" }), { status: 1, name: "BadThing", message: "bad", errorCode: "E1" });
  assert.equal((await send(socket, { op: "nope", v: "1" })).name, "UnknownOperation");
});

test("a version mismatch asks for a restart and drains the server", async t => {
  const { socket, exits } = await server(t);
  assert.deepEqual(await send(socket, { op: "echo", v: "2" }), { restart: true });
  assert.equal(existsSync(socket), false);
  assert.deepEqual(exits, ["version"]);
});

test("stop drains, and an in-flight request finishes before exit", async t => {
  let release;
  const handlers = { slow: () => new Promise(r => (release = r)) };
  const { socket, exits } = await server(t, { handlers });
  const slow = send(socket, { op: "slow", v: "1" });
  while (!release) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(await send(socket, { op: "stop" }), { status: 0, result: { stopping: true } });
  assert.deepEqual(exits, []);
  release("done");
  assert.deepEqual(await slow, { status: 0, result: "done" });
  assert.deepEqual(exits, ["stop"]);
});

test("a stale install drains after the current request", async t => {
  const { socket, exits } = await server(t, { handlers: { ping: async () => "pong" }, isStale: () => true });
  assert.deepEqual(await send(socket, { op: "ping", v: "1" }), { status: 0, result: "pong" });
  assert.deepEqual(exits, ["stale"]);
});

test("idle timeout drains", async t => {
  const { exits } = await server(t, { idleMs: 20 });
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(exits, ["idle"]);
});

test("refuses a live socket and replaces a dead one", async t => {
  const { socket } = await server(t);
  await assert.rejects(startServer({ socket, version: "1", handlers: {} }), AlreadyRunning);

  const dead = socketPath();
  writeFileSync(dead, "");
  const s = await startServer({ socket: dead, version: "1", handlers: { ping: async () => 1 } });
  t.after(() => s.drain("test"));
  assert.deepEqual(await send(dead, { op: "ping", v: "1" }), { status: 0, result: 1 });
});

test("server preserves a multibyte request split between writes", async t => {
  const { socket } = await server(t, { handlers: { echo: async req => req.body } });
  const response = await new Promise((resolve, reject) => {
    const conn = net.connect(socket, () => {
      const bytes = Buffer.from(JSON.stringify({ op: "echo", v: "1", body: "café ☕" }) + "\n");
      const split = bytes.indexOf(Buffer.from("é")) + 1;
      conn.write(bytes.subarray(0, split));
      setTimeout(() => conn.write(bytes.subarray(split)), 20);
    });
    conn.setEncoding("utf8");
    let body = "";
    conn.on("data", chunk => { body += chunk; });
    conn.on("end", () => resolve(JSON.parse(body)));
    conn.on("error", reject);
  });
  assert.equal(response.result, "café ☕");
});
