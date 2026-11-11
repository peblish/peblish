import { useRouter, type AnyRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

/**
 * Opens `href` through the router when it is one of the app's pages, and with a page load when
 * it is not (an API path, a file, a page the router does not know yet, which then answers 404
 * itself). A `#` link to this same page (the skip link, a Mux Link) moves to its target as the
 * browser does for a plain link: scrolled to, and focused when it can take focus.
 */
export function openInRouter(router: AnyRouter, href: string): void {
  const url = new URL(href, window.location.href);
  if (href.startsWith('#')) {
    window.location.hash = url.hash;
    document.getElementById(decodeURIComponent(url.hash.slice(1)))?.focus();
    return;
  }
  const [, , found] = router.getMatchedRoutes(url.pathname);
  if (url.origin !== window.location.origin || !found) window.location.assign(href);
  else void router.navigate({ href: url.pathname + url.search + url.hash });
}

/**
 * Plain `<a href>` links in the app's own components (post cards, comments, the sidebar) go
 * through the router like Mux UI links do, with one listener for the whole page instead of a
 * router link in every row. Left to the browser: modified clicks (new tab), links that open
 * elsewhere or download, and same-page `#` links.
 */
export function useClientLinks(): void {
  const router = useRouter();
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const target = link.getAttribute('target');
      if (link.getAttribute('href')?.startsWith('#') || (target && target !== '_self') || link.hasAttribute('download')) return;
      if (link.origin !== window.location.origin) return;
      event.preventDefault();
      openInRouter(router, link.href);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [router]);
}
