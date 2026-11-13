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
`Content-Length`, and no `Set-Cookie`. Its body must be handed to the connection within 10 s of
the start of that read: if the connection is not taking it by then, the origin destroys the
connection, so Cloudflare holds a body shorter than its `Content-Length` and does not store it.
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

## 3. Check a hit and a purge from outside

Wait until the worker has run for a minute (it proves the token first). Take a public post's image
URL from the page source (`/media/proxy/<signature>/<target>`):

```sh
url='https://feddit.com/media/proxy/<signature>/<target>'
curl -s -o /dev/null -D - "$url" | grep -i -E '^(cf-cache-status|cache-control|set-cookie):'
curl -s -o /dev/null -D - "$url" | grep -i '^cf-cache-status:'
```

The first answer shows `cache-control: public, max-age=600, s-maxage=3600`, `cf-cache-status:
MISS` and no `set-cookie`; the second `HIT`. A sensitive post's image (while signed out it is a 404) and a removed post's image answer `no-store` with `DYNAMIC` or `BYPASS`, never `HIT`.

Use GET for these checks, not `curl -I`. The origin answers a HEAD `private`, but a HEAD through
Cloudflare may never reach it: Cloudflare answers a HEAD from a cached GET (a `HIT` with the
public headers), and on a miss it may fetch the image from the origin with a GET, cache that and
answer the HEAD from it. That is harmless, so no rule is added for it: such a fill is an ordinary
public GET answer, decided, tagged and purged like any other, and a HEAD only ever sees the
headers of what a GET would get.

Then remove that post as a moderator. Within about 20 seconds the URL answers `404` with
`no-store`, and Cloudflare's status is `MISS`, `EXPIRED` (Tiered Cache), `BYPASS` or `DYNAMIC`,
never `HIT`. The same purge is sent again a minute later. A purge that works logs nothing.

What the worker logs when it does not:

- `edge cache: Cloudflare refused the purge request (http 403 (cloudflare 10000)); proxy images are answered private until it works`: at once and on every attempt (20 s, doubling to 5 minutes). Fix the token's permissions or zone.
- `edge cache: purge request failed <n> times in a row (<why>); the debt stays owed`: at 1, 2, 4, 8 ... failures in a row.
- `edge cache: purge path works again after <n> failed requests`: once it recovers.

The first failure of each run of failures is also an `edge.purge_failed` row in the outbox
(`failures`, `refused`, `why`); later ones only count up in `edge_status`, so a long outage adds
one row, not one every few seconds. For a quick look at the state: `select * from edge_status;`
(`verified_at` is the last proof and `zone_id` the zone it proved; web is public only while it is
under 5 minutes old and the zone matches) and `select tag, send, due_at, claim_token from
edge_purges order by due_at;` (what is owed; `send` 2 is the repeat a minute after the first).

## 4. Limits

The free plan allows tag purges at 5 requests a minute per account (bursts of 25), 100 tags each
(Cloudflare's "Purge cache" documentation, checked 2026-11-13). The worker lets at most one
request out every 15 seconds across all workers: one batch at a time holds the status row's claim
under a 30 s lease, and the request is let out only if, by the database's clock, that claim is
still held and 15 s have passed since the last one was let out. The one case this does not cover
is a worker that pauses for more than the lease between being let out and sending, and so sends
just after another; at 5 a minute that is still inside the bucket of 25.

The queue is bounded: more than 100 owed first sends become one purge of everything (`pbm`), and
so do more than 100 owed repeats. With at most one batch in flight (up to 101 rows, or all rows
due when it purges everything), `edge_purges` holds at most about 300 rows, plus the rows of
transactions committing at the same instant before one of them collapses them. A repeat never
counts toward the collapse of first sends, so echoes cannot make a purge wider than the sends that
caused them.

Each takedown's purge goes out normally within about 20 seconds and again about a minute later.
The second send is what covers an answer that was decided just before the takedown but was still
being handed to Cloudflare: its body ended within 10 s of its decision, so it was complete well
before the repeat, which is sent at least 60 s after the first succeeded.

If purging stays broken, a taken-down image can be served from Cloudflare for up to an hour
after it was cached (`s-maxage=3600`), and no new image is cached once the path is not ready.
Visitors' browsers keep any image for up to ten minutes (`max-age=600`) whatever Cloudflare does.

## 5. Turning it off

1. Disable or delete the cache rule (step 2). From then on nothing new is cached.
2. Purge what is held: Caching, Configuration, Custom Purge, Tag, `pbm`.
3. Remove `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` from web and worker and redeploy:
   answers are `private` again.
4. Delete the token.

Do it in this order: removing the variables first stops the purges while Cloudflare may still
hold images for up to an hour.
