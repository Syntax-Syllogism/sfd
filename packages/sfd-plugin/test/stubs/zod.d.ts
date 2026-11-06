export interface ZodType<O = unknown> { safeParse(v: unknown): { success: true; data: O } | { success: false; error: unknown } }
