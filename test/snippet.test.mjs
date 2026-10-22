import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { COMMANDS, commandHelp } from "../src/commands.mjs";
import { snippet, upsertSnippet } from "../src/snippet.mjs";

const cli = resolve("bin/sfd.mjs");
const block = snippet();

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "sfd-snippet-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = join(cwd, "runtime");
  return {
    cwd,
    run: (...args) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd, encoding: "utf8", timeout: 10000,
        env: { ...process.env, SFD_RUNTIME_DIR: runtime, SFD_SF_ROOT: join(cwd, "no-sf"), SF_TARGET_ORG: "" }
      });
      assert.ifError(result.error);
      assert.equal(existsSync(runtime), false, "local command must not start the daemon");
      return result;
    }
  };
}

test("snippet includes all command metadata and token tips within 15 lines", () => {
  assert.ok(block.split("\n").length <= 15);
  for (const { name } of COMMANDS) assert.ok(block.includes(`sfd ${name}`), name);
  assert.ok(block.includes('query "<soql>" --csv --limit 200'));
  assert.ok(block.includes("logs get latest"));
  assert.ok(block.includes("sf … --json"));
  assert.ok(block.startsWith("<!-- sfd:start -->\n"));
  assert.ok(block.endsWith("\n<!-- sfd:end -->"));
});

test("new command metadata automatically appears in help and snippet", () => {
  COMMANDS.push({ name: "future-command", args: "<value>", summary: "Future command" });
  try {
    assert.ok(commandHelp().includes("future-command <value>"));
    assert.ok(snippet().includes("`sfd future-command <value>`: Future command"));
  } finally { COMMANDS.pop(); }
});

test("snippet rejects agent tips without a usage-description separator", () => {
  COMMANDS.push({ name: "invalid-command", args: "", summary: "Invalid command", agentTip: "missing separator" });
  try {
    assert.throws(() => snippet(), /Invalid agentTip for invalid-command: expected ": " separator/);
  } finally { COMMANDS.pop(); }
});

test("upsert creates and appends with one blank line and a trailing newline", () => {
  assert.equal(upsertSnippet("", block), `${block}\n`);
  for (const suffix of ["", "\n", "\n\n\n", " \n\t"]) {
    assert.equal(upsertSnippet(`Existing instructions${suffix}`, block), `Existing instructions\n\n${block}\n`);
  }
});

test("upsert replaces only the marked range and is idempotent", () => {
  const prefix = "# Instructions\r\nKeep these spaces  \n\n";
  const suffix = "\r\n\nOther instructions  ";
  const original = `${prefix}<!-- sfd:start -->\nold\n<!-- sfd:end -->${suffix}`;
  const updated = `${prefix}${block}${suffix}`;
  assert.equal(upsertSnippet(original, block), updated);
  assert.equal(upsertSnippet(updated, block), updated);
  assert.equal(upsertSnippet(`${block}\n`, block), `${block}\n`);
});

test("upsert rejects incomplete, reversed, duplicate and nested markers", () => {
  for (const text of ["<!-- sfd:start -->", "<!-- sfd:end -->", "<!-- sfd:end --><!-- sfd:start -->", `${block}\n${block}`, "<!-- sfd:start --><!-- sfd:start --><!-- sfd:end -->"]) {
    assert.throws(() => upsertSnippet(text, block));
  }
});

test("CLI prints the snippet without an org or daemon", t => {
  const { run } = fixture(t);
  const result = run("agents-snippet");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${block}\n`);
});

test("CLI defaults to CLAUDE.md at project root from a child directory", t => {
  const { cwd, run } = fixture(t);
  writeFileSync(join(cwd, "sfdx-project.json"), "{}");
  writeFileSync(join(cwd, "CLAUDE.md"), "# Claude\n");
  mkdirSync(join(cwd, "child"));
  const result = spawnSync(process.execPath, [cli, "agents-snippet", "--write"], {
    cwd: join(cwd, "child"), encoding: "utf8", timeout: 10000,
    env: { ...process.env, SFD_RUNTIME_DIR: join(cwd, "runtime") }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Updated CLAUDE.md\n");
  assert.equal(readFileSync(join(cwd, "CLAUDE.md"), "utf8"), `# Claude\n\n${block}\n`);
  assert.equal(existsSync(join(cwd, "child", "AGENTS.md")), false);
  assert.equal(run("agents-snippet", "--write").stdout, "CLAUDE.md already up to date\n");
});

test("CLI creates AGENTS.md, prefers it over CLAUDE.md, and avoids rewriting", t => {
  const { cwd, run } = fixture(t);
  writeFileSync(join(cwd, "sfdx-project.json"), "{}");
  const file = join(cwd, "AGENTS.md");
  const first = run("agents-snippet", "--write");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "Created AGENTS.md\n");
  assert.equal(readFileSync(file, "utf8"), `${block}\n`);
  const before = statSync(file, { bigint: true }).mtimeNs;
  writeFileSync(join(cwd, "CLAUDE.md"), "untouched");
  const second = run("agents-snippet", "--write");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "AGENTS.md already up to date\n");
  assert.equal(statSync(file, { bigint: true }).mtimeNs, before);
  assert.equal(readFileSync(join(cwd, "CLAUDE.md"), "utf8"), "untouched");
});

test("CLI falls back to cwd and supports explicit relative and absolute paths", t => {
  const { cwd, run } = fixture(t);
  assert.equal(run("agents-snippet", "--write").status, 0);
  assert.equal(existsSync(join(cwd, "AGENTS.md")), true);
  mkdirSync(join(cwd, "docs"));
  for (const file of ["docs/CLAUDE.md", join(cwd, "custom.md")]) {
    const result = run("agents-snippet", "--write", file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(resolve(cwd, file), "utf8"), `${block}\n`);
  }
});

test("CLI rejects malformed blocks with exit 2 and leaves files intact", t => {
  const { cwd, run } = fixture(t);
  const file = join(cwd, "AGENTS.md");
  const original = "Keep\n<!-- sfd:start -->\nold";
  writeFileSync(file, original);
  const result = run("agents-snippet", "--write");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Malformed sfd block in AGENTS.md: found start marker without end/);
  assert.equal(readFileSync(file, "utf8"), original);
  for (const args of [["extra"], ["--write", "one", "two"]]) {
    assert.equal(run("agents-snippet", ...args).status, 2);
  }
});

test("CLI reports target read and write failures as local usage errors", t => {
  const { cwd, run } = fixture(t);
  mkdirSync(join(cwd, "directory"));
  for (const [file, operation, code] of [
    ["directory", "read", "EISDIR"],
    ["missing-parent/AGENTS.md", "write", "ENOENT"]
  ]) {
    const result = run("agents-snippet", "--write", file);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(`Cannot ${operation} target file ${join(cwd, file)}:`), result.stderr);
    assert.ok(result.stderr.includes(code), result.stderr);
    assert.doesNotMatch(result.stderr, /daemon|log:/);
  }
  assert.ok(statSync(join(cwd, "directory")).isDirectory());
  assert.equal(existsSync(join(cwd, "missing-parent")), false);
});

const originalCommands = "  query <soql>          Run SOQL (all pages). --tooling, --all (include deleted), --limit <n>, --csv\n  apex [file]           Run anonymous Apex from a file, -f <file>, or stdin. --log for the full debug log\n  rest <path>           Call a REST path, e.g. /services/data/v67.0/limits. -X <method>, --body <json|@file>\n  describe <sobject>    Compact describe. --tooling, --raw for the full describe\n  list-metadata-types   List supported metadata types (cached per org and API version)\n  list-metadata -m <Type>[,<Type>…]\n                        List metadata names. -m repeatable, --folder <name>, --details for audit fields\n  deploy                Deploy source. -d <path> (repeatable), -m <Type[:Name]> (repeatable),\n                        --check-only, -l <test level>, -t <test> (repeatable), -w <minutes>\n  retrieve              Retrieve source. -d <path>, -m <Type[:Name]> or -x <package.xml>,\n                        -w <minutes>, --ignore-conflicts. No selector pulls tracked remote changes\n  tracking              Show source-tracked changes. --local | --remote, --conflicts (conflicts only)\n  test                  Run Apex tests. -n <class> (repeatable), -t <Class.method> (repeatable),\n                        -s <suite> (repeatable), -l <test level>, -c (coverage), -w <minutes>, --logs, --no-trace\n  logs                  List recent debug logs. --count/--limit <10>, --user <username>, --no-trace\n  logs get <id|latest>  Print a filtered log. --full for raw text, --no-trace\n  org                   Show the resolved org (username, id, instance, API version)\n  org list [--all] [--status]\n                        List authenticated orgs (local; --status pings)\n  hook <agent|check|install|uninstall>\n                        Integrate with Claude Code, Codex CLI or Gemini CLI\n  start | stop | status | reload\n                        Manage the daemon. reload drops cached orgs and auth state";

test("help preserves existing command text and shares the metadata", t => {
  const { run } = fixture(t);
  const result = run("--help");
  assert.equal(result.status, 0, result.stderr);
  const commands = result.stdout.split("Commands:\n")[1].split("\n\nCommon options:")[0];
  assert.equal(commands, commandHelp());
  const withoutSnippet = commands.split("\n").filter(line => !line.startsWith("  agents-snippet ") && !line.includes("Print agent instructions, or update") && !line.startsWith("  discover ") && !line.includes("Report missed sfd opportunities")).join("\n");
  assert.equal(withoutSnippet, originalCommands);
});
