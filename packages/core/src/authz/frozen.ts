/**
 * Deeply readonly: what a grant holds and a policy sees. The values behind it are JSON-like
 * plain data only (plain objects, arrays, strings, numbers, booleans, null, undefined,
 * bigint); frozenCopy rejects anything else, because freezing cannot make it immutable.
 */
export type Frozen<T> = { readonly [K in keyof T]: Frozen<T[K]> };

/** Thrown by frozenCopy, so by authorize(), for input that is not JSON-like plain data. */
export class SnapshotError extends TypeError {
  override readonly name = 'SnapshotError';
  /** Where in the input, such as `subject.createdAt`. */
  readonly path: string;
  /** What was found there, such as `Date` or `a cycle`. */
  readonly found: string;

  constructor(path: string, found: string) {
    super(`cannot snapshot ${path}: ${found} is not JSON-like plain data`);
    this.path = path;
    this.found = found;
  }
}

/**
 * A deep copy of JSON-like plain data, frozen all the way down, so no caller can change it
 * afterwards. Rejects, with SnapshotError: Date (setTime() still mutates a frozen Date),
 * Buffer and typed arrays, Map, Set, class instances, functions, symbols, accessor or
 * symbol-keyed properties, and cycles. The storage sites (grant fields, PolicyRequest)
 * carry the Frozen types.
 */
export function frozenCopy<T>(value: T, path = 'value'): T {
  assertPlain(value, path, []);
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}

function describe(value: object): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  const constructor =
    typeof prototype === 'object' && prototype !== null ? Object.getOwnPropertyDescriptor(prototype, 'constructor') : undefined;
  return typeof constructor?.value === 'function' && constructor.value.name ? constructor.value.name : 'an exotic object';
}

function assertPlain(value: unknown, path: string, ancestors: object[]): void {
  if (typeof value === 'function' || typeof value === 'symbol') throw new SnapshotError(path, `a ${typeof value}`);
  if (typeof value !== 'object' || value === null) return;
  if (ancestors.includes(value)) throw new SnapshotError(path, 'a cycle');
  const prototype: unknown = Object.getPrototypeOf(value);
  const plain = Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null;
  if (!plain) throw new SnapshotError(path, describe(value));
  if (Object.getOwnPropertySymbols(value).length > 0) throw new SnapshotError(path, 'a symbol-keyed property');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    const at = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
    if (!('value' in descriptor)) throw new SnapshotError(at, 'an accessor property');
    assertPlain(descriptor.value, at, [...ancestors, value]);
  }
}

function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
