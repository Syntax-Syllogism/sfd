// Syntax-checks every shipped module. A Node script rather than a shell loop so it runs on Windows too.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = ["bin/sfd.mjs", ...readdirSync("src").filter(f => f.endsWith(".mjs")).map(f => `src/${f}`)];
for (const f of files) execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
