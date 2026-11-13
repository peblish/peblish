import net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * A loopback SMTP server for tests. It answers a whole conversation, except that while `withhold`
 * is set it keeps back the reply to a message's data and sends an empty line every `trickleMs`
 * instead, so the client's socket never falls silent. `open` counts connections still open.
 */
export async function testSmtpServer(trickleMs = 100) {
  const sockets = new Set<net.Socket>();
  const state = { withhold: false, received: [] as string[], url: '', open: 0, close: async () => {} };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    state.open++;
    let timer: NodeJS.Timeout | undefined;
    socket.on('close', () => {
      clearInterval(timer);
      sockets.delete(socket);
      state.open--;
    });
    socket.on('error', () => undefined);
    let buffer = '';
    let data: string[] | null = null;
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line !== '.') {
            data.push(line);
            continue;
          }
          state.received.push(data.join('\n'));
          data = null;
          if (state.withhold) timer = setInterval(() => socket.write('\r\n'), trickleMs);
          else socket.write('250 queued\r\n');
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'DATA') {
          data = [];
          socket.write('354 go on\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  state.url = `smtp://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  };
  return state;
}
