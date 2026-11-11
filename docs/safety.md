---
title: Safety policy
description: "sfd gates built-in commands and plugin operations by declared effects and target org type."
---

sfd gates built-in commands and plugin operations by declared effects and target org type.

Source: `src/policy.mjs` (`checkPolicy`, `decide`, `builtinEffects`, `DEFAULT_POLICY`,
the policy loader), `src/ops/effects.mjs` (`EFFECTS`, the declared effects of each
built-in), `src/handlers.mjs` (`policyGate`, and the wrapper that runs it before the
project queue), `src/ops/org-list.mjs` (its own check), `src/hooks.mjs`
(`CONFIRM_DENY_RULES` and the `ask` decisions), and the plugin effects ceiling in
`src/plugin/handler.mjs` and `src/plugin/supervisor.mjs`. Tests:
`test/policy.test.mjs`, `test/ops-registry.test.mjs` and `test/hooks.test.mjs`.

## Effects and defaults

| Effect | Built-in commands | Scratch | Sandbox | Production / unknown |
| --- | --- | --- | --- | --- |
| `read` | query, describe, metadata lists, logs, org, org list, tracking, test | allow | allow | allow |
| `local-write` | retrieve | allow | allow | allow |
| `org-write` | deploy, apex, REST POST/PATCH/PUT | allow | allow | ask |
| `destructive` | REST DELETE | allow | ask | ask |

`ping`, `status` and `reload` are daemon commands that never reach an org, so they
skip the generic gate. `org list` applies its own check, against the most restricted
org it lists.

REST GET/HEAD are reads; other methods conservatively count as org writes.
Deploy includes `--check-only`: this preview can run tests and still uses the
org-write policy. Deploy does not accept destructive manifest flags.
Anonymous Apex is classified as org-write even though arbitrary Apex can delete
data. Apex tests count as reads because their data changes roll back. Logs and
`test --logs` retain their automatic TraceFlag setup; this incidental write is
not separately gated. Effects describe command intent, not a Salesforce sandbox.

Plugins declare an effects ceiling. A write's recomputed plan may narrow that
ceiling; the host rejects effects outside it before apply. The strictest policy
decision wins: `deny`, then `ask`, then `allow`. Read operations also honor custom
read restrictions.

## Session expiry

When Salesforce reports `INVALID_SESSION_ID` or `INVALID_AUTH_HEADER`, sfd drops
the affected username's cached connections, traces and metadata-type state.
Cached org types are preserved. The invalidation rules are in
[auth-cache.md](auth-cache.md). Whether the failed call is retried depends on the
operation:

- Retry-safe built-ins are retried once on a fresh connection, even if the call
  had already started: `query`, `describe`, `org`, `list-metadata-types`,
  `list-metadata`, `tracking`, `logs`, `logs get`, `test`, and REST GET/HEAD.
- `deploy`, `retrieve`, `apex`, and REST POST/PATCH/PUT/DELETE are retried only if
  the session failed before the call started (for example, while connecting).
  Once started, the error is `SessionExpired` and is not retried. A deploy may or
  may not have applied, so check the org (the deploy ID when one is known) before
  running it again. A retrieve may or may not have changed local files, and
  re-running it is safe.
- Plugin operations follow their `retry` descriptor. A failure during connection
  creation is retried for any operation; see [plugins](plugins.md#lifecycle-and-auth).

## Request limits

Read calls retry `REQUEST_LIMIT_EXCEEDED`, `ConcurrentPerOrgLongTxn`, and
`ExceededQuota` up to twice. Writes and Apex test execution are never retried for
these errors. The backoff, the bounded fan-out and the API usage reporting are in
[Request limits](request-limits.md).

## Org types

Scratch orgs have an auth `expirationDate` or `devHubUsername`. Otherwise sfd
queries `Organization` for `IsSandbox`, `OrganizationType` and
`TrialExpirationDate`. `IsSandbox: true` means sandbox; false means production.
Developer Edition, trial orgs and Dev Hubs count as production. Failed detection
is `unknown`, which uses production rules.

Detection is cached by username. `sfd reload` clears it. An auth change keeps
known types, since a username's org type never changes, and drops only alias
entries whose alias now names another username. A session error for one org
keeps it too. A restarted daemon seeds its cache from an existing
`org-types.json` and re-checks those aliases before first use. The daemon
atomically writes a token-free `org-types.json` in its runtime directory for hooks. It rewrites the file only when the serialized
content changes. A failed write is logged and does not fail the request, so hooks
may read a stale file until the next successful write. `sfd org --json` includes a
top-level `type`.
`org list --json` keeps its existing display `type` and adds `safetyType`:
scratch when known locally, otherwise the cached safety type or unknown. Listing
orgs does not introduce a network lookup for safety classification.

## Policy file

The default file is `~/.config/sfd/policy.json`; `SFD_POLICY` overrides its path.
An absent file uses the defaults above. Partial rules merge over defaults.
Invalid JSON, versions, types, effects or decisions cause a usage error.
The daemon reloads changed files before evaluating subsequent requests.

```json
{
  "version": 1,
  "rules": {
    "production": { "destructive": "deny" }
  },
  "orgs": { "uat": "production" }
}
```

`orgs` maps usernames or aliases to `scratch`, `sandbox` or `production`.
A username override takes precedence over an alias override. Overrides affect
policy evaluation; org display reports the detected type.

## Confirmation

An ask decision stops execution with exit code **4** and prints a summary and
12-character confirmation hash on stderr:

```text
sfd: approval required: org-write on production org prod (user@example.com)
plan: apex ...
re-run with: --confirm 3f9a1c0b7d2e   (valid 10 min)
```

Review the proposed change and repeat the same command with `--confirm <hash>`.
Confirmation is single use and expires after ten minutes. Its SHA-256 hash
covers canonical JSON of the operation, resolved username, options and plan.
Built-ins use a null plan and bind the supplied command options and input body;
they do not preview remote state or hash the contents of deploy source files.
Plugin writes recompute the plan and require approval again if it changes.

```sh
sfd op example.change -o prod --options-json @options.json --plan --json
sfd op example.change -o prod --options-json @options.json --confirm <hash>
```

Plugin preview returns the plan and `policy` decision, including a hash when
approval is needed. Preview never applies or consumes approval. Deny decisions
have no confirmation hash and cannot be overridden with `--confirm`.

For an approval error, `--json` prints
`{ "status": 4, "approvalRequired": { "decision": "ask", "hash": "...", "effect": "org-write", "orgType": "production", "summary": "...", "expiresAt": "..." } }`.
Plugin previews may also include the `plan`.
Denials print status 4 with their reason. Supported `--sf-json` commands use an
sf-style error with `name: "ApprovalRequired"` (or `PolicyDenied`) and
`exitCode: 4`. Other exit codes keep their existing meanings.

## Agent permissions and hooks

Claude and Codex rewrite hooks ask the harness for permission when a rewritten
command's policy decision is ask or deny. They read only local policy and cached
org types; they never start the daemon or contact Salesforce. An uncached or
unresolved default target uses unknown. A leading `SF_TARGET_ORG` assignment or
explicit `-o` selects the cached org. Each rewritten call in a shell list is
checked. Plugin `cli.json` rewrites use the effects that `sfd plugin list`
caches from the plugin's operation descriptors. A command without cached
effects counts as `org-write`; effects written into `cli.json` itself are
ignored. Gemini keeps its existing response shape because it has no equivalent
permission decision field. The daemon still enforces confirmation after the
harness prompt.

An agent must not approve its own plan. `sfd hook install --agent claude`
therefore adds three deny rules to `permissions.deny` in the same settings file
as the hook:

```json
{
  "permissions": {
    "deny": [
      "Bash(sfd * --confirm *)",
      "Bash(sfd --confirm *)",
      "Bash(sfd *--confirm=*)"
    ]
  }
}
```

A `*` matches any text, including spaces, but the text before it must match
literally, so each rule covers one spelling: `--confirm` after a subcommand,
`--confirm` as the first argument, and the `--confirm=<hash>` form. Install
appends only the missing rules and keeps your other permission entries and
their order, so re-running it after an older sfd adds the rules. Pass
`--no-deny-confirm` to install only the hook. Uninstall removes exactly these
three rules and the hook. It removes `permissions.deny` only when no other rules
remain in it, and removes `permissions` only when it is then empty.

Per the [Claude Code permissions reference](https://code.claude.com/docs/en/permissions),
deny rules apply when any subcommand of a compound command matches (`&&`,
`;`, pipes, subshells and command substitution). They also match past a
leading assignment such as `SF_TARGET_ORG=prod sfd …`, and past the wrappers
`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command` and `builtin`. They do
not match `sh -c "…"`, an absolute path such as `/usr/local/bin/sfd`, `npx`,
or other indirection. Add rules for executable paths and any wrappers allowed
in your environment. Deny rules are not a security boundary. The daemon's
confirmation check is the enforcement point, and a human should run approved
confirmations outside the agent.

Codex and Gemini have no equivalent rule that sfd can install. Codex exec-policy
rules match prefixes only, and Gemini has no `permissions.deny`. Configure
those agents yourself to keep `--confirm` out of agent-issued commands. Raw sf
commands outside supported rewrites retain the agent harness's existing
permission behavior.
