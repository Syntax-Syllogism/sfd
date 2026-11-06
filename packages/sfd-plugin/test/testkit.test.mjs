import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { stubContext, stubOrg, runOperation } from "../index.mjs";
import { readOperation, writeOperation } from "./fixtures.mjs";

test("context collects progress and notices, resolves paths and accepts overrides", () => {
  const org = stubOrg();
  const ctx = stubContext({ cwd: "/client/project", org, projectRoot: "/client/project" });
  ctx.onProgress({ phase: "query", done: 1 }); ctx.notice("hello");
  assert.deepEqual(ctx._progress, [{ phase: "query", done: 1 }]);
  assert.deepEqual(ctx._notices, ["hello"]);
  assert.equal(ctx.resolvePath("../file"), resolve("/client/project", "../file"));
  assert.equal(ctx.org, org); assert.equal(ctx.projectRoot, "/client/project");
  const fresh = stubContext();
  assert.notEqual(ctx.signal, fresh.signal); assert.deepEqual(fresh._notices, []);
  assert.equal(fresh.resolvePath("file"), resolve("/tmp/sfd-testkit", "file"));
  const signal = new AbortController().signal;
  assert.equal(stubContext({ signal }).signal, signal);
  assert.equal(stubOrg({ username: "override" }).username, "override");
  assert.deepEqual(org, { username: "test@example.com", apiVersion: "67.0", type: "scratch" });
});
test("read receives parsed options, connection and context and returns plain data", async () => {
  const conn = {}, ctx = stubContext();
  const op = readOperation({ optionsSchema: { safeParse: input => ({ success: true, data: { limit: Number(input.limit) } }) } });
  op.run = async (c, options, context) => { assert.equal(c, conn); assert.equal(context, ctx); return options.limit; };
  assert.deepEqual(await runOperation(op, { conn, ctx, options: { limit: "2" } }), { data: 2 });
});
test("write previews, confirms and applies the identical parsed plan", async () => {
  const op = writeOperation(), conn = {}, ctx = stubContext();
  const plan = { effects: [], value: 3 };
  let calls = 0;
  op.plan = async (c, options, context) => { assert.equal(c, conn); assert.equal(context, ctx); assert.equal(options, 3); return plan; };
  op.apply = async (c, p, context) => { assert.equal(c, conn); assert.equal(context, ctx); assert.equal(p, plan); calls++; return "done"; };
  const args = { conn, ctx, options: 3 };
  assert.deepEqual(await runOperation(op, { ...args, confirmPlan: async p => { assert.equal(p, plan); return false; } }), { plan });
  assert.equal(calls, 0);
  assert.deepEqual(await runOperation(op, { ...args, confirmPlan: () => true }), { plan, data: "done" });
  assert.equal(calls, 1);
  assert.deepEqual(await runOperation(op, args), { plan, data: "done" });
});
test("missing plan effects retains ceiling and exceeding plan never confirms or applies", async () => {
  const op = writeOperation();
  assert.deepEqual(await runOperation(op, { options: {} }), { plan: { summary: "Change records" }, data: "applied" });
  op.plan = async () => ({ effects: ["destructive"] });
  op.apply = async () => assert.fail("must not apply");
  await assert.rejects(runOperation(op, { options: {}, confirmPlan: () => assert.fail("must not confirm") }), { code: "plan-exceeds-effects" });
});
test("invalid options stop both read and write before execution", async () => {
  for (const op of [readOperation(), writeOperation()]) {
    const cause = { issues: ["missing input"] };
    op.descriptor.optionsSchema = { safeParse: () => ({ success: false, error: cause }) };
    op.run = op.plan = async () => assert.fail("must not execute");
    await assert.rejects(runOperation(op, { options: null }), error => error.code === "invalid-options" && error.cause === cause);
  }
});
test("operation failures and rejected confirmation propagate", async () => {
  const failure = new Error("failure");
  const op = readOperation(); op.run = async () => { throw failure; };
  await assert.rejects(runOperation(op, { options: {} }), error => error === failure);
  await assert.rejects(runOperation(writeOperation(), { options: {}, confirmPlan: async () => { throw failure; } }), error => error === failure);
});
