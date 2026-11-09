# Media, link previews and the remote-media proxy (lane B2)

| Area                       | What                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `../storage/`              | `ObjectStore` (put, get, delete), the S3 adapter `s3Store()` (MinIO, R2; `S3_*` variables) and `memoryStore()` for tests                                           |
| `clean.ts`, `image/`       | `cleanImage(bytes)`: JPEG, PNG, WebP and GIF rebuilt without metadata; never SVG                                                                                   |
| `upload.ts`                | `uploadImage(principal, { bytes, altText })`: refused with `site.disabled` while `uploads.enabled` is false; stores, records a `pending` row, emits `media.stored` |
| `../links/`                | `fetchLinkPreview(principal, url)`: title, description, a stored `thumbnail` row; stopped by `remote_media.enabled`                                                |
| `proxy-url.ts`, `proxy.ts` | signed `/media/proxy/<signature>/<target>` paths and the fetch behind the route `packages/web/src/routes/media/proxy/`                                             |
| `image-src.ts`             | `imageSource(url, policy)`: where a page loads an image from; `isImageContentType`                                                                                 |

## Cleaning, and what it does not do

`cleanImage` parses the container strictly and writes it again from the parts that decide what is drawn. Exif (GPS, camera, owner), XMP, IPTC, ICC profiles, comments, PNG text and time chunks, GIF comment and XMP extensions, WebP `EXIF`, `XMP ` and `ICCP` chunks and any bytes after the image are gone. A JPEG keeps one 34-byte Exif segment with only its orientation (phone photos would display sideways without it). A damaged file is refused (`media.invalid_image`), and so is anything past 8192 pixels a side or 40 million pixels (`media.too_large`).

The pixels are neither decoded nor re-encoded: no native or wasm codec ships in the image, and nothing allocates per pixel, so there is no decompression bomb to defend against. The price is that a thumbnail is the image as sent, not a resized copy (previews download at most 2 MiB).

## Rows and serving

Every stored row is `scan_state = 'pending'` and nothing serves it. Lane SAFE consumes `media.stored`, scans the object at `media.storage_key` (`media/<id>.<jpg|png|webp|gif>`) and sets the state; its route `/media/<id>` serves clean rows only, with the stored `mime_type`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. A preview's `thumbnailUrl` is that future URL (`<origin>/media/<id>`).

## The remote-media proxy (decision 5)

Remote images reach viewers only as `/media/proxy/<signature>/<target>`: `target` is the remote URL in base64url, `signature` an HMAC-SHA-256 of it under `derivedKey('media-proxy')` (a key derived from `BETTER_AUTH_SECRET`, `identity/auth.ts`). The route answers 404 to anything unsigned or altered and while `remote_media.enabled` is off. Otherwise it fetches through `safeFetch` (http or https, 3 redirects, 15 s, 10 MiB, nothing from the viewer sent upstream), accepts JPEG, PNG, GIF, WebP and AVIF by their first bytes (SVG, HTML and the rest are 415, an oversize body is 413, a private address is 403, any other upstream trouble 502 or 504), and answers with the type it sniffed, `Cache-Control: public, max-age=600`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Nothing is written to the database, the bucket or the disk. `siteMarkdown()` sets `proxy` to the builder, so Markdown images and remote HTML go through it; for a post's `thumbnailUrl` or an image post's `url`, call `createMarkdownRenderer().image(url)`, which returns the URL itself on this instance, the proxy path for a remote one, or `null`.
