import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { files, matches, candidate, count, outputChars } from "./shared.mjs";

export async function* read(options) {
  const { home, since = new Date(0), stats } = options;
  for await (const file of files(join(home, ".gemini/tmp"), ".json", since, stats)) {
    if (basename(dirname(file)) !== "chats" && basename(file) !== "logs.json") continue;
    let document;
    // Gemini persists a JSON document, rather than a JSONL stream.
    try { document = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { count(stats, error instanceof SyntaxError ? "malformedEntries" : "unreadableFiles"); continue; }
    const messages = Array.isArray(document) ? document : document?.messages;
    if (!Array.isArray(messages)) { count(stats, "ignoredEntries"); continue; }
    for (const message of messages) {
      if (!Array.isArray(message?.toolCalls)) { count(stats, "ignoredEntries"); continue; }
      for (const tool of message.toolCalls) {
        if (tool?.name !== "run_shell_command") { count(stats, "ignoredEntries"); continue; }
        const command = tool.args?.command;
        if (!candidate(command)) continue;
        const record = {
          agent: "gemini", ts: new Date(tool.timestamp ?? message.timestamp ?? NaN), command,
          cwd: tool.args?.directory ?? message.cwd ?? document.cwd,
          session: file
        };
        const chars = outputChars(tool.result);
        if (chars !== undefined) record.outputChars = chars;
        if (matches(record, options)) yield record;
      }
    }
  }
}
