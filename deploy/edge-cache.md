# Edge cache for public remote images

Cloudflare may hold the proxy's answers for public remote images (`/media/proxy/*`), so a popular
post's thumbnail is fetched from its remote host about once an hour per Cloudflare cache instead of
once per viewer. Nothing here has been applied to the zone: these are the steps for the operator.
The application side is `packages/core/src/edge/` and `packages/core/src/media/README.md`.

What the origin sends:

| Answer                                                                                                        | `Cache-Control`                      | Held by Cloudflare          |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------- |
| A GET for an image public when fetched (below), while the purge path is ready (section 1)                     | `public, max-age=600, s-maxage=3600` | up to 1 hour, purged by tag |
| Any other image (sensitive, removed or moderator-only content, a draft preview, a HEAD, purge path not ready) | `private, max-age=600`               | never                       |
| A refusal or an error (404, 403, 413, 415, 502, 503, 504), and any image whose hash is on the blocked list    | `no-store`                           | never                       |

"Public when fetched": once the bytes are in hand, one consistent database read finds the content
shown to a signed-out visitor, its community live, its supplier and every host it came through
allowed, the hash not listed and the remote-media switch on, and that read finished within 2 s.
An answer whose tags would be more than 64, or longer than 4 KB in all, is `private` (an image
reached through a very long chain of hosts, say), so Cloudflare never truncates the list it
purges by.

A public answer also carries `Cache-Tag` (Cloudflare strips it before the browser sees it), a
`Content-Length`, and no `Set-Cookie`. The application must hand its body to its own connection
within 10 s of the start of that read: if that connection is not taking it by then, the
application destroys it. This bounds the application's own stream only. Traefik, or any proxy in
front, may already hold a small body whole and pass it to Cloudflare later.
Without both variables below, or while the purge path is not ready, every image answer is
`private`, as before.

## 1. The purge token

Create an API token (My Profile, API Tokens, Create Token, Custom token):

- Permissions: **Zone, Cache Purge, Purge**. Nothing else.
- Zone resources: **Include, Specific zone, feddit.com**. Not all zones.
- No IP filtering is needed; set a TTL only if you will rotate it.

Check it from your own machine (prints `active` for a working token; this proves the token
exists, not that it may purge the zone, which the worker proves itself):

```sh
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $CLOUDFLARE_PURGE_TOKEN" | jq -r .result.status
```

Set both variables on **web and worker**:

| Variable                 | Value                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| `CLOUDFLARE_ZONE_ID`     | the zone id, 32 hexadecimal characters (the zone's Overview, API box) |
| `CLOUDFLARE_PURGE_TOKEN` | the token above                                                       |

A half-set or malformed pair keeps edge caching off and logs `edge cache: <names> missing or
malformed; edge caching stays off` once per process (names only, never values).

The purge path is ready, and web answers public, only while all of these hold, read in the same
database snapshot as the decision itself and by the database's clock:

1. The database holds a record, under 5 minutes old and for the zone web is configured with, of a
   Cloudflare request that succeeded with the worker's token (a purge or, with nothing to purge,
   a purge of the unused tag `pbm-check` at most every 2 minutes).
2. No purge has been owed for more than 2 minutes. After a restore (deploy/cutover.md, the
   drill's ledger replay) a purge of everything is owed as late from the start, so web stays
   private until the worker has sent it.
3. The takedown consumer keeps up: its cursor exists and no outbox event older than 30 s lies
   beyond it. A consumer that fails on an event, a worker that is stopped, or an old open
   transaction holding the outbox back turns answers private within about 30 s.

A worker that is stopped, lacks the variables or holds a refused token therefore turns public
answers private within 5 minutes (30 s once a takedown waits for it), and a refused token at
once. A zone id changed on web but not yet on the worker, or the other way, is private until both
agree.

## 2. The cache rule

Before adding it, read feddit.com's own cache settings in the dashboard and record each one. A
purge-only token cannot read them, and the real-edge proof (section 3) ran on another zone, so
nothing has checked them on feddit.com:

- Always Online (Caching, Configuration): **off**. It can answer from a saved copy while the
  origin is down, past the hour.
- Cache Reserve (Caching): **off**. The proof did not cover a persistent cache tier.
- Serve stale content, in this rule and in any other rule or Page Rule that matches
  `/media/proxy/`: **none**.
- Edge TTL overrides: **none** but this rule's. No Page Rule (Cache Level, Edge Cache TTL) or other
  cache rule may match `/media/proxy/`.
- Tiered Cache (Caching, Tiered Cache): on or off; record which. A purge reaches every tier, and
  each tier keeps an answer only for its `s-maxage`.
- HTTP/2 to origin (Speed or Network): on or off; record which. It changes only the hop from
  Cloudflare to Traefik; the body deadline was proven on HTTP/1.1 between Traefik and web.

Any of the first four that is not as listed can keep a taken-down image, or one whose purge
failed, past its hour: fix it before the rule goes on.

Caching, Cache Rules, Create rule. One rule, matching the proxy path only:

- Rule name: `Public remote images (media proxy)`
- Custom filter expression:

  ```
  (http.host eq "feddit.com" and starts_with(http.request.uri.path, "/media/proxy/"))
  ```

- Cache eligibility: **Eligible for cache**
- Edge TTL: **Use cache-control header if present, bypass cache if not**
- Browser TTL: **Respect origin**
- Leave the cache key, Serve stale content and the rest at their defaults.

The same rule through the API, for the record (`edge_ttl` keeps the origin's `s-maxage`; Origin
Cache Control is always on below Enterprise, so `private` and `no-store` are never cached):

```json
{
  "description": "Public remote images (media proxy)",
  "expression": "(http.host eq \"feddit.com\" and starts_with(http.request.uri.path, \"/media/proxy/\"))",
  "action": "set_cache_settings",
  "action_parameters": {
    "cache": true,
    "edge_ttl": { "mode": "bypass_by_default" },
    "browser_ttl": { "mode": "respect_origin" }
  }
}
```

No other path gets a cache rule: not `/u`, `/c`, `/post` or any page.

## 3. Prove it on a test hostname

Run these on a proxied test hostname whose requests take the same chain as production
(Cloudflare, then Traefik, then web), with this build, the cache rule of section 2 extended to the
test host, and both variables set on web and worker. Nothing here touches production. Keep a log:
for every step, the time, the command, the `cf-ray` (its suffix is the Cloudflare location) and
the `cf-cache-status` of each answer.

This checklist ran on 2026-11-13 on a Cloudflare free plan, on a test hostname of another zone
than feddit.com, through the same server's Traefik. It established that the free plan honours
`Cache-Tag` and purge by tag, that purges took effect within about 1 s at both locations tested,
and that an image expired at its hour with the origin failing and was not served stale. What it
measured is in steps (b), (g) 5 and (i) and in section 5; feddit.com's own settings still need
reading (section 2).

Throughout:

```sh
host='https://<test host>'
url="$host/media/proxy/<signature>/<target>"   # a public post's image, from the page source
status() { curl -s -o /dev/null -D - "$1" | grep -i -E '^(cf-cache-status|cf-ray|cache-control|age|set-cookie|content-length):'; }
purge() { curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_PURGE_TOKEN" -H 'content-type: application/json' \
  -d "{\"tags\":[\"$1\"]}" | jq -c '{success, errors}'; }
```

Use GET for every check, not `curl -I`: the origin answers a HEAD `private`, but Cloudflare may
answer a HEAD from a cached GET, or fill a miss with a GET and answer the HEAD from it. That is an
ordinary public GET answer, decided, tagged and purged like any other, so no rule is added for it.

**(a) Record the chain's settings.** Before anything else, write down Traefik's effective
settings for the test router and service: response buffering (the `buffering` middleware and its
`maxResponseBodyBytes`, `memResponseBodyBytes`), compression (the `compress` middleware and its
minimum size and types), retries (the `retry` middleware), and the entry point's and transport's
timeouts (`respondingTimeouts`, `forwardingTimeouts`, idle timeouts). From Cloudflare, record the
plan's origin read timeout (100 s below Enterprise unless changed) and whether HTTP/2 to origin is
on. Every later result is read against these.

**(b) A delay between the proxy and the edge (the accepted residual, made visible).** Use a small
tagged response that the origin completes at once: a public image of a few kilobytes, so Traefik
takes it whole. Then hold the connection between Traefik and Cloudflare while Cloudflare fills:

1. Complete silence: start `curl "$url"` on a cold key, and within a second stop Traefik's
   egress to Cloudflare (pause the test Traefik process, or drop its outbound packets with a
   firewall rule on the test host). Purge the image's content tag at once, purge it again 150 s
   later (as the worker's repeat does), then release the hold. GET the URL repeatedly for ten
   minutes.
2. A trickle: the same, but limit the test Traefik's egress to a few hundred bytes a second
   (`tc qdisc ... tbf` or `netem rate`) instead of stopping it, so the delivery never falls silent
   long enough for Cloudflare to give up (section 5); release it only after the second purge.

Record for each: whether Cloudflare answered the first client at all (a 524 or a complete image),
how long the delivery took, and whether any later GET is `HIT`. A `HIT` after both purges is the
accepted residual (a fill completing after the second send, served until its hour is up): record
it with its timings and the settings from (a). It does not block the rollout. On 2026-11-13 the
silent delivery ended about 125 s after the decision with nothing stored, and the trickled one
was stored and served after both purges (section 5).

**(c) The body deadline on this build.** Use a public image large enough to fill the socket
buffers (several megabytes, under the proxy's 10 MiB limit), so the application meets
backpressure. Start a GET on a cold key and, within a second, stop the chain from draining (pause
the test Traefik, or hold its socket to web). Check on web's host that within 10 s of the request
the application has destroyed its socket to Traefik (`ss -tn` shows it gone) and web has logged
`edge cache: a public proxy answer was cut off at the 10000 ms body deadline (image <sha256>)`.
Release, then GET repeatedly for ten minutes: never `HIT` for that key. Repeat with each framing
and compression mode the chain has enabled: HTTP/1.1 with `Content-Length`, chunked if Traefik
re-frames, HTTP/2 to origin if on, Traefik's `compress` on and off, and Cloudflare's own
compression. Record any mode in which a later GET is `HIT`.

**(d) Private and `no-store` answers are never stored.** On fresh keys, GET each twice, once
with no cookie and once with a browser's session cookie (`-H 'cookie: ...'`): a signed-in
viewer's sensitive image (`private`), an unbound private image (a draft preview's proxy URL), a
signed-out request for a sensitive post's image (404), a URL with a bad or altered signature
(404), an image whose hash is on the blocked list (404), and an image whose upstream fails (502 or
504). Every answer: `cf-cache-status` `BYPASS`, `DYNAMIC` or `MISS`, never `HIT`, and no public
`cache-control`.

**(e) Narrow against wide invalidation.** Warm four tagged URLs until each is `HIT`: two images of
post A, one of post B, one of a community avatar. `purge pbm-p-<A's post id>`: A's two go (not
`HIT`), B's and the avatar stay `HIT`. Warm A again, then `purge pbm`: all four go. Check from at
least two locations (two machines in different regions; the `cf-ray` suffix shows the location),
and note any location that still answers `HIT`.

**(f) A real takedown, end to end.** Warm a public post's image to `HIT`, then remove the post as
a moderator. In the test database, check in order: the `mod.remove` row in `outbox`; an
`edge_purges` row for `pbm-p-<post id>` with `send` 1, then gone and replaced by `send` 2 due 150 s
later; then nothing. From outside: not `HIT` within about 20 seconds, and still not `HIT`
after the second send. The worker logs nothing for a purge that works.

**(g) Readiness.** Each step from a ready state; after each, check that a fresh public URL answers
`private` (not `public`) and that it returns to `public` once restored.

1. Idle for more than five minutes with nothing taken down: answers stay `public` (the worker's
   idle check of `pbm-check` every two minutes keeps `edge_status.verified_at` fresh).
2. Web's variables removed: `private` at once.
3. Worker's variables removed: `private` within five minutes.
4. Zone mismatch: web given another zone's id: `private` at once.
5. A stopped consumer with a pending event: stop the worker, take a post down: `private` within
   30 seconds. Start the worker: `public` again as soon as its consumer has passed the event,
   which can be a few seconds before that event's purge is sent, since debt due less than two
   minutes ago is allowed (`DEBT_LATE_MS`, rule 2 in section 1). The taken-down post's own images
   answer 404 meanwhile. Then check that the purge is sent (`select * from edge_purges`).
6. A skipped event: on the test database, make the edge consumer skip its next event (set its
   `outbox_cursors` row's `failing_event_id` to that event, `failures` to 10 and
   `first_failure_at` to 31 minutes ago). After the skip: a `pbm` row due at the epoch, `private`
   until it is sent, then `public`.
7. A refused token: swap in a token without Cache Purge on the worker. An idle worker tests the
   token on its own schedule (its idle check, up to about two minutes after the swap, or its next
   purge), so wait for the refusal in the worker's log: from that line on, fresh URLs answer
   `private`. Restore the token: `public` once the next request succeeds, with "works again"
   logged.

**(h) Expiry without purging.** While the path is ready, warm a fresh image and confirm it is
`HIT`; note the time it was cached (its first `MISS`). Then make purging unavailable: swap in a
token without Cache Purge on the worker and wait for the refusal in its log (a fresh image would
now answer `private`, which is why the image is warmed first). Then stop web so the origin is
down. GET the warmed image until an hour after it was cached and for ten minutes more: after the
hour it must not be served (a 52x error, not a stale image). Record the zone's
Tiered Cache, Cache Reserve, Always Online and "serve stale content" settings, and any rule that
overrides the edge TTL, since each can keep an image past its hour.

**(i) The rate limit.** With the worker stopped and nothing else purging on the account, send tag
purges of an unused tag in a quick loop until one is refused. Record the request count, the
status (429), the body and `Retry-After`. Then owe a purge (take a post down) and start the
worker: the debt survives the refusal (`select * from edge_purges`), the worker waits at least
`Retry-After`, or 60 s when Cloudflare names none (the free plan's 429 named none on 2026-11-13),
and it is sent once the bucket refills.

**(j) Propagation per location.** For several purges, note the time the API answered success and
poll the URL from each location every second until it is not `HIT`. Record the delay per
location, the worst case, and any location over 20 seconds.

## 4. What the worker logs, and the state

A purge that works logs nothing. When one does not, the worker logs:

- `edge cache: Cloudflare refused the purge request (http 403 (cloudflare 10000)); proxy images are answered private until it works`: at once and on every attempt (20 s, doubling to 5 minutes). Fix the token's permissions or zone.
- `edge cache: purge request failed <n> times in a row (<why>); the debt stays owed`: at 1, 2, 4, 8 ... failures in a row.
- `edge cache: purge path works again after <n> failed requests`: once it recovers.

The first failure of each run of failures is also an `edge.purge_failed` row in the outbox
(`failures`, `refused`, `why`); later ones only count up in `edge_status`, so a long outage adds
one row, not one every few seconds. For a quick look at the state: `select * from edge_status;`
(`verified_at` is the last proof and `zone_id` the zone it proved; web is public only while it is
under 5 minutes old and the zone matches) and `select tag, send, due_at, claim_token from
edge_purges order by due_at;` (what is owed; `send` 2 is the repeat, due 150 s after the first
succeeded).

Never delete or move the `edge.purge` row of `outbox_cursors` by hand: every takedown event it
skips that way is never turned into a purge, and readiness cannot see it. If it has to be done
(a restore of that table, say), owe a purge of everything in the same transaction, due at once and
already late, so web answers `private` until the worker has sent it:

```sql
insert into edge_purges (tag, send, due_at) values ('pbm', 1, 'epoch')
on conflict (tag, send) where claim_token is null do update set due_at = 'epoch';
```

## 5. Limits

The free plan allows tag purges at 5 requests a minute per account (bursts of 25), 100 tags each
(Cloudflare's "Purge cache" documentation, checked 2026-11-13). The worker lets at most one
request out every 15 seconds across all workers: one batch at a time holds the status row's claim
under a 30 s lease, and the request is let out only if, by the database's clock, that claim is
still held and 15 s have passed since the last one was let out. The one case this does not cover
is a worker that pauses for more than the lease between being let out and sending, and so sends
just after another; at 5 a minute that is still inside the bucket of 25.

The queue is bounded: more than 100 owed first sends become one purge of everything (`pbm`), and
so do more than 100 owed repeats. At most one batch is in flight: up to 100 rows, or, when it
purges everything, every row that was due (at most 200). So `edge_purges` holds at most 400 rows,
plus one row for each transaction owing a purge at the same instant (a new peer's first sight, say). A repeat never
counts toward the collapse of first sends, so echoes cannot make a purge wider than the sends that
caused them.

Each takedown's purge goes out normally within about 20 seconds and again 150 s after that send
succeeded. The second send covers an answer decided just before the takedown whose fill completed
at Cloudflare within 150 s of that decision. A fill that completes later, such as a small answer
Traefik took whole and delivered to Cloudflare slowly for longer than that, is not covered and
can be served until its hour is up. No fixed delay closes that; it needs an end-to-end completion
bound the application does not control, and the owner accepted it as a residual risk. On
2026-11-13 section 3 (b) 2 showed it: a delivery trickled at about 8 B/s completed after both
purges and was then served from the cache (`HIT`) until a later purge removed it.

The 150 s exceed the 10 s body deadline plus the longest Cloudflare was seen to wait on a
completely silent delivery, so such a delivery ends before the repeat. Cloudflare documents a
100 s read timeout; on 2026-11-13 (free plan, through Traefik, one run) the silent connection of
section 3 (b) 1 ended about 125 s after the decision, after the 120 s repeat of that build, which
is why the repeat is now 150 s. Cloudflare stored nothing from it. That it stores nothing from an
abandoned delivery was seen once, not guaranteed.

If purging stays broken, a taken-down image can be served from Cloudflare for up to an hour
after it was cached (`s-maxage=3600`), and no new image is cached once the path is not ready.
Visitors' browsers keep any image for up to ten minutes (`max-age=600`) whatever Cloudflare does.

## 6. Turning it off

1. Disable or delete the cache rule (step 2). From then on nothing new is cached.
2. Purge what is held: Caching, Configuration, Custom Purge, Tag, `pbm`.
3. Remove `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` from web and worker and redeploy:
   answers are `private` again.
4. Delete the token.

Do it in this order: removing the variables first stops the purges while Cloudflare may still
hold images for up to an hour.
