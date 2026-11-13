import { createTransport } from 'nodemailer';

// Outgoing mail (verification and reset links). Two transports: SMTP from SMTP_URL (Mailpit
// in development, smtp://127.0.0.1:18425) and a recording one for tests. Never send from
// inside a write transaction: better-auth calls these after its own writes.

export type MailMessage = { to: string; subject: string; text: string };

export interface MailTransport {
  send(message: MailMessage & { from: string }): Promise<void>;
}

/** Keeps every message it is given, newest last. */
export function recordingTransport(): MailTransport & { sent: (MailMessage & { from: string })[] } {
  const sent: (MailMessage & { from: string })[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

/**
 * Finite SMTP timeouts (nodemailer's defaults are 2 minutes to connect and 10 minutes of
 * silence), so a mail server that stops answering fails the send instead of holding its caller.
 * nodemailer counts the DNS lookup and the greeting inside the connection's 10 seconds; after
 * that each answer has 20.
 */
export const SMTP_TIMEOUTS = { dnsTimeout: 10_000, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

export function smtpTransport(url: string, timeouts: typeof SMTP_TIMEOUTS = SMTP_TIMEOUTS): MailTransport {
  const transport = createTransport({ url, ...timeouts });
  return {
    async send(message) {
      await transport.sendMail(message);
    },
  };
}

declare global {
  // One per process, on globalThis like the pools (the web build carries two module copies).
  var peblishMail: MailTransport | undefined;
}

/** Replaces the transport (tests); pass undefined to go back to SMTP_URL. */
export function useMailTransport(transport: MailTransport | undefined): void {
  globalThis.peblishMail = transport;
}

function transport(): MailTransport {
  if (globalThis.peblishMail) return globalThis.peblishMail;
  const url = process.env.SMTP_URL;
  if (!url) throw new Error('mail is not configured: set SMTP_URL (smtp://host:port, or smtps://user:pass@host)');
  return (globalThis.peblishMail = smtpTransport(url));
}

/** Sends `message` from MAIL_FROM, or from no-reply at the instance host. */
export async function sendMail(message: MailMessage, host: string): Promise<void> {
  await transport().send({ ...message, from: process.env.MAIL_FROM ?? `${host} <no-reply@${host}>` });
}
