# @syntax-syllogism/sfd-plugin

Experimental v0 operation contract for sfd plugins, version 0.0.1.
May break between sfd minor versions; changes appear in the sfd CHANGELOG.

The package has hand-written TypeScript declarations, runtime validators and a
hermetic test kit. It has no build step or runtime dependencies. Zod 4 and
`@salesforce/core` are optional type-only peers resolved by the adopting plugin.
Node 22 or newer is required.

```js
import { validateManifest, validateOperationModule, effectsExceeding } from "@syntax-syllogism/sfd-plugin/validate";
import { stubContext, stubOrg, runOperation, assertConformance } from "@syntax-syllogism/sfd-plugin/testkit";
```

The root entry re-exports all helpers. `index.d.ts` declares the types.
See the sfd [plugin API guide](https://github.com/Syntax-Syllogism/sfd/blob/release/docs/plugin-api.md)
for the manifest, operation, context, effects, CLI schema and migration rules.

sfd itself is on npm as `@syntax-syllogism/sfd`, but this helper package is
not published yet. Vendor `index.d.ts` as `src/sfd/contract.d.ts` in your
plugin. Add a header recording the sfd commit it came from and resolve the
type-only peers from your plugin.

MIT licensed; see LICENSE.
