import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rewrite } from "../src/rewrite.mjs";

const powershell = { shell: "powershell" };
const reportedQuery = "SELECT Id, DeveloperName FROM CustomObject WHERE DeveloperName LIKE '%ABC%'";
for (const [input, expected] of [
  [`sf data query -o myOrg -q "${reportedQuery}" --use-tooling-api --json`, `sfd query 'SELECT Id, DeveloperName FROM CustomObject WHERE DeveloperName LIKE ''%ABC%''' -o 'myOrg' --tooling`],
  ["sf data query -q 'SELECT Id WHERE Name = ''O''''Brien'''", "sfd query 'SELECT Id WHERE Name = ''O''''Brien'''"],
  [String.raw`sf project deploy start -d force-app\main\default`, String.raw`sfd deploy -d 'force-app\main\default'`],
  ["sf apex run -f 'code with spaces.apex'", "sfd apex -f 'code with spaces.apex'"],
  ["sf data query -q 'SELECT $x, `x`; | & < > @ # () {}'", "sfd query 'SELECT $x, `x`; | & < > @ # () {}'"],
  ["sf data query -q q -r csv --json", "sfd query 'q' --csv"],
  ["sf org list --json", "sfd org list --json --status"],
  ["sf org display --target-org=dev", "sfd org -o 'dev'"],
  [" \tsf org display\r\n", "sfd org"],
  ["sf apex run -f src/*.apex", "sfd apex -f 'src/*.apex'"],
]) test(`PowerShell rewrite: ${input}`, () => {
  assert.deepEqual(rewrite(input, powershell), { command: expected, reason: "sfd: warm daemon, ~0.3 s", rewritten: 1, skipped: [] });
});

for (const input of [
  "sf org display | cat", "sf org display; echo hi", "sf org display && echo hi", "sf org display || echo hi",
  "sf org display > out", "sf org display 2>$null", "sf org display < input", "& sf org display",
  "sf org display -o $org", "sf org display -o `org", "sf org display -o @(a)", "sf org display -o a,b",
  "sf org display # comment", "sf org display -o {a}", "sf org display --% -o dev",
  ...Array.from("‘’‚‛“”„", q => `sf org display -o ${q}org${q}`),
  'sf org display -o \'a"b\'', String.raw`sf project deploy start -d 'path with spaces\'`,
  "sf org display -o ''", 'sf org display -o ""', 'sf org display -o "a$var"', 'sf org display -o "a`b"',
  'sf data query --query="SELECT Id"', "sf org display -o a'b'", "sf org display -o 'a'b", 'sf org display -o "a""b"',
  "sf org display -o 'unclosed", "sf org display\necho hi", "sf org display\n\n", "sf data query -q 'SELECT\nId'",
  "sf.cmd org display", "./sf org display", "'sf' org display", "sfdx org display", "SF_TARGET_ORG=x sf org display",
  "sf apex run", "sf apex run -o dev --json", "sf org display -o a!b", "sf data query", "sf org display --verbose",
  'sf apex run test -n A', 'sf data query -q q --json | jq .',
]) test(`PowerShell skip: ${input}`, () => assert.ok(rewrite(input, powershell).skip, input));

test("explicit POSIX mode is identical to the default and unknown shells skip", () => {
  for (const input of ['sf data query -q "SELECT Id WHERE Name = \'x\'"', 'sf org display --json | jq .']) {
    assert.deepEqual(rewrite(input, { shell: "posix" }), rewrite(input));
  }
  assert.ok(rewrite("sf org display", { shell: "cmd" }).skip);
});

const rewrites = [
  ["sf org list metadata-types -o dev --json", "sfd list-metadata-types -o 'dev'"],
  ["sf org list metadata -m Report --folder Public -o dev", "sfd list-metadata -m 'Report' --folder 'Public' -o 'dev'"],
  ["sf org list metadata --metadata-type=ApexClass --json", "sfd list-metadata -m 'ApexClass'"],
  ['sf data query -q "SELECT Id FROM Account" -o dev --json', "sfd query 'SELECT Id FROM Account' -o 'dev'"],
  ["sf data query --query='SELECT Id' --target-org=x -t --all-rows -r json", "sfd query 'SELECT Id' -o 'x' --tooling --all"],
  ["sf data query -q 'SELECT Id' --result-format human", "sfd query 'SELECT Id'"],
  ["sf data query -q 'SELECT Id' -r csv", "sfd query 'SELECT Id' --csv"],
  ["sf data query --query='SELECT Id' --result-format=csv -o dev -t --all-rows --json", "sfd query 'SELECT Id' --csv -o 'dev' --tooling --all"],
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
  ["sf org list metadata", "needs metadata-type"],
  ...["metadata", "metadata-types"].flatMap(command => ["--api-version 67.0", "-f out.json", "--output-file out.json"].map(flag => [`sf org list ${command} ${flag}`, "unsupported flag"])),

  ["sf org display > out", 'redirection'], ["sf org display >> out", 'redirection'],
  ["sf org display | tee out", 'piped'],
  ['echo "$(sf org display)"', 'plain sf'], ['echo `sf org display`', 'plain sf'],
  ['sf data query -q "$QUERY"', 'expansion'],

  ["sfdx force:data:soql:query", 'plain sf'], ["./node_modules/.bin/sf org display", 'plain sf'],
  ["SF_X=1 sf org display", 'plain sf'], ["env SF_TARGET_ORG=x sf org display", 'plain sf'],
  ["sfd org", 'plain sf'], ["sf data query -q q --api-version 67", 'unsupported flag'],
  ["sf data query -q q -f q.txt", 'unsupported flag'], ["sf data query -q q --bulk", 'unsupported flag'],
  ["sf data query -q q -r xml", 'result format'], ["sf data query -q q -w 5", 'unsupported flag'],
  ["sf data query -q q -r csv --result-format json", 'duplicate'],
  ["sf data query --query", 'missing value'], ["sf data query -q q --json=true", 'boolean'],
  ["sf data query -q q -q other", 'duplicate'], ["sf data query", 'required'],
  ["sf project deploy start --json", 'needs source-dir'],
  ...['-x manifest.xml', '--metadata-dir dir', '--async', '--pre-destructive-changes x', '--post-destructive-changes x', '--ignore-conflicts', '--ignore-errors', '--purge-on-delete', '-c', '-g', '--concise', '--verbose'].map(f => [`sf project deploy start -d src ${f}`, 'unsupported flag']),
  ["sf apex run test -n A", 'asynchronous'], ["sf apex run test -w 0", 'positive'],
  ["sf apex run test -y -r junit", 'result format'], ["sf apex run test -y -r tap", 'result format'],
  ["sf apex run test -y -r csv", 'result format'],
  ["sf apex run test -y -d results", 'unsupported flag'],
  ...['-H Accept:json', '-S out', '-i', '--json'].map(f => [`sf api request rest /x ${f}`, 'unsupported flag']),
  ["sf api request rest /x --body=hello", 'implicit'],
  ["sf api request rest /x -X GET --body=hello", 'explicit GET'],
  ["sf api request rest /x -X post --body=hello", 'method'],
  ["sf api request rest /x --body=-", 'unsupported'],
  ["sf org display --verbose", 'unsupported flag'], ["sf org list --clean", 'unsupported flag'],
  ["sf org display < file", 'redirection'], ["cat x | sf org display", 'only for apex'],
  ["sf org display &", 'background'],

  ["sf apex run <<EOF\nx\nEOF ", 'terminator'],
  ["sf apex run <<EOF", 'terminator'],
  ["sf data query -q 'unclosed", 'unclosed'], ["sf apex run -f *.apex", 'syntax'],
  ["sf apex run -f ~/x.apex", 'syntax'], ["sf org display # hi", 'syntax'],
   ["sf org display extra", 'positional'],
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
]) test(`retrieve rewrite: ${args}`, () => assert.equal(rewrite(`sf project retrieve start${args ? ` ${args}` : ""}`).command, expected));

for (const args of ["--target-metadata-dir out", "-t out", "-r out", "--output-dir out", "--package-name pkg", "-n pkg", "-z", "--unzip", "-m ApexClass -d src"]) {
  test(`retrieve skip: ${args}`, () => assert.ok(rewrite(`sf project retrieve start${args ? ` ${args}` : ""}`).skip));
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

test("org list preserves status defaults and supported flags", () => {
  assert.equal(rewrite("sf org list").command, "sfd org list --status");
  assert.equal(rewrite("sf org list --skip-connection-status").command, "sfd org list");
  assert.equal(rewrite("sf org list --all --json").command, "sfd org list --all --json --status");
  assert.equal(rewrite("sf org list --skip-connection-status --all --json").command, "sfd org list --all --json");
  for (const flag of ["--clean", "--verbose", "-p", "--no-prompt", "-o dev"]) assert.ok(rewrite(`sf org list ${flag}`).skip);
});

for (const [input, output] of [
  ['sf data query -q q --json | jq .; gh pr view 73 --json state', "sfd query 'q' --sf-json | jq .; gh pr view 73 --json state"],
  ['cd ~/projects/x && sf data query -q q 2>/dev/null --json | jq .', "cd ~/projects/x && sfd query 'q' --sf-json 2>/dev/null | jq ."],
  ['S=$VAR; sf org display; echo *.txt && sf sobject describe -s Account --json > out.json', "S=$VAR; sfd org; echo *.txt && sfd describe 'Account' --sf-json > out.json"],
  ["cat > f <<'EOF'\n$x; | bad\nEOF\nsf org display", "cat > f <<'EOF'\n$x; | bad\nEOF\nsfd org"],
  ['echo $(echo x; echo y); sf org display || sf org display', 'echo $(echo x; echo y); sfd org || sfd org'],
  ['sf org display\necho x', 'sfd org\necho x'],
  ['sf org display --json >> out', 'sfd org --sf-json >> out'],
  ['sf org list --json | jq .', 'sfd org list --status --sf-json | jq .'],
  ['sf org list --skip-connection-status --json | jq .', 'sfd org list --skip-connection-status --sf-json | jq .'],
  ['sf apex run -f code --json | jq .', "sfd apex -f 'code' --sf-json | jq ."],
  ['sf org display 2>/dev/null -o dev 2>&1', "sfd org -o 'dev' 2>/dev/null 2>&1"],
]) test(`list/pipe rewrite: ${input}`, () => assert.equal(rewrite(input).command, output));
for (const input of [
  'sf apex run test -y --json | jq .', 'sf project deploy start -d src --json | jq .', 'sf apex list log --json | head',
  'sf data query -q q -r json | jq .', 'sf org display --json 2>&1 | jq .', 'sf org display --json > f 2>&1',
  'sf org display --json | jq .result.accessToken', 'sf org list --json | jq .sfdxAuthUrl',
  'SF_TEMP_SHOW_SECRETS=true; sf org display --json | jq .', 'SF_TEMP_SHOW_SECRETS=true; sf org display', 'sf org display 1> f', 'sf org display 2> f',
  'sf org display 3> f', 'sf org display < f', 'sf org display --json > $FILE',
]) test(`consumed output skip: ${input}`, () => assert.ok(rewrite(input).skip));
test('partial rewrite retains skipped calls and opaque bytes', () => {
  const input = 'sf data query -q "$Q";  sf org display\t|| echo "$X"';
  const result = rewrite(input);
  assert.equal(result.command, 'sf data query -q "$Q";  sfd org\t|| echo "$X"');
  assert.equal(result.rewritten, 1);
  assert.deepEqual(result.skipped, ['shell expansion or command substitution']);
});

test('heredoc bytes stay opaque when another pipeline or list element owns the body', () => {
  for (const [input, output] of [
    ["cat <<EOF; sf org display\n'\\\n$secret; | sf org display\nEOF", "cat <<EOF; sfd org\n'\\\n$secret; | sf org display\nEOF"],
    ['sf apex run <<EOF --json | jq .\nSystem.debug(1);\nEOF', 'sfd apex --sf-json <<EOF | jq .\nSystem.debug(1);\nEOF'],
    ["sf apex run <<EOF\n'\nEOF\nsf org display", "sfd apex <<EOF\n'\nEOF\nsfd org"],
  ]) assert.equal(rewrite(input).command, output);
});
