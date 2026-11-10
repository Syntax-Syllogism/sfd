import { EFFECTS } from "./effects.mjs";
import { summarizeChanges } from "../format.mjs";
import { UsageError } from "../usage-error.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").TrackingArgs>} */
export default {
  name: "tracking", effects: EFFECTS.tracking, retry: "safe", project: true, policy: true,
  run: async (ctx, { projectDir, local = false, remote = false, conflicts: conflictsOnly = false }) => {
    const o = ctx.org;
    if (!(await o.tracksSource())) throw new UsageError("tracking requires an org with source tracking.");
    ctx.clearProjects();
    const project = await ctx.core.SfProject.resolve(projectDir);
    const st = await ctx.tracking().SourceTracking.create({ org: o, project, ignoreLocalCache: true });
    const rows = conflictsOnly ? [] : await st.getStatus({ local: !remote, remote: !local });
    return {
      local: summarizeChanges(rows.filter((/** @type {any} */ r) => r.origin === "local" && !r.ignored), projectDir),
      remote: summarizeChanges(rows.filter((/** @type {any} */ r) => r.origin === "remote" && !r.ignored), projectDir),
      conflicts: summarizeChanges(await st.getConflicts(), projectDir, "Conflict")
    };
  }
};
