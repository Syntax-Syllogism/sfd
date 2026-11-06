import type { Connection } from "@salesforce/core";
import type { ZodType } from "zod";
import type {
  Effect, ReadOperation, WriteOperation, OperationDescriptor, OperationContext,
  OperationModule, WritePlan, SfdManifest, CliTable, Envelope, StubContext,
} from "../index.d.ts";
import type { runOperation, stubContext, stubOrg, validateManifest } from "../index.d.ts";
import type * as validators from "@syntax-syllogism/sfd-plugin/validate";
import type * as testkit from "@syntax-syllogism/sfd-plugin/testkit";
// @ts-expect-error The validator runtime does not export test-kit helpers.
import type { stubContext as invalidStub } from "@syntax-syllogism/sfd-plugin/validate";
// @ts-expect-error The test-kit runtime does not export validators.
import type { validateManifest as invalidValidator } from "@syntax-syllogism/sfd-plugin/testkit";

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;
type ValidatorExports = "validateCliTable" | "API_VERSIONS" | "EFFECTS" | "validateManifest" | "validateOperationModule" | "effectsExceeding";
type TestkitExports = "stubContext" | "stubOrg" | "runOperation" | "assertConformance";
type NoExtraValidators = Assert<Extends<keyof typeof validators, ValidatorExports>>;
type AllValidators = Assert<Extends<ValidatorExports, keyof typeof validators>>;
type NoExtraTestkit = Assert<Extends<keyof typeof testkit, TestkitExports>>;
type AllTestkit = Assert<Extends<TestkitExports, keyof typeof testkit>>;
type Options = { limit: number };
type Plan = { ids: string[] };
declare const descriptor: OperationDescriptor<Options>;
declare const schema: ZodType<Options>;
declare const read: ReadOperation<Options, string[]>;
declare const write: WriteOperation<Options, Plan, number>;
type ReadSample = Assert<Extends<{
  kind: "read"; descriptor: typeof descriptor;
  run(conn: Connection | undefined, options: Options, ctx: OperationContext): Promise<string[]>;
}, typeof read>>;
type WriteSample = Assert<Extends<{
  kind: "write"; descriptor: typeof descriptor;
  plan(conn: Connection | undefined, options: Options, ctx: OperationContext): Promise<Plan & WritePlan>;
  apply(conn: Connection | undefined, plan: Plan & WritePlan, ctx: OperationContext): Promise<number>;
}, typeof write>>;
type BadEffect<T extends Effect> = T;
// @ts-expect-error Unknown effects must be rejected.
type InvalidEffect = BadEffect<"write">;
type ReadContract<T extends ReadOperation<Options, string[]>> = T;
// @ts-expect-error Reads require run.
type MissingRun = ReadContract<{ kind: "read"; descriptor: typeof descriptor }>;
type WriteContract<T extends WriteOperation<Options, Plan, number>> = T;
// @ts-expect-error Writes require apply.
type MissingApply = WriteContract<{ kind: "write"; descriptor: typeof descriptor; plan: typeof write.plan }>;
type ModuleSample = Assert<Extends<{ apiVersion: 0; operations: [typeof read, typeof write] }, OperationModule>>;
type ManifestSample = Assert<Extends<{ apiVersion: 0; operations: "./operations.js" }, SfdManifest>>;
type CliSample = Assert<Extends<{ apiVersion: 0; commands: [{ operation: "test.list"; name: ["test", "list"]; summary: "List"; flags: [{ name: "limit"; type: "integer"; option: "limit" }] }] }, CliTable>>;
type ResultSample = Assert<Extends<{ ok: true; data: string[]; warnings: [] }, Envelope<string[]>>>;
type StubSample = Assert<Extends<ReturnType<typeof stubContext>, StubContext>>;
type OrgSample = Assert<Extends<ReturnType<typeof stubOrg>, NonNullable<OperationContext["org"]>>>;
type ValidatorSample = Assert<Extends<ReturnType<typeof validateManifest>, string[]>>;
