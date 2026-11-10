import test from "node:test";
import assert from "node:assert/strict";
import { limiter, withBackoff } from "../src/limit.mjs";

test("limiter bounds concurrency and releases rejected tasks", async () => {
  const run = limiter(2);
  let active = 0, max = 0;
  const tasks = [0, 1, 2, 3].map(i => run(async () => {
    max = Math.max(max, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (i === 1) throw new Error("failure");
    return i;
  }));
  const results = await Promise.allSettled(tasks);
  assert.equal(max, 2);
  assert.deepEqual(results.map(r => r.status === "fulfilled" ? r.value : r.reason.message), [0, "failure", 2, 3]);
});

test("backoff retries only limit errors with exponential jitter", async () => {
  let attempts = 0;
  const delays = [];
  const error = Object.assign(new Error("limit"), { errorCode: "REQUEST_LIMIT_EXCEEDED" });
  await assert.rejects(withBackoff(() => { attempts++; throw error; }, { sleep: async ms => delays.push(ms), random: () => 0.5 }), e => e === error);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 3000]);
  attempts = 0;
  await assert.rejects(withBackoff(() => { attempts++; throw new Error("other"); }, { sleep: async () => assert.fail() }), /other/);
  assert.equal(attempts, 1);
});
