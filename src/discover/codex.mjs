import { join } from "node:path";
import { files, lines, matches, complete, candidate, count, shellCommand } from "./shared.mjs";

export async function* read(options) {
  const { home, since = new Date(0), stats } = options;
  for await (const file of files(join(home, ".codex/sessions"), ".jsonl", since, stats)) {
    const pending = new Map();
    let cwd;
    for await (const entry of lines(file, stats)) {
      const payload = entry?.payload;
      if (["session_meta", "turn_context"].includes(entry?.type)) { cwd = payload?.cwd ?? cwd; continue; }
      if (entry?.type !== "response_item" || !payload) { count(stats, "ignoredEntries"); continue; }
      if (payload.type === "function_call" && ["shell", "shell_command", "exec_command"].includes(payload.name)) {
        let args;
        try { args = JSON.parse(payload.arguments); }
        catch { count(stats, "malformedEntries"); continue; }
        const command = shellCommand(args);
        if (!candidate(command)) continue;
        const record = { agent: "codex", ts: new Date(entry.timestamp ?? NaN), command, cwd: args.workdir ?? cwd, session: file };
        if (matches(record, options)) pending.set(payload.call_id, record);
      } else if (payload.type === "function_call_output" && pending.has(payload.call_id)) {
        yield complete(pending.get(payload.call_id), entry.timestamp, payload.output);
        pending.delete(payload.call_id);
      } else count(stats, "ignoredEntries");
    }
    yield* pending.values();
  }
}
