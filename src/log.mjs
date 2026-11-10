import { createWriteStream, statSync, renameSync, unlinkSync } from "node:fs";

/** @typedef {import("./types.js").LogFields} LogFields */

/**
 * @param {{ file: string, maxBytes?: number, keep?: number }} options
 * @returns {import("./types.js").FileLogger}
 */
export function createLogger({ file, maxBytes = 5 * 1024 * 1024, keep = 1 }) {
  let size = 0;
  try { size = statSync(file).size; } catch {}
  let stream = createWriteStream(file, { flags: "a" });
  // A failed log destination must not crash the daemon.
  stream.on("error", () => {});
  let queue = Promise.resolve();
  let closed = false;
  const finish = () => new Promise((/** @type {(value?: unknown) => void} */ resolve) => {
    if (stream.destroyed) return resolve();
    stream.once("error", resolve);
    stream.end(resolve);
  });
  const rotate = async () => {
    await finish();
    if (keep > 0) {
      for (let i = keep - 1; i >= 1; i--) {
        try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
      }
      try { renameSync(file, `${file}.1`); } catch {}
    } else { try { unlinkSync(file); } catch {} }
    size = 0;
    stream = createWriteStream(file, { flags: "a" });
    stream.on("error", () => {});
  };
  /**
   * @param {LogFields} base
   * @returns {import("./types.js").FileLogger}
   */
  const logger = base => {
    /**
     * @param {string} level
     * @param {string} msg
     * @param {LogFields} [fields]
     */
    const write = (level, msg, fields = {}) => {
      if (closed) return;
      let line;
      try {
        line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }, (_key, value) =>
          value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value) + "\n";
      } catch { line = JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "unserializable log entry" }) + "\n"; }
      queue = queue.then(async () => {
        const bytes = Buffer.byteLength(line);
        if (size && size + bytes > maxBytes) await rotate();
        if (!stream.destroyed) stream.write(line);
        size += bytes;
      });
    };
    return {
      info: (msg, fields) => write("info", msg, fields),
      warn: (msg, fields) => write("warn", msg, fields),
      error: (msg, fields) => write("error", msg, fields),
      child: fields => logger({ ...base, ...fields }),
      close: () => { closed = true; return queue.then(finish); }
    };
  };
  return logger({});
}
