// What the inbox costs us, counted in fixed one-minute windows kept in memory per process: they
// limit this process's own work, which is what they protect. Three budgets, none shared, so one
// kind of traffic cannot spend another's:
//
// - Key fetches (takeKeyFetch). Verifying a signature whose key we do not hold fetches the
//   signer's actor (signing/inbound.ts), and anyone can sign a request with a key id of their
//   choosing. Spent by requests that are not authenticated yet, per host the key names and in
//   total; the actor fetches of a busy day from real peers stay far under it, while a flood of
//   made-up key ids is answered 429 once the window is spent. Nothing authenticated spends it.
// - Pipeline fetches (takePipelineFetch). What processing an authenticated delivery fetches
//   (actors it names, announced objects, collections). Its own budget, so a flood of unsigned
//   requests cannot starve the work of real peers; a row that finds it spent waits and is tried
//   again (pipeline.ts).
// - Intake (takeIntake). Authenticated requests per signer and per instance, after the
//   signature is verified, so only a peer's own key spends its allowance.
//
// Every table is bounded: past the cap the oldest window is forgotten (a forgotten window only
// loosens one key's count, while the totals keep counting).

const windowMs = 60_000;
const maxKeys = 2000;

export const perHostBudget = 20;
export const totalBudget = 200;
export const pipelinePerHostBudget = 120;
export const pipelineTotalBudget = 1200;
/** Requests per minute from one signing actor, and from all actors of one instance. */
export const perSignerRate = 300;
export const perInstanceRate = 1200;

type Window = { start: number; used: number };
type Windows = Map<string, Window>;

// On globalThis because the web build can hold two copies of a module.
const table = (name: string): Windows => {
  const holder = globalThis as unknown as Record<string, Windows | undefined>;
  return (holder[`__peblishInbox${name}`] ??= new Map());
};
const keyFetches = table('KeyFetches');
const pipelineFetches = table('PipelineFetches');
const intake = table('Intake');

/** Counts one use of `key`; false once the window's budget is spent (a refused use counts too, so hammering stays refused). */
function spend(windows: Windows, key: string, budget: number, now: number): boolean {
  const current = windows.get(key);
  const window = current && now - current.start < windowMs ? current : { start: now, used: 0 };
  windows.delete(key);
  windows.set(key, window);
  if (windows.size > maxKeys) windows.delete(windows.keys().next().value!);
  window.used += 1;
  return window.used <= budget;
}

/** Spends one use of the shared window and of `key`'s; both are counted even when the first is spent. */
function spendBoth(windows: Windows, key: string, budgets: { key: number; total: number }, now: number): boolean {
  const total = spend(windows, '*', budgets.total, now);
  return spend(windows, key, budgets.key, now) && total;
}

/** Counts one fetch to `host` for an unauthenticated request; false when this host's window or the shared window is spent. */
export const takeKeyFetch = (host: string, now = Date.now()): boolean =>
  spendBoth(keyFetches, `host:${host}`, { key: perHostBudget, total: totalBudget }, now);

/** Counts one fetch to `host` made while processing an authenticated delivery. */
export const takePipelineFetch = (host: string, now = Date.now()): boolean =>
  spendBoth(pipelineFetches, `host:${host}`, { key: pipelinePerHostBudget, total: pipelineTotalBudget }, now);

/** Counts one authenticated request from `signerApId`; false when its window or its instance's is spent. */
export function takeIntake(signerApId: string, now = Date.now()): boolean {
  const instance = spend(intake, `instance:${new URL(signerApId).origin}`, perInstanceRate, now);
  return spend(intake, `signer:${signerApId}`, perSignerRate, now) && instance;
}

/** How many windows are held, across the three budgets (tests). */
export const heldWindows = (): number => keyFetches.size + pipelineFetches.size + intake.size;

/** Forgets every window (tests). */
export function resetKeyFetchBudget(): void {
  keyFetches.clear();
  pipelineFetches.clear();
  intake.clear();
}
