/**
 * srvx's graceful shutdown (on SIGTERM it stops accepting, lets in-flight requests finish for up to
 * SERVER_SHUTDOWN_TIMEOUT seconds, then forces the rest) reports its progress for a terminal: a
 * countdown rewritten in place with \r and an erase-line escape, with no newline, so in a log it
 * runs into one line. srvx 1.0.8 has no switch for that report alone (`silent` also mutes its
 * start-up line and its response errors, and turning `gracefulShutdown` off loses the draining).
 *
 * Its reporter takes `process.stderr.write.bind(process.stderr)` once, while the server is built,
 * which Nitro's node-server entry does right after its plugins run, in the same synchronous step.
 * So a plugin calls this: stderr's write is a line writer for that step only, and the stream has
 * its own write back in the next microtask, before any request or other output. The reporter keeps
 * the line writer; nothing else ever sees it.
 */
export function lineWritesUntilServerBuilt(stream: NodeJS.WriteStream = process.stderr): void {
  const write = stream.write;
  stream.write = ((chunk: string | Uint8Array, ...rest: never[]) => write.call(stream, asLine(chunk), ...rest)) as typeof write;
  queueMicrotask(() => {
    stream.write = write;
  });
}

/** A terminal write as one whole line: no carriage return, no escape sequence, ending in a newline. */
export function asLine(chunk: string | Uint8Array): string {
  const text = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()).replace(/\u001b\[[0-9;]*[A-Za-z]|\r/g, '');
  return text.endsWith('\n') ? text : `${text}\n`;
}
