import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers } from "../src/handlers.mjs";
import { fixture, sfCapture } from "./fixtures/sf-modules.mjs";

test("queries fetch every page beyond 100,000 rows, including tooling and deleted records", async () => {
  for (const tooling of [false, true]) {
    const { handlers, conn } = fixture();
    const api = tooling ? (conn.tooling = {}) : conn;
    api.query = async (q, options) => {
      assert.equal(options.scanAll, true);
      return { totalSize: 100002, done: false, records: Array.from({ length: 100000 }, () => ({ Id: "first" })), nextRecordsUrl: "page2" };
    };
    const pages = [];
    api.queryMore = async url => {
      pages.push(url);
      return { done: url === "page3", records: [{ Id: url }], nextRecordsUrl: url === "page2" ? "page3" : undefined };
    };
    const result = await handlers.query({ q: "SELECT Id FROM Account", tooling, all: true });
    assert.equal(result.records.length, 100002);
    assert.equal(result.done, true);
    assert.deepEqual(pages, ["page2", "page3"]);
  }
});

test("an incomplete query without a continuation fails explicitly", async () => {
  const { handlers, conn } = fixture();
  conn.query = async () => ({ done: false, records: [] });
  await assert.rejects(handlers.query({}), /Incomplete query/);
});

test("query limits stop paging and slice records while preserving server metadata", async () => {
  for (const tooling of [false, true]) for (const raw of [false, true]) {
    for (const limit of [undefined, 1, 2, 3, 5, 6, 9]) {
      const { handlers, conn } = fixture();
      const api = tooling ? (conn.tooling = {}) : conn;
      const record = id => ({ attributes: { type: "Account" }, Id: id });
      api.query = async () => ({ totalSize: 6, done: false, records: [record(1), record(2)], nextRecordsUrl: "2" });
      const pages = [];
      api.queryMore = async url => {
        pages.push(url);
        const page = Number(url);
        return { done: page === 3, records: [record(page * 2 - 1), record(page * 2)], nextRecordsUrl: page === 2 ? "3" : undefined };
      };
      const result = await handlers.query({ q: "SELECT Id FROM Account", limit, tooling, raw });
      const shown = Math.min(limit ?? 6, 6);
      assert.deepEqual(result.records.map(r => r.Id), Array.from({ length: shown }, (_, i) => i + 1));
      assert.equal(result.totalSize, 6);
      assert.equal(result.truncated, shown < 6 ? true : undefined);
      assert.equal(pages.length, Math.ceil(shown / 2) - 1);
      assert.equal(result.done, shown > 4);
      assert.equal(result.nextRecordsUrl, shown <= 2 ? "2" : shown <= 4 ? "3" : undefined);
      assert.equal(Boolean(result.records[0].attributes), raw);
    }
  }
});

test('raw apex expands library diagnostics into sf error data', async () => {
  const expected = sfCapture('apex-compile-error');
  const data = expected.data;
  const modules = {
    '@salesforce/core': { Org: { create: async () => ({ getUsername: () => 'scratch', getConnection: () => ({}) }) }, AuthInfo: { create: async () => ({ getFields: () => ({ devHubUsername: 'hub' }) }) } },
    '@salesforce/kit': {},
    '@salesforce/apex-node': { ExecuteService: class { async executeAnonymous() {
      return { success: data.success, compiled: data.compiled, logs: data.logs, diagnostic: [{ lineNumber: data.line, columnNumber: data.column, compileProblem: data.compileProblem, exceptionMessage: data.exceptionMessage, exceptionStackTrace: data.exceptionStackTrace }] };
    } } }
  };
  const handlers = createHandlers('unused', { home: '/nonexistent', env: { SFD_RUNTIME_DIR: mkdtempSync(join(tmpdir(), 'sfd-raw-apex-')) }, load: name => modules[name] });
  const { sfEnvelope } = await import('../src/sf-json.mjs');
  const { stack, cause, ...envelope } = expected;
  assert.deepEqual(sfEnvelope('apex', { status: 0, result: await handlers.apex({ org: 'scratch', body: 'bad', raw: true }) }), envelope);
});
