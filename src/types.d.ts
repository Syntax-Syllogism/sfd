/** An outgoing request from the client to the daemon. */
export interface Request {
  op: string;
  v: number | string;
  org?: string;
  confirm?: string;
  raw?: boolean;
  [key: string]: unknown;
}

/** The server checks only op before handling stop and version mismatches. */
export type RequestEnvelope = { op: string; [key: string]: unknown };

/** A successful reply. Absent fields of the other members are `undefined`. */
export interface OkResponse { status: 0; result: unknown; name?: undefined; restart?: undefined; }

/** A failed operation; the approval fields are present when `exitCode` is 4. */
export interface ErrorResponse {
  status: 1; name: string; message: string; errorCode?: string;
  exitCode?: number; approvalRequired?: unknown; effect?: unknown;
  orgType?: unknown; summary?: unknown; plan?: unknown; trace?: unknown;
  actions?: unknown; restart?: undefined;
}

/** The daemon runs different code; the client must start a new one. */
export interface RestartResponse { restart: true; status?: undefined; name?: undefined; }

export type Response = OkResponse | ErrorResponse | RestartResponse;

/** A progress event streamed before the final response. */
export interface ProgressEvent { event: string; [key: string]: unknown; }

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error?(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** The daemon's JSON-lines file logger (`src/log.mjs`). */
export interface FileLogger extends Logger {
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): FileLogger;
  close(): Promise<unknown>;
}

export interface Transport {
  signal: AbortSignal;
  emit(event: unknown): void;
  log?: Logger;
}

export type Handler = (args: Request, transport?: Transport) => Promise<unknown>;

/** Arguments consumed by the built-in query handler. */
export interface QueryArgs extends Request {
  op: "query";
  q: string;
  tooling?: boolean;
  all?: boolean;
  limit?: number;
}

/** Arguments consumed by the built-in deploy handler. */
export interface DeployArgs extends Request {
  op: "deploy";
  projectDir: string;
  sourcePaths?: string[];
  metadata?: string[];
  checkOnly?: boolean;
  testLevel?: string;
  tests?: string[];
  waitMinutes?: number;
}

/** The API result shape used when following a paginated query. */
export interface QueryResult {
  done: boolean;
  records: any[];
  nextRecordsUrl?: string;
  [key: string]: any;
}

/** Narrow surface of the dynamically loaded Salesforce connection. */
export interface SfConnection {
  query(q: string, options?: object): Promise<QueryResult>;
  queryMore(url: string): Promise<QueryResult>;
  tooling: SfConnection;
  request(...args: any[]): Promise<any>;
  getApiVersion(): string;
  instanceUrl: string;
  metadata: any;
  identity(): Promise<any>;
  getAuthInfoFields?(): any;
  describe(name: string): Promise<any>;
  sobject(name: string): any;
  limitInfo?: { apiUsage?: { used: number; limit: number } };
}

export interface SfOrg {
  getUsername(): string;
  getOrgId(): string;
  getConnection(): SfConnection;
  refreshAuth(): Promise<void>;
  tracksSource(): Promise<boolean>;
}

export interface OrgArgs extends Request { op: "org"; }
/** orgList also runs without arguments, so none of its fields are required. */
export interface OrgListArgs { all?: boolean; status?: boolean; raw?: boolean; confirm?: string; }
export interface ApexArgs extends Request { op: "apex"; body: string; }
export interface RestArgs extends Request {
  op: "rest"; method: string; url: string; body?: unknown;
  headers?: Record<string, string>;
}
export interface DescribeArgs extends Request { op: "describe"; sobject: string; tooling?: boolean; }
export interface RetrieveArgs extends Request {
  op: "retrieve"; projectDir: string; sourcePaths?: string[]; metadata?: string[];
  manifest?: string; ignoreConflicts?: boolean; waitMinutes?: number;
}
export interface TrackingArgs extends Request {
  op: "tracking"; projectDir: string; local?: boolean; remote?: boolean; conflicts?: boolean;
}
export interface TestArgs extends Request {
  op: "test"; classNames?: string[]; tests?: string[]; suiteNames?: string[];
  testLevel?: string; synchronous?: boolean; codeCoverage?: boolean;
  logs?: boolean; noTrace?: boolean; waitMinutes?: number;
}
export interface LogsArgs extends Request { op: "logs"; count?: number; user?: string; noTrace?: boolean; }
export interface LogGetArgs extends Request { op: "logGet"; id: string; noTrace?: boolean; }
export interface ListMetadataTypesArgs extends Request { op: "listMetadataTypes"; }
export interface ListMetadataArgs extends Request { op: "listMetadata"; types?: string[]; folder?: string; }

/** The current user, as the TraceFlag setup needs it. */
export interface TraceUser { id: string; username: string; }
/** A TraceFlag setup result: whether sfd found, extended or created the flag. */
export interface Trace { action: string; id: string; expires: string; }
export interface MetadataTypeInfo { name: string; inFolder: boolean; children: string[]; }

export interface WithConnOptions {
  /** Retry once on an expired session even after the operation started. */
  retry?: boolean;
  /** Back off and retry on request-limit errors; defaults to `retry`. */
  backoff?: boolean;
  /** The noun in the session-expiry message ("write" or "retrieve"). */
  write?: string;
  /** Supplies the deploy ID for the session-expiry message. */
  deployId?: () => string | undefined;
}

/** Daemon-wide org and connection state (`src/org-session.mjs`). */
export interface OrgSession {
  getOrg(alias: string | undefined): Promise<SfOrg>;
  withConn<T>(alias: string | undefined, fn: (conn: SfConnection, org: SfOrg) => T | Promise<T>, options?: WithConnOptions): Promise<T>;
  orgType(alias: string | undefined): Promise<string>;
  metadataTypes(alias: string | undefined, conn: SfConnection): Promise<{ types: MetadataTypeInfo[]; apiVersion: string; cached: boolean }>;
  traceFor(conn: SfConnection, alias: string | undefined, user: TraceUser, noTrace: boolean | undefined): Promise<(Trace & { username: string }) | undefined> | undefined;
  invalidate(scope: "all" | { alias?: string; username?: string }, observedStamp?: string): Promise<void>;
  refreshIfAuthChanged(): Promise<void>;
  runtimeDir(): string;
  /** Aliases and usernames with a cached org. */
  cachedOrgs(): (string | undefined)[];
  /** Drops one cached org without invalidating anything else. */
  forgetOrg(key: string | undefined): void;
  /** The last safety type resolved for a username or alias, if any. */
  cachedType(key: string): string | undefined;
  apiUsage(): Record<string, { used: number; limit: number }>;
  sizes(): { orgs: number; traces: number; typeCache: number; safetyTypes: number };
}

export type Effect = "read" | "local-write" | "org-write" | "destructive";
/** Whether an operation may run again after a session expiry interrupted it. */
export type Retry = "safe" | "never";

/** What a built-in operation's `run` receives. */
export interface OpContext {
  session: OrgSession;
  /** `@salesforce/core` and `@salesforce/kit`'s `Duration`, loaded from the sf install. */
  core: any;
  Duration: any;
  /** Lazy loaders for the heavier Salesforce libraries. */
  sdr(): any;
  apex(): any;
  tracking(): any;
  /** The connection and org, for operations that need one. */
  conn?: SfConnection;
  org?: SfOrg;
  signal?: AbortSignal;
  emit?(event: unknown): void;
  /** The request-scoped warning logger, or the daemon log. */
  warn(message: string): void;
  home: string;
  getPolicy(): import("./policy.mjs").Policy;
  /** Clears SfProject instances; only valid inside the project queue. */
  clearProjects(): void;
  /** Per-request state that survives connection retries (deploy ID, limiters). */
  state: Record<string, any>;
}

/** A built-in daemon operation (`src/ops/<name>.mjs`). */
export interface BuiltinOp<A = any> {
  name: string;
  /** The operation's declared effects; defined in `src/ops/effects.mjs`. */
  effects(args?: Record<string, unknown>): Effect[];
  /** "safe" lets a session-expiry retry repeat the operation; a function decides per request. */
  retry: Retry | ((args: A) => Retry);
  /** Back off on request limits; defaults to whether retry is "safe". */
  backoff?: boolean;
  /** The noun for the session-expiry message; defaults to "write". */
  write?: string;
  /** Runs inside the project queue (SDR and source tracking). */
  project: boolean;
  /** Gate through the safety policy before running. orgList checks itself. */
  policy: boolean;
  /** False for operations that run without a connection. Defaults to true. */
  needsOrg?: boolean;
  run(ctx: OpContext, args: A): Promise<unknown>;
}
