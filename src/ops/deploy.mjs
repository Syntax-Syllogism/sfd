import { EFFECTS } from "./effects.mjs";
import { summarizeDeploy } from "../format.mjs";
import { abortable, disconnected, throwIfAborted } from "../sf-util.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").DeployArgs>} */
export default {
  name: "deploy", effects: EFFECTS.deploy, retry: "never", project: true, policy: true,
  run: async (ctx, { org, projectDir, sourcePaths, metadata, checkOnly, testLevel, tests, waitMinutes = 33 }) => {
    const { conn, org: o, core, Duration, signal, warn, state } = ctx;
    const { ComponentSetBuilder } = ctx.sdr();
    ctx.clearProjects();
    const project = await core.SfProject.resolve(projectDir);
    const packageDirs = project.getUniquePackageDirectories().map((/** @type {any} */ d) => d.fullPath);
    const cs = await ComponentSetBuilder.build({
      projectDir,
      sourceapiversion: project.getSfProjectJson().get("sourceApiVersion"),
      sourcepath: sourcePaths?.length ? sourcePaths : undefined,
      metadata: metadata?.length ? { metadataEntries: metadata, directoryPaths: packageDirs } : undefined
    });
    if (cs.size === 0) throw new Error("Nothing to deploy: no source components matched.");
    // The Metadata API serializes undefined as the string "undefined", so only set what was asked.
    /** @type {Record<string, unknown>} */
    const apiOptions = { checkOnly: Boolean(checkOnly), rollbackOnError: true };
    if (tests?.length) Object.assign(apiOptions, { testLevel: "RunSpecifiedTests", runTests: tests });
    if (testLevel) apiOptions.testLevel = testLevel;
    throwIfAborted(signal);
    const deploy = await cs.deploy({ usernameOrConnection: conn, apiOptions });
    // The session-expiry message names this ID.
    state.deployId = deploy.id;
    const result = await abortable(deploy.pollStatus({ frequency: Duration.seconds(2), timeout: Duration.minutes(waitMinutes) }), signal,
      () => disconnected(warn, "deploy", org, `deploy ${deploy.id ?? "(id unavailable)"}; source tracking not updated for deploy ${deploy.id ?? "(id unavailable)"}`));
    throwIfAborted(signal);
    // Keep scratch-org source tracking in step, as `sf project deploy start` does.
    if (result.response.success && !checkOnly && (await o.tracksSource())) {
      const st = await ctx.tracking().SourceTracking.create({ org: o, project });
      throwIfAborted(signal);
      await st.updateTrackingFromDeploy(result);
    }
    return summarizeDeploy(result.response);
  }
};
