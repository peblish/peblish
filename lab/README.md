# Federation lab

This Docker Compose lab runs Lemmy 0.19.21, PieFed 1.8.11, the Feddit Fedify spike and a rogue test peer. Results and captures live in `spikes/fedify-threadiverse/`.

It is local only:

- Every service sits on one network, `lab`, which Docker marks `internal`, so no container has a route out of the lab. This includes Caddy.
- Every hostname is under `.lab.test`.
- Allowlists on Lemmy and PieFed name only the lab hosts.

The one exception is opt-in. `make ports` starts `host-ports`, a 20-line TCP forwarder (`forward.mjs`), on a second, ordinary network so Docker can publish 127.0.0.1 ports. Docker publishes no ports from internal networks. The forwarder only ever connects to Caddy. While it runs, it is the only container that has a route out; `make down` and `make reset` remove it.

Mbin and Lemmy 1.0 beta can be added later as more peers.

## Quick start

```sh
cd lab
make check        # the whole clean sequence below, from an empty lab
# or step by step:
make reset        # delete everything, including the lab CA
make up           # build Feddit (and PieFed v1.8.11 from Codeberg once), start everything
make seed         # admins, users and test communities on all three peers
make scenarios    # interop: S1-S9, S8b, R1-R6
make moderation   # moderation S10-S14, M0-M4, P0-P5, then the refusals N0-N15
make collision    # name collision C0-C3 and the instance actor I1
make durability   # delivery policy D3-D7, then SIGKILL of Feddit and recovery D1-D2
make captures     # the peers' own logs and instance records into captures/
make ports        # optional: host access on 127.0.0.1
```

Other targets:

| Target | Effect |
|---|---|
| `make ps` | List the lab containers |
| `make logs SERVICE=lemmy` | Follow one service's log |
| `make restart-feddit` | Restart the Feddit app; `src/` is mounted, so edits apply without a rebuild |
| `make typecheck` | Run `tsc --noEmit` in the runner container |
| `make stats` | Show memory per container |

`PEERS="lemmy"` or `PEERS="piefed"` limits `scenarios`, `moderation` and `collision` to one peer.

Scenario results can be:

- `pass`
- `fail`
- `n/a`: the peer cannot perform the action at all.
- `known`: the scenario failed exactly as a documented peer defect predicts. `known` results do not fail the run, and a scenario turns to `pass` once the peer is fixed.

## Services and ports

The Compose project is `feddit-lab`. Inside the lab, every service reaches the others at `https://<name>.lab.test` through Caddy's network aliases.

| Service | Image | Role |
|---|---|---|
| caddy | caddy:2.10-alpine | TLS for every host (`tls internal`), routing Lemmy between lemmy-ui and the backend |
| lab-ca | caddy:2.10-alpine | One-shot: copies Caddy's root certificate into a world-readable volume |
| lemmy, lemmy-ui | dessalines/lemmy:0.19.21, lemmy-ui:0.19.21 | Lemmy peer |
| lemmy-db, lemmy-pictrs | postgres:16-alpine, asonix/pictrs:0.5.16 | Lemmy storage (image proxying off) |
| piefed-web, piefed-celery | feddit-lab/piefed:1.8.11 (built from the `v1.8.11` tag) | PieFed peer and its task worker |
| piefed-db, piefed-redis | postgres:17, redis:7-alpine | PieFed storage, cache and Celery broker |
| feddit, feddit-db | feddit-lab/feddit-spike:dev (Node 24), postgres:16-alpine | The Fedify spike |
| rogue | feddit-lab/feddit-spike:dev | `rogue.lab.test`, a test double (`scenarios/rogue.ts`). It signs forged activities and serves broken inboxes |
| runner | feddit-lab/feddit-spike:dev | One-shot, `tools` profile: runs the seed and scenario scripts |
| host-ports | feddit-lab/feddit-spike:dev | `host` profile, `make ports` only: forwards host ports to Caddy |

With `make ports`:

| Host port | Serves |
|---|---|
| 18201 | Lemmy over plain HTTP: lemmy-ui, with the API and ActivityPub paths routed to the backend |
| 18202 | PieFed over plain HTTP |
| 18203 | Feddit over plain HTTP, including the `/spike/*` control surface |
| 18243 | HTTPS for every `*.lab.test` name, the same endpoints the peers use |

Logins, all with password `lab-password-1`:

| Peer | Admin | User |
|---|---|---|
| Lemmy | `lemmyadmin` | `lemmyuser` |
| PieFed | `pfadmin` | `pfuser` |

Feddit has no logins. Its actors (`alice`, `bob` and `!spike`) are driven through `/spike/*`.

## Why it is built this way

- **HTTPS everywhere.** Lemmy 0.19 and PieFed build `https://` actor URLs, so each peer needs a certificate the others trust.
  - Caddy's internal CA issues the certificates. `lab-ca` copies only the root certificate into a world-readable volume, because Lemmy cannot read Caddy's 0700 pki directory.
  - Each service trusts that file only: Lemmy through `SSL_CERT_FILE`, PieFed through `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE`, and the Node services through `NODE_EXTRA_CA_CERTS`.
- **Subnet 192.88.99.0/24.** This is the retired 6to4 anycast prefix (RFC 7526).
  - Lemmy and PieFed accept it because Python's `ipaddress` and Rust's `Ipv4Addr` classify it as global. No flag is involved: the subnet was chosen so their production SSRF checks stay on and still pass.
  - Fedify classifies it as non-public. Its guard is all-or-nothing, so the Feddit container sets `FEDDIT_ALLOW_PRIVATE_ADDRESS=1` for Fedify's own fetches.
  - Feddit's deliveries go through its own guard (`src/safe-post.ts`). It allows public space plus only `FEDDIT_LAB_CIDR=192.88.99.0/24`, so loopback and RFC 1918 inboxes stay refused even in the lab.
- **`LEMMY_TEST_FAST_FEDERATION=1`.** Shortens the recheck loop of Lemmy's outbound workers to about 1 s. It changes timing only, not the wire format.
- **Short outbox retries.** `FEDDIT_OUTBOX_MAX_ATTEMPTS=4`, `FEDDIT_OUTBOX_BASE_DELAY_MS=1000` and `FEDDIT_OUTBOX_LEASE_MS=20000` make the retry and crash scenarios finish in seconds. The defaults are 10 attempts over about 11 hours with a 60 s lease.
- **PieFed entrypoint (`piefed/entrypoint.sh`).** A copy of upstream's entrypoint without `flask populate_community_search`, which downloads from data.lemmyverse.net and crash-loops without egress.
- **PieFed Celery health check.** The PieFed image's HEALTHCHECK curls the web server on :5000, which the Celery container does not run, so it always reported unhealthy. Compose overrides it with the `celery inspect ping` that upstream's own compose.yaml uses.
- **PieFed image built once.** `make up` builds PieFed from Codeberg only when `feddit-lab/piefed:1.8.11` is missing, so a Codeberg outage does not block the lab.
- **PieFed bootstrap (`piefed/bootstrap.py`).** Does what the setup wizard would do:
  - initialises the site
  - opens registration
  - turns on downvotes and ActivityPub JSON logging
  - turns on allowlist mode with `piefed.lab.test`, `lemmy.lab.test` and `feddit.lab.test`
  - creates the two accounts
  
  PieFed's own domain must be on its allowlist, because `validate_remote_actor` checks it too. The rogue host is on neither peer's allowlist, on purpose.
- **Waiting in `make seed`.** Lemmy release builds start the outbound worker for a newly seen instance on a 60 s timer, and that worker skips everything queued before it started. `make seed` waits for both lab peers' workers, so the first Follow is not lost. This is a live-peer risk; see RESULT.md.
- **Backdating in `make scenarios` and `make moderation`.** These first age PieFed's remote accounts by two days. PieFed lets an account it first saw less than 24 h ago make only 4 posts, which repeated lab runs would hit. This is also a live-peer risk.

## Talking to the lab from the host

Run `make ports` first. `make seed` writes the lab CA to `lab/data/lab-ca.crt`; `lab/data/` is git-ignored. Use `--resolve` so the real hostnames and certificates work:

```sh
curl --cacert lab/data/lab-ca.crt --resolve feddit.lab.test:18243:127.0.0.1 \
  -H 'accept: application/activity+json' https://feddit.lab.test:18243/ap/c.spike
curl --cacert lab/data/lab-ca.crt --resolve lemmy.lab.test:18243:127.0.0.1 \
  https://lemmy.lab.test:18243/api/v3/site
```

Or browse <http://localhost:18201> (Lemmy) and <http://localhost:18202> (PieFed). Links inside the UIs point at the `.lab.test` names, which the host does not resolve.

Without `make ports`, use the containers directly. For example:

```sh
docker compose run --rm runner node scenarios/get.ts https://feddit.lab.test/ap/c.spike
```

## Captures

Feddit and the scenario runner write to `spikes/fedify-threadiverse/captures/` through a bind mount. On Docker Desktop, do not move or rename files in that directory while the lab runs. Its file-sharing cache can keep writing to the old location. Stop the lab (`make down`) first.

## Ports this lab must not use

The host already uses 5000, 5432, 8080, 6006, 6007, 4321, 4322, 3773 and 7000. The lab publishes nothing by default. With `make ports` it publishes 18201, 18202, 18203 and 18243, all on 127.0.0.1.
