import { PUBLIC_BODY_MS } from './timing.ts';

// The body of a public proxy answer, under a deadline (timing.ts). The server pulls a chunk only
// after the previous one was written to the socket (srvx waits for write() or 'drain'), and the
// stream closes only on the pull after the last chunk, so "closed" means every byte was handed
// to the socket. If that has not happened by `deadline`, the stream errors and the server
// destroys the socket, so the answer ends short of its content-length on that connection. This
// bounds the application's own stream only: what a proxy in front has already taken, it may still
// deliver later (timing.ts). Private answers are plain bodies and never cut off.

const CHUNK = 64 * 1024;

export class PublicBodyLate extends Error {
  override name = 'PublicBodyLate';
}

/**
 * `bytes` as a stream that errors unless fully handed over by `deadline` (performance.now()
 * milliseconds; by default the read's start plus PUBLIC_BODY_MS). `onLate` runs once when the
 * deadline cuts the body off, not when the reader cancels. `clock` is for tests.
 */
export function deadlineBody(
  bytes: Uint8Array,
  deadline: number,
  { clock = () => performance.now(), chunk = CHUNK, onLate }: { clock?: () => number; chunk?: number; onLate?: () => void } = {},
): ReadableStream<Uint8Array> {
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A late pull clears the timer, and an errored stream is not pulled again, so this runs at most once.
  const cutOff = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.error(new PublicBodyLate(`the public answer was not handed over within ${PUBLIC_BODY_MS} ms of its decision`));
    onLate?.();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        timer = setTimeout(() => cutOff(controller), Math.max(0, deadline - clock()));
        timer.unref?.();
      },
      pull(controller) {
        if (clock() > deadline) {
          clearTimeout(timer);
          cutOff(controller);
          return;
        }
        if (offset >= bytes.byteLength) {
          clearTimeout(timer);
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + chunk));
        offset += chunk;
      },
      cancel() {
        clearTimeout(timer);
      },
    },
    { highWaterMark: 0 },
  );
}
