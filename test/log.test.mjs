import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log.mjs";

const entries = path => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);

test("writes structured entries, serializes errors and handles circular fields", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sfd-log-")), "log");
  const log = createLogger({ file });
  log.child({ reqId: "r1" }).info("hello", { count: 2, error: new Error("oops") });
  const circular = {}; circular.self = circular;
  log.warn("bad", { circular });
  await log.close();
  const lines = entries(file);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].level, "info"); assert.equal(lines[0].msg, "hello");
  assert.equal(lines[0].reqId, "r1"); assert.equal(lines[0].count, 2);
  assert.ok(Date.parse(lines[0].ts)); assert.equal(lines[0].error.message, "oops");
  assert.equal(lines[0].error.name, "Error"); assert.match(lines[0].error.stack, /oops/);
  assert.equal(lines[1].msg, "unserializable log entry");
});

test("rotates in order while writes are queued", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sfd-log-")), "log");
  const log = createLogger({ file, maxBytes: 200, keep: 50 });
  for (let i = 0; i < 50; i++) log.info("line", { i });
  await log.close();
  assert.ok(existsSync(file + ".1"));
  const files = []; for (let i = 50; i >= 1; i--) if (existsSync(`${file}.${i}`)) files.push(`${file}.${i}`);
  files.push(file);
  assert.deepEqual(files.flatMap(entries).map(entry => entry.i), Array.from({ length: 50 }, (_, i) => i));
  assert.ok(Buffer.byteLength(readFileSync(file)) <= 200);
});
