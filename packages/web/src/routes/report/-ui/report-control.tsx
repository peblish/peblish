import type { ReportForm } from '@peblish/core/reports/form';
import type { RefusalReason } from '@peblish/schema/refusal';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { loadReportForm } from '../-load.ts';
import { asReportError } from './errors.ts';
import { ReportFormView } from './report-form.tsx';
import './report.css';

type Target = { kind: 'post' | 'comment' | 'actor'; id: string };
type Loaded = { form: ReportForm } | { reason: RefusalReason };

/**
 * The Report control of every slot: a link to /report that works without JavaScript. Once
 * hydrated, a plain click opens the same form in a native modal dialog instead (no focus
 * trap library: <dialog> traps focus and closes on Escape by itself, and the Mux dialog would
 * add about 48 kB gzip to every page that shows this link). The form's data is fetched on the
 * first click, not with the page.
 */
export function ReportControl({ target, back, label }: { target: Target; back: string; label?: string }) {
  const { t } = useTranslate();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const href = `/report?${new URLSearchParams({ kind: target.kind, id: target.id, back })}`;

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
  }, [open, loaded]);

  async function show(event: MouseEvent<HTMLAnchorElement>) {
    // A new tab, a download or a modified click keeps the link's own behaviour.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpen(true);
    if (loaded) return;
    try {
      const result = await loadReportForm({ data: { kind: target.kind, id: target.id } });
      if (!result.ok) return setLoaded({ reason: result.reason });
      const { ok: _ok, ...form } = result;
      setLoaded({ form });
    } catch {
      window.location.assign(href);
    }
  }

  const close = () => {
    dialog.current?.close();
    setOpen(false);
  };

  return (
    <>
      <a className="pb-linkbutton" href={href} onClick={show}>
        {label ?? t('reports', 'form.open')}
      </a>
      {open && (
        <dialog ref={dialog} className="rp-dialog" aria-labelledby="report-dialog-title" onClose={() => setOpen(false)}>
          {!loaded && <p>{t('reports', 'form.loading')}</p>}
          {loaded && 'form' in loaded && (
            <>
              <h2 id="report-dialog-title">
                {t('reports', `form.title.${loaded.form.target.kind === 'actor' ? loaded.form.about.kind : loaded.form.target.kind}`)}
              </h2>
              <ReportFormView form={loaded.form} back={back} onCancel={close} />
            </>
          )}
          {loaded && 'reason' in loaded && (
            <>
              <h2 id="report-dialog-title">{t('reports', 'form.open')}</h2>
              <p role="alert">{t('reports', `error.${asReportError(loaded.reason) ?? 'generic'}`)}</p>
              <button type="button" className="pb-linkbutton" onClick={close}>
                {t('reports', 'form.close')}
              </button>
            </>
          )}
        </dialog>
      )}
    </>
  );
}
