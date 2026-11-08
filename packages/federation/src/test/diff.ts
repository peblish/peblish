// Structural diff of a wire document against its round trip through the mapping.
// Three JSON-LD equivalences are not differences: null and an absent key, an original
// scalar and a one-element array holding it (peblish sends arrays, as Lemmy does), and two
// timestamps naming the same millisecond (Date keeps milliseconds; Lemmy sends microseconds).
// Arrays of plain values (addressing) compare as sets; arrays of objects compare by position.
// An @context is one value: it is reported once, as a whole, when it differs.

export type Change = 'dropped' | 'added' | 'changed';
export type Difference = { path: string; change: Change; original?: unknown; mapped?: unknown };

const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function sameInstant(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !isoInstant.test(a) || !isoInstant.test(b)) return false;
  return Date.parse(a) === Date.parse(b);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPlain = (value: unknown) => value === null || typeof value !== 'object';
const key = (value: unknown) => JSON.stringify(value);

function join(path: string, segment: string | number): string {
  if (typeof segment === 'number') return `${path}[${segment}]`;
  return path === '' ? segment : `${path}.${segment}`;
}

function walk(path: string, original: unknown, mapped: unknown, out: Difference[]): void {
  const a = original ?? undefined;
  let b = mapped ?? undefined;
  if (a === undefined && b === undefined) return;
  if (a === undefined) return void out.push({ path, change: 'added', mapped: b });
  if (b === undefined) return void out.push({ path, change: 'dropped', original: a });
  if (!Array.isArray(a) && Array.isArray(b) && b.length === 1) b = b[0];
  if (path === '@context' || path.endsWith('.@context')) {
    if (key(a) !== key(b)) out.push({ path, change: 'changed', original: a, mapped: b });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.every(isPlain) && b.every(isPlain)) {
      const left = a.map(key).sort();
      const right = b.map(key).sort();
      if (left.length !== right.length || left.some((item, index) => item !== right[index]))
        out.push({ path, change: 'changed', original: a, mapped: b });
      return;
    }
    for (let index = 0; index < Math.max(a.length, b.length); index++) walk(join(path, index), a[index], b[index], out);
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const name of keys) walk(join(path, name), a[name], b[name], out);
    return;
  }
  if (a === b || sameInstant(a, b)) return;
  out.push({ path, change: 'changed', original: a, mapped: b });
}

export function diff(original: unknown, mapped: unknown): Difference[] {
  const out: Difference[] = [];
  walk('', original, mapped, out);
  return out;
}

/** Array indices dropped, so `object.tag[2].name` matches the pattern `**.tag[].name`. */
export const normalPath = (path: string) => path.replaceAll(/\[\d+\]/g, '[]');

/** Glob over normalized paths: `*` is one key, `**.` any number of leading keys. */
export function matches(pattern: string, path: string): boolean {
  const source = pattern
    .split('**.')
    .map((part) =>
      part
        .split('*')
        .map((piece) => piece.replaceAll(/[.[\]\\^$+?(){}|]/g, '\\$&'))
        .join('[^.]+'),
    )
    .join('(?:[^.]+\\.)*');
  return new RegExp(`^${source}$`).test(normalPath(path));
}
