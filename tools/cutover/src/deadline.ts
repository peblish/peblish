import { CutoverError } from './errors.ts';

/**
 * `promise`, or a CutoverError "<what> timed out" once `ms` has passed, or "<what> stopped" as
 * soon as `signal` aborts. The promise itself is not cancelled (it is left to settle, its result
 * ignored), so give its work its own way to stop too.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CutoverError(`${what} timed out`)), ms);
    onAbort = () => reject(new CutoverError(`${what} stopped`));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => undefined);
  return Promise.race([promise, late]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  });
}
