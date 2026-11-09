// A budget for the requests an unknown signing key makes us send. Verifying a signature whose
// key we do not hold fetches the signer's actor (signing/inbound.ts), and anyone can sign a
// request with a key id of their choosing. A fixed window per host and one for all hosts bound
// what such requests cost: the actor fetches of a busy day from real peers stay far under it,
// while a flood of made-up key ids is answered 429 once the window is spent. Kept in memory per
// process: it limits this process's outbound traffic, which is what it protects.

const windowMs = 60_000;
export const perHostBudget = 20;
export const totalBudget = 200;

type Window = { start: number; used: number };
const state = ((globalThis as { __peblishKeyFetchBudget?: Map<string, Window> }).__peblishKeyFetchBudget ??= new Map());

function spend(key: string, budget: number, now: number): boolean {
  const current = state.get(key);
  const window = current && now - current.start < windowMs ? current : { start: now, used: 0 };
  state.set(key, window);
  window.used += 1;
  return window.used <= budget;
}

/** Counts one fetch to `host`; false when this host's window or the shared window is spent. */
export function takeKeyFetch(host: string, now = Date.now()): boolean {
  if (state.size > 2000) for (const [key, window] of state) if (now - window.start >= windowMs) state.delete(key);
  const total = spend('*', totalBudget, now);
  return spend(`host:${host}`, perHostBudget, now) && total;
}

/** Forgets every window (tests). */
export const resetKeyFetchBudget = (): void => state.clear();
