import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/commands.mjs";
import { assertManualMappings, extractSection, listGuides, parseFrontmatter, renderCommandManual, renderGuide } from "../src/help-topics.mjs";

test("every registered command has a renderable manual and mapped docs exist", () => {
  assert.doesNotThrow(assertManualMappings);
  for (const { name } of COMMANDS) {
    const manual = renderCommandManual(name);
    assert.ok(manual, name);
    assert.match(manual, /See also:/, name);
  }
});

test("guide names do not collide with command names", () => {
  const commandNames = new Set(COMMANDS.map(command => command.name));
  for (const guide of listGuides()) assert.ok(!commandNames.has(guide.name), guide.name);
});

test("section extraction ignores headings inside fenced code", () => {
  const markdown = [
    "# Guide",
    "## Target",
    "Text before example.",
    "```md",
    "## Not a section boundary",
    "```",
    "More target text.",
    "### Child",
    "Child text.",
    "## Next",
    "Next text."
  ].join("\n");
  assert.equal(extractSection(markdown, "Target"), [
    "## Target", "Text before example.", "```md", "## Not a section boundary", "```", "More target text.", "### Child", "Child text."
  ].join("\n"));
  assert.throws(() => extractSection(markdown, "Not a section boundary"), /Heading not found/);
});

test("guide rendering rewrites relative Markdown links to CLI help topics", () => {
  const query = renderGuide("query-output");
  assert.match(query, /`agent-hooks: sfd help agent-hooks`/);
  assert.doesNotMatch(query, /\]\(agent-hooks\.md\)/);
  const tracking = renderGuide("source-tracking");
  assert.match(tracking, /`README: sfd help -a`/);
});

test("command manuals rewrite mapped documentation links to CLI help topics", () => {
  const snippet = renderCommandManual("agents-snippet");
  assert.match(snippet, /`agent-hooks: sfd help agent-hooks`/);
  assert.match(snippet, /`cli-help: sfd help cli-help`/);
  assert.doesNotMatch(snippet, /\]\(cli-help\.md#keeping-it-in-sync\)/);
  assert.doesNotMatch(snippet, /\]\(agent-hooks\.md\)/);
  assert.match(renderCommandManual("deploy"), /`README: sfd help -a`/);
});

test("manual agent tips omit leading separators and preserve argument tips", () => {
  assert.match(renderCommandManual("status"), /## Tips for agents\n\ndaemon status/);
  assert.match(renderCommandManual("org"), /## Tips for agents\n\nresolved org details/);
  assert.match(renderCommandManual("query"), /## Tips for agents\n\n"<soql>" --csv --limit 200: SOQL/);
});

test("guides read their title and description from frontmatter and skip the docs index", () => {
  const guides = listGuides();
  assert.ok(!guides.some(guide => guide.name === "README"));
  const tracking = guides.find(guide => guide.name === "source-tracking");
  assert.equal(tracking.title, "Source tracking, retrieve and deploy");
  assert.match(renderGuide("source-tracking"), /^# Source tracking, retrieve and deploy\n\n(?!---)/);
  assert.equal(parseFrontmatter("---\ntitle: \"A: b\"\ndescription: Hi.\n---\n\nBody").data.title, "A: b");
  assert.deepEqual(parseFrontmatter("# No frontmatter").data, {});
});
