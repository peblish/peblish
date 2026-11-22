// Share and Copy link for a page of this site (a post, a comment), in one small module the post page, the
// comment tree and the feeds' rows can share. Browser only: call these from an event handler, never while
// rendering, since the server has no clipboard, no share sheet and no address of its own to give.

/** What a Share or Copy link did. A share sheet the reader closed is `cancelled`, which is not a failure. */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

/** Whether the browser offers its own share sheet (`navigator.share`). */
export function canShareNatively(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** The absolute address of a path on this site, as the reader's browser reaches the site. */
export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

/** Copies `url` to the clipboard. `failed` when the browser refuses (no permission, an insecure origin). */
export async function copyLink(url: string): Promise<'copied' | 'failed'> {
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * Opens the browser's share sheet with `url`, or copies the link where there is none. A sheet the reader
 * dismisses is `cancelled`; a sheet the browser refuses to open falls back to copying.
 */
export async function shareLink(url: string, title?: string): Promise<ShareOutcome> {
  if (!canShareNatively()) return copyLink(url);
  try {
    await navigator.share(title ? { url, title } : { url });
    return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    return copyLink(url);
  }
}
