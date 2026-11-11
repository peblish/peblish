import { Button } from '@peblish/ui/components/button';
import { Dialog } from '@peblish/ui/components/dialog';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asReportError } from './errors.ts';
import type { Loaded } from './report-control.tsx';
import { ReportFormView } from './report-form.tsx';

/** The report form in a Mux Dialog, loaded by ReportControl on the first click. */
export default function ReportDialog({ loaded, back, onClose }: { loaded: Loaded | null; back: string; onClose: () => void }) {
  const { t } = useTranslate();
  const onOpenChange = (open: boolean) => !open && onClose();
  if (loaded && 'form' in loaded) {
    const { form } = loaded;
    return (
      <Dialog
        open
        onOpenChange={onOpenChange}
        title={t('reports', `form.title.${form.target.kind === 'actor' ? form.about.kind : form.target.kind}`)}
        panelClassName="rp-dialog"
      >
        <ReportFormView form={form} back={back} onCancel={onClose} />
      </Dialog>
    );
  }
  if (loaded) {
    return (
      <Dialog
        open
        onOpenChange={onOpenChange}
        title={t('reports', 'form.open')}
        panelClassName="rp-dialog"
        actions={
          <Button variant="neutral" onActivate={onClose}>
            {t('reports', 'form.close')}
          </Button>
        }
      >
        <Text as="p" role="alert">
          {t('reports', `error.${asReportError(loaded.reason) ?? 'generic'}`)}
        </Text>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={onOpenChange} aria-label={t('reports', 'form.open')} panelClassName="rp-dialog">
      <Text as="p">{t('reports', 'form.loading')}</Text>
    </Dialog>
  );
}
