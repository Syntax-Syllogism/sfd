import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { validateCliTable } from "../packages/sfd-plugin/validate.mjs";
import { loadTable, refreshTableMetadata } from "../src/plugin/table-cache.mjs";
import { mergeTables, matchCommand, parseCommand, formatPlugin } from "../src/plugin/cli-table.mjs";
import { rewrite } from "../src/rewrite.mjs";
import { snippet } from "../src/snippet.mjs";
import { handle } from "../src/hooks.mjs";
import { renderCommandManual, renderHelpIndex } from "../src/help-topics.mjs";

const fixture = resolve("test/fixtures/plugins/echo");
const table = JSON.parse(readFileSync(join(fixture, "cli.json")));
const descriptor = { id: "echo.say", cliId: "echo:say", summary: "Echo text", effects: ["read"], optionsSchema: { shape: { text: {} } } };
const merged = { plugins: [{ name: "echo", root: fixture, commands: table.commands }] };

test("validates structural and descriptor constraints without throwing on malformed input", () => {
  assert.deepEqual(validateCliTable(table, [descriptor]), []);
  const cases = [
    [t => t.apiVersion = 1, /apiVersion/],
    [t => t.commands[0].operation = "echo.missing", /does not exist/],
    [t => t.commands[0].name = ["other", "say"], /namespace/],
    [t => t.commands.push(t.commands[0]), /duplicate command/],
    [t => t.commands[0].flags.push(t.commands[0].flags[0]), /duplicate flag/],
    [t => t.commands[0].flags[0].char = "tt", /char/],
    [t => t.commands[0].flags.push({ name: "other", type: "string", char: "t" }), /char/],
    [t => t.commands[0].flags[0].option = "missing", /option key/],
    [t => t.commands[0].flags.push({ name: "target-org", type: "string", option: "text" }), /reserved/],
    [t => t.commands[0].sf = ["echo", "other"], /cliId/],
    [t => t.commands[0].sf = "echo say", /cliId/],
    [t => t.commands[0].formatter = { module: "./../escape.mjs" }, /formatter/],
    [t => t.commands[0].flags = [null], /flag must/],
    [t => t.commands[0].flags[0].char = "h", /reserved/]
  ];
  for (const [mutate, expected] of cases) {
    const copy = structuredClone(table); mutate(copy);
    assert.match(validateCliTable(copy, [descriptor]).join(";"), expected);
  }
  for (const value of [null, [], {}, { apiVersion: 0, commands: [null, {}] }]) assert.ok(validateCliTable(value).length);
  assert.match(validateCliTable(table, [{ ...descriptor, optionsSchema: {} }]).join(";"), /warning:.*shape/);
});

test("merges first discovered commands and protects built-in namespaces", () => {
  const command = table.commands[0];
  const plugins = mergeTables([
    { name: "one", commands: [command, { ...command, name: ["query", "other"] }] },
    { name: "two", commands: [command] }
  ]);
  assert.equal(plugins[0].commands.length, 1);
  assert.equal(plugins[1].commands.length, 0);
  assert.match(plugins[0].problems[0], /built-in/);
  assert.match(plugins[1].problems[0], /one/);
});

test("parses typed flags, repetition, required values and longest command", () => {
  const command = { name: "echo say", flags: [
    ...table.commands[0].flags, { name: "n", type: "integer", option: "n", multiple: true },
    { name: "file", type: "file", option: "file" }, { name: "loud", type: "boolean", option: "loud" }
  ] };
  const result = parseCommand(["echo", "say", "--text", "hi", "--n", "2", "--n", "3", "--file", "x", "--loud", "-o", "dev"], command, "/tmp");
  assert.deepEqual(result.options, { text: "hi", n: [2, 3], file: resolve("/tmp", "x"), loud: true });
  assert.equal(result.values["target-org"], "dev");
  assert.throws(() => parseCommand(["echo", "say"], command), /required/);
  assert.throws(() => parseCommand(["echo", "say", "--text", "hi", "--n", "1.2"], command), /integer/);
  assert.throws(() => parseCommand(["echo", "say", "--text", "hi", "extra"], command), /positional/);
  assert.equal(matchCommand(["echo", "say", "more"], { plugins: [{ ...merged.plugins[0], commands: [...table.commands, { ...table.commands[0], name: ["echo", "say", "more"] }] }] }).name, "echo say more");
});

test("plugin rewrites preserve strict shell and flag rules", () => {
  assert.equal(rewrite("sf echo say --text hi -o dev", { table: merged }).command, "sfd echo say --text 'hi' -o 'dev'");
  for (const command of ["sf echo say --unknown hi", "sf echo say --text -hi", "sf echo say --help", "sf echo say --text $X"]) assert.ok(rewrite(command, { table: merged }).skip);
  assert.equal(rewrite("sf echo say --text hi", { shell: "powershell", table: merged }).command, "sfd echo say --text 'hi'");
});

test("plugin rewrites require every required flag and accept aliases in both shells", () => {
  const commands = structuredClone(table.commands);
  commands[0].flags.push({ name: "confirm", type: "boolean", required: true });
  commands[0].flags.push({ name: "target-org", type: "string", required: true });
  const requiredTable = { plugins: [{ ...merged.plugins[0], commands }] };
  for (const shell of ["posix", "powershell"]) {
    assert.match(rewrite("sf echo say", { shell, table: merged }).skip, /required --text/);
    for (const flags of ["--text hi", "--confirm -o dev", "--text hi --confirm"]) {
      assert.match(rewrite(`sf echo say ${flags}`, { shell, table: requiredTable }).skip, /required/);
    }
    for (const flags of ["--text hi --confirm --target-org dev", "-t hi --confirm -o dev", "--text=hi --confirm -o=dev"]) {
      assert.equal(rewrite(`sf echo say ${flags}`, { shell, table: requiredTable }).command,
        "sfd echo say --text 'hi' --confirm -o 'dev'");
    }
  }
});

test("plugin rewrites enforce required host json without throwing in both shells", () => {
  const required = structuredClone(table);
  required.commands[0].flags.push({ name: "json", type: "boolean", required: true });
  assert.deepEqual(validateCliTable(required, [descriptor]), []);
  const requiredTable = { plugins: [{ ...merged.plugins[0], commands: required.commands }] };
  for (const shell of ["posix", "powershell"]) {
    assert.equal(rewrite("sf echo say --text hi", { shell, table: requiredTable }).skip,
      "missing required --json flag");
    assert.equal(rewrite("sf echo say --text hi --json", { shell, table: requiredTable }).command,
      "sfd echo say --text 'hi' --json");
  }
});

test("plugin rewrites carry declared effects to the hook policy check; unknown effects count as org-write", () => {
  const known = { plugins: [{ ...merged.plugins[0], commands: [{ ...table.commands[0], effects: ["read"] }] }] };
  const unknown = { plugins: [{ ...merged.plugins[0], commands: [{ ...table.commands[0], effects: undefined }] }] };
  for (const shell of ["posix", "powershell"]) {
    assert.deepEqual(rewrite("sf echo say --text hi", { shell, table: known, includePolicy: true }).policyCalls[0].effects, ["read"]);
    assert.deepEqual(rewrite("sf echo say --text hi", { shell, table: unknown, includePolicy: true }).policyCalls[0].effects, ["org-write"]);
  }
});

test("namespace help excludes unrelated commands in the same plugin", () => {
  const commands = [table.commands[0], { ...table.commands[0], name: ["other", "say"], operation: "other.say" }];
  const mixed = { plugins: [{ ...merged.plugins[0], commands }] };
  assert.equal(renderCommandManual("echo", mixed), "echo say: Echo text");
  assert.equal(renderCommandManual("other", mixed), "other say: Echo text");
  assert.equal(renderCommandManual("missing", mixed), undefined);
});

test("plugin snippets fall back to the summary for missing or malformed tips", () => {
  for (const agentTip of [undefined, "missing separator"]) {
    const commands = [{ ...table.commands[0], agentTip, summary: "Echo\ntext" }];
    const output = snippet({ plugins: [{ ...merged.plugins[0], commands }] });
    assert.ok(output.includes("- `sfd echo say`: Echo text"));
    assert.ok(!output.includes("missing separator"));
  }
});

test("help and snippet use plugin entries and enforce command budgets", () => {
  assert.equal(snippet(), snippet({ plugins: [] }));
  assert.match(snippet(merged), /sfd echo say --text <text>/);
  const commands = Array.from({ length: 30 }, (_, i) => ({ ...table.commands[0], name: ["echo", `cmd${i}`] }));
  const output = snippet({ plugins: [{ name: "echo", commands }] });
  assert.equal((output.match(/sfd echo cmd/g) ?? []).length, 6);
  assert.match(output, /24 more commands/);
  assert.match(renderHelpIndex({ table: merged }), /Plugin echo:/);
  assert.match(renderCommandManual("echo say", merged), /--text.*required/);
});

test("cache rebuilds missing and corrupt files, invalidates edits and runs warm in under one second", t => {
  const root = mkdtempSync(join(tmpdir(), "sfd-table-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, "echo"); cpSync(fixture, plugin, { recursive: true });
  const env = { SFD_RUNTIME_DIR: join(root, "runtime"), SFD_PLUGIN_PATHS: plugin, SFD_PLUGIN_PATHS_ONLY: "1" };
  const first = loadTable({ env }); assert.equal(first.plugins[0].commands.length, 1);
  const start = performance.now();
  for (let i = 0; i < 100; i++) assert.equal(loadTable({ env }).key, first.key);
  assert.ok(performance.now() - start < 1000);
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "sf echo say --text hi" } });
  assert.match(handle("claude", input, env), /sfd echo say/);
  writeFileSync(join(env.SFD_RUNTIME_DIR, "plugin-table.json"), "{");
  assert.equal(loadTable({ env }).plugins[0].commands.length, 1);
  const copy = structuredClone(table); copy.commands[0].summary = "Changed";
  writeFileSync(join(plugin, "cli.json"), JSON.stringify(copy));
  assert.notEqual(loadTable({ env }).key, first.key);
  utimesSync(join(plugin, "package.json"), new Date(), new Date(Date.now() + 2000));
  const changed = loadTable({ env });
  assert.notEqual(changed.key, first.key);
  refreshTableMetadata([{ root: plugin, operations: [descriptor], problems: [] }], env);
  assert.match(renderCommandManual("echo say", loadTable({ env })), /Effects: read/);
  writeFileSync(join(plugin, "cli.json"), '{"apiVersion": 1, "commands": []}');
  assert.equal(loadTable({ env }).plugins[0].commands.length, 0);
  assert.equal(handle("claude", input, env), "");
});

test("repeated metadata refreshes keep table advisories unique", t => {
  const root = mkdtempSync(join(tmpdir(), "sfd-table-advisories-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, "echo"); cpSync(fixture, plugin, { recursive: true });
  const env = { SFD_RUNTIME_DIR: join(root, "runtime"), SFD_PLUGIN_PATHS: plugin, SFD_PLUGIN_PATHS_ONLY: "1" };
  const entry = { root: plugin, operations: [{ ...descriptor, optionsSchema: {} }], problems: [] };
  const first = refreshTableMetadata([entry], env).plugins[0].problems;
  assert.equal(first.length, 1);
  assert.match(first[0], /warning:.*shape/);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(refreshTableMetadata([entry], env).plugins[0].problems, first);
    assert.deepEqual(entry.problems, first);
    assert.deepEqual(loadTable({ env }).plugins[0].problems, first);
  }
});

test("formatters reuse CSV and support table, summary, JSON and client modules", async t => {
  const rows = [{ name: "a,b", n: 2 }];
  assert.match(await formatPlugin(rows, { formatter: "csv" }), /"a,b"/);
  assert.match(await formatPlugin(rows, { formatter: "table" }), /name\s+n/);
  assert.equal(await formatPlugin({ summary: "done" }, { formatter: "summary" }), "done");
  assert.deepEqual(JSON.parse(await formatPlugin(rows, { formatter: "json" })), rows);
  const root = mkdtempSync(join(tmpdir(), "sfd-formatter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "format.mjs"), 'export default data => `value: ${data.n}`;');
  assert.equal(await formatPlugin({ n: 2 }, { root, formatter: { module: "./format.mjs" } }), "value: 2");
  await assert.rejects(formatPlugin({}, { root, formatter: { module: "../missing.mjs" } }));
});
