import { DropZone, type MuxUIDropEvent } from '@peblish/ui/components/drop-zone';
import { Input } from '@peblish/ui/components/input';
import { ProgressBar } from '@peblish/ui/components/progress-bar';
import { useRef, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';

/**
 * The image to upload: the form's own file field, so the file posts with the form before and
 * without JavaScript, inside a drop target that puts a dropped or pasted image into that field.
 * Mux UI's FileTrigger is not used: its input has no name and its button does nothing before
 * hydration, so the form would no longer carry the file. While the post is sending, the bar
 * shows how much of the file has gone.
 */
export function ImageField({
  error,
  progress,
}: {
  error?: ReactNode;
  /** Percent of the request sent, while it is sending. */
  progress: number | null;
}) {
  const { t } = useTranslate();
  const input = useRef<HTMLInputElement>(null);

  async function take(event: MuxUIDropEvent) {
    const item = event.items.find((dropped) => dropped.kind === 'file');
    const field = input.current;
    if (!item || item.kind !== 'file' || !field) return;
    const files = new DataTransfer();
    files.items.add(await item.getFile());
    field.files = files.files;
  }

  return (
    <DropZone aria-label={t('composer', 'image.drop')} onDrop={(event) => void take(event)} className="cmp__drop">
      <Input.Root invalid={error !== undefined}>
        <Input.Label>{t('composer', 'image.label')}</Input.Label>
        <Input.Input ref={input} type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif" />
        <Input.Description>{t('composer', 'image.hint')}</Input.Description>
        {error !== undefined && <Input.Error>{error}</Input.Error>}
      </Input.Root>
      {progress !== null && <ProgressBar label={t('composer', 'image.sending')} value={progress} />}
    </DropZone>
  );
}
