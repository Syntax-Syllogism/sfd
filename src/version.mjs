import { readdirSync, readFileSync, statSync } from "node:fs";

const pkg = new URL("../package.json", import.meta.url);
export const VERSION = JSON.parse(readFileSync(pkg, "utf8")).version;

// The client and daemon must run the same code, not just the same package version:
// fold the newest source mtime in, so an edited or reinstalled checkout replaces a running daemon.
const src = new URL("./", import.meta.url);
const newest = Math.max(...readdirSync(src).map(f => statSync(new URL(f, src)).mtimeMs));
export const PROTOCOL = `${VERSION}+${Math.floor(newest)}`;
