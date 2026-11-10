import { EFFECTS } from "./effects.mjs";
import { summarizeChanges, summarizeRetrieve } from "../format.mjs";
import { UsageError } from "../usage-error.mjs";
import { abortable, disconnected, throwIfAborted } from "../sf-util.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").RetrieveArgs>} */
export default {
  name: "retrieve", effects: EFFECTS.retrieve, retry: "never", write: "retrieve", project: true, policy: true,
  run: async (ctx, { org, projectDir, sourcePaths, metadata, manifest, ignoreConflicts = false, waitMinutes = 33 }) => {
    const { conn, org: o, core, Duration, signal, warn } = ctx;
    ctx.clearProjects();
    const project = await core.SfProject.resolve(projectDir);
    const tracked = await o.tracksSource();
    const changesOnly = !sourcePaths?.length && !metadata?.length && !manifest;
    if (changesOnly && !tracked) throw new UsageError("retrieve needs -d, -m or -x on an org without source tracking.");
    // Handle conflicts and tracking explicitly: daemon requests must not leave lifecycle listeners behind.
    const st = tracked ? await ctx.tracking().SourceTracking.create({ org: o, project, ignoreConflicts, ignoreLocalCache: true }) : undefined;
    const conflicts = st && !ignoreConflicts ? await st.getConflicts() : [];
    /** @type {any} */
    let cs;
    /** @type {any[]} */
    let deletedFiles = [];
    const refusal = (/** @type {any[]} */ entries) => ({ success: false, status: "Conflicts", files: /** @type {any[]} */ ([]), warnings: /** @type {any[]} */ ([]), conflicts: summarizeChanges(entries, projectDir, "Conflict") });
    if (changesOnly) {
      // Remote deletes write to disk, so refuse before asking STL to apply any of them.
      if (conflicts.length) return refusal(conflicts);
      const targets = await st.maybeApplyRemoteDeletesToLocal(true);
      cs = targets.componentSetFromNonDeletes;
      deletedFiles = targets.fileResponsesFromDelete;
    } else {
      const packageDirs = project.getUniquePackageDirectories().map((/** @type {any} */ d) => d.fullPath);
      cs = await ctx.sdr().ComponentSetBuilder.build({
        projectDir,
        sourceapiversion: project.getSfProjectJson().get("sourceApiVersion"),
        sourcepath: sourcePaths?.length ? sourcePaths : undefined,
        metadata: metadata?.length ? { metadataEntries: metadata, directoryPaths: packageDirs } : undefined,
        ...(manifest ? { manifest: { manifestPath: manifest, directoryPaths: packageDirs } } : {})
      });
      const selectedConflicts = conflicts.filter((/** @type {any} */ c) => cs.has({ type: c.type, fullName: c.name }));
      if (selectedConflicts.length) return refusal(selectedConflicts);
    }
    if (cs.size === 0) {
      if (!changesOnly) throw new Error("Nothing to retrieve: no components matched.");
      return { success: true, status: "Succeeded", files: summarizeChanges(deletedFiles, projectDir), warnings: [], conflicts: [],
        ...(!deletedFiles.length ? { message: "No remote changes to retrieve." } : {}) };
    }
    throwIfAborted(signal);
    const retrieve = await cs.retrieve({ usernameOrConnection: conn, output: project.getDefaultPackage().fullPath, merge: true, format: "source" });
    const result = await abortable(retrieve.pollStatus({ frequency: Duration.seconds(2), timeout: Duration.minutes(waitMinutes) }), signal,
      () => disconnected(warn, "retrieve", org, `retrieve ${retrieve.id ?? "(id unavailable)"}; source tracking not updated for retrieve ${retrieve.id ?? "(id unavailable)"}`));
    throwIfAborted(signal);
    if (st && result.response.success) await st.updateTrackingFromRetrieve(result);
    const summary = summarizeRetrieve(result, projectDir);
    summary.files.unshift(...summarizeChanges(deletedFiles, projectDir));
    return summary;
  }
};
