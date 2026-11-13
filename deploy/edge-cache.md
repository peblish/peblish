# Edge cache for public remote images

Cloudflare may hold the proxy's answers for public remote images (`/media/proxy/*`), so a popular
post's thumbnail is fetched from its remote host about once an hour per Cloudflare cache instead of
once per viewer. Nothing here has been applied to the zone: these are the steps for the operator.
The application side is `packages/core/src/edge/` and `packages/core/src/media/README.md`.

What the origin sends:

| Answer                                                                                                       | `Cache-Control`                      | Held by Cloudflare          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------- |
| A GET for an image public when fetched (below), while the worker's purge path is proven working              | `public, max-age=600, s-maxage=3600` | up to 1 hour, purged by tag |
| Any other image (sensitive, removed or moderator-only content, a draft preview, a HEAD, purge path unproven) | `private, max-age=600`               | never                       |
| A refusal or an error (404, 403, 413, 415, 502, 503, 504), and any image whose hash is on the blocked list   | `no-store`                           | never                       |

"Public when fetched": once the bytes are in hand, one consistent database read finds the content
shown to a signed-out visitor, its community live, its supplier and every host it came through
allowed, the hash not listed and the remote-media switch on, and that read finished within 2 s.

A public answer also carries `Cache-Tag` (Cloudflare strips it before the browser sees it) and
no `Set-Cookie`. Without both variables below, or until the worker has proven the token, every
image answer is `private`, as before.

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

Web answers public only while the database holds a fresh record, written by the worker, of a
Cloudflare request that succeeded with this token (a purge, or with nothing to purge a purge of the
unused tag `pbm-check` at most every 2 minutes), and no purge has been owed for more than 2
minutes. A worker that is stopped, lacks the variables or holds a refused token therefore turns
public answers private within 5 minutes, and a refused token at once.

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
MISS` and no `set-cookie`; the second `HIT`. A sensitive post's image (while signed out it is a 404) and a removed post's image answer `no-store` with `DYNAMIC` or `BYPASS`, never `HIT`. A
`curl -I` (HEAD) always answers `private`.

Then remove that post as a moderator. Within about 20 seconds the URL answers `404` with
`no-store`, and Cloudflare's status is `MISS`, `EXPIRED` (Tiered Cache), `BYPASS` or `DYNAMIC`,
never `HIT`. The same purge is sent again a minute later. A purge that works logs nothing.

What the worker logs when it does not:

- `edge cache: Cloudflare refused the purge request (http 403 (cloudflare 10000)); proxy images are answered private until it works`: at once and on every attempt (20 s, doubling to 5 minutes). Fix the token's permissions or zone.
- `edge cache: purge request failed <n> times in a row (<why>); the debt stays owed`: at 1, 2, 4, 8 ... failures in a row.
- `edge cache: purge path works again after <n> failed requests`: once it recovers.

Each failure is also an `edge.purge_failed` row in the outbox (`failures`, `refused`, `why`). For a
quick look at the state: `select * from edge_status;` (`verified_at` is the last proof; web is
public only while it is under 5 minutes old) and `select tag, send, due_at, claim_token from
edge_purges order by due_at;` (what is owed; `send` 2 is the repeat a minute after the first).

## 4. Limits

The free plan allows tag purges at 5 requests a minute per account (bursts of 25), 100 tags each
(Cloudflare's "Purge cache" documentation, checked 2026-11-13). The worker sends at most one
request every 15 seconds across all workers (the claim takes a row lock in the database), and
more than 100 owed tags become one purge of everything (`pbm`). Any number of worker replicas
is safe: each owed purge is claimed by one of them under a 30 s lease and given to another if
that worker dies.

If purging stays broken, a taken-down image can be served from Cloudflare for up to an hour
after it was cached (`s-maxage=3600`), and no new image is cached once the record goes stale.
Visitors' browsers keep any image for up to ten minutes (`max-age=600`) whatever Cloudflare does.

## 5. Turning it off

1. Disable or delete the cache rule (step 2). From then on nothing new is cached.
2. Purge what is held: Caching, Configuration, Custom Purge, Tag, `pbm`.
3. Remove `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` from web and worker and redeploy:
   answers are `private` again.
4. Delete the token.

Do it in this order: removing the variables first stops the purges while Cloudflare may still
hold images for up to an hour.
