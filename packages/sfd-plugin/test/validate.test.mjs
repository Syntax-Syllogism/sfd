import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest, validateOperationModule, effectsExceeding, assertConformance } from "../index.mjs";
import { readOperation, writeOperation, moduleOf } from "./fixtures.mjs";

const manifest = { apiVersion: 0, operations: "./lib/operations.js" };
test("accepts minimal and full manifests", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.deepEqual(validateManifest({ ...manifest, cli: "./lib/cli.json", requires: { sfd: ">=0.7.0" } }), []);
});
for (const [label, value, field] of [
  ["null", null, "object"], ["array", [], "object"], ["primitive", "x", "object"],
  ["version", { ...manifest, apiVersion: 1 }, "apiVersion"],
  ["missing operations", { apiVersion: 0 }, "operations"],
  ...["lib/a.js", "/a.js", "./../a.js", "./lib/../a.js", "./", "./lib\\..\\a.js", 1].map(path => [`path ${path}`, { ...manifest, operations: path }, "operations"]),
  ["cli traversal", { ...manifest, cli: "./../cli.json" }, "cli"],
  ["null cli", { ...manifest, cli: null }, "cli"],
  ["range type", { ...manifest, requires: { sfd: 1 } }, "requires.sfd"],
  ["requires type", { ...manifest, requires: [] }, "requires"],
]) test(`rejects manifest ${label}`, () => assert.ok(validateManifest(value).some(p => p.includes(field))));

test("accepts reads, writes, nested ids and default export precedence", () => {
  const mod = moduleOf(readOperation(), writeOperation({ id: "test.change" }));
  assert.deepEqual(validateOperationModule(mod), []);
  assert.deepEqual(validateOperationModule({ default: mod, apiVersion: 99, operations: [] }), []);
  assert.deepEqual(validateOperationModule(moduleOf(readOperation({ id: "test.nested.list", effects: ["read", "local-write"], summary: "a".repeat(120), paged: true, cliId: "test:list" }))), []);
  assert.ok(validateOperationModule({ default: null, ...mod }).length);
});
for (const [label, mod, field] of [
  ["null", null, "object"], ["array", [], "object"],
  ["version", { apiVersion: 1, operations: [readOperation()] }, "apiVersion"],
  ["empty operations", moduleOf(), "operations"],
  ["operations type", { apiVersion: 0, operations: {} }, "operations"],
  ["null op", moduleOf(null), "operation"],
  ["kind", moduleOf({ ...readOperation(), kind: "other" }), "kind"],
  ["run", moduleOf({ ...readOperation(), run: null }), "run"],
  ["plan", moduleOf({ ...writeOperation(), plan: null }), "plan"],
  ["apply", moduleOf({ ...writeOperation(), apply: null }), "apply"],
  ["descriptor", moduleOf({ ...readOperation(), descriptor: null }), "descriptor"],
  ["duplicate", moduleOf(readOperation(), readOperation()), "unique"],
  ["read effect", moduleOf(readOperation({ effects: ["org-write"] })), "effects"],
  ["write effect", moduleOf(writeOperation({ effects: ["local-write"] })), "effects"],
  ...["Test.list", "list", "test.List", "test.", "test.a_b", undefined].map(id => [`id ${id}`, moduleOf(readOperation({ id })), "descriptor.id"]),
  ...Object.entries({ title: " ", summary: "", effects: [], requiresOrg: "always", requiresProject: "true", retry: "no", optionsSchema: {}, paged: "yes", cliId: 2 }).map(([field, value]) => [field, moduleOf(readOperation({ [field]: value })), `descriptor.${field}`]),
  ["summary length", moduleOf(readOperation({ summary: "a".repeat(121) })), "summary"],
  ["summary newline", moduleOf(readOperation({ summary: "a\nb" })), "summary"],
  ["summary CR", moduleOf(readOperation({ summary: "a\rb" })), "summary"],
  ["summary type", moduleOf(readOperation({ summary: 1 })), "summary"],
  ["effects type", moduleOf(readOperation({ effects: "read" })), "effects"],
  ["unknown effect", moduleOf(readOperation({ effects: ["write"] })), "unknown effect"],
  ["non-string effect", moduleOf(readOperation({ effects: [1n] })), "unknown effect"],
  ["duplicate effects", moduleOf(readOperation({ effects: ["read", "read"] })), "duplicates"],
]) test(`rejects module ${label}`, () => assert.ok(validateOperationModule(mod).some(p => p.includes(field))));

test("messages identify operation and field; write retry warnings are advisory", () => {
  assert.ok(validateOperationModule(moduleOf(readOperation({ retry: "no" })))[0].startsWith("test.list: descriptor.retry"));
  const mod = moduleOf(writeOperation({ retry: "safe" }));
  assert.match(validateOperationModule(mod)[0], /^warning: test.list: descriptor.retry/);
  assert.doesNotThrow(() => assertConformance(mod));
  assert.throws(() => assertConformance(moduleOf(readOperation({ summary: "" }))), /test.list: descriptor.summary/);
});
test("effects narrowing uses exact membership, with omitted and empty plans supported", () => {
  assert.deepEqual(effectsExceeding(["org-write"]), []);
  assert.deepEqual(effectsExceeding(["org-write"], []), []);
  assert.deepEqual(effectsExceeding(["read", "local-write"], ["local-write"]), []);
  assert.deepEqual(effectsExceeding(["org-write"], ["destructive", "destructive"]), ["destructive"]);
  assert.throws(() => effectsExceeding(["read"], "read"), /array/);
});
