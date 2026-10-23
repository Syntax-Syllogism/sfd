import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { rewrite } from "../src/rewrite.mjs";

const query = "SELECT Id, DeveloperName FROM CustomObject WHERE DeveloperName LIKE '%ABC%'";
const cases = [
  { command: `sf data query -o myOrg -q "${query}" --use-tooling-api --json`, sf: ["data", "query", "-o", "myOrg", "-q", query, "--use-tooling-api", "--json"], sfd: ["query", query, "-o", "myOrg", "--tooling"], value: query },
  { command: "sf org display -o 'O''Brien org'", sf: ["org", "display", "-o", "O'Brien org"], sfd: ["org", "-o", "O'Brien org"], value: "O'Brien org" },
  { command: String.raw`sf project deploy start -d 'force-app\main with spaces\default'`, sf: ["project", "deploy", "start", "-d", String.raw`force-app\main with spaces\default`], sfd: ["deploy", "-d", String.raw`force-app\main with spaces\default`], value: String.raw`force-app\main with spaces\default` },
  { command: "sf apex run -f src/*.apex", sf: ["apex", "run", "-f", "src/*.apex"], sfd: ["apex", "-f", "src/*.apex"], value: "src/*.apex" },
];

// npm cmd-shim's node fallback, including $args forwarding through a .ps1 shim.
const ps1 = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe" "$basedir/argv.mjs" $args
  } else {
    & "$basedir/node$exe" "$basedir/argv.mjs" $args
  }
  $ret=$LASTEXITCODE
} else {
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe" "$basedir/argv.mjs" $args
  } else {
    & "node$exe" "$basedir/argv.mjs" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;
const cmd = '@ECHO off\r\n"node.exe" "%~dp0\\argv.mjs" %*\r\n';

for (const shell of ["powershell.exe", "pwsh"]) {
  test(`${shell}: original and rewritten argv survive npm-style Windows shims`, { skip: process.platform !== "win32" && "requires Windows PowerShell" }, t => {
    const probe = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", timeout: 15000 });
    if (shell === "pwsh" && probe.error?.code === "ENOENT") { t.skip("pwsh is not installed"); return; }
    assert.equal(probe.status, 0, probe.error?.message ?? probe.stderr);
    const dir = mkdtempSync(join(tmpdir(), "sfd powershell-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "argv.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
    for (const name of ["sf", "sfd"]) {
      writeFileSync(join(dir, `${name}.ps1`), ps1);
      writeFileSync(join(dir, `${name}.cmd`), cmd);
    }
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = [dir, dirname(process.execPath), env[pathKey]].join(delimiter);
    const capture = command => {
      const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { cwd: dir, env, encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 0, `${command}\n${result.error?.message ?? result.stderr}`);
      return JSON.parse(result.stdout.trim());
    };
    for (const shim of ["ps1", "cmd"]) {
      if (shim === "cmd") for (const name of ["sf", "sfd"]) rmSync(join(dir, `${name}.ps1`));
      for (const entry of cases) {
        const rewritten = rewrite(entry.command, { shell: "powershell" });
        assert.ok(!rewritten.skip, rewritten.skip);
        const originalArgs = capture(entry.command);
        const rewrittenArgs = capture(rewritten.command);
        assert.deepEqual(originalArgs, entry.sf, `${shim}: original`);
        assert.deepEqual(rewrittenArgs, entry.sfd, `${shim}: rewritten`);
        assert.equal(originalArgs.find(value => value === entry.value), rewrittenArgs.find(value => value === entry.value), `${shim}: value parity`);
      }
    }
  });
}
