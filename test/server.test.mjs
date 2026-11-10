import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlreadyRunning, startServer } from "../src/server.mjs";
import { socketPath as socketFor } from "../src/paths.mjs";

const windows = process.platform === "win32";
const socketPath = () => socketFor(mkdtempSync(join(tmpdir(), "sfd-srv-")));

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
  if (!windows) assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.deepEqual(await send(socket, { op: "echo", v: "1", x: 5 }), { status: 0, result: { got: 5 } });
  assert.deepEqual(await send(socket, { op: "boom", v: "1" }), { status: 1, name: "BadThing", message: "bad", errorCode: "E1" });
  assert.equal((await send(socket, { op: "nope", v: "1" })).name, "UnknownOperation");
});

test("a version mismatch asks for a restart and drains the server", async t => {
  const { socket, exits } = await server(t);
  assert.deepEqual(await send(socket, { op: "echo", v: "2" }), { restart: true });
  if (!windows) assert.equal(existsSync(socket), false);
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
  // Named pipes vanish with their owner, so there is no stale file to replace on Windows.
  if (windows) return;

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


test("server emits event lines before the final response", async t => {
  const { socket } = await server(t, { handlers: { stream: async (req, { emit }) => {
    emit({ event: "progress", phase: "start" }); return "done";
  } } });
  const lines = await new Promise((resolve, reject) => {
    const conn = net.connect(socket, () => conn.write('{"op":"stream","v":"1"}\n'));
    let buf = ""; conn.on("data", c => { buf += c; }); conn.on("error", reject);
    conn.on("end", () => resolve(buf.trim().split("\n").map(line => JSON.parse(line))));
  });
  assert.deepEqual(lines, [{event:"progress",phase:"start"},{status:0,result:"done"}]);
});

test("client disconnect aborts an active handler", async t => {
  let entered, aborted;
  const started = new Promise(r => { entered = r; });
  const cancelled = new Promise(r => { aborted = r; });
  const { socket } = await server(t, { handlers: { slow: async (req, { signal }) => {
    entered(); await new Promise(r => signal.addEventListener("abort", () => { aborted(); r(); }, {once:true}));
    return "cancelled";
  } } });
  const conn = net.connect(socket, () => conn.write('{"op":"slow","v":"1"}\n'));
  await started; conn.destroy(); await cancelled;
});


test("disconnecting an abortable handler releases active work and permits idle drain", async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { socket, exits } = await server(t, { idleMs: 40, handlers: { slow: async (_req, { signal }) => {
    entered();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("disconnected")), { once: true }));
  } } });
  const conn = net.connect(socket, () => conn.write('{"op":"slow","v":"1"}\n'));
  await started;
  conn.destroy();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(exits, ["idle"]);
});

test("malformed requests and prototype keys cannot drain or dispatch", async t => {
  const { socket, exits } = await server(t, { handlers: { echo: async () => "ok" } });
  const raw = line => new Promise((resolve, reject) => {
    const conn = net.connect(socket, () => conn.write(line + "\n"));
    let data = "";
    conn.on("data", chunk => { data += chunk; });
    conn.on("end", () => resolve(JSON.parse(data)));
    conn.on("error", reject);
  });
  for (const line of ["null", "1", '"x"', "[]", "{}", '{"op":null}', '{"op":1}', "{", ""]) {
    assert.equal((await raw(line)).name, "BadRequest");
    assert.equal((await send(socket, { op: "echo", v: "1" })).result, "ok");
  }
  for (const op of ["constructor", "__proto__"]) assert.equal((await send(socket, { op, v: "1" })).name, "UnknownOperation");
  assert.deepEqual(exits, []);
});

test("serialization failure releases the active request and idles", async t => {
  const circular = {}; circular.self = circular;
  const { socket, exits } = await server(t, { idleMs: 50, handlers: { circular: async () => circular } });
  assert.equal((await send(socket, { op: "circular", v: "1" })).name, "SerializeError");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(exits, ["idle"]);
});

test("oversized and incomplete frames do not prevent idle", async t => {
  const { socket, exits } = await server(t, { maxRequestBytes: 1024, readTimeoutMs: 30, idleMs: 150, handlers: { echo: async () => "ok" } });
  assert.equal((await send(socket, { op: "echo", v: "1", body: "x".repeat(1024) })).message, "Request too large");
  assert.equal((await send(socket, { op: "echo", v: "1" })).result, "ok");
  await new Promise((resolve, reject) => {
    const conn = net.connect(socket, () => conn.write("partial"));
    conn.on("close", resolve); conn.on("error", reject);
  });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(exits, ["idle"]);
});


test("access logs contain timing and errors without request payloads", async t => {
  const records = [];
  const log = { info: (msg, fields) => records.push({ msg, ...fields }), warn: (msg, fields) => records.push({ msg, ...fields }), child: fields => ({ info: (msg, more) => records.push({ msg, ...fields, ...more }) }) };
  const { socket } = await server(t, { log, handlers: {
    query: async (_req, transport) => { transport.log.info("handler"); return 1; },
    boom: async () => { throw new TypeError("secret error message"); }
  } });
  await send(socket, { op: "query", v: "1", org: "alias", q: "secret query", body: "secret body" });
  await send(socket, { op: "boom", v: "1" });
  const access = records.filter(record => record.msg === "request");
  assert.equal(access.length, 2); assert.equal(access[0].status, 0);
  assert.equal(access[0].qLen, 12); assert.equal(access[0].op, "query");
  assert.equal(typeof access[0].ms, "number"); assert.equal(records[0].reqId, access[0].reqId);
  assert.equal(access[1].status, 1); assert.equal(access[1].error, "TypeError");
  assert.doesNotMatch(JSON.stringify(records), /secret/);
});
