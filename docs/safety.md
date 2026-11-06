# Safety policy

sfd gates built-in commands and plugin operations by declared effects and target org type.

## Effects and defaults

| Effect | Built-in commands | Scratch | Sandbox | Production / unknown |
| --- | --- | --- | --- | --- |
| `read` | query, describe, metadata lists, logs, org, tracking, test | allow | allow | allow |
| `local-write` | retrieve | allow | allow | allow |
| `org-write` | deploy, apex, REST POST/PATCH/PUT | allow | allow | ask |
| `destructive` | REST DELETE | allow | ask | ask |

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

## Org types

Scratch orgs have an auth `expirationDate` or `devHubUsername`. Otherwise sfd
queries `Organization` for `IsSandbox`, `OrganizationType` and
`TrialExpirationDate`. `IsSandbox: true` means sandbox; false means production.
Developer Edition, trial orgs and Dev Hubs count as production. Failed detection
is `unknown`, which uses production rules.

Detection is cached by username, cleared on auth changes, session invalidation
and `sfd reload`. The daemon atomically writes a token-free `org-types.json` in
its runtime directory for hooks. `sfd org --json` includes a top-level `type`.
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
checked. Plugin `cli.json` rewrites use the effects declared in the cached
plugin table; a command without declared effects counts as `org-write`. Gemini keeps its existing response shape because it has no equivalent
permission decision field. The daemon still enforces confirmation after the
harness prompt.

Configure agent permissions to deny agent-issued confirmation commands so an
agent cannot approve its own plan. For Claude Code, a wildcard rule can be placed
in `permissions.deny` in settings:

```json
{ "permissions": { "deny": ["Bash(sfd * --confirm *)"] } }
```

Also cover the argument order `Bash(sfd --confirm *)`, executable paths and any
wrappers allowed in your environment. Have a human run approved confirmations
outside the agent. See the [Claude Code permissions reference](https://code.claude.com/docs/en/permissions)
for rule matching details. Hook installation does not add these permission rules;
that remains a follow-up. Raw sf commands outside supported rewrites retain
the agent harness's existing permission behavior.
