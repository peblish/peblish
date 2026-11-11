import { Button } from '@peblish/ui/components/button';
import { Dialog } from '@peblish/ui/components/dialog';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
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
  const form = loaded && 'form' in loaded ? loaded.form : null;
  const title = form
    ? t('reports', `form.title.${form.target.kind === 'actor' ? form.about.kind : form.target.kind}`)
    : t('reports', 'form.open');
  return (
    <Dialog
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
