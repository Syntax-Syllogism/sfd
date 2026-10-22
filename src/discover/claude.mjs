import { join } from "node:path";
import { files, lines, matches, complete, candidate, count } from "./shared.mjs";

export async function* read(options) {
  const { home, since = new Date(0), stats } = options;
  for await (const file of files(join(home, ".claude/projects"), ".jsonl", since, stats)) {
    const pending = new Map();
    for await (const entry of lines(file, stats)) {
      const content = entry?.message?.content;
      if (!Array.isArray(content)) { count(stats, "ignoredEntries"); continue; }
      for (const item of content) {
        if (item?.type === "tool_use" && item.name === "Bash") {
          const command = item.input?.command;
          if (!candidate(command)) continue;
          const record = { agent: "claude", ts: new Date(entry.timestamp ?? NaN), command, cwd: entry.cwd, session: file };
          if (matches(record, options)) pending.set(item.id, record);
        } else if (item?.type === "tool_result" && pending.has(item.tool_use_id)) {
          yield complete(pending.get(item.tool_use_id), entry.timestamp, item.content);
          pending.delete(item.tool_use_id);
        } else count(stats, "ignoredEntries");
      }
    }
    yield* pending.values();
  }
}
