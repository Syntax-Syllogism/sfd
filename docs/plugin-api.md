---
title: Plugin API v0
description: "The experimental v0 operation contract defines the manifest, operations and test helpers for sfd plugins."
---

The experimental v0 operation contract defines the manifest, operations and test helpers for sfd plugins.

**v0, experimental:** this API may break between sfd minor versions, with
changes recorded in the CHANGELOG. The contract package is
`@syntax-syllogism/sfd-plugin` version `0.0.1`, MIT licensed, with zero runtime
dependencies and no build step. The [plugin host](plugins.md) discovers manifests and executes operations in
isolated warm workers.

## Manifest and module

The `SfdManifest` is the `sfd` key of a plugin's `package.json`:

```json
{
  "sfd": {
    "apiVersion": 0,
    "operations": "./lib/sfd/operations.js",
    "cli": "./lib/sfd/cli.json",
    "requires": { "sfd": ">=0.7.0" }
  }
}
```

`operations` is required; `cli` and `requires` are optional. Paths start with
`./`, cannot contain `..` segments, backslashes or NUL characters, and are
relative to the package root. `requires.sfd` is a version range string;
validation of that range belongs to the host. `ApiVersion` is currently `0`.

An operations file's default export is an `OperationModule`:

```js
export default { apiVersion: 0, operations: [listOperation, changeOperation] };
```

`operations` must be non-empty. Validators accept either the export itself or
a module namespace, preferring `default` when present. IDs are unique within
the module, lowercase, namespaced and stable: `warden.access`, for example.
They match `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/` and must never be reused
for a different operation once published.

`Operation` is the union of `ReadOperation<O, R>` and
`WriteOperation<O, P, R>`. Both contain a descriptor:

```ts
// ReadOperation
{ kind: "read", descriptor, async run(conn, options, ctx) { /* return R */ } }
// WriteOperation
{ kind: "write", descriptor,
  async plan(conn, options, ctx) { /* return P & WritePlan */ },
  async apply(conn, plan, ctx) { /* return R */ } }
```

These fragments illustrate signatures rather than executable definitions.
`conn` is `Connection | undefined`. The host worker builds the connection using
the plugin's own Salesforce library; this package never imports it at runtime.
Zod 4 and `@salesforce/core` are optional type-only peers. Operations use the
connection and context they receive rather than resolving auth themselves.

## Descriptor

`OperationDescriptor<O>` declares:

| Field | Meaning |
| --- | --- |
| `id: string` | Stable namespaced operation ID. |
| `cliId?: string` | Matching sf command ID, such as `warden:access`. |
| `title: string` | Non-empty human title. |
| `summary: string` | Non-empty single line, at most 120 characters. |
| `effects: Effect[]` | Non-empty static ceiling, without duplicates. |
| `requiresOrg: OrgRequirement` | `required`, `optional` or `none`. |
| `requiresProject: boolean` | Requires a project root and serialization per project. |
| `optionsSchema: ZodType<O>` | Owns validation and transformation of options. |
| `retry: "safe" | "unsafe"` | Whether replay after an uncertain failure is safe. |
| `paged?: boolean` | Returns a list and honors `options.limit`. |

A write with `retry: "safe"` produces an advisory warning. Authors must ensure
replay is safe, including after an uncertain timeout.

## Context and org

`OperationContext` supplies `signal: AbortSignal`,
`onProgress(event: ProgressEvent)`, `notice(message: string)`,
`resolvePath(path: string)`, optional `reportFailures(count: number)`, and optional `projectRoot` and `org`.
`ProgressEvent` has a required `phase: string` and optional `done: number`,
`total: number`, and `message: string`. Notices are short human messages for
stderr; return structured data separately.

Call `ctx.reportFailures?.(count)` with a non-negative integer to report completed item failures from `run`, `plan`, or `apply`. The last call wins across plan and apply; a positive count appears in the success envelope and causes exit 1 while data and warnings are still printed. The optional call supports older hosts without this method. Invalid counts cause an `invalid-failures` error.

`projectRoot` is present when `requiresProject` is true, or when the client is
inside an sfdx project. `resolvePath` resolves user paths against the client's
cwd. Never use `process.cwd()` or change the process cwd. Operations must not call
`process.exit`, set `process.exitCode`, prompt, or add process-wide listeners; use `reportFailures` for partial failures.
Honor cancellation through `signal` and report progress through the context.

`OrgInfo` contains `username: string`, `apiVersion: string`, `type: OrgType`,
and optional `alias: string` and `instanceUrl: string`. `OrgType` is `scratch`,
`sandbox`, `production` or `unknown`. The host detects the type from the org and
uses `unknown` (production rules) when detection fails; see
[safety policy](safety.md). `org` is present for `requiresOrg: "required"`, and for
`"optional"` when an org was supplied. An operation with `"none"` can run with
an undefined connection.

## Effects and plans

`Effect` is `read | local-write | org-write | destructive`. Effects are an
unordered set, with exact membership rather than an implied hierarchy.
Reads may declare only `read` and/or `local-write`; local-only generation is a
read with `local-write`. Writes must declare `org-write` or `destructive`.

`WritePlan` has optional `effects: Effect[]` and `summary: string`. The summary
is one human line for previews and approval prompts. The plan may also carry
operation-specific fields through generic `P extends object`. A plan may
narrow the descriptor's ceiling but never widen it. Omitted effects mean the
full ceiling. `effects: []` is a valid zero-change plan. Plans must not cause
the org changes they describe; `apply` receives the computed plan.

`effectsExceeding(ceiling, planEffects)` returns distinct effects outside the
ceiling, or `[]` for an omitted or valid narrowing. A malformed non-array
`planEffects` throws. This helper checks membership, not whether declared
effects truthfully describe an operation's behavior.

## Errors and envelopes

Operations return plain data. They may throw an error with the
`OperationErrorShape`: required `code: string` and `message: string`, optional
`actions: string[]` and `retryable: "safe" | "unsafe" | "no"`. The host owns
wrapping results into `Envelope<R>`, the union of:

```ts
type Ok<R> = { ok: true; data: R; total?: number; truncated?: boolean; failures?: number; warnings: string[] };
type Err = { ok: false; code: string; message: string; actions: string[];
             retryable: "safe" | "unsafe" | "no" };
```

For paged operations, use the shared `limit` option and return
`{ items, total, truncated }` as data, setting `descriptor.paged: true`.

## CLI table

`CliTable` describes `cli.json`: `{ apiVersion: 0, commands: CliCommand[] }`.
It is static data, readable without importing plugin code. The packaged
`packages/sfd-plugin/cli.schema.json` describes its JSON structure.
`validateCliTable(table, operations?)` returns errors and `warning: ` advisories;
passing operations also checks IDs, sf words against `cliId`, and top-level
option keys against `optionsSchema.shape`. Without a shape, key validation is
skipped with a warning. Names must start with the operation namespace; command
names, flag names and single-letter aliases must be unique within their scope.
Host flags `target-org` and `api-version` omit `option`; `o` and `h` are reserved
aliases. A table cannot declare `confirm`: the host adds `--confirm <hash>` to
every direct command, and the rewrite hook never forwards `--confirm` from an sf
command. Paths in custom formatters start with `./` and stay under the real
plugin root, including through symlinks.

Use `sfd plugin init [root] [--ops echo.say,…] [--write]` to generate an initial
table from descriptors and `oclif.manifest.json`. It prints JSON on stdout and
manual review items on stderr. `--write` saves `cli.json` and sets `sfd.cli` in
package.json. Commit and maintain the generated file by hand. Manifest option
flags default to strings: integer/file/directory hints are honored when present;
manifests may omit parser information, so review custom parsing and types.
Missing manifests fall back to schema keys as string flags. Relationships and
unmapped flags are review items, not automatically enforced constraints.

`CliCommand` fields:

| Field | Meaning |
| --- | --- |
| `operation: string` | Operation ID. |
| `name: string[]` | sfd command words, e.g. `["warden", "access"]`. |
| `summary: string` | Short description. |
| `agentTip?: string` | Agent guidance. |
| `docs?: string` | Documentation reference. |
| `sf?: string[]` | Matching sf command words for rewriting. |
| `flags: CliFlag[]` | Accepted flags and option mapping. |
| `formatter?` | `table`, `csv`, `summary`, `json`, or `{ module: string }`. |

`CliFlag` fields: `name: string` (long sf flag name), optional `char: string`,
`type: "string" | "boolean" | "integer" | "file" | "directory"`, optional
`multiple: boolean`, optional `option: string` (schema key), and optional
`required: boolean`. Omit `option` for host-handled target-org and api-version.

Formatter names select client output: `csv` uses sfd CSV escaping; `table`
aligns object rows (an array or `data.items`); `summary` uses `data.summary`
when present, otherwise compact JSON; `json` prints indented JSON. Empty tables
fall back to JSON. `{ "module": "./format.mjs" }` imports a default pure
function `(data, {columns}) => string` by file URL in the CLI process. `columns`
is currently undefined. Keep these modules light and free of heavy dependencies
or side effects. `--json` bypasses formatters and prints the operation envelope.

## Validation and test kit

The root entry re-exports all runtime helpers. Each subpath has declarations
matching its runtime exports. `/validate` exports
`API_VERSIONS` (currently `[0]`), `EFFECTS`, `validateManifest`,
`validateOperationModule`, `validateCliTable` and `effectsExceeding`. Validators return `string[]`
problems. Separate advisory entries by their `"warning: "` prefix; an empty
array means valid with no warnings. Schema checks duck-type `safeParse`, with
no Zod runtime dependency.

`/testkit` exports:

- `stubContext(overrides = {})`: a `StubContext` with fresh cancellation signal,
  `_progress: ProgressEvent[]`, `_notices: string[]`, `_failures?: number`, and collecting callbacks.
  Accepts context overrides and `cwd` (default `/tmp/sfd-testkit`) for path
  resolution. The arrays belong to each context independently.
- `stubOrg(overrides = {})`: `OrgInfo` with `test@example.com`, API `67.0`,
  and `scratch` type. This is org metadata, not an authenticated connection.
  Supply a fake `conn` matching the methods your operation calls.
- `runOperation(op, { conn, options, ctx, confirmPlan })`: parses options using
  the operation's schema, including transformations. For reads it returns
  `{ data }`. For writes it plans, checks the effects ceiling, optionally awaits
  `confirmPlan(plan)`, and applies unless confirmation returns exactly false.
  A declined confirmation returns `{ plan }`; applying returns `{ plan, data }`.
  Results include `failures` when the context recorded a count, including zero.
  `ctx` defaults to `stubContext()`. Invalid options throw code
  `invalid-options`; widened plans throw `plan-exceeds-effects` before
  confirmation or application. Operation errors propagate unchanged.
- `assertConformance(mod)`: throws readable validation errors while allowing
  warnings. It does not run operations or certify their side effects.

`RunOperationOptions<O>` describes runner inputs (`options: unknown` is parsed
by the schema, with optional `conn` and `ctx`). The write overload also accepts
synchronous or asynchronous confirmation. `StubContext` extends
`OperationContext` with its collection arrays and recorded failure count.

```js
import { assertConformance, runOperation, stubContext } from "@syntax-syllogism/sfd-plugin";
assertConformance(operations);
const ctx = stubContext({ cwd: "/my/project" });
const result = await runOperation(operations.operations[0], { options: {}, ctx });
```

## Migration and vendoring

The package is not yet published to npm. For v0, vendor `index.d.ts` as
`src/sfd/contract.d.ts`, adding a header with the source sfd commit. Resolve the
Zod and Salesforce type imports from your own plugin dependencies. Keep adapters
in the plugin package; existing core contracts can migrate later. Do not use
machine-specific `file:` dependencies in published plugins.

| Old | New |
| --- | --- |
| `destructive: true` | `effects: ["destructive"]` |
| `destructive: false` on a write | `effects: ["org-write"]` |
| `destructive: false` on a read | `effects: ["read"]` |
| simply `tier: "write"` | `effects: ["org-write"]` |
| warden connection always required | `requiresOrg: "required"` |
| apx `GenerationApplyContext.overwrite` | An option in the plan; not part of the context. |
| simply `limitItems` result | `{ items, total, truncated }` returned as data; set `descriptor.paged`. |
