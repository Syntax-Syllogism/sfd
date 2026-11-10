import test from "node:test";
import assert from "node:assert/strict";
import { ops } from "../src/ops/index.mjs";
import { EFFECTS } from "../src/ops/effects.mjs";
import { builtinEffects } from "../src/policy.mjs";

const byName = Object.fromEntries(ops.map(op => [op.name, op]));
const retryOf = (op, args = {}) => typeof op.retry === "function" ? op.retry(args) : op.retry;
const names = predicate => ops.filter(predicate).map(op => op.name).sort();

// Copied from the v0.7.1 effects table in docs/safety.md, with "metadata lists"
// spelled out and the daemon's own commands (ping, status, reload, org list) added.
const SAFETY_TABLE = {
  read: ["query", "describe", "listMetadataTypes", "listMetadata", "logs", "logGet", "org", "orgList", "tracking", "test", "ping", "status", "reload"],
  "local-write": ["retrieve"],
  "org-write": ["deploy", "apex"]
};
const REST_METHODS = { GET: "read", HEAD: "read", POST: "org-write", PATCH: "org-write", PUT: "org-write", DELETE: "destructive" };

test("every descriptor declares a name, effects, retry and run, and names are unique", () => {
  assert.equal(new Set(ops.map(op => op.name)).size, ops.length);
  for (const op of ops) {
    assert.equal(typeof op.name, "string", "name");
    assert.equal(typeof op.effects, "function", `${op.name} effects`);
    assert.ok(op.retry === "safe" || op.retry === "never" || typeof op.retry === "function", `${op.name} retry`);
    assert.equal(typeof op.run, "function", `${op.name} run`);
    assert.equal(typeof op.project, "boolean", `${op.name} project`);
    assert.equal(typeof op.policy, "boolean", `${op.name} policy`);
    assert.equal(op.effects, EFFECTS[op.name], `${op.name} effects come from src/ops/effects.mjs`);
  }
  assert.deepEqual(Object.keys(EFFECTS).sort(), names(() => true));
});

test("builtinEffects matches the docs/safety.md effects table", () => {
  for (const [effect, list] of Object.entries(SAFETY_TABLE)) {
    for (const name of list) {
      assert.deepEqual(builtinEffects(name), [effect], name);
      assert.deepEqual(byName[name].effects({}), [effect], `${name} descriptor`);
    }
  }
  for (const [method, effect] of Object.entries(REST_METHODS)) {
    assert.deepEqual(builtinEffects("rest", { method }), [effect], method);
    assert.deepEqual(builtinEffects("rest", { method: method.toLowerCase() }), [effect], method.toLowerCase());
  }
  assert.deepEqual(builtinEffects("rest", {}), ["read"]);
  assert.deepEqual(builtinEffects("rest", { body: {} }), ["org-write"]);
  assert.deepEqual(builtinEffects("deploy", { checkOnly: true }), ["org-write"]);
  assert.deepEqual(names(() => true), [...Object.values(SAFETY_TABLE).flat(), "rest"].sort());
});

test("exactly deploy, retrieve and tracking use the project queue", () => {
  assert.deepEqual(names(op => op.project), ["deploy", "retrieve", "tracking"]);
});

test("exactly the reads may retry after a session expiry", () => {
  for (const op of ops) {
    if (op.name === "rest") continue;
    assert.equal(retryOf(op), op.effects({})[0] === "read" ? "safe" : "never", op.name);
  }
  for (const [method, effect] of Object.entries(REST_METHODS)) {
    assert.equal(retryOf(byName.rest, { method }), effect === "read" ? "safe" : "never", `rest ${method}`);
  }
  assert.equal(retryOf(byName.rest, { body: {} }), "never");
  assert.deepEqual(names(op => retryOf(op) === "never"), ["apex", "deploy", "retrieve"]);
});

test("only the daemon's own commands and org list skip the generic policy gate", () => {
  assert.deepEqual(names(op => !op.policy), ["orgList", "ping", "reload", "status"]);
  assert.deepEqual(names(op => op.needsOrg === false), ["orgList", "ping", "reload", "status"]);
});
