import { sendMail, type MailMessage } from '@peblish/core/identity/mail';
import { describe } from './errors.ts';

// The overdue mail (deploy/backups.md, "Alerts"): when a kind's last good run is older than its
// threshold, mail BACKUP_ALERT_TO, at most once a day per kind. Nothing is stored: the schedule
// works out "overdue" each tick from the status records, and this keeps, in memory only, when
// each kind was last mailed (set only by a send that succeeded) and when a failed send may be
// tried again. One send at a time per process, through core's sendMail (the web process's mail
// path, with its finite SMTP timeouts); nothing waits for it, and nothing races it.

export type Kind = 'backup' | 'ledger';

/** After a mail that went out, the same kind is not mailed again for this long. */
export const REPEAT_MS = 24 * 3600_000;
/** After a send that failed or timed out, the next try waits this long from when it ended. */
export const RETRY_MS = 15 * 60_000;

export type Overdue = {
  kind: Kind;
  /** The last good run's finish time, or null when no readable record names one. */
  lastGood: string | null;
  /** How long ago the baseline was (the last good finish, or this process's start). */
  ageMs: number;
  /** This process's last failure for the kind, already filtered to fixed words. */
  lastFailure: string | null;
};

export type Alerter = {
  /** A kind is overdue now. Starts a send if one is due and none is in flight; returns at once. */
  overdue(o: Overdue): void;
  /** Resolves when no send is in flight (tests). */
  idle(): Promise<void>;
};

const label = { backup: 'nightly database backup', ledger: 'hourly ledger export' } as const;

/** What alerts need, or why they are off (said once at start). */
export function alertConfig(env: NodeJS.ProcessEnv = process.env): { to: string } | { off: string } {
  const missing = (['SMTP_URL', 'MAIL_FROM', 'BACKUP_ALERT_TO'] as const).filter((name) => !env[name]);
  if (missing.length > 0) return { off: `alert mail is off: ${missing.join(', ')} not set` };
  if (!/^[^\s@,<>]+@[^\s@,<>]+$/.test(env.BACKUP_ALERT_TO!)) return { off: 'alert mail is off: BACKUP_ALERT_TO is not one email address' };
  return { to: env.BACKUP_ALERT_TO! };
}

const age = (ms: number) => `${Math.floor(ms / 3600_000)} h ${Math.floor((ms % 3600_000) / 60_000)} min`;

export function mailAlerter(
  to: string,
  bucketName: string,
  log: (line: string) => void,
  send: (message: MailMessage) => Promise<void> = (message) => sendMail(message, 'localhost'),
  clock: () => number = Date.now,
): Alerter {
  const mailedAt = new Map<Kind, number>();
  const retryAt = new Map<Kind, number>();
  let inFlight: Promise<void> | null = null;

  return {
    overdue({ kind, lastGood, ageMs, lastFailure }) {
      const now = clock();
      if (inFlight || now - (mailedAt.get(kind) ?? -Infinity) < REPEAT_MS || now < (retryAt.get(kind) ?? 0)) return;
      const message: MailMessage = {
        to,
        subject: `peblish backups: the ${label[kind]} is overdue`,
        text: [
          `The ${label[kind]} to bucket ${bucketName} is overdue.`,
          lastGood
            ? `Last good run: ${lastGood}, ${age(ageMs)} ago.`
            : `Last good run: none recorded (counted from this service's start, ${age(ageMs)} ago).`,
          `Last failure seen by this service: ${lastFailure ?? 'none'}.`,
          '',
          'Look at the backup service log in Easypanel, and run `node tools/cutover/src/cli.ts backup-status` in its console.',
          'deploy/backups.md has the steps. This mail comes at most once a day for each kind while it stays overdue.',
        ].join('\n'),
      };
      inFlight = send(message)
        .then(
          () => {
            mailedAt.set(kind, clock());
            log(`${kind} overdue mail sent`);
          },
          (error: unknown) => {
            retryAt.set(kind, clock() + RETRY_MS);
            log(`${kind} overdue mail not sent (tried again in 15 min): ${describe(error)}`);
          },
        )
        .finally(() => {
          inFlight = null;
        });
    },
    idle: async () => {
      await inFlight;
    },
  };
}
