# Federation lab

A local Docker Compose lab that runs the production peblish image (the root `Dockerfile`, no lab
switch) against Lemmy 0.19.21, PieFed 1.8.11 and Mbin 1.11, plus a rogue peer that signs forged
activities. `tools/interop` drives it; `INTEROP.md` at the repository root has the topology, the
scenario table, the latest results and the known peer defects.

It is local only:

- Every service sits on one network, `lab`, which Docker marks `internal`: no container has a route
  out, and that includes Caddy and peblish.
- Every hostname is under `.lab.test`. The network is `44.255.99.0/24` (public address space, so
  peblish's public-address check passes without an overlay); nothing is ever routed there.
- Allowlists on Lemmy, PieFed and Mbin name only the lab hosts.

The one exception is opt-in. `make ports` starts `host-ports`, a small TCP forwarder
(`forward.mjs`), on a second, ordinary network so Docker can publish 127.0.0.1 ports. Docker
publishes no ports from internal networks. While it runs it is the only container with a route
out; `make down` and `make reset` remove it.

The lab is a Docker singleton: compose project `feddit-lab`, fixed names and volumes. `make up`
refuses to start while the project runs from another worktree.

## Quick start

```sh
cd lab
make check        # reset, up, seed, interop, interop-d1, cleanup (about 20 minutes)
# or step by step:
make reset        # delete everything, including volumes, the lab CA and data/results
make up           # build peblish (and PieFed once), start everything, wait until healthy
make seed         # peers' admins, users and communities; peblish's accounts and !lab
make interop      # the fast tier; PEERS="lemmy" and ONLY=Z1,P1 narrow it
make interop-d1   # D1, the delivery schedule, around a SIGKILL of the worker
make cleanup      # put the lab back from the ledger
make interop-slow # F3, the Follow resend at 5 and 15 minutes (about 17 minutes)
make down         # stop the containers; images stay
```

Other targets: `make ps`, `make logs SERVICE=peblish-worker`, `make stats`, `make ports`.

Results land in `data/results/` (git-ignored): `interop.json` for the fast tier, one
`group-*.json` per scenario group, and `ledger.jsonl`, the cleanup ledger.

A scenario result is one of:

- `pass`
- `fail`
- `n/a`: the peer cannot do the action at all.
- `known`: it failed exactly as a documented peer or product defect predicts (the exact signature is in
  the code). A `known` scenario that starts to pass is reported as such, so its entry gets removed.
- `pending(<lane>)`: it waits for a lane that has not merged (no scenario is pending since FX-INTEROP).

## Services

Inside the lab every service reaches the others at `https://<name>.lab.test` through Caddy's
network aliases (`lemmy`, `piefed`, `mbin`, `peblish`, `rogue`).

| Service | Image | Role |
|---|---|---|
| caddy, lab-ca | caddy:2.10-alpine | TLS for every host (`tls internal`); lab-ca copies the root certificate into a volume |
| peblish-migrate, -web, -worker, -db | `peblish:lab` (the root Dockerfile), postgres:17.11 | peblish; only the worker delivers |
| lemmy, lemmy-ui, lemmy-db, lemmy-pictrs | dessalines/lemmy:0.19.21 and friends | Lemmy peer |
| piefed-web, piefed-celery, piefed-db, piefed-redis | feddit-lab/piefed:1.8.11 (built once from the tag) | PieFed peer |
| mbin-php, mbin-messenger, mbin-db, mbin-valkey, mbin-rabbitmq | ghcr.io/mbinorg/mbin:v1.11.0 | Mbin peer (FrankenPHP, queue worker) |
| rogue | feddit-lab/interop:dev | `rogue.lab.test`: signs forged activities, serves misbehaving inboxes, poses as Mastodon in NodeInfo |
| runner | feddit-lab/interop:dev | `tools` profile: runs `tools/interop` on the lab network |
| host-ports | node:24.21.0-bookworm-slim | `host` profile: forwards 127.0.0.1 ports to Caddy |

With `make ports`: 18243 serves every `*.lab.test` name over HTTPS, 18201 Lemmy, 18202 PieFed,
18204 Mbin and 18322 peblish, over plain HTTP.

Logins use the password `lab-password-1`: Lemmy `lemmyadmin` and `lemmyuser`, PieFed `pfadmin` and
`pfuser`, Mbin `mbinadmin` and `mbinuser` (bot users behind OAuth clients, see `INTEROP.md`), peblish
`labadmin` (admin, with two-factor seeded), `alice` and `bob`.

## Files

| Path | What |
|---|---|
| `compose.yaml` | Every service, the network and the volumes |
| `Makefile` | The targets above |
| `caddy/Caddyfile` | Hosts, TLS and routing |
| `lemmy/`, `piefed/`, `mbin/` | Per-peer configuration, bootstrap and seed scripts |
| `runner.Dockerfile` | The image for `tools/interop` and the rogue |
| `forward.mjs` | The `host-ports` forwarder |
