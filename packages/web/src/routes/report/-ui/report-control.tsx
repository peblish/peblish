import type { ReportForm } from '@peblish/core/reports/form';
import type { RefusalReason } from '@peblish/schema/refusal';
import { Link } from '@peblish/ui/components/link';
import { lazy, Suspense, useState, type MouseEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { loadReportForm } from '../-load.ts';
import './report.css';

type Target = { kind: 'post' | 'comment' | 'actor'; id: string };
export type Loaded = { form: ReportForm } | { reason: RefusalReason };

// The Mux Dialog with the form in it is split out and loaded on the first click: the Dialog and
// the RadioGroup cost about 48 and 48 kB gzip, which every page that shows this link would
// otherwise pay.
const ReportDialog = lazy(() => import('./report-dialog.tsx'));

/**
 * The Report control of every slot: a Mux Link to /report that works without JavaScript. Once
 * hydrated, a plain click opens the same form in a Mux Dialog instead. The form's data is
 * fetched on the first click, not with the page.
 */
export function ReportControl({ target, back, label }: { target: Target; back: string; label?: string }) {
  const { t } = useTranslate();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const href = `/report?${new URLSearchParams({ kind: target.kind, id: target.id, back })}`;

  // A capture handler, so its preventDefault also stops the router navigation the Link would start.
  async function show(event: MouseEvent<HTMLElement>) {
    // A new tab, a download or a modified click keeps the link's own behaviour.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpen(true);
    if (loaded) return;
    try {
      const result = await loadReportForm({ data: { kind: target.kind, id: target.id } });
      if (!result.ok) return setLoaded({ reason: result.reason });
      const { ok: _ok, back: _back, ...form } = result;
      setLoaded({ form });
    } catch {
      window.location.assign(href);
    }
  }

  return (
    <>
      <Link href={href} onClickCapture={show}>
        {label ?? t('reports', 'form.open')}
      </Link>
      {open && (
        <Suspense fallback={null}>
          <ReportDialog loaded={loaded} back={back} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
