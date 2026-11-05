export const COMMANDS = [
  {
    name: "help",
    args: "[-a | -g] [<command|guide>]",
    summary: "Show command manuals and concept guides",
    agentTip: "<command>: full documentation",
    targetOrg: false,
    json: false
  },
  {
    "name": "query",
    "args": "<soql>",
    "summary": "Run SOQL (all pages). --tooling, --all (include deleted), --limit <n>, --csv. --sf-json for sf-compatible JSON",
    "agentTip": "\"<soql>\" --csv --limit 200: SOQL; --tooling, --all",
    "docs": [{ "file": "query.md" }]
  },
  {
    "name": "apex",
    "args": "[file]",
    "summary": "Run anonymous Apex from a file, -f <file>, or stdin. --log for the full debug log. --sf-json for sf-compatible JSON",
    "agentTip": "-f <file> (or stdin): anonymous Apex; debug and fatal lines"
  },
  {
    "name": "rest",
    "args": "<path>",
    "summary": "Call a REST path, e.g. /services/data/v67.0/limits. -X <method>, --body <json|@file>",
    "agentTip": "<path>: REST; -X <method>, --body <json|@file>"
  },
  {
    "name": "describe",
    "args": "<sobject>",
    "summary": "Compact describe. --tooling, --raw for the full describe. --sf-json for sf-compatible JSON",
    "agentTip": "<sobject>: compact describe; --tooling, --raw",
    "agentGroup": "describe"
  },
  {
    "name": "list-metadata-types",
    "args": "",
    "summary": "List supported metadata types (cached per org and API version)",
    "agentTip": ": supported metadata types (cached)",
    "docs": [{ "file": "metadata-list.md" }],
    "agentGroup": "describe"
  },
  {
    "name": "list-metadata",
    "args": "-m <Type>[,<Type>…]",
    "summary": "List metadata names. -m repeatable, --folder <name>, --details for audit fields",
    "agentTip": "-m <Type>: metadata names; --folder <name>, --details",
    "docs": [{ "file": "metadata-list.md" }],
    "agentGroup": "describe"
  },
  {
    "name": "deploy",
    "args": "",
    "summary": "Deploy source. -d <path> (repeatable), -m <Type[:Name]> (repeatable),\n--check-only, -l <test level>, -t <test> (repeatable), -w <minutes>",
    "agentTip": "-d <path> | -m <Type:Name>: deploy source",
    "docs": [{ "file": "source-tracking.md" }],
    "agentGroup": "source"
  },
  {
    "name": "retrieve",
    "args": "",
    "summary": "Retrieve source. -d <path>, -m <Type[:Name]> or -x <package.xml>,\n-w <minutes>, --ignore-conflicts. No selector pulls tracked remote changes",
    "agentTip": "[-d <path> | -m <Type:Name> | -x <manifest>]: retrieve source",
    "docs": [{ "file": "source-tracking.md" }],
    "agentGroup": "source"
  },
  {
    "name": "tracking",
    "args": "",
    "summary": "Show source-tracked changes. --local | --remote, --conflicts (conflicts only)",
    "agentTip": "[--local | --remote] [--conflicts]: source changes",
    "docs": [{ "file": "source-tracking.md" }]
  },
  {
    "name": "test",
    "args": "",
    "summary": "Run Apex tests. -n <class> (repeatable), -t <Class.method> (repeatable),\n-s <suite> (repeatable), -l <test level>, -c (coverage), -w <minutes>, --logs, --no-trace,\n-y/--synchronous (one class; no suites; RunSpecifiedTests only; -w affects socket timeout only)",
    "agentTip": "-n <class> [-y] | -t <Class.method>: Apex tests; --logs, -c"
  },
  {
    "name": "logs",
    "args": "",
    "summary": "List recent debug logs. --count/--limit <10>, --user <username>, --no-trace",
    "agentTip": "[--count 10]: recent debug logs",
    "docs": [{ "file": "debug-logs.md" }],
    "agentGroup": "logs"
  },
  {
    "name": "logs get",
    "args": "<id|latest>",
    "summary": "Print a filtered log. --full for raw text, --no-trace",
    "agentTip": "latest: filtered debug log; --full for raw text",
    "docs": [{ "file": "debug-logs.md" }],
    "agentGroup": "logs"
  },
  {
    "name": "org",
    "args": "",
    "summary": "Show the resolved org (username, id, instance, API version). --sf-json for sf-compatible JSON",
    "agentTip": ": resolved org details",
    "docs": [{ "file": "org-list.md" }],
    "agentGroup": "orgs"
  },
  {
    "name": "org list",
    "args": "[--all] [--status]",
    "summary": "List authenticated orgs (local; --status pings). --sf-json for sf-compatible JSON",
    "agentTip": "[--all] [--status]: list local orgs; optional live checks",
    "docs": [{ "file": "org-list.md" }],
    "agentGroup": "orgs",
    "targetOrg": false
  },
  {
    "name": "hook",
    "args": "<agent|check|install|uninstall>",
    "summary": "Integrate with Claude Code, Codex CLI or Gemini CLI",
    "agentTip": "install --agent <claude|codex|gemini>: install rewrite hook",
    "docs": [{ "file": "agent-hooks.md" }],
    "agentGroup": "agents"
  },
  {
    "name": "agents-snippet",
    "args": "[--write [file]]",
    "summary": "Print agent instructions, or update AGENTS.md / CLAUDE.md",
    "agentTip": "[--write [file]]: print or update agent instructions",
    "docs": [{ "file": "agents-snippet.md" }],
    "agentGroup": "agents",
    "targetOrg": false,
    "json": false
  },
  {
    "name": "discover",
    "args": "[--since 30d]",
    "summary": "Report missed sfd opportunities in local agent transcripts",
    "agentTip": "[--since 30d]: local transcript adoption report",
    "docs": [{ "file": "discover.md" }],
    "agentGroup": "agents"
  },
  {
    "name": "start",
    "args": "",
    "summary": "Start the daemon",
    "agentTip": ": start the daemon",
    "agentGroup": "lifecycle",
    "targetOrg": false,
    "json": false
  },
  {
    "name": "stop",
    "args": "",
    "summary": "Stop the daemon",
    "agentTip": ": stop the daemon",
    "agentGroup": "lifecycle",
    "targetOrg": false,
    "json": false
  },
  {
    "name": "status",
    "args": "",
    "summary": "Show daemon status",
    "agentTip": ": daemon status",
    "agentGroup": "lifecycle",
    "targetOrg": false
  },
  {
    "name": "reload",
    "args": "",
    "summary": "Restart the daemon and drop cached orgs and auth state",
    "agentTip": ": restart daemon and drop cached orgs and auth state",
    "agentGroup": "lifecycle",
    "targetOrg": false,
    "json": false
  }
];

export function commandHelp() {
  const commands = COMMANDS.filter(command => command.agentGroup !== "lifecycle");
  commands.push({
    name: "start | stop | status | reload",
    args: "",
    summary: "Manage the daemon. reload drops cached orgs and auth state"
  });
  return commands.map(({ name, args, summary }) => {
    const syntax = [name, args].filter(Boolean).join(" ");
    const description = summary.replaceAll("\n", "\n                        ");
    return syntax.length >= 22
      ? `  ${syntax}\n                        ${description}`
      : `  ${syntax.padEnd(22)}${description}`;
  }).join("\n");
}

export function commandUsage(name) {
  const command = COMMANDS.find(entry => entry.name === name);
  if (!command) return undefined;
  const syntax = [command.name, command.args].filter(Boolean).join(" ");
  const commonOptions = [
    ...(command.targetOrg === false ? [] : ["  -o, --target-org <alias>  Select the target org"]),
    ...(command.json === false ? [] : ["  --json                    Print the raw JSON response"]),
    "  -h, --help                Show this help"
  ];
  const specificOptions = name === "help" ? [
    "",
    "Options:",
    "  -a, --all                 List all commands and guides",
    "  -g, --guides              List guides only"
  ] : [];
  return [
    `Usage: sfd ${syntax} [options]`,
    "",
    command.summary,
    "",
    "Common options:",
    ...commonOptions,
    ...specificOptions,
    "",
    "Run 'sfd help <command|guide>' for full documentation."
  ].join("\n");
}
