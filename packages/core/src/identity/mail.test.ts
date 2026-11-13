import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { SMTP_SEND_LIMIT_MS, SMTP_TIMEOUTS, smtpTransport } from './mail.ts';
import { testSmtpServer } from './smtp-test-server.ts';

// The SMTP transport has finite timeouts, so a send to a mail server that stops answering ends
// with an error instead of holding its caller (a web request, the backup service's one alert send).

let server: net.Server;
let port = 0;
const sockets = new Set<net.Socket>();
beforeAll(async () => {
  // Accepts the connection and never says anything: no greeting, no answers.
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => server.close(done));
});

test('the timeouts are finite and short', () => {
  expect(SMTP_TIMEOUTS).toEqual({ dnsTimeout: 10_000, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  expect(SMTP_SEND_LIMIT_MS).toBe(120_000);
});

test('a server that trickles empty lines instead of its last reply is cut off at the send limit, its connection closed', async () => {
  const smtp = await testSmtpServer(100);
  try {
    smtp.withhold = true;
    // The socket is never silent for 300 ms, so only the elapsed limit can end this send.
    const transport = smtpTransport(smtp.url, { ...SMTP_TIMEOUTS, socketTimeout: 300 }, 1_000);
    const started = Date.now();
    await expect(transport.send({ from: 'a@example.test', to: 'b@example.test', subject: 's', text: 't' })).rejects.toThrow(
      'the SMTP send took more than 1 s and was cut off',
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(smtp.received).toHaveLength(1); // it got as far as the data
    for (let i = 0; i < 20 && smtp.open > 0; i++) await new Promise((done) => setTimeout(done, 50));
    expect(smtp.open).toBe(0);
  } finally {
    await smtp.close();
  }
});

test('a send that is answered is not held by the limit', async () => {
  const smtp = await testSmtpServer();
  try {
    await smtpTransport(smtp.url, SMTP_TIMEOUTS, 1_000).send({ from: 'a@example.test', to: 'b@example.test', subject: 's', text: 't' });
    expect(smtp.received).toHaveLength(1);
  } finally {
    await smtp.close();
  }
});

test('a server that never greets fails the send within the greeting timeout', async () => {
  const transport = smtpTransport(`smtp://127.0.0.1:${port}`, { ...SMTP_TIMEOUTS, greetingTimeout: 300, connectionTimeout: 300 });
  const started = Date.now();
  await expect(transport.send({ from: 'a@example.test', to: 'b@example.test', subject: 's', text: 't' })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(3_000);
});
