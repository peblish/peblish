import { expect, test } from 'vitest';
import { clientWentAway, withClientAborts } from './client-gone.ts';

/** Node's own error when a connection closes before the reply ends (node:_http_server abortIncoming). */
const nodeAborted = () => Object.assign(new Error('aborted'), { code: 'ECONNRESET' });

function requestAbortedWith(reason?: unknown) {
  const controller = new AbortController();
  controller.abort(reason);
  return new Request('https://feddit.test/_serverFn/x', { signal: controller.signal });
}
const live = () => new Request('https://feddit.test/_serverFn/x');

test("a client that left: the signal's own reason, Node's aborted error, or a bare AbortError", () => {
  const reason = nodeAborted();
  expect(clientWentAway(requestAbortedWith(reason), reason)).toBe(true);
  const bare = requestAbortedWith();
  expect(clientWentAway(bare, bare.signal.reason)).toBe(true);
  expect(clientWentAway(requestAbortedWith(nodeAborted()), nodeAborted())).toBe(true);
  expect(clientWentAway(requestAbortedWith(), new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
});

test('anything else is a real failure, even after the client left', () => {
  const gone = () => requestAbortedWith(nodeAborted());
  expect(clientWentAway(gone(), new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(false);
  expect(clientWentAway(gone(), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(false);
  expect(clientWentAway(gone(), new DOMException('The operation timed out.', 'TimeoutError'))).toBe(false);
  expect(clientWentAway(gone(), 'aborted')).toBe(false);
});

test('an abort while the client is still there came from the server itself', () => {
  expect(clientWentAway(live(), new DOMException('This operation was aborted', 'AbortError'))).toBe(false);
  expect(clientWentAway(live(), nodeAborted())).toBe(false);
});

test('the wrapper answers a client that left and rethrows every other error', async () => {
  const reason = nodeAborted();
  const answered = await withClientAborts(() => Promise.reject(reason))(requestAbortedWith(reason));
  expect(answered.status).toBe(499);
  const failure = new Error('database is down');
  await expect(withClientAborts(() => Promise.reject(failure))(requestAbortedWith(nodeAborted()))).rejects.toBe(failure);
  await expect(withClientAborts(() => Promise.reject(nodeAborted()))(live())).rejects.toThrow('aborted');
  const ok = new Response('fine');
  expect(await withClientAborts(() => ok)(live())).toBe(ok);
});
