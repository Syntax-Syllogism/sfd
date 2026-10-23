import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { handle, editSettings, hookShell } from "../src/hooks.mjs";

const cli = fileURLToPath(new URL("../bin/sfd.mjs", import.meta.url));
const configs = {
  claude: { tool: "Bash", directory: ".claude", file: "settings.json", event: "PreToolUse" },
  codex: { tool: "Bash", directory: ".codex", file: "hooks.json", event: "PreToolUse" },
  gemini: { tool: "run_shell_command", directory: ".gemini", file: "settings.json", event: "BeforeTool" }
};
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "sfd-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(args, input, dir, env = {}) {
  return spawnSync(process.execPath, [cli, "hook", ...args], {
    input, encoding: "utf8", cwd: dir, timeout: 5000,
    env: { ...process.env, HOME: dir, SFD_RUNTIME_DIR: join(dir, "runtime"), SFD_HOOK_DISABLE: "", SFD_HOOK_SHELL: "posix", ...env }
  });
}
for (const [agent, config] of Object.entries(configs)) {
  const input = { tool_name: config.tool, hook_event_name: config.event, tool_input: { command: 'sf data query -q "SELECT Id" --json', timeout: 5000, description: "query", run_in_background: true } };
  const updatedInput = { ...input.tool_input, command: "sfd query 'SELECT Id'" };
  const expected = agent === "gemini" ? { hookSpecificOutput: { tool_input: updatedInput } } : {
    hookSpecificOutput: { hookEventName: "PreToolUse", ...(agent === "codex" ? { permissionDecision: "allow" } : {}), permissionDecisionReason: "sfd: warm daemon, ~0.3 s", updatedInput }
  };
  test(`${agent}: golden response and no opinion inputs`, () => {
    assert.deepEqual(JSON.parse(handle(agent, JSON.stringify(input), {}, "linux")), expected);
    for (const malformed of ["{", "null", "[]", "1", '"text"']) assert.equal(handle(agent, malformed, {}), "");
    for (const change of [{ tool_name: "read_file" }, { tool_input: { command: "sfd org" } }, { tool_input: null }, { tool_input: { command: 42 } }, { hook_event_name: "AfterTool" }]) {
      assert.equal(handle(agent, JSON.stringify({ ...input, ...change }), {}), "");
    }
    assert.equal(handle(agent, JSON.stringify(input), { SFD_HOOK_DISABLE: "1" }), "");
    assert.equal(handle(agent, JSON.stringify({ ...input, tool_input: { command: 'sf org display --verbose' } }), {}), "");
  });
  test(`${agent}: CLI handles stdin without a daemon`, t => {
    const dir = temporary(t);
    const result = run([agent], JSON.stringify(input), dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), expected);
    for (const payload of ["bad json", JSON.stringify({ tool_name: config.tool, tool_input: { command: "echo hi" } })]) {
      const passthrough = run([agent], payload, dir);
      assert.equal(passthrough.status, 0);
      assert.equal(passthrough.stdout, "");
      assert.equal(passthrough.stderr, "");
    }
    const disabled = run([agent], JSON.stringify(input), dir, { SFD_HOOK_DISABLE: "1" });
    assert.equal(disabled.status, 0);
    assert.equal(disabled.stdout, "");
    assert.equal(existsSync(join(dir, "runtime")), false);
  });
  test(`${agent}: CLI rewrites CSV queries without a daemon`, t => {
    const dir = temporary(t);
    const csvInput = { ...input, tool_input: { ...input.tool_input, command: 'sf data query -q "SELECT Id" -r csv' } };
    const csvExpected = structuredClone(expected);
    const output = csvExpected.hookSpecificOutput;
    (output.updatedInput ?? output.tool_input).command = "sfd query 'SELECT Id' --csv";
    const result = run([agent], JSON.stringify(csvInput), dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), csvExpected);
    assert.equal(existsSync(join(dir, "runtime")), false);
  });
  for (const project of [false, true]) test(`${agent}: ${project ? "project" : "user"} install and uninstall preserve settings`, t => {
    const dir = temporary(t), cwd = join(dir, "project"), home = join(dir, "home");
    mkdirSync(cwd); mkdirSync(home);
    const options = { project, cwd, home };
    const file = join(project ? cwd : home, config.directory, config.file);
    assert.equal(editSettings("uninstall", agent, options).changed, false);
    assert.equal(existsSync(file), false);
    assert.equal(editSettings("install", agent, options).changed, true);
    const fresh = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(fresh.hooks[config.event], [{ matcher: config.tool, hooks: [{ type: "command", command: `sfd hook ${agent}` }] }]);
    assert.equal(editSettings("install", agent, options).changed, false);
    assert.equal(editSettings("uninstall", agent, options).changed, true);
    assert.equal(editSettings("uninstall", agent, options).changed, false);

    // Existing RTK configuration and mixed groups must survive both operations.
    const unrelated = { type: "command", command: "rtk hook claude" };
    const settings = { theme: "dark", hooks: { OtherEvent: [{ custom: true }], [config.event]: [{ matcher: config.tool, hooks: [unrelated] }] } };
    writeFileSync(file, JSON.stringify(settings));
    // The first uninstall already saved the original installed configuration.
    const backup = readFileSync(`${file}.bak`, "utf8");
    editSettings("install", agent, options);
    const installed = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(installed.hooks[config.event][0], settings.hooks[config.event][0]);
    assert.equal(installed.hooks[config.event].length, 2);
    assert.equal(editSettings("install", agent, options).changed, false);
    editSettings("uninstall", agent, options);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), settings);
    assert.equal(readFileSync(`${file}.bak`, "utf8"), backup);
    const mixed = structuredClone(settings);
    mixed.hooks[config.event][0].hooks.push({ type: "command", command: `sfd hook ${agent}` });
    writeFileSync(file, JSON.stringify(mixed));
    editSettings("uninstall", agent, options);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), settings);
  });
  test(`${agent}: backs up original bytes; malformed settings are never overwritten`, t => {
    const dir = temporary(t), file = join(dir, config.directory, config.file);
    mkdirSync(join(dir, config.directory));
    const original = '{ "custom": 1 }\n';
    writeFileSync(file, original);
    editSettings("install", agent, { home: dir });
    assert.equal(readFileSync(`${file}.bak`, "utf8"), original);
    for (const invalid of ["bad json", "null", '[]', '{"hooks":[]}', `{"hooks":{"${config.event}":{}}}`, `{"hooks":{"${config.event}":[{}]}}`]) {
      writeFileSync(file, invalid);
      assert.throws(() => editSettings("install", agent, { home: dir }));
      assert.equal(readFileSync(file, "utf8"), invalid);
    }
  });
  test(`${agent}: install/uninstall CLI supports temp HOME and project scope`, t => {
    const dir = temporary(t);
    for (const scope of [[], ["--project"]]) {
      const result = run(["install", "--agent", agent, ...scope], "", dir);
      assert.equal(result.status, 0, result.stderr);
      if (agent === "codex") assert.match(result.stdout, /trust.*\/hooks/);
      assert.equal(run(["uninstall", "--agent", agent, ...scope], "", dir).status, 0);
    }
    assert.equal(existsSync(join(dir, "runtime")), false);
  });
}
test("unknown agents have no opinion", () => assert.equal(handle("unknown", "{}"), ""));
test("shell selection covers agents, platforms and explicit overrides", () => {
  for (const agent of Object.keys(configs)) for (const platform of ["linux", "darwin", "win32"]) {
    const expected = platform !== "win32" || agent === "claude" ? "posix" : agent === "gemini" ? "powershell" : null;
    assert.equal(hookShell(agent, {}, platform), expected, `${agent}/${platform}`);
    for (const shell of ["posix", "powershell", "invalid", ""]) {
      assert.equal(hookShell(agent, { SFD_HOOK_SHELL: shell }, platform), ["posix", "powershell"].includes(shell) ? shell : null);
    }
  }
  assert.equal(hookShell("check", {}, "win32"), "posix");
});
test("Windows adapters quote for the selected shell and preserve tool input", () => {
  const command = `sf data query -q "SELECT Id WHERE Name = 'x'" --json`;
  for (const agent of Object.keys(configs)) {
    const input = JSON.stringify({ tool_name: configs[agent].tool, tool_input: { command, timeout: 5000 } });
    const response = handle(agent, input, {}, "win32");
    if (agent === "codex") assert.equal(response, "");
    else {
      const output = JSON.parse(response).hookSpecificOutput;
      assert.deepEqual(output.tool_input ?? output.updatedInput, { timeout: 5000, command: agent === "gemini" ? "sfd query 'SELECT Id WHERE Name = ''x'''" : "sfd query 'SELECT Id WHERE Name = '\\''x'\\'''" });
    }
    assert.equal(handle(agent, input, { SFD_HOOK_SHELL: "invalid" }, "win32"), "");
    const output = JSON.parse(handle(agent, input, { SFD_HOOK_SHELL: "powershell" }, "win32")).hookSpecificOutput;
    assert.equal((output.tool_input ?? output.updatedInput).command, "sfd query 'SELECT Id WHERE Name = ''x'''");
  }
  const input = JSON.stringify({ tool_name: "PowerShell", tool_input: { command } });
  assert.equal(handle("claude", input, {}, "win32"), "");
});
test("check accepts a shell option, defaults to the environment and rejects invalid options", t => {
  const dir = temporary(t);
  const command = `sf data query -q "SELECT Id WHERE Name = 'x'" --json`;
  for (const args of [["check", "--shell", "powershell", command], ["check", "--shell=powershell", command], ["check", command]]) {
    const result = run(args, "", dir, { SFD_HOOK_SHELL: "powershell" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "→ sfd query 'SELECT Id WHERE Name = ''x'''\n");
  }
  const overridden = run(["check", "--shell", "posix", command], "", dir, { SFD_HOOK_SHELL: "invalid" });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(overridden.stdout, "→ sfd query 'SELECT Id WHERE Name = '\\''x'\\'''\n");
  for (const args of [["check", "--shell", "cmd", command], ["check", "--shell"], ["check", "--shell="]]) {
    const result = run(args, "", dir);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
  }
  const invalidEnv = run(["check", command], "", dir, { SFD_HOOK_SHELL: "invalid" });
  assert.equal(invalidEnv.status, 1);
  assert.match(invalidEnv.stdout, /invalid SFD_HOOK_SHELL/);
  const pipeline = run(["check", "--shell", "powershell", "sf org display --json | jq ."], "", dir);
  assert.equal(pipeline.status, 1);
  assert.equal(existsSync(join(dir, "runtime")), false);
});
test("hook help succeeds without starting a daemon", t => {
  const dir = temporary(t);
  for (const flag of ["--help", "-h"]) {
    const result = run([flag], "", dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: sfd hook /);
    assert.equal(result.stderr, "");
  }
  assert.equal(existsSync(join(dir, "runtime")), false);
});
test("missing and invalid hook usage exits 2 without starting a daemon", t => {
  const dir = temporary(t);
  for (const args of [[], ["unknown"], ["--unknown"], ["install"], ["uninstall"], ["install", "--agent", "unknown"], ["uninstall", "--agent", "unknown"], ["install", "--agent"], ["install", "--unknown"]]) {
    const result = run(args, "", dir);
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  }
  assert.equal(existsSync(join(dir, "runtime")), false);
});
test("check reports rewrite or skip and never starts daemon", t => {
  const dir = temporary(t);
  const result = run(["check", 'sf data query -q "SELECT Id" -o dev --json'], "", dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "→ sfd query 'SELECT Id' -o 'dev'\n");
  const consumed = run(["check", 'sf data query -q "SELECT Id" --json | jq .'], "", dir);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.equal(consumed.stdout, "→ sfd query 'SELECT Id' --sf-json | jq .\n");
  const skipped = run(["check", 'sf data query -q "SELECT Id" | jq .'], "", dir);
  assert.equal(skipped.status, 1);
  assert.match(skipped.stdout, /skip:.*piped/);
  const disabled = run(["check", "sf org display"], "", dir, { SFD_HOOK_DISABLE: "1" });
  assert.equal(disabled.status, 1);
  assert.match(disabled.stdout, /SFD_HOOK_DISABLE/);
  assert.equal(existsSync(join(dir, "runtime")), false);
});
