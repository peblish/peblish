/** Deeply readonly: what a grant holds and a policy sees. */
export type Frozen<T> = { readonly [K in keyof T]: Frozen<T[K]> };

/**
 * A deep copy of plain data, frozen all the way down, so no caller can change it afterwards.
 * The storage sites (grant fields, PolicyRequest) carry the Frozen types.
 */
export function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}

function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
