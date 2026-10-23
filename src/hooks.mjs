import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, unlinkSync, statSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { rewrite } from "./rewrite.mjs";
import { UsageError } from "./usage-error.mjs";

const USAGE = "Usage: sfd hook claude|codex|gemini|check [--shell posix|powershell] <command>|install|uninstall --agent <agent> [--project]";

const agents = {
  claude: { directory: ".claude", file: "settings.json", event: "PreToolUse", tool: "Bash" },
  codex: { directory: ".codex", file: "hooks.json", event: "PreToolUse", tool: "Bash" },
  gemini: { directory: ".gemini", file: "settings.json", event: "BeforeTool", tool: "run_shell_command" }
};

export function hookShell(agent, env = process.env, platform = process.platform) {
  if (env.SFD_HOOK_SHELL !== undefined) return ["posix", "powershell"].includes(env.SFD_HOOK_SHELL) ? env.SFD_HOOK_SHELL : null;
  if (platform === "win32" && agent === "codex") return null;
  return platform === "win32" && agent === "gemini" ? "powershell" : "posix";
}

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
    const result = rewrite(input.tool_input.command, { shell });
    if (result.skip) return "";
    const updatedInput = { ...input.tool_input, command: result.command };
    if (agent === "gemini") return JSON.stringify({ hookSpecificOutput: { tool_input: updatedInput } });
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(agent === "codex" ? { permissionDecision: "allow" } : {}),
      permissionDecisionReason: result.reason,
      updatedInput
    } });
  } catch { return ""; }
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function editSettings(action, agent, { project = false, cwd = process.cwd(), home = homedir() } = {}) {
  const config = agents[agent];
  if (!config || !["install", "uninstall"].includes(action)) throw new UsageError("Expected install|uninstall --agent claude|codex|gemini [--project]");
  const file = join(project ? cwd : home, config.directory, config.file);
  let original, settings = {};
  try { original = readFileSync(file, "utf8"); settings = JSON.parse(original); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!object(settings) || (settings.hooks !== undefined && !object(settings.hooks))) throw Error(`Invalid hooks settings in ${file}`);
  const entries = settings.hooks?.[config.event] ?? [];
  if (!Array.isArray(entries) || entries.some(entry => !object(entry) || !Array.isArray(entry.hooks))) throw Error(`Invalid ${config.event} settings in ${file}`);
  const isSfd = hook => hook?.type === "command" && typeof hook.command === "string" && new RegExp(`^sfd hook ${agent}(?:\\s|$)`).test(hook.command);
  const exists = entries.some(entry => entry.hooks.some(isSfd));
  if ((action === "install") === exists) return { file, changed: false };
  let updated;
  if (action === "install") {
    updated = [...entries, { matcher: config.tool, hooks: [{ type: "command", command: `sfd hook ${agent}` }] }];
  } else {
    updated = entries.flatMap(entry => {
      const hooks = entry.hooks.filter(hook => !isSfd(hook));
      return hooks.length === entry.hooks.length ? [entry] : hooks.length ? [{ ...entry, hooks }] : [];
    });
  }
  settings.hooks ??= {};
  settings.hooks[config.event] = updated;
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
  return { file, changed: true };
}

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
      : shell === null ? { skip: "invalid SFD_HOOK_SHELL" } : rewrite(args.join(" "), { shell });
    process.stdout.write(result.skip ? `skip: ${result.skip}\n` : `→ ${result.command}\n`);
    return result.skip ? 1 : 0;
  }
  if (["install", "uninstall"].includes(action)) {
    const { values } = parseArgs({ args, options: { agent: { type: "string" }, project: { type: "boolean" } } });
    const result = editSettings(action, values.agent, { project: values.project });
    process.stdout.write(`${result.changed ? "Updated" : "Unchanged"} ${result.file}\n`);
    if (action === "install" && values.agent === "codex") process.stdout.write("Review and trust the hook with /hooks in Codex before it can run.\n");
    return 0;
  }
  throw new UsageError(USAGE);
}
