// @ts-check
import { findProjectDir } from "../project.mjs";
import { errorEnvelope, failure } from "./envelope.mjs";
import { effectsExceeding } from "../../packages/sfd-plugin/validate.mjs";
import { createRegistry } from "./registry.mjs";
/** @param {{supervisor: ReturnType<typeof import('./supervisor.mjs').createSupervisor>, resolveOrg: (alias: string) => Promise<any>, projectQueue: (fn: () => Promise<any>) => Promise<any>, refreshAuth?: () => Promise<void>, policyCheck?: (input: any) => any, suggest?: (name: string, names: string[]) => string | undefined}} config */
export function createPluginHandler({ supervisor, resolveOrg, projectQueue, refreshAuth = async () => {}, suggest = () => undefined, policyCheck = () => ({ decision: "allow" }) }) {
  const registry = createRegistry(supervisor);
  /** @param {any} req @param {{emit?: (event: any) => void, signal?: AbortSignal}} [transport] */
  return async (req, { emit, signal } = {}) => {
    try {
      await refreshAuth();
      const { plugin, descriptor, names, error } = await registry.lookup(req.operation);
      if (error) return error;
      if (plugin?.problems.length) return failure("invalid-plugin", plugin.problems.join("; "));
      if (!plugin || !descriptor) {
        const suggestion = suggest(req.operation, names);
        return failure("unknown-operation", `Unknown operation: ${req.operation}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`);
      }
      if (!["run", "plan", "apply"].includes(req.mode)) return failure("usage", "Invalid operation mode");
      if (req.mode === "plan" && descriptor.kind === "read") return failure("usage", "--plan requires a write operation");
      if (descriptor.requiresOrg === "required" && !req.targetOrg) return failure("usage", "Operation requires a target org; pass -o <alias>");
      const org = req.targetOrg && descriptor.requiresOrg !== "none" ? await resolveOrg(req.targetOrg) : undefined;
      if (org && req.apiVersion) org.apiVersion = req.apiVersion;
      const projectRoot = findProjectDir(req.cwd);
      if (descriptor.requiresProject && !projectRoot) return failure("no-project", "No sfdx-project.json found");
      const run = async () => {
        if (signal?.aborted) return failure("aborted", "Operation aborted");
        /** @param {any} [plan] */
        const check = (plan = null, preview = false) => policyCheck({
          operation: req.operation, username: org?.username, alias: req.targetOrg,
          options: { options: req.options ?? {}, cwd: req.cwd, projectRoot }, plan,
          effects: plan?.effects ?? descriptor.effects, orgType: org?.type,
          confirm: req.confirm, preview
        });
        if (descriptor.kind === "read") check();
        const result = await supervisor.call(plugin, { ...req, org, projectRoot }, { onEvent: emit, signal, descriptor, onPlan: plan => check(plan) });
        if (result.ok && result.plan && effectsExceeding(descriptor.effects, result.plan.effects).length) return failure("plan-exceeds-effects", "Plan exceeds declared effects ceiling");
        if (result.policyError) throw Object.assign(new Error(result.policyError.message), result.policyError);
        if (result.ok && result.plan && req.mode === "plan") result.policy = check(result.plan, true);
        return result;
      };
      return descriptor.requiresProject ? await projectQueue(run) : await run();
    } catch (e) { if (/** @type {any} */ (e)?.exitCode === 4 || /** @type {any} */ (e)?.name === "UsageError") throw e; return errorEnvelope(e); }
  };
}
