import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rewrite } from "../src/rewrite.mjs";

const rewrites = [
  ['sf data query -q "SELECT Id FROM Account" -o dev --json', "sfd query 'SELECT Id FROM Account' -o 'dev'"],
  ["sf data query --query='SELECT Id' --target-org=x -t --all-rows -r json", "sfd query 'SELECT Id' -o 'x' --tooling --all"],
  ["sf data query -q 'SELECT Id' --result-format human", "sfd query 'SELECT Id'"],
  ['sf data query -q "SELECT Id WHERE Name = \'a|b>;c\'"', "sfd query 'SELECT Id WHERE Name = '\\''a|b>;c'\\'''"],
  ["sf apex run -f code.apex --json", "sfd apex -f 'code.apex'"],
  ["sf apex run --file=x.apex -o dev", "sfd apex -f 'x.apex' -o 'dev'"],
  ["sf apex run", "sfd apex"],
  ["sf project deploy start -d src -d other -m ApexClass:X --dry-run -l RunSpecifiedTests -t A B -w 10 -o dev --json", "sfd deploy -d 'src' -d 'other' -m 'ApexClass:X' --check-only -l 'RunSpecifiedTests' -t 'A' -t 'B' -w '10' -o 'dev'"],
  ["sf project deploy start --source-dir=src --metadata ApexClass:X ApexClass:Y", "sfd deploy -d 'src' -m 'ApexClass:X' -m 'ApexClass:Y'"],
  ["sf apex run test -n A B -t A.method -s S -l RunSpecifiedTests -c -w 5 -r human --json -o dev", "sfd test -n 'A' -n 'B' -t 'A.method' -s 'S' -l 'RunSpecifiedTests' -c -w '5' -o 'dev'"],
  ["sf apex run test --synchronous --class-names=A --result-format=json", "sfd test -n 'A'"],
  ["sf sobject describe -s Account -t --target-org=dev --json", "sfd describe 'Account' --tooling -o 'dev'"],
  ["sf api request rest /services/data/v67.0/limits -X GET -o dev", "sfd rest '/services/data/v67.0/limits' -X 'GET' -o 'dev'"],
  ['sf api request rest /path --method=POST --body \'{"x":1}\'', 'sfd rest \'/path\' -X \'POST\' --body \'{"x":1}\''],
  ["sf api request rest /path -X POST -b @body.json", "sfd rest '/path' -X 'POST' --body '@body.json'"],
  ["sf org display -o dev --json", "sfd org -o 'dev'"],
  ['cd "my project" && sf data query -q "SELECT Id"', 'cd "my project" && sfd query \'SELECT Id\''],
  ["SF_TARGET_ORG='my org' sf org display", "SF_TARGET_ORG='my org' sfd org"],
  ["cd x && SF_TARGET_ORG=x sf org display", "cd x && SF_TARGET_ORG=x sfd org"],
  ["printf 'System.debug(1);' | sf apex run -o dev", "printf 'System.debug(1);' | sfd apex -o 'dev'"],
  ["cat code | cat | sf apex run", "cat code | cat | sfd apex"],
  ["sf apex run <<'APEX'\nSystem.debug('$x | ;');\nAPEX\n", "sfd apex <<'APEX'\nSystem.debug('$x | ;');\nAPEX\n"],
  ["cd x && sf apex run 2>&1 <<EOF\nSystem.debug(1);\nEOF", "cd x && sfd apex 2>&1 <<EOF\nSystem.debug(1);\nEOF"],
  ["sf apex run <<EOF 2>&1\nSystem.debug(1);\nEOF", "sfd apex 2>&1 <<EOF\nSystem.debug(1);\nEOF"],
  ["sf apex run <<'EOF'\na\\\nb\nEOF", "sfd apex <<'EOF'\na\\\nb\nEOF"],
  ["sf org display 2>&1", "sfd org 2>&1"],
  ["sf org display 2>/dev/null", "sfd org 2>/dev/null"],
  ["sf data query \\\n -q 'SELECT Id'", "sfd query 'SELECT Id'"],
  ["sf data query -q 'SELECT\nId'", undefined],
  ["sf data query -q 'SELECT \\\nId'", undefined],
  ["sf data query -q 'SELECT $x, `x`'", "sfd query 'SELECT $x, `x`'"],
  ['sf data query -q "SELECT \\$x"', "sfd query 'SELECT $x'"],
  ["sf data query -q 'SELECT '\\''O'\\'' FROM X'", "sfd query 'SELECT '\\''O'\\'' FROM X'"],
];
for (const [input, expected] of rewrites) {
  test(`rewrite: ${input}`, () => {
    const result = rewrite(input);
    if (expected === undefined) assert.ok(result.skip);
    else { assert.equal(result.command, expected); assert.match(result.reason, /sfd/); }
  });
}

const skips = [
  ['sf data query -q "SELECT Id" --json | jq .', 'piped'],
  ["sf org display > out", 'redirection'], ["sf org display >> out", 'redirection'],
  ["sf org display | tee out", 'piped'], ["sf org display | sf apex run", 'piped'],
  ['echo "$(sf org display)"', 'substitution'], ['echo `sf org display`', 'substitution'],
  ['sf data query -q "$QUERY"', 'expansion'],
  ["sf org display; echo done", 'chain'], ["sf org display || true", 'chain'],
  ["echo x && sf org display", 'chain'], ["cd x && sf org display && true", 'chain'],
  ["sfdx force:data:soql:query", 'plain sf'], ["./node_modules/.bin/sf org display", 'plain sf'],
  ["SF_X=1 sf org display", 'plain sf'], ["env SF_TARGET_ORG=x sf org display", 'plain sf'],
  ["sfd org", 'plain sf'], ["sf data query -q q --api-version 67", 'unsupported flag'],
  ["sf data query -q q -f q.txt", 'unsupported flag'], ["sf data query -q q --bulk", 'unsupported flag'],
  ["sf data query -q q -r csv", 'result format'], ["sf data query -q q -w 5", 'unsupported flag'],
  ["sf data query --query", 'missing value'], ["sf data query -q q --json=true", 'boolean'],
  ["sf data query -q q -q other", 'duplicate'], ["sf data query", 'required'],
  ["sf project deploy start --json", 'needs source-dir'],
  ...['-x manifest.xml', '--metadata-dir dir', '--async', '--pre-destructive-changes x', '--post-destructive-changes x', '--ignore-conflicts', '--ignore-errors', '--purge-on-delete', '-c', '-g', '--concise', '--verbose'].map(f => [`sf project deploy start -d src ${f}`, 'unsupported flag']),
  ["sf apex run test -n A", 'asynchronous'], ["sf apex run test -w 0", 'positive'],
  ["sf apex run test -y -r junit", 'result format'], ["sf apex run test -y -r tap", 'result format'],
  ["sf apex run test -y -d results", 'unsupported flag'],
  ...['-H Accept:json', '-S out', '-i', '--json'].map(f => [`sf api request rest /x ${f}`, 'unsupported flag']),
  ["sf api request rest /x --body=hello", 'implicit'],
  ["sf api request rest /x -X GET --body=hello", 'explicit GET'],
  ["sf api request rest /x -X post --body=hello", 'method'],
  ["sf api request rest /x --body=-", 'unsupported'],
  ["sf org display --verbose", 'unsupported flag'], ["sf org list", 'unsupported sf command'],
  ["sf org display < file", 'redirection'], ["cat x | sf org display", 'only for apex'],
  ["sf org display &", 'chain'], ["sf apex run <<EOF\nx\nEOF\necho x", 'terminator'],
  ["sf apex run <<EOF\nx\nEOF\nx\nEOF", 'terminator'],
  ["sf apex run <<EOF\nx\nEOF ", 'terminator'],
  ["sf apex run <<EOF", 'terminator'], ["sf org display\necho x", 'multiline'],
  ["sf data query -q 'unclosed", 'unclosed'], ["sf apex run -f *.apex", 'syntax'],
  ["sf apex run -f ~/x.apex", 'syntax'], ["sf org display # hi", 'syntax'],
  ["cd - && sf org display", 'chain'], ["sf org display extra", 'positional'],
  ["sf sobject describe --sobject=-x", 'unsupported'],
  ["sf org display " + String.fromCharCode(92), 'escape'], ["", 'empty'], [null, 'empty']
];
for (const [input, reason] of skips) test(`skip: ${input}`, () => assert.ok(rewrite(input).skip?.includes(reason), JSON.stringify(rewrite(input))));

test("rewritten quoting round trips through a real shell without executing metacharacters", { skip: process.platform === "win32" && "needs a POSIX /bin/sh" }, () => {
  const query = "SELECT Id WHERE Name = 'a|b;>c' AND Other = '$HOME `id`'";
  const input = `sf data query -q '${query.replaceAll("'", "'\\''")}'`;
  const result = rewrite(input);
  const capture = spawnSync("/bin/sh", ["-c", `sfd() { printf '%s\\n' "$@"; }; ${result.command}`], { encoding: "utf8" });
  assert.equal(capture.status, 0);
  assert.equal(capture.stdout, `query\n${query}\n`);
});


for (const [args, expected] of [
  ["", "sfd retrieve"],
  ["-m ApexClass:Foo ApexClass:Bar --ignore-conflicts -w 5 -o dev --json", "sfd retrieve -m 'ApexClass:Foo' -m 'ApexClass:Bar' --ignore-conflicts -w '5' -o 'dev'"],
  ["--manifest=package.xml -c", "sfd retrieve -x 'package.xml' --ignore-conflicts"],
  ["-d classes -d flows", "sfd retrieve -d 'classes' -d 'flows'"]
]) test(`retrieve rewrite: ${args}`, () => assert.equal(rewrite(`sf project retrieve start ${args}`).command, expected));

for (const args of ["--target-metadata-dir out", "-t out", "-r out", "--output-dir out", "--package-name pkg", "-n pkg", "-z", "--unzip", "-m ApexClass -d src"]) {
  test(`retrieve skip: ${args}`, () => assert.ok(rewrite(`sf project retrieve start ${args}`).skip));
}
for (const command of ["retrieve", "deploy"]) test(`${command} preview stays unmapped`, () => assert.ok(rewrite(`sf project ${command} preview`).skip));


test("debug log rewrites accept IDs or one latest log and skip file output", () => {
  assert.equal(rewrite("sf apex list log -o dev --json").command, "sfd logs -o 'dev'");
  assert.equal(rewrite("sf apex get log -i 07L000000000001").command, "sfd logs get '07L000000000001'");
  assert.equal(rewrite("sf apex get log --log-id 07L000000000001").command, "sfd logs get '07L000000000001'");
  assert.equal(rewrite("sf apex get log --number 1").command, "sfd logs get 'latest'");
  for (const args of ["-n 2", "-i id -n 1", "-n 1 -d logs", "-n 1 --output-dir logs", ""]) {
    assert.ok(rewrite(`sf apex get log ${args}`).skip, args);
  }
});
