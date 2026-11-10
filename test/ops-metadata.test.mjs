import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { metadataFixture } from "./fixtures/sf-modules.mjs";

test("metadata members batch seven types into three queries per call and remain live", async () => {
  const { handlers, calls } = metadataFixture();
  const types = ["Flow", "Layout", "ApexClass", "ApexTrigger", "CustomObject", "PermissionSet", "CustomMetadata"];
  const result = await handlers.listMetadata({ org: "dev", types });
  assert.deepEqual(calls.lists.map(c => c.queries.length), [3, 3, 1]);
  assert.ok(calls.lists.every(c => c.version === "67.0"));
  assert.deepEqual(result.groups.map(g => g.type), types);
  assert.ok(result.groups.every(g => g.members.map(m => m.fullName).join() === "A,Z"));
  await handlers.listMetadata({ org: "dev", types: ["Flow"] });
  assert.equal(calls.lists.length, 4);
  assert.equal(calls.describes.length, 1);
});

test("folder listing uses folder types, respects explicit folders and normalizes API responses", async () => {
  const { handlers, conn, calls } = metadataFixture();
  for (const [type, folderType] of [["Report", "ReportFolder"], ["Dashboard", "DashboardFolder"], ["Document", "DocumentFolder"], ["EmailTemplate", "EmailFolder"]]) {
    conn.metadata.list = async queries => {
      assert.deepEqual(queries, [{ type: folderType }]);
      return { type: folderType, fullName: "Public", id: "excluded", lastModifiedByName: "User" };
    };
    const { groups } = await handlers.listMetadata({ types: [type] });
    assert.equal(groups[0].folders, true);
    assert.equal(groups[0].folderType, folderType);
    assert.equal(groups[0].members[0].fullName, "Public");
    assert.equal(groups[0].members[0].id, undefined);
  }
  conn.metadata.list = async queries => {
    assert.deepEqual(queries, [{ type: "Report", folder: "Public" }]);
    return undefined;
  };
  assert.deepEqual((await handlers.listMetadata({ types: ["Report"], folder: "Public" })).groups,
    [{ type: "Report", members: [] }]);
  const describe = conn.metadata.describe;
  conn.metadata.describe = async version => {
    const result = await describe(version);
    result.metadataObjects.push({ xmlName: "EmailTemplateFolder" });
    return result;
  };
  await handlers.reload();
  conn.metadata.list = async queries => { assert.deepEqual(queries, [{ type: "EmailTemplateFolder" }]); return []; };
  await handlers.listMetadata({ types: ["EmailTemplate"] });
  assert.equal(calls.describes.length, 2);
});

test("metadata rejects unknown types with helpful suggestions before listing", async () => {
  const { handlers, calls } = metadataFixture();
  for (const type of ["ApexClas", "apexclass", "ApexCl", "ApexClaxs"]) {
    await assert.rejects(handlers.listMetadata({ types: [type] }), error => error.name === "UsageError" && /Did you mean ApexClass/.test(error.message));
  }
  await assert.rejects(handlers.listMetadata({ types: ["NotAType"] }), { name: "UsageError" });
  await assert.rejects(handlers.listMetadata({ types: [] }), { name: "UsageError" });
  await assert.rejects(handlers.listMetadata({ types: ["Flow", "Layout"], folder: "x" }), { name: "UsageError" });
  assert.equal(calls.lists.length, 0);
  await handlers.listMetadata({ types: ["Child"] });
  assert.equal(calls.lists.length, 1);
});

test("metadata listing bounds concurrent chunks", async () => {
  const { handlers, conn } = metadataFixture();
  const list = conn.metadata.list;
  let active = 0, max = 0;
  conn.metadata.list = async (...args) => {
    max = Math.max(max, ++active);
    await new Promise(resolve => setImmediate(resolve));
    try { return await list(...args); } finally { active--; }
  };
  await handlers.listMetadata({ types: ["Flow", "Layout", "ApexClass", "ApexTrigger", "CustomObject", "PermissionSet", "CustomMetadata"] });
  assert.equal(max, 2);
});

test("metadata retries wait for every failed-attempt chunk to settle", async t => {
  const { handlers, conn } = metadataFixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, active = 0, max = 0, release;
  conn.metadata.list = async () => {
    const call = ++calls;
    max = Math.max(max, ++active);
    try {
      if (call === 1) throw Object.assign(new Error("quota"), { errorCode: "REQUEST_LIMIT_EXCEEDED" });
      if (call === 2) await new Promise(resolve => { release = resolve; });
      return [];
    } finally { active--; }
  };
  const pending = handlers.listMetadata({ types: ["Flow", "Layout", "ApexClass", "ApexTrigger", "CustomObject", "PermissionSet", "CustomMetadata"] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  release();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1300);
  await pending;
  assert.equal(calls, 6);
  assert.equal(max, 2);
});
