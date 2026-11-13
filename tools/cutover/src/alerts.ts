import { sendMail, type MailMessage } from '@peblish/core/identity/mail';
import { type } from 'arktype';
import type { Bucket } from './bucket.ts';
import { describe } from './errors.ts';

// Mail to the operator when a backup kind starts failing or goes stale, and once when it works
// again (deploy/backups.md, "Alerts"). Through the web process's own mail path (core's sendMail:
// SMTP_URL, MAIL_FROM), to BACKUP_ALERT_TO. One mail per change of state, not per retry: the
// state lives in status/<kind>.alert.json in the bucket, so a restart neither repeats a mail nor
// loses a recovery. A mail names the kind, since when, and where to look; never an error's text,
// a URL or a credential.

export type Kind = 'backup' | 'ledger';
export type Problem = 'failing' | 'stale';

const AlertState = type({ state: "'failing' | 'stale' | 'ok'", since: 'string.date.iso', 'mailedAt?': 'string.date.iso' });
type AlertState = typeof AlertState.infer;

export type Alerter = {
  /** A run failed, or the last good run is too old; mails once per episode. */
  problem(kind: Kind, problem: Problem, since: Date, lastGood: string | null): Promise<void>;
  /** A good run after a mailed problem: mails once. */
  recovered(kind: Kind, object: string, at: Date): Promise<void>;
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
): Alerter {
  const known = new Map<Kind, AlertState | null>();

  async function state(kind: Kind): Promise<AlertState | null> {
    if (!known.has(kind)) {
      const text = await bucket.getSmall(alertKey(kind)).catch(() => null);
      let parsed: unknown = null;
      try {
        parsed = text === null ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      const checked = AlertState(parsed);
      known.set(kind, checked instanceof type.errors ? null : checked);
    }
    return known.get(kind) ?? null;
  }

  async function mail(kind: Kind, message: MailMessage, next: AlertState): Promise<void> {
    try {
      await send(message);
    } catch (error) {
      log(`${kind} alert mail not sent: ${describe(error)}`);
      return; // tried again at the next problem or recovery
    }
    known.set(kind, next);
    await bucket.putSmall(alertKey(kind), `${JSON.stringify(next)}\n`, 'application/json').catch((error: unknown) => {
      log(`${kind} alert state not saved: ${describe(error)}`);
    });
    log(`${kind} alert mail sent (${next.state})`);
  }

  const where =
    'Look at the backup service log in Easypanel, and run `node tools/cutover/src/cli.ts backup-status` in its console. ' +
    'deploy/backups.md has the steps.';

  return {
    async problem(kind, problem, since, lastGood) {
      const current = await state(kind);
      if (current && current.state !== 'ok') return;
      const what = problem === 'failing' ? 'is failing' : 'has not succeeded in time';
      await mail(
        kind,
        {
          to,
          subject: `peblish backups: the ${label[kind]} ${what}`,
          text: [
            `The ${label[kind]} to bucket ${bucketName} ${what}, since ${since.toISOString()}.`,
            `Last good run: ${lastGood ?? 'none recorded'}.`,
            '',
            where,
            'You get one more mail when it works again.',
          ].join('\n'),
        },
        { state: problem, since: since.toISOString(), mailedAt: new Date().toISOString() },
      );
    },
    async recovered(kind, object, at) {
      const current = await state(kind);
      if (!current || current.state === 'ok') return;
      await mail(
        kind,
        {
          to,
          subject: `peblish backups: the ${label[kind]} works again`,
          text: [
            `The ${label[kind]} to bucket ${bucketName} works again: ${object} at ${at.toISOString()}.`,
            `It had been ${current.state === 'failing' ? 'failing' : 'stale'} since ${current.since}.`,
            '',
            where,
          ].join('\n'),
        },
        { state: 'ok', since: at.toISOString(), mailedAt: new Date().toISOString() },
      );
    },
  };
}
