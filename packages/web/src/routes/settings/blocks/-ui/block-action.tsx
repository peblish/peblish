import { Button } from '@peblish/ui/components/button';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { BlockForm } from './block-form.tsx';

/**
 * The Block control of the four action slots (post, comment, profile, community page): one form
 * that adds the block and sends the viewer back to `back`. Stateless: blocking twice changes
 * nothing, so a slot needs no idea of what is already blocked. `link` is the small text
 * button of a post or comment row, `button` a profile or community page's.
 */
export function BlockAction({
  kind,
  target,
  back,
  look = 'link',
}: {
  kind: 'person' | 'community';
  target: string;
  back: string;
  look?: 'link' | 'button';
}) {
  const { t } = useTranslate();
  const label = t('blocks', kind === 'person' ? 'action.person' : 'action.community');
  return (
    <BlockForm kind={kind} inline fields={{ intent: 'add', kind, target, back }}>
      {look === 'link' ? (
        <button type="submit" className="pb-linkbutton">
          {label}
        </button>
      ) : (
        <Button type="submit" variant="neutral">
          {label}
        </Button>
      )}
    </BlockForm>
  );
}
