import type { ZodType } from "zod";
import type { Connection } from "@salesforce/core";

export type ApiVersion = 0;
export type Effect = "read" | "local-write" | "org-write" | "destructive";
export type OrgRequirement = "required" | "optional" | "none";
export type OrgType = "scratch" | "sandbox" | "production" | "unknown";

export interface OperationDescriptor<O = unknown> {
  /** Stable, plugin-namespaced id, e.g. "warden.access". Never reused once published. */
  id: string;
  /** Matching sf command id, e.g. "warden:access". Used by the CLI table and parity tests. */
  cliId?: string;
  title: string;
  /** One line for snippets and search. */
  summary: string;
  /** Static effects ceiling. Policy and help use this before running. Order is irrelevant. */
  effects: Effect[];
  requiresOrg: OrgRequirement;
  /** If true, the host serializes this op per project root and passes ctx.projectRoot. */
  requiresProject: boolean;
  optionsSchema: ZodType<O>;
  /** May the host replay after an uncertain failure (timeout, dropped worker)? */
  retry: "safe" | "unsafe";
  /** Optional: true if the op returns a list and honours options.limit (simply convention). */
  paged?: boolean;
}

export interface ProgressEvent { phase: string; done?: number; total?: number; message?: string }

export interface OrgInfo {
  alias?: string;
  username: string;
  apiVersion: string;
  /** "unknown" until the host implements org-type policy. */
  type: OrgType;
  instanceUrl?: string;
}

export interface OperationContext {
  signal: AbortSignal;
  onProgress(event: ProgressEvent): void;
  /** Short human notice printed to stderr by the CLI (sfd's existing notice channel). */
  notice(message: string): void;
  /** Present when requiresProject is true, or when cwd is inside an sfdx project. */
  projectRoot?: string;
  /** Resolve a user-supplied path against the client's cwd, never process.cwd(). */
  resolvePath(path: string): string;
  /** Present when requiresOrg is "required", or "optional" and an org was given. */
  org?: OrgInfo;
}

export interface ReadOperation<O = unknown, R = unknown> {
  kind: "read";
  descriptor: OperationDescriptor<O>;
  run(conn: Connection | undefined, options: O, ctx: OperationContext): Promise<R>;
}

export interface WritePlan { /** Effects this plan would actually cause; must be a subset of the descriptor's ceiling. */
  effects?: Effect[];
  /** Human one-line summary used by --plan output and "ask" prompts. */
  summary?: string;
}

export interface WriteOperation<O = unknown, P extends object = WritePlan, R = unknown> {
  kind: "write";
  descriptor: OperationDescriptor<O>;
  plan(conn: Connection | undefined, options: O, ctx: OperationContext): Promise<P & WritePlan>;
  apply(conn: Connection | undefined, plan: P & WritePlan, ctx: OperationContext): Promise<R>;
}

export type Operation = ReadOperation<any, any> | WriteOperation<any, any, any>;

export interface OperationModule { apiVersion: ApiVersion; operations: Operation[] }

/** Errors: throw anything with these fields; the host maps them into Err. */
export interface OperationErrorShape { code: string; message: string; actions?: string[]; retryable?: "safe" | "unsafe" | "no" }

export type Ok<R> = { ok: true; data: R; total?: number; truncated?: boolean; warnings: string[] };
export type Err = { ok: false; code: string; message: string; actions: string[]; retryable: "safe" | "unsafe" | "no" };
export type Envelope<R> = Ok<R> | Err;

export interface SfdManifest {
  apiVersion: ApiVersion;
  /** Path relative to the package root, e.g. "./lib/sfd/operations.js". */
  operations: string;
  /** Path to cli.json. Optional in v0. */
  cli?: string;
  requires?: { sfd?: string };
}

/** Schema of cli.json, used by direct dispatch, agent tooling and generation. */
export interface CliTable {
  apiVersion: ApiVersion;
  commands: CliCommand[];
}
export interface CliCommand {
  /** Operation id this command runs. */
  operation: string;
  /** sfd command words, e.g. ["warden", "access"]. */
  name: string[];
  summary: string;
  agentTip?: string;
  docs?: string;
  /** sf command words for the rewrite hook, e.g. ["warden", "access"]. */
  sf?: string[];
  flags: CliFlag[];
  formatter?: "table" | "csv" | "summary" | "json" | { module: string };
}
export interface CliFlag {
  /** Long flag name as sf accepts it, e.g. "target-org". */
  name: string;
  char?: string;
  type: "string" | "boolean" | "integer" | "file" | "directory";
  multiple?: boolean;
  /** Key in optionsSchema this flag maps to; omitted for target-org/api-version (host handles those). */
  option?: string;
  required?: boolean;
}

export const API_VERSIONS: readonly ApiVersion[];
export const EFFECTS: readonly Effect[];
/** Returns problems, including advisory entries prefixed with "warning: ". */
export function validateCliTable(table: unknown, operations?: readonly unknown[]): string[];
export function validateManifest(manifest: unknown): string[];
export function validateOperationModule(mod: unknown): string[];
export function effectsExceeding(ceiling: readonly Effect[], planEffects?: readonly Effect[]): Effect[];

export interface StubContext extends OperationContext {
  _progress: ProgressEvent[];
  _notices: string[];
}
export function stubContext(overrides?: Partial<OperationContext> & { cwd?: string }): StubContext;
export function stubOrg(overrides?: Partial<OrgInfo>): OrgInfo;
export interface RunOperationOptions<O> {
  conn?: Connection;
  options: unknown;
  ctx?: OperationContext;
}
export function runOperation<O, R>(op: ReadOperation<O, R>, args: RunOperationOptions<O>): Promise<{ data: R }>;
export function runOperation<O, P extends object, R>(
  op: WriteOperation<O, P, R>,
  args: RunOperationOptions<O> & { confirmPlan?: (plan: P & WritePlan) => boolean | void | Promise<boolean | void> }
): Promise<{ plan: P & WritePlan; data?: R }>;
export function assertConformance(mod: unknown): void;
