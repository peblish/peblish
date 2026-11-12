import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { asLine, lineWritesUntilServerBuilt } from './shutdown-report.ts';

test("srvx's countdown and its end are each one whole line", () => {
  const gray = (text: string) => `\u001b[90m${text}\u001b[39m`;
  expect(asLine(gray('\rStopping server gracefully (5s)... Press \u001b[1mCtrl+C\u001b[22m again to force close.'))).toBe(
    'Stopping server gracefully (5s)... Press Ctrl+C again to force close.\n',
  );
  expect(asLine('\u001b[2K\rServer closed successfully.\n')).toBe('Server closed successfully.\n');
});

test('only a write bound in the same synchronous step keeps the line writer; the stream gets its own back', async () => {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  const own = stream.write;
  lineWritesUntilServerBuilt(stream);
  const reporter = stream.write.bind(stream);
  await Promise.resolve();
  expect(stream.write).toBe(own);
  let written = '';
  stream.on('data', (chunk) => (written += chunk));
  reporter('\rStopping (1s)...');
  stream.write('raw\r');
  expect(written).toBe('Stopping (1s)...\nraw\r');
});
