import { loadTable } from "./plugin/table-cache.mjs";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, unlinkSync, statSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { rewrite } from "./rewrite.mjs";
import { builtinEffects, loadPolicy, decide, effectiveOrgType } from "./policy.mjs";
import { UsageError } from "./usage-error.mjs";

const USAGE = "Usage: sfd hook claude|codex|gemini|check [--shell posix|powershell] <command>|install|uninstall --agent <agent> [--project] [--no-deny-confirm]";

/** @typedef {{ directory: string, file: string, event: string, tool: string }} AgentConfig */

/** @type {Record<string, AgentConfig>} */
const agents = {
  claude: { directory: ".claude", file: "settings.json", event: "PreToolUse", tool: "Bash" },
  codex: { directory: ".codex", file: "hooks.json", event: "PreToolUse", tool: "Bash" },
  gemini: { directory: ".gemini", file: "settings.json", event: "BeforeTool", tool: "run_shell_command" }
};

/**
 * @param {string} agent
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 */
export function hookShell(agent, env = process.env, platform = process.platform) {
  if (env.SFD_HOOK_SHELL !== undefined) return ["posix", "powershell"].includes(env.SFD_HOOK_SHELL) ? env.SFD_HOOK_SHELL : null;
  if (platform === "win32" && agent === "codex") return null;
  return platform === "win32" && agent === "gemini" ? "powershell" : "posix";
}

/**
 * @param {import("./rewrite.mjs").PolicyCall[]} calls
 * @param {NodeJS.ProcessEnv} env
 * @param {string} platform
 */
function approvalReason(calls, env, platform) {
  try {
    const policy = loadPolicy({ env });
    const dir = env.SFD_RUNTIME_DIR ?? (platform === "win32" ? join(env.LOCALAPPDATA ?? tmpdir(), "sfd") : join(env.XDG_RUNTIME_DIR ?? tmpdir(), `sfd-${process.getuid?.() ?? "user"}`));
    /** @type {Record<string, any>} */
    let cached = {};
    try { cached = JSON.parse(readFileSync(join(dir, "org-types.json"), "utf8")); } catch {}
    for (const { operation, args, effects } of calls) {
      const alias = args.org ?? env.SF_TARGET_ORG;
      const type = effectiveOrgType(cached[alias], policy, cached.$usernames?.[alias] ?? alias, alias);
      const result = decide(effects ?? builtinEffects(operation, args), type, policy);
      if (result.decision !== "allow") return `sfd: ${result.effect} on ${type} org (${alias ?? "default"}); policy ${result.decision}`;
    }
  } catch { return "sfd: cannot validate safety policy; approval required"; }
}

/**
 * @param {string} agent
 * @param {string} inputJson
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 */
export function handle(agent, inputJson, env = process.env, platform = process.platform) {
  try {
    if (env.SFD_HOOK_DISABLE === "1") return "";
    const config = agents[agent];
    if (!config) return "";
    const input = JSON.parse(inputJson);
    if (input?.tool_name !== config.tool || (input.hook_event_name && input.hook_event_name !== config.event)) return "";
    if (!input.tool_input || typeof input.tool_input.command !== "string") return "";
    const shell = hookShell(agent, env, platform);
    if (shell === null) return "";
    const result = rewrite(input.tool_input.command, { shell, table: loadTable({ env }), includePolicy: true });
    if (result.skip) return "";
    const updatedInput = { ...input.tool_input, command: result.command };
    if (agent === "gemini") return JSON.stringify({ hookSpecificOutput: { tool_input: updatedInput } });
    const reason = approvalReason(result.policyCalls ?? [], env, platform);
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(reason ? { permissionDecision: "ask" } : agent === "codex" ? { permissionDecision: "allow" } : {}),
      permissionDecisionReason: reason ?? result.reason,
      updatedInput
    } });
  } catch { return ""; }
}

/** @param {unknown} value */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

export const CONFIRM_DENY_RULES = Object.freeze(["Bash(sfd * --confirm *)", "Bash(sfd --confirm *)", "Bash(sfd *--confirm=*)"]);

/**
 * @param {string} action
 * @param {string} agent
 * @param {{ project?: boolean, cwd?: string, home?: string, denyConfirm?: boolean }} [options]
 */
export function editSettings(action, agent, { project = false, cwd = process.cwd(), home = homedir(), denyConfirm = true } = {}) {
  const config = agents[agent];
  if (!config || !["install", "uninstall"].includes(action)) throw new UsageError("Expected install|uninstall --agent claude|codex|gemini [--project] [--no-deny-confirm]");
  const file = join(project ? cwd : home, config.directory, config.file);
  /** @type {string | undefined} */
  let original;
  // Agent settings files are arbitrary JSON.
  /** @type {any} */
  let settings = {};
  try { original = readFileSync(file, "utf8"); settings = JSON.parse(original); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!object(settings) || (settings.hooks !== undefined && !object(settings.hooks))) throw Error(`Invalid hooks settings in ${file}`);
  const entries = settings.hooks?.[config.event] ?? [];
  if (!Array.isArray(entries) || entries.some(entry => !object(entry) || !Array.isArray(entry.hooks))) throw Error(`Invalid ${config.event} settings in ${file}`);
  // Only Claude Code has permissions.deny; other agents' permission settings are never touched.
  const permissions = agent === "claude";
  if (permissions && settings.permissions !== undefined && !object(settings.permissions)) throw Error(`Invalid permissions settings in ${file}`);
  const deny = permissions ? settings.permissions?.deny ?? [] : [];
  if (!Array.isArray(deny)) throw Error(`Invalid permissions.deny settings in ${file}`);
  const isSfd = (/** @type {any} */ hook) => hook?.type === "command" && typeof hook.command === "string" && new RegExp(`^sfd hook ${agent}(?:\\s|$)`).test(hook.command);
  const exists = entries.some(entry => entry.hooks.some(isSfd));
  // The hook entry and the deny rules are reconciled independently, so re-running install adds rules an older install lacked.
  const denyAdded = permissions && action === "install" && denyConfirm ? CONFIRM_DENY_RULES.filter(rule => !deny.includes(rule)) : [];
  const denyRemoved = permissions && action === "uninstall" ? CONFIRM_DENY_RULES.filter(rule => deny.includes(rule)) : [];
  const hookChanged = (action === "install") !== exists;
  if (!hookChanged && !denyAdded.length && !denyRemoved.length) return { file, changed: false, denyAdded, denyRemoved };
  if (hookChanged) {
    let updated;
    if (action === "install") {
      updated = [...entries, { matcher: config.tool, hooks: [{ type: "command", command: `sfd hook ${agent}` }] }];
    } else {
      updated = entries.flatMap(entry => {
        const hooks = entry.hooks.filter((/** @type {any} */ hook) => !isSfd(hook));
        return hooks.length === entry.hooks.length ? [entry] : hooks.length ? [{ ...entry, hooks }] : [];
      });
    }
    settings.hooks ??= {};
    settings.hooks[config.event] = updated;
  }
  if (denyAdded.length) {
    settings.permissions ??= {};
    settings.permissions.deny = [...deny, ...denyAdded];
  }
  if (denyRemoved.length) {
    // sfd cannot tell whether it created these keys, so it removes them only when nothing else is left.
    const remaining = deny.filter(rule => !CONFIRM_DENY_RULES.includes(rule));
    if (remaining.length) settings.permissions.deny = remaining;
    else delete settings.permissions.deny;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }
  mkdirSync(dirname(file), { recursive: true });
  if (original !== undefined) {
    try { copyFileSync(file, `${file}.bak`, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode: original === undefined ? 0o600 : statSync(file).mode & 0o777 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { file, changed: true, denyAdded, denyRemoved };
}

/** @param {string[]} argv */
export function runHook(argv) {
  const [action, ...args] = argv;
  if (action === "--help" || action === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (Object.hasOwn(agents, action)) {
    // Adapter errors must never change whether the original tool call can run.
    try { process.stdout.write(handle(action, readFileSync(0, "utf8"))); } catch { /* no opinion */ }
    return 0;
  }
  if (action === "check") {
    let shell = hookShell("check");
    if (args[0] === "--shell" || args[0]?.startsWith("--shell=")) {
      const flag = args.shift();
      shell = flag === "--shell" ? args.shift() : flag.slice("--shell=".length);
      if (!["posix", "powershell"].includes(shell)) throw new UsageError("Expected --shell posix|powershell");
    }
    const result = process.env.SFD_HOOK_DISABLE === "1" ? { skip: "SFD_HOOK_DISABLE=1" }
      : shell === null ? { skip: "invalid SFD_HOOK_SHELL" } : rewrite(args.join(" "), { shell, table: loadTable() });
    process.stdout.write(result.skip ? `skip: ${result.skip}\n` : `→ ${result.command}\n`);
    return result.skip ? 1 : 0;
  }
  if (["install", "uninstall"].includes(action)) {
    const { values } = parseArgs({ args, options: { agent: { type: "string" }, project: { type: "boolean" }, "no-deny-confirm": { type: "boolean" } } });
    // --no-deny-confirm is accepted as a no-op for agents without permission rules.
    const result = editSettings(action, values.agent, { project: values.project, denyConfirm: !values["no-deny-confirm"] });
    process.stdout.write(`${result.changed ? "Updated" : "Unchanged"} ${result.file}\n`);
    if (result.denyAdded.length) process.stdout.write(`Added permissions.deny: ${result.denyAdded.join(", ")}\n`);
    if (result.denyRemoved.length) process.stdout.write(`Removed permissions.deny: ${result.denyRemoved.join(", ")}\n`);
    if (action === "install" && values.agent === "codex") process.stdout.write("Review and trust the hook with /hooks in Codex before it can run.\n");
    return 0;
  }
  throw new UsageError(USAGE);
}
