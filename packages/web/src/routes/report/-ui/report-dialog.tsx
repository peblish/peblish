import { Button } from '@peblish/ui/components/button';
import { Dialog } from '@peblish/ui/components/dialog';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { useEffect, useRef } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asReportError } from './errors.ts';
import type { Loaded } from './report-control.tsx';
import { ReportFormView } from './report-form.tsx';

/**
 * The report form in a Mux Dialog, loaded by ReportControl on the first click. One Dialog with a
 * title in every state (loading, the form, a refusal): the Dialog names itself from the title it
 * mounted with, so a state that swapped `aria-label` for a title would leave it with no name.
 */
export default function ReportDialog({ loaded, back, onClose }: { loaded: Loaded | null; back: string; onClose: () => void }) {
  const { t } = useTranslate();
  const panel = useRef<HTMLElement>(null);
  // Enter on the Report link fires a click with no pointer, which React Aria reads as a screen
  // reader's virtual cursor and so holds the Dialog's own focus until the entrance animation ends,
  // leaving focus on the page behind. Focus the panel now; React Aria's late focus then does nothing.
  useEffect(() => {
    const element = panel.current;
    if (element && !element.contains(element.ownerDocument.activeElement)) element.focus({ preventScroll: true });
  }, []);
  const form = loaded && 'form' in loaded ? loaded.form : null;
  const title = form
    ? t('reports', `form.title.${form.target.kind === 'actor' ? form.about.kind : form.target.kind}`)
    : t('reports', 'form.open');
  return (
    <Dialog
      ref={panel}
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      panelClassName="rp-dialog"
      actions={
        loaded &&
        !form && (
          <Button variant="neutral" onActivate={onClose}>
            {t('reports', 'form.close')}
          </Button>
        )
      }
    >
      {form ? (
        <ReportFormView form={form} back={back} onCancel={onClose} />
      ) : loaded && 'reason' in loaded ? (
        <Notice tone="warning" role="alert">
          {t('reports', `error.${asReportError(loaded.reason) ?? 'generic'}`)}
        </Notice>
      ) : (
        <Text as="p">{t('reports', 'form.loading')}</Text>
      )}
    </Dialog>
  );
}
