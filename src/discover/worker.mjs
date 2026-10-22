import { parentPort, workerData } from "node:worker_threads";
import { read as claude } from "./claude.mjs";
import { read as codex } from "./codex.mjs";
import { read as gemini } from "./gemini.mjs";
import { classify } from "./index.mjs";

const stats = {};
const observations = [];
const { agent, ...options } = workerData;
for await (const record of ({ claude, codex, gemini })[agent]({ ...options, stats })) {
  const classification = classify(record.command);
  if (classification) observations.push({
    agent, session: record.session, durationMs: record.durationMs,
    outputChars: record.outputChars, classification
  });
}
parentPort.postMessage({ observations, stats });
