import { sendMail, type MailMessage } from '@peblish/core/identity/mail';
import { type } from 'arktype';
import type { Bucket } from './bucket.ts';
import { withDeadline } from './deadline.ts';
import { describe } from './errors.ts';

// Mail to the operator when a backup kind starts failing or goes stale, and once when it works
// again (deploy/backups.md, "Alerts"). Through the web process's own mail path (core's sendMail:
// SMTP_URL, MAIL_FROM), to BACKUP_ALERT_TO. Alerting never holds a run or a tick: the schedule
// hands it events and goes on. Events become mails on one queue, one at a time, each with a hard
// deadline. A kind's state is claimed when the event arrives, before any mail is sent, so
// overlapping ticks cannot send the same mail twice; a recovery is mailed only after a problem
// mail actually went out. What was mailed is kept in
// status/<kind>.alert.json; a write that fails is retried on every tick until it lands. A mail
// names the kind, since when, and where to look; never an error's text, a URL or a credential.

export type Kind = 'backup' | 'ledger';
const kinds: readonly Kind[] = ['backup', 'ledger'];
export type Problem = 'failing' | 'stale';

const AlertState = type({ state: "'failing' | 'stale' | 'ok'", since: 'string.date.iso', 'mailedAt?': 'string.date.iso' });
type AlertState = typeof AlertState.infer;

/** One mail, however long the mail server takes: past this it is abandoned and counted as not sent. */
export const MAIL_DEADLINE_MS = 60_000;
/** Reading the stored states at start. */
const LOAD_TIMEOUT_MS = 20_000;

export type LastGood = Record<Kind, { object: string; finishedAt: string } | null>;

export type Alerter = {
  /** Reads the stored states (bounded) and reconciles them with the last good runs; call once at start. */
  load(lastGood: LastGood): Promise<void>;
  /** A run failed, or the last good run is too old. Mails once per episode. Returns at once. */
  problem(kind: Kind, problem: Problem, since: Date, lastGood: string | null): void;
  /** A good run. Mails once if a problem was mailed. Returns at once. */
  recovered(kind: Kind, object: string, at: Date): void;
  /** Retries saving any state that did not save. Returns at once. */
  flush(): void;
  /** Resolves when the queue is empty (tests, and a bounded wait at shutdown). */
  idle(): Promise<void>;
};

const label = { backup: 'nightly database backup', ledger: 'hourly ledger export' } as const;
const alertKey = (kind: Kind) => `status/${kind}.alert.json`;

/** What alerts need, or why they are off (said once at start). */
export function alertConfig(env: NodeJS.ProcessEnv = process.env): { to: string } | { off: string } {
  const missing = (['SMTP_URL', 'MAIL_FROM', 'BACKUP_ALERT_TO'] as const).filter((name) => !env[name]);
  if (missing.length > 0) return { off: `alert mail is off: ${missing.join(', ')} not set` };
  if (!/^[^\s@,<>]+@[^\s@,<>]+$/.test(env.BACKUP_ALERT_TO!)) return { off: 'alert mail is off: BACKUP_ALERT_TO is not one email address' };
  return { to: env.BACKUP_ALERT_TO! };
}

export function mailAlerter(
  to: string,
  bucket: Bucket,
  bucketName: string,
  log: (line: string) => void,
  send: (message: MailMessage) => Promise<void> = (message) => sendMail(message, 'localhost'),
  options: { mailDeadlineMs?: number } = {},
): Alerter {
  const mailDeadlineMs = options.mailDeadlineMs ?? MAIL_DEADLINE_MS;
  /** What the operator has been told about each kind; claimed before the mail goes out. */
  const claimed = new Map<Kind, { state: 'ok' | Problem; since: string }>();
  /** What the operator has actually been mailed (or, from the bucket, was mailed before a restart). */
  const told = new Map<Kind, 'ok' | Problem>();
  /** States mailed but not yet saved in the bucket. */
  const unsaved = new Map<Kind, AlertState>();
  let queue: Promise<void> = Promise.resolve();
  let flushQueued = false;

  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job).catch((error: unknown) => log(`alert failed: ${describe(error)}`));
  };
  const current = (kind: Kind) => claimed.get(kind) ?? { state: 'ok' as const, since: new Date(0).toISOString() };

  async function deliver(kind: Kind | 'state', message: MailMessage): Promise<boolean> {
    try {
      await withDeadline(send(message), mailDeadlineMs, 'the mail');
      return true;
    } catch (error) {
      log(`${kind} alert mail not sent: ${describe(error)}`);
      return false;
    }
  }

  async function save(kind: Kind): Promise<void> {
    const next = unsaved.get(kind);
    if (!next) return;
    try {
      await bucket.putSmall(alertKey(kind), `${JSON.stringify(next)}\n`, 'application/json');
      if (unsaved.get(kind) === next) unsaved.delete(kind);
    } catch (error) {
      log(`${kind} alert state not saved (tried again on the next tick): ${describe(error)}`);
    }
  }

  const where =
    'Look at the backup service log in Easypanel, and run `node tools/cutover/src/cli.ts backup-status` in its console. ' +
    'deploy/backups.md has the steps.';

  const alerter: Alerter = {
    async load(lastGood) {
      const unreadable: Kind[] = [];
      for (const kind of kinds) {
        let stored: AlertState | null = null;
        try {
          const found = await bucket.getSmall(alertKey(kind), AbortSignal.timeout(LOAD_TIMEOUT_MS));
          if (found) {
            let value: unknown = null;
            try {
              value = JSON.parse(found.text);
            } catch {
              value = null;
            }
            const checked = AlertState(value);
            if (checked instanceof type.errors) unreadable.push(kind);
            else stored = checked;
          }
        } catch {
          unreadable.push(kind);
        }
        if (!stored) continue; // missing or unreadable: nothing was told that we know of
        claimed.set(kind, { state: stored.state, since: stored.since });
        told.set(kind, stored.state);
        // A recovery whose saved state was lost (a failed write, then a restart): the good run is
        // newer than the problem mail, so mail the recovery (again, perhaps) and save it this time.
        const good = lastGood[kind];
        if (stored.state !== 'ok' && good && Date.parse(good.finishedAt) > Date.parse(stored.mailedAt ?? stored.since)) {
          alerter.recovered(kind, good.object, new Date(good.finishedAt));
        }
      }
      if (unreadable.length > 0) {
        log(`alert state unreadable for ${unreadable.join(' and ')}: treated as nothing mailed`);
        enqueue(async () => {
          await deliver('state', {
            to,
            subject: 'peblish backups: the alert state cannot be read',
            text: [
              `The backup service could not read what it last mailed about the ${unreadable.map((k) => label[k]).join(' and ')} (bucket ${bucketName}).`,
              'Mails for new failures still go out; a recovery mail may be missing or repeated.',
              '',
              where,
            ].join('\n'),
          });
        });
      }
    },

    problem(kind, problem, since, lastGood) {
      if (current(kind).state !== 'ok') return;
      const claim = { state: problem, since: since.toISOString() };
      claimed.set(kind, claim);
      const what = problem === 'failing' ? 'is failing' : 'has not succeeded in time';
      enqueue(async () => {
        const sent = await deliver(kind, {
          to,
          subject: `peblish backups: the ${label[kind]} ${what}`,
          text: [
            `The ${label[kind]} to bucket ${bucketName} ${what}, since ${claim.since}.`,
            `Last good run: ${lastGood ?? 'none recorded'}.`,
            '',
            where,
            'You get one more mail when it works again.',
          ].join('\n'),
        });
        if (!sent) {
          // Not told: release the claim so the next failure or stale check tries again.
          if (claimed.get(kind) === claim) claimed.delete(kind);
          return;
        }
        told.set(kind, problem);
        unsaved.set(kind, { state: problem, since: claim.since, mailedAt: new Date().toISOString() });
        log(`${kind} alert mail sent (${problem})`);
        await save(kind);
      });
    },

    recovered(kind, object, at) {
      const before = current(kind);
      if (before.state === 'ok') return;
      const claim = { state: 'ok' as const, since: at.toISOString() };
      claimed.set(kind, claim);
      enqueue(async () => {
        // The problem mail ahead of this one may not have gone out (it failed or timed out): then there is nothing to take back.
        if ((told.get(kind) ?? 'ok') === 'ok') return;
        const sent = await deliver(kind, {
          to,
          subject: `peblish backups: the ${label[kind]} works again`,
          text: [
            `The ${label[kind]} to bucket ${bucketName} works again: ${object} at ${claim.since}.`,
            `It had been ${before.state === 'failing' ? 'failing' : 'stale'} since ${before.since}.`,
            '',
            where,
          ].join('\n'),
        });
        if (!sent) {
          if (claimed.get(kind) === claim) claimed.set(kind, before);
          return;
        }
        told.set(kind, 'ok');
        unsaved.set(kind, { state: 'ok', since: claim.since, mailedAt: new Date().toISOString() });
        log(`${kind} alert mail sent (ok)`);
        await save(kind);
      });
    },

    flush() {
      if (flushQueued || unsaved.size === 0) return;
      flushQueued = true;
      enqueue(async () => {
        flushQueued = false;
        for (const kind of kinds) await save(kind);
      });
    },

    idle: () => queue,
  };
  return alerter;
}
