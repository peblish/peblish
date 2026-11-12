import { expect, test, vi } from 'vitest';
import { betterAuthLog } from './auth.ts';

const marker = 'MARKER-typed@example.test';

test("Better Auth's log calls come out as one line, a mail failure without the address and a refused origin without the origin", () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const refusal = Object.assign(new Error("Can't send mail - all recipients were rejected"), {
      code: 'EENVELOPE',
      responseCode: 550,
      command: 'RCPT TO',
    });
    refusal.message += `: 550 5.1.1 <${marker}>: Recipient address rejected`;
    betterAuthLog('error', 'Failed to run background task:', refusal);
    betterAuthLog('error', `Invalid origin: https://${marker}`);
    betterAuthLog('warn', 'User not found');
    const lines = [...error.mock.calls, ...warn.mock.calls].map((call) => {
      expect(call).toHaveLength(1);
      return String(call[0]);
    });
    for (const line of lines) {
      expect(line).not.toContain(marker);
      expect(line).not.toMatch(/[\r\n]/);
    }
    expect(lines[0]).toMatch(/ ERROR \[Better Auth\]: Failed to run background task: Error EENVELOPE 550 RCPT TO( at \S+)?$/);
    expect(lines[1]).toMatch(/ ERROR \[Better Auth\]: Invalid origin$/);
    expect(lines[2]).toMatch(/ WARN \[Better Auth\]: User not found$/);
  } finally {
    vi.restoreAllMocks();
  }
});
