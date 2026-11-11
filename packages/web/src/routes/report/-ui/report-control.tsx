import type { ReportForm } from '@peblish/core/reports/form';
import type { RefusalReason } from '@peblish/schema/refusal';
import { Link } from '@peblish/ui/components/link';
import { lazy, Suspense, useEffect, useId, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { loadReportForm } from '../-load.ts';
import './report.css';

type Target = { kind: 'post' | 'comment' | 'actor'; id: string };
export type Loaded = { form: ReportForm } | { reason: RefusalReason };

// The Mux Dialog with the form in it is split out and loaded on the first click: the Dialog and
// the RadioGroup cost about 48 and 48 kB gzip, which every page that shows this link would
// otherwise pay. ReportControl awaits the import itself before rendering the lazy component, so a
// chunk that fails to load is caught there and never reaches the page's error boundary.
const loadDialog = () => import('./report-dialog.tsx');
const ReportDialog = lazy(loadDialog);

// The one control on the page whose dialog is open or on its way. A click on another Report link
// while the code loads takes over, so two dialogs never mount at once.
let active: string | null = null;
const listeners = new Set<() => void>();
function activate(key: string | null) {
  active = key;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The Report control of every slot: a Mux Link to /report that works without JavaScript. Once
 * hydrated, a plain click opens the same form in a Mux Dialog instead, and the link shows it is
 * busy until the dialog's code has loaded. The form's data is fetched on the first click, not
 * with the page. If either fails to load, the click goes to /report after all.
 */
export function ReportControl({ target, back, label }: { target: Target; back: string; label?: string }) {
  const { t } = useTranslate();
  const key = useId();
  const mine = useSyncExternalStore(
    subscribe,
    () => active === key,
    () => false,
  );
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const href = `/report?${new URLSearchParams({ kind: target.kind, id: target.id, back })}`;
  /** Navigates to the form page, unless another control has taken over since the click. */
  function fallBack() {
    if (active === key) window.location.assign(href);
  }
  // A control that leaves the page (a client navigation while its code loads) gives up its turn.
  useEffect(
    () => () => {
      if (active === key) activate(null);
    },
    [key],
  );

  // A capture handler, so its preventDefault also stops the router navigation the Link would start.
  async function show(event: MouseEvent<HTMLElement>) {
    // A new tab, a download or a modified click keeps the link's own behaviour.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (active === key) return;
    activate(key);
    const form = loaded ? undefined : loadReportForm({ data: { kind: target.kind, id: target.id } });
    try {
      await loadDialog();
    } catch {
      return fallBack();
    }
    if (active !== key) return;
    setReady(true);
    if (!form) return;
    try {
      const result = await form;
      if (!result.ok) return setLoaded({ reason: result.reason });
      const { ok: _ok, back: _back, ...rest } = result;
      setLoaded({ form: rest });
    } catch {
      fallBack();
    }
  }

  function close() {
    if (active === key) activate(null);
  }

  const pending = mine && !ready;
  return (
    <>
      <Link
        href={href}
        onClickCapture={show}
        className="rp-open pb-link-quiet"
        // A static busy look (no animation) from the click until the dialog opens. A data attribute:
        // React Aria's link drops aria-busy, and Mux takes data-pending for its own state attribute.
        data-opening={pending || undefined}
      >
        {label ?? t('reports', 'form.open')}
      </Link>
      {mine && ready && (
        <Suspense fallback={null}>
          <ReportDialog loaded={loaded} back={back} onClose={close} />
        </Suspense>
      )}
    </>
  );
}
