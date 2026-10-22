import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, utimes, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { read as claude } from "../src/discover/claude.mjs";
import { read as codex } from "../src/discover/codex.mjs";
import { read as gemini } from "../src/discover/gemini.mjs";
import { classify, discover, discoverOptions, formatReport } from "../src/discover/index.mjs";
import { rewrite } from "../src/rewrite.mjs";

const since = new Date("2026-10-01");
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "sfd-discover-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = {
    claude: join(home, ".claude/projects/encoded/session.jsonl"),
    codex: join(home, ".codex/sessions/2026/10/21/rollout-test.jsonl"),
    gemini: join(home, ".gemini/tmp/hash/chats/session.json")
  };
  for (const [agent, file] of Object.entries(paths)) {
    await mkdir(resolve(file, ".."), { recursive: true });
    await copyFile(`test/fixtures/discover/${agent}.${agent === "gemini" ? "json" : "jsonl"}`, file);
    await utimes(file, new Date("2026-10-22"), new Date("2026-10-22"));
  }
  return { home, paths };
}
const collect = async reader => { const result = []; for await (const record of reader) result.push(record); return result; };

test("readers pair results, preserve missing samples, and count malformed/unknown entries", async t => {
  const { home } = await fixture(t);
  for (const [reader, count, duration, chars] of [[claude, 5, 2000, 8], [codex, 5, 4000, 12], [gemini, 3, undefined, 4]]) {
    const stats = {};
    const records = await collect(reader({ home, since, stats }));
    assert.equal(records.length, count);
    assert.equal(records[0].durationMs, duration);
    assert.equal(records[0].outputChars, chars);
    assert.ok(records[0].ts instanceof Date);
    assert.ok(stats.ignoredEntries > 0);
    if (reader !== gemini) assert.equal(stats.malformedEntries, 1);
    assert.ok(records.some(record => record.outputChars === undefined));
  }
});

test("classifications use the rewrite engine, ignore mentions and handle shell wrappers", () => {
  for (const command of ['sf org display', 'sf data query -q "SELECT Id FROM Account"', 'cd /work && sf org display', 'sf apex run test', 'sf org display | jq .', 'sf org display --verbose', 'sf org create scratch', 'sf org display -o "$ORG"']) {
    assert.equal(classify(command).classification === "rewritable", Boolean(rewrite(command).command), command);
  }
  assert.equal(classify('echo "sf org display"'), undefined);
  assert.equal(classify("cat sfd.log"), undefined);
  assert.equal(classify("echo 'sfd org'"), undefined);
  assert.equal(classify("rtk sf org display").classification, "skipped");
  assert.equal(classify("sfdx force:org:list").classification, "legacy");
  for (const command of ["sfdx plugins", "sfdx org list", "sfdx"]) {
    assert.deepEqual(classify(command), {
      classification: "skipped",
      subcommand: command.slice(5) || "(no subcommand)",
      reason: rewrite(command).skip
    });
  }
  assert.equal(classify("sfd org").classification, "adopted");
  assert.equal(classify("sf org display && sfd org").classification, "skipped");
});

test("reports redact values from skip reasons before grouping", async t => {
  const { home, paths } = await fixture(t);
  const commands = [
    'sf data query -q SELECT --result-format=PRIVATE_ONE',
    'sf data query -q SELECT --result-format=PRIVATE_TWO',
    'sf org display --json=PRIVATE_BOOLEAN',
    'sf org display --target-org=PRIVATE_ORG --target-org=PRIVATE_DUPLICATE',
    'sf org display --target-org=PRIVATE_ORG --unknown=PRIVATE_UNKNOWN',
    'sf org display --target-org=-PRIVATE_VALUE',
    'sf org display "--PRIVATE FLAG"'
  ];
  await writeFile(paths.claude, commands.map((command, id) => JSON.stringify({
    timestamp: "2026-10-21", message: { content: [{ type: "tool_use", name: "Bash", id, input: { command } }] }
  })).join("\n"));
  const report = await discover({ home, since, agents: ["claude"] });
  assert.equal(report.counts.skipped, commands.length);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.doesNotMatch(formatReport(report), /PRIVATE/);
  assert.deepEqual(report.skipReasons.find(item => item.name === "unsupported result format"), { name: "unsupported result format", count: 2 });
  assert.ok(report.skipReasons.some(item => item.name === "unsupported boolean value --json"));
  assert.ok(report.skipReasons.some(item => item.name === "duplicate flag --target-org"));
  assert.ok(report.skipReasons.some(item => item.name === "unsupported flag --unknown"));
  assert.ok(report.skipReasons.some(item => item.name === "unsupported value for --target-org"));
});

test("report command groups omit positional values in every classification", async t => {
  const { home, paths } = await fixture(t);
  const cases = [
    ['sf data query "SELECT Id FROM PRIVATE_ACCOUNT" --verbose', "skipped", "data query"],
    ['sf data query "SELECT Name FROM PRIVATE_CONTACT" --verbose', "skipped", "data query"],
    ['sf api request rest /PRIVATE_ENDPOINT', "rewritable", "api request rest"],
    ['sf org create scratch PRIVATE_ALIAS', "unsupported", "org create scratch"],
    ['sfd query "SELECT Id FROM PRIVATE_ACCOUNT"', "adopted", "query"],
    ['sfd logs get PRIVATE_LOG', "adopted", "logs get"],
    ['sfdx force:org:list PRIVATE_ORG', "legacy", "force:org:list"],
    ['sf PRIVATE_COMMAND PRIVATE_ARGUMENT', "unsupported", "(unrecognized subcommand)"],
    ['sfdx force:PRIVATE_COMMAND PRIVATE_ARGUMENT', "legacy", "(unrecognized subcommand)"],
    ['sf data query "$PRIVATE_QUERY" --verbose', "skipped", "data query"]
  ];
  for (const [command, classification, subcommand] of cases) {
    assert.equal(classify(command).classification, classification, command);
    assert.equal(classify(command).subcommand, subcommand, command);
  }
  await writeFile(paths.claude, cases.map(([command], id) => JSON.stringify({
    timestamp: "2026-10-21", message: { content: [{ type: "tool_use", name: "Bash", id, input: { command } }] }
  })).join("\n"));
  const report = await discover({ home, since, agents: ["claude"] });
  assert.equal(report.sfCalls + report.counts.adopted, cases.length);
  assert.equal(report.commands.find(item => item.subcommand === "data query" && item.reason === "unsupported flag --verbose").count, 2);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SELECT/);
  assert.doesNotMatch(formatReport(report), /PRIVATE|SELECT/);
});

test("all readers count missing and invalid candidate timestamps, but not old calls", async t => {
  const { home, paths } = await fixture(t);
  const timestamps = [undefined, null, "invalid", "2026-09-01", "2026-10-21"];
  for (const [agent, reader] of Object.entries({ claude, codex, gemini })) {
    const entries = timestamps.map((timestamp, id) => {
      if (agent === "claude") return { timestamp, message: { content: [{ type: "tool_use", name: "Bash", id, input: { command: "sf org display" } }] } };
      if (agent === "codex") return { timestamp, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd: "sf org display" }) } };
      return { timestamp, toolCalls: [{ name: "run_shell_command", args: { command: "sf org display" } }] };
    });
    await writeFile(paths[agent], agent === "gemini" ? JSON.stringify({ messages: entries }) : entries.map(entry => JSON.stringify(entry)).join("\n"));
    const stats = {};
    const records = await collect(reader({ home, since, stats }));
    assert.equal(records.length, 1, agent);
    assert.equal(stats.malformedEntries, 3, agent);
  }
  const report = await discover({ home, since });
  assert.equal(report.sfCalls, 3);
  assert.equal(report.diagnostics.malformedEntries, 9);
});

test("aggregate includes medians, coverage and conservative savings", async t => {
  const { home } = await fixture(t);
  const report = await discover({ home, since, window: "30d" });
  assert.deepEqual(report.counts, { rewritable: 4, skipped: 4, unsupported: 1, legacy: 1, adopted: 3 });
  assert.equal(report.sfCalls, 10);
  assert.equal(report.sessions, 3);
  assert.deepEqual(report.estimates, { timeSavedMs: 5400, durationSamples: 2, outputChars: 24, outputSamples: 3, outputTokens: 6 });
  const query = report.commands.find(c => c.subcommand === "data query");
  assert.equal(query.count, 2);
  assert.equal(query.medianDurationMs, 3000);
  assert.equal(query.medianOutputChars, 10);
  assert.equal(query.medianOutputTokens, 2.5);
  assert.equal(report.diagnostics.malformedEntries, 2);
  assert.equal(report.commands.find(c => c.classification === "legacy").medianDurationMs, null);
  assert.equal(formatReport(report), [
    "sfd discover: 30d, 3 agents, 10 sf/sfdx calls in 3 sessions",
    "  rewritable now  4  (~0.1 min saved (2 samples); ~6 output tokens (3 samples))",
    "  skipped         4  sf output is piped 2 · asynchronous tests need --wait or --synchronous 1 · unsupported flag --verbose 1",
    "  not in sfd      2  force:org:list 1 · org create scratch 1 (legacy 1)",
    "  already sfd     3",
    "Top rewritable: data query 2 · org display 2",
    `Scan: 2 malformed, ${report.diagnostics.ignoredEntries} ignored entries, 0 unreadable files.`,
    "Durations include permission wait; savings assume 0.3 s/call. Tokens are chars/4.",
    "Output tokens are potential savings before sfd output, which is not measured. Missing samples are not extrapolated.",
    "Counts classify shell tool calls once; compound calls use the first sf/sfdx invocation."
  ].join("\n"));
});

test("filters by timestamp, file mtime, agent and project path boundary", async t => {
  const { home, paths } = await fixture(t);
  assert.equal((await discover({ home, since: new Date("2026-10-21T12:00:08Z") })).sfCalls, 3);
  const filtered = await discover({ home, since, project: "/work/app/", agents: ["claude"] });
  assert.equal(filtered.counts.rewritable, 1, "sibling /work/application is excluded");
  await utimes(paths.claude, new Date(0), new Date(0));
  assert.equal((await discover({ home, since, agents: ["claude"] })).sfCalls, 0);
  assert.equal((await discover({ home, since: new Date("2027-01-01") })).sfCalls, 0);
});

test("missing stores, unknown shapes and malformed Gemini documents are harmless", async t => {
  const { home, paths } = await fixture(t);
  await writeFile(paths.gemini, "{broken");
  const report = await discover({ home, agents: ["gemini"] });
  assert.equal(report.diagnostics.malformedEntries, 1);
  await writeFile(paths.gemini, "null");
  assert.equal((await discover({ home, agents: ["gemini"] })).diagnostics.ignoredEntries, 1);
  assert.equal((await discover({ home: join(home, "missing") })).sfCalls, 0);
});

test("Codex cmd arguments, argv, missing results and malformed arguments", async t => {
  const { home, paths } = await fixture(t);
  const entry = payload => JSON.stringify({ type: "response_item", timestamp: "2026-10-21", payload });
  await writeFile(paths.codex, [
    entry({ type: "function_call", name: "exec_command", call_id: "a", arguments: JSON.stringify({ cmd: "sf org display", workdir: "/work/app" }) }),
    entry({ type: "function_call", name: "shell", call_id: "b", arguments: JSON.stringify({ command: ["sf", "org", "display"] }) }),
    entry({ type: "function_call", name: "shell_command", arguments: "{broken" })
  ].join("\n"));
  const stats = {};
  const records = await collect(codex({ home, since, stats }));
  assert.equal(records.length, 2);
  assert.equal(records[0].cwd, "/work/app");
  assert.equal(classify(records[1].command).classification, "rewritable");
  assert.equal(stats.malformedEntries, 1);
  assert.equal((await collect(codex({ home, since, project: "/work/app" }))).length, 1);
});

test("CLI validates flags and reads fixtures locally without a daemon", async t => {
  const { home } = await fixture(t);
  const runtime = join(home, "runtime");
  const run = (...args) => spawnSync(process.execPath, [resolve("bin/sfd.mjs"), "discover", ...args], {
    encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, SFD_RUNTIME_DIR: runtime }, timeout: 10000
  });
  for (const args of [["--since", "x"], ["--agent", "other"], ["--top", "0"], ["--top", "1.5"], ["extra"], ["--since", "9".repeat(100) + "d"]]) {
    const result = run(...args);
    assert.equal(result.status, 2, result.stderr);
  }
  const result = run("--since", "9999d", "--agent", "claude", "--agent", "codex", "--json", "--top", "1");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).agents, ["claude", "codex"]);
  assert.equal(JSON.parse(result.stdout).counts.adopted, 2);
  assert.equal(run("--help").status, 0);
  await assert.rejects(access(runtime));
  assert.equal(discoverOptions({ since: "12h" }, Date.parse("2026-10-22")).since.toISOString(), "2026-10-21T12:00:00.000Z");
});
