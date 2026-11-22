import type { ReactNode } from 'react';

/**
 * The right rail (Commons): what explains the place a page shows (a feed's, a community's charter, a
 * post's cast), in RailPanels. A route renders it beside its <main>, as its sibling, and the frame's
 * grid (#pb-main, shell.css) puts it in the column right of the centre, sticky under the header and
 * scrolling on its own. A page without one is a single centre column, centred at the width it has
 * beside a rail. Where the page is narrower than 62rem the rail gives way, before the phone layout
 * does, so a route shows what the rail held inside its view there itself. Server rendered: it reads
 * the same with scripts off. Its panels stand a gap apart (shell.css); `className` is the page's own,
 * for what it styles inside them.
 */
export function Rail({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <aside className={className ? `pb-rail ${className}` : 'pb-rail'} aria-label={label}>
      {children}
    </aside>
  );
}
