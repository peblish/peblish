# Edge cache for public remote images

Cloudflare may hold the proxy's answers for public remote images (`/media/proxy/*`), so a popular
post's thumbnail is fetched from its remote host about once an hour per Cloudflare cache instead of
once per viewer. Nothing here has been applied to the zone: these are the steps for the operator.
The application side is `packages/core/src/edge/` and `packages/core/src/media/README.md`.

What the origin sends:

| Answer                                                                               | `Cache-Control`                      | Held by Cloudflare          |
| ------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------- |
| An image whose content a signed-out visitor is shown, with the purge path configured | `public, max-age=600, s-maxage=3600` | up to 1 hour, purged by tag |
| Any other image (sensitive, removed or moderator-only content, a draft preview)      | `private, max-age=600`               | never                       |
| A refusal or an error (404, 403, 413, 415, 502, 503, 504)                            | `no-store`                           | never                       |

A public answer also carries `Cache-Tag` (Cloudflare strips it before the browser sees it) and
no `Set-Cookie`. Without both variables below every image answer is `private`, as before.

## 1. The purge token

Create an API token (My Profile, API Tokens, Create Token, Custom token):

- Permissions: **Zone, Cache Purge, Purge**. Nothing else.
- Zone resources: **Include, Specific zone, feddit.com**. Not all zones.
- No IP filtering is needed; set a TTL only if you will rotate it.

Check it from your own machine (prints `active` for a working token):

```sh
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $CLOUDFLARE_PURGE_TOKEN" | jq -r .result.status
```

Set both variables on **web and worker** (the same values; web answers public only when it has them,
and only the worker purges):

| Variable                 | Value                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| `CLOUDFLARE_ZONE_ID`     | the zone id, 32 hexadecimal characters (the zone's Overview, API box) |
| `CLOUDFLARE_PURGE_TOKEN` | the token above                                                       |

A half-set or malformed pair keeps edge caching off and logs `edge cache: <names> missing or
malformed; edge caching stays off` once per process (names only, never values).

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

Take a public post's image URL from the page source (`/media/proxy/<signature>/<target>`):

```sh
url='https://feddit.com/media/proxy/<signature>/<target>'
curl -s -o /dev/null -D - "$url" | grep -i -E '^(cf-cache-status|cache-control|set-cookie):'
curl -s -o /dev/null -D - "$url" | grep -i '^cf-cache-status:'
```

The first answer shows `cache-control: public, max-age=600, s-maxage=3600`, `cf-cache-status:
MISS` and no `set-cookie`; the second `HIT`. A sensitive post's image (while signed out it is a 404) and a removed post's image answer `no-store` with `DYNAMIC` or `BYPASS`, never `HIT`.

Then remove that post as a moderator. Within about 20 seconds (the purge job runs every 20 s) the
URL answers `404` with `no-store`, and Cloudflare's status is `MISS`, `EXPIRED` (Tiered Cache),
`BYPASS` or `DYNAMIC`, never `HIT`. A purge that works logs nothing. A purge that fails logs
`edge cache: purge failed 1 time in a row (http <status> ...)` in the worker, again at 2, 4, 8 ...
failures in a row, and `edge cache: purge succeeded after <n> failed attempts` once it works.

A new worker purges every public image when it starts (the tag `pbm`), so the first image
requests after a deploy are misses. Every purge of `pbm` (on start, a peer's media quarantined,
purged or blocked, an image hash blocked, the kill switch changed) is sent again a minute later.

## 4. Limits

The free plan allows tag purges at 5 requests a minute per account (bursts of 25), 100 tags each
(Cloudflare's "Purge cache" documentation, checked 2026-11-13). The worker sends at most one
request every 20 seconds and turns more than 100 waiting tags into one wide purge. Two worker
replicas would send up to 6 a minute together; run one, as `deploy/README.md` already says.

If a purge is lost for good (a revoked token nobody notices), a taken-down image can be served
from Cloudflare for up to an hour after it was cached (`s-maxage=3600`). Visitors' browsers keep
any image for up to ten minutes (`max-age=600`) whatever Cloudflare does.

## 5. Turning it off

1. Disable or delete the cache rule (step 2). From then on nothing new is cached.
2. Purge what is held: Caching, Configuration, Custom Purge, Tag, `pbm`.
3. Remove `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` from web and worker and redeploy:
   answers are `private` again.
4. Delete the token.

Do it in this order: removing the variables first stops the purges while Cloudflare may still
hold images for up to an hour.
