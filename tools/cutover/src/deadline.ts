import { CutoverError } from './errors.ts';

/**
 * `promise`, or a CutoverError "<what> timed out" once `ms` has passed. The promise itself is not
 * cancelled (it is left to settle, its result ignored), so give its work its own way to stop too.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CutoverError(`${what} timed out`)), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
