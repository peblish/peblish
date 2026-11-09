// Host access for the lab (the `host-ports` service, `make ports`): forwards
// TCP from the published ports to Caddy on the internal lab network. It opens
// no other connection, so the lab gets no route out through it.
import net from "node:net";

const ROUTES = { 8443: 443, 8201: 8201, 8202: 8202, 8204: 8204, 8322: 8322 };

for (const [listen, target] of Object.entries(ROUTES)) {
  net
    .createServer((client) => {
      const upstream = net.connect(target, "caddy");
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
      client.pipe(upstream).pipe(client);
    })
    .listen(Number(listen), "0.0.0.0");
}
console.log("forwarding", ROUTES);
