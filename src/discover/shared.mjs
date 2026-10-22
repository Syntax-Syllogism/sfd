import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, relative, resolve, isAbsolute } from "node:path";

export function count(stats, key) {
  if (stats) stats[key] = (stats[key] ?? 0) + 1;
}

export async function* files(root, extension, since, stats) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== "ENOENT") count(stats, "unreadableFiles");
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, extension, since, stats);
    else if (entry.isFile() && entry.name.endsWith(extension)) {
      try {
        if ((await stat(path)).mtimeMs >= Number(since)) yield path;
      } catch { count(stats, "unreadableFiles"); }
    }
  }
}

export async function* lines(file, stats) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  // Forward stream errors into the iterator, including files removed mid-scan.
  stream.on("error", error => reader.close());
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); }
      catch { count(stats, "malformedEntries"); }
    }
    if (stream.errored) count(stats, "unreadableFiles");
  } catch { count(stats, "unreadableFiles"); }
  finally { reader.close(); stream.destroy(); }
}

export function matches(record, { since, project, stats }) {
  if (record.ts == null || !Number.isFinite(+record.ts)) {
    count(stats, "malformedEntries");
    return false;
  }
  if (+record.ts < +since) return false;
  if (!project) return true;
  if (typeof record.cwd !== "string") return false;
  const path = relative(resolve(project), resolve(record.cwd));
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export function outputChars(output) {
  if (output === undefined || output === null) return undefined;
  return (typeof output === "string" ? output : JSON.stringify(output)).length;
}

export function complete(record, timestamp, output) {
  const duration = +new Date(timestamp) - +record.ts;
  return {
    ...record,
    ...(Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
    ...(outputChars(output) !== undefined ? { outputChars: outputChars(output) } : {})
  };
}

export function shellCommand(args) {
  const command = args?.command ?? args?.cmd;
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || !command.every(v => typeof v === "string")) return;
  if (["bash", "sh", "/bin/bash", "/bin/sh"].includes(command[0]) && ["-lc", "-c"].includes(command[1]) && command.length === 3) return command[2];
  // Preserve argv boundaries for the literal-shell rewriter.
  return command.map(v => `'${v.replaceAll("'", "'\\''")}'`).join(" ");
}

export const candidate = command => typeof command === "string" && /\b(?:sf|sfd|sfdx)\b/.test(command);
