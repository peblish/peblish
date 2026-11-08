import { type, type Type } from 'arktype';

/** A JSON value as it goes on the wire. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** A wire object the mapping cannot read: wrong shape, unsupported type or a missing reference. */
export class MappingError extends Error {
  override name = 'MappingError';
}

/** Validates `value` against `schema`, throwing MappingError with ArkType's summary (which names the field). */
export function parse<T>(schema: Type<T>, value: unknown, what: string): Type<T>['infer'] {
  const out = schema(value);
  if (out instanceof type.errors) throw new MappingError(`${what}: ${out.summary}`);
  return out;
}

/** Drops undefined members so the output is plain JSON and absent stays absent. */
export function compact(fields: Record<string, Json | undefined>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
}
