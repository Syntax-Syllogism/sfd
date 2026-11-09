import { resolve } from "node:path";
import { effectsExceeding, validateOperationModule } from "./validate.mjs";

export function stubContext(overrides = {}) {
  const { cwd = "/tmp/sfd-testkit", ...context } = overrides;
  const progress = [];
  const notices = [];
  const stub = {
    signal: new AbortController().signal,
    onProgress: event => { progress.push(event); },
    notice: message => { notices.push(message); },
    reportFailures: count => { stub._failures = count; },
    resolvePath: path => resolve(cwd, path),
    ...context,
    _progress: progress,
    _notices: notices,
  };
  return stub;
}

export function stubOrg(overrides = {}) {
  return { username: "test@example.com", apiVersion: "67.0", type: "scratch", ...overrides };
}

export async function runOperation(op, { conn, options, ctx = stubContext(), confirmPlan }) {
  const parsed = op.descriptor.optionsSchema.safeParse(options);
  if (!parsed.success) throw Object.assign(new Error("Invalid operation options", { cause: parsed.error }), { code: "invalid-options" });
  const withFailures = result => ctx._failures === undefined ? result : { ...result, failures: ctx._failures };
  if (op.kind === "read") return withFailures({ data: await op.run(conn, parsed.data, ctx) });
  const plan = await op.plan(conn, parsed.data, ctx);
  const exceeding = effectsExceeding(op.descriptor.effects, plan.effects);
  if (exceeding.length) throw Object.assign(new Error(`Plan exceeds descriptor.effects: ${exceeding.join(", ")}`), { code: "plan-exceeds-effects" });
  if (confirmPlan && await confirmPlan(plan) === false) return withFailures({ plan });
  return withFailures({ plan, data: await op.apply(conn, plan, ctx) });
}

export function assertConformance(mod) {
  const problems = validateOperationModule(mod).filter(problem => !problem.startsWith("warning: "));
  if (problems.length) throw new Error(`Operation module conformance failed:\n${problems.join("\n")}`);
}
