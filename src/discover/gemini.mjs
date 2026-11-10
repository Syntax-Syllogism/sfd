import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { files, lines, matches, candidate, count, outputChars, elapsed } from "./shared.mjs";

/**
 * @param {import("./shared.mjs").ReadOptions} options
 * @returns {AsyncGenerator<import("./shared.mjs").ShellRecord>}
 */
export async function* read(options) {
  const { home, since = new Date(0), stats } = options;
  for await (const file of files(join(home, ".gemini/tmp"), [".json", ".jsonl"], since, stats)) {
    if (basename(dirname(file)) !== "chats" && basename(file) !== "logs.json") continue;
    const document = file.endsWith(".jsonl") ? await session(file, stats) : await legacy(file, stats);
    if (document === undefined) continue;
    const messages = Array.isArray(document) ? document : document?.messages;
    if (!Array.isArray(messages)) { count(stats, "ignoredEntries"); continue; }
    for (const message of messages) {
      if (!Array.isArray(message?.toolCalls)) { count(stats, "ignoredEntries"); continue; }
      for (const tool of message.toolCalls) {
        if (tool?.name !== "run_shell_command") { count(stats, "ignoredEntries"); continue; }
        const command = tool.args?.command;
        if (!candidate(command)) continue;
        /** @type {import("./shared.mjs").ShellRecord} */
        const record = {
          agent: "gemini", ts: new Date(tool.timestamp ?? message.timestamp ?? NaN), command,
          cwd: tool.args?.directory ?? message.cwd ?? document.cwd,
          session: file
        };
        const chars = outputChars(tool.result);
        if (chars !== undefined) record.outputChars = chars;
        // A call is stamped when its whole batch completes, so only a lone
        // call's duration can be measured from the message that requested it.
        const duration = elapsed(message.timestamp, tool.timestamp);
        if (message.toolCalls.length === 1 && Number.isFinite(duration) && duration > 0) record.durationMs = duration;
        if (matches(record, options)) yield record;
      }
    }
  }
}

// Older Gemini CLI versions persist one JSON document per session.
/**
 * @param {string} file
 * @param {import("./shared.mjs").ScanStats} [stats]
 * @returns {Promise<any>}
 */
async function legacy(file, stats) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { count(stats, error instanceof SyntaxError ? "malformedEntries" : "unreadableFiles"); }
}

// Current versions append JSONL: a metadata line, message records keyed by `id`
// (re-appended as tool calls complete, so the last copy wins), `$set` metadata
// patches that may replace `messages`, and `$rewindTo` markers. Rewinds and
// replacements keep earlier messages, because their shell calls still ran.
/**
 * @param {string} file
 * @param {import("./shared.mjs").ScanStats} [stats]
 */
async function session(file, stats) {
  /** @type {Record<string, any>} */
  const document = {};
  /** @type {Map<string, any>} */
  const messages = new Map();
  const merge = (/** @type {any} */ { messages: listed, ...metadata }) => {
    if (Array.isArray(listed)) for (const message of listed) if (typeof message?.id === "string") messages.set(message.id, message);
    Object.assign(document, metadata);
  };
  for await (const entry of lines(file, stats)) {
    if (typeof entry?.id === "string") messages.set(entry.id, entry);
    else if (entry?.$set && typeof entry.$set === "object") merge(entry.$set);
    else if (typeof entry?.sessionId === "string") merge(entry);
    else if (typeof entry?.$rewindTo !== "string") count(stats, "ignoredEntries");
  }
  return { ...document, messages: [...messages.values()] };
}
