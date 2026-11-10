import { pluginCommands, pluginManual } from "./plugin/cli-table.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, commandUsage } from "./commands.mjs";

const DOCS_DIR = fileURLToPath(new URL("../docs/", import.meta.url));
// Guides carry Starlight frontmatter (`title`, optional `description`) for the
// docs site. For the terminal, the frontmatter becomes an H1 so every consumer
// below sees plain Markdown.
/** @typedef {{ file: string, heading?: string }} CommandDoc */

/**
 * @param {string} raw
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n*/);
  if (!match) return { data: {}, body: raw };
  /** @type {Record<string, string>} */
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(\w+):\s*(.*?)\s*$/);
    if (field) data[field[1]] = field[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { data, body: raw.slice(match[0].length) };
}

/** @type {Map<string, { markdown: string, description?: string }>} */
const guideCache = new Map();
/** @param {string} file */
function readGuide(file) {
  if (!guideCache.has(file)) {
    const { data, body } = parseFrontmatter(readFileSync(join(DOCS_DIR, file), "utf8"));
    const markdown = data.title ? `# ${data.title}\n\n${body}` : body;
    guideCache.set(file, { markdown, description: data.description });
  }
  return /** @type {{ markdown: string, description?: string }} */ (guideCache.get(file));
}

/** @param {string} file */
function readGuideFile(file) {
  return readGuide(file).markdown;
}

function guideFiles() {
  return readdirSync(DOCS_DIR).filter(file => file.endsWith(".md") && file !== "README.md").sort();
}

/** @param {string} file */
function guideName(file) {
  const name = basename(file, ".md");
  if (name === "query") return "query-output";
  return COMMANDS.some(command => command.name === name) ? `${name}-guide` : name;
}

/** @param {string} markdown */
function firstParagraph(markdown) {
  const afterTitle = markdown.replace(/^#\s+[^\n]+\n+/, "");
  return afterTitle.split(/\n\s*\n/).find(block => block.trim() && !block.trim().startsWith("```"))?.trim() ?? "";
}

/** @param {string} text */
function firstSentence(text) {
  const clean = text.replace(/\s+/g, " ").replace(/`([^`]+)`/g, "$1").trim();
  const boundary = clean.search(/[.!?](?:\s|$)/);
  return boundary === -1 ? clean : clean.slice(0, boundary + 1);
}

export function listGuides() {
  return guideFiles().map(file => {
      const { markdown: content, description } = readGuide(file);
      const title = content.match(/^#\s+(.+)\s*$/m)?.[1];
      if (!title) throw new Error(`Guide ${file} needs a frontmatter title or an H1.`);
      return { name: guideName(file), title, description: firstSentence(description ?? firstParagraph(content)) };
    });
}

/**
 * @param {string} markdown
 * @param {string} heading
 */
export function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  let fence;
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const text = match[2].replace(/`/g, "").trim();
    if (start === -1 && text.toLowerCase() === heading.replace(/`/g, "").toLowerCase()) {
      start = index;
      level = match[1].length;
    } else if (start !== -1 && match[1].length <= level) {
      return lines.slice(start, index).join("\n").trimEnd();
    }
  }
  if (start === -1) throw new Error(`Heading not found: ${heading}`);
  return lines.slice(start).join("\n").trimEnd();
}

/** @param {string} markdown */
function rewriteDocLinks(markdown) {
  const guides = new Set(listGuides().map(guide => guide.name));
  return markdown
    .replace(/\[([^\]]+)\]\(https:\/\/github\.com\/Syntax-Syllogism\/sfd(?:#[^)]*)?\)/g, (/** @type {string} */ _match, /** @type {string} */ label) => `\`${label}: sfd help -a\``)
    .replace(/\[([^\]]+)\]\((?!https?:\/\/)([^)]+\.md)(?:#[^)]*)?\)/g, (/** @type {string} */ _match, /** @type {string} */ label, /** @type {string} */ target) => {
    const name = guideName(basename(target));
    const readableLabel = label.replace(/\.md$/i, "");
    return guides.has(name) ? `\`${readableLabel}: sfd help ${name}\`` : `\`${readableLabel}: sfd help -a\``;
  });
}

/** @param {string} name */
export function renderGuide(name) {
  const guide = listGuides().find(item => item.name === name);
  if (!guide) return undefined;
  const file = guideFiles().find(candidate => guideName(candidate) === guide.name);
  const content = readGuideFile(file);
  return rewriteDocLinks(content);
}

/**
 * @param {string} name
 * @param {{ plugins: any[] }} [table]
 */
export function renderCommandManual(name, table) {
  const plugin = pluginCommands(table).find(c => c.name === name);
  if (!COMMANDS.some(c => c.name === name) && plugin) return pluginManual(plugin);
  const group = table?.plugins.find(p => p.commands.some((/** @type {any} */ c) => c.name[0] === name));
  if (!COMMANDS.some(c => c.name === name) && group) return group.commands.filter((/** @type {any} */ c) => c.name[0] === name).map((/** @type {any} */ c) => `${c.name.join(" ")}: ${c.summary}`).join("\n");
  const command = COMMANDS.find(entry => entry.name === name);
  const usage = commandUsage(name);
  if (!command || !usage) return undefined;
  const sections = [usage];
  if (command.agentTip) sections.push(`## Tips for agents\n\n${command.agentTip.replace(/^: /, "")}`);
  const references = [];
  for (const doc of /** @type {CommandDoc[]} */ (command.docs ?? [])) {
    const markdown = readGuideFile(doc.file);
    const content = doc.heading ? extractSection(markdown, doc.heading) : markdown.trimEnd();
    sections.push(rewriteDocLinks(content));
    references.push(guideName(doc.file));
  }
  sections.push(`See also: ${references.length ? references.map(guide => `sfd help ${guide}`).join(", ") : "sfd help -a"}.`);
  return sections.join("\n\n");
}

/** @param {{ guidesOnly?: boolean, table?: { plugins: any[] } }} [options] */
export function renderHelpIndex({ guidesOnly = false, table } = {}) {
  const guides = listGuides();
  const lines = [];
  if (!guidesOnly) {
    lines.push("Commands:");
    lines.push(...COMMANDS.map(command => `  ${command.name.padEnd(22)}${command.summary.split("\n")[0]}`));
    for (const plugin of table?.plugins ?? []) {
      if (plugin.commands.length) lines.push(`Plugin ${plugin.name}:`, ...plugin.commands.map((/** @type {any} */ c) => `  ${c.name.join(" ").padEnd(22)}${c.summary}`));
    }
    lines.push("");
  }
  lines.push("Guides:");
  lines.push(...guides.map(guide => `  ${guide.name.padEnd(22)}${guide.description}`));
  if (!guidesOnly) lines.push("", "Run 'sfd help <command|guide>' for full documentation.");
  return lines.join("\n");
}

/** @param {string} topic */
export function helpUsageError(topic) {
  const names = [...COMMANDS.map(command => command.name), ...listGuides().map(guide => guide.name)];
  const near = names
    .map(name => ({ name, distance: editDistance(topic, name) }))
    .filter(item => item.distance <= Math.max(2, Math.floor(topic.length / 3)))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, 3)
    .map(item => item.name);
  const suggestion = near.length ? ` Did you mean ${near.map(name => `'${name}'`).join(", ")}?` : "";
  return `Unknown help topic: ${topic}.${suggestion} Run 'sfd help -a' to see all commands and guides.`;
}

/**
 * @param {string} left
 * @param {string} right
 */
function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
}

export function assertManualMappings() {
  for (const command of COMMANDS) {
    for (const doc of /** @type {CommandDoc[]} */ (command.docs ?? [])) {
      const content = readGuideFile(doc.file);
      if (doc.heading) extractSection(content, doc.heading);
    }
  }
  const guideNames = new Set(listGuides().map(guide => guide.name));
  const collision = COMMANDS.find(command => guideNames.has(command.name));
  if (collision) throw new Error(`Command name collides with guide: ${collision.name}`);
}

