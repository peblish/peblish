import { Button } from '@peblish/ui/components/button';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { BlockForm } from './block-form.tsx';

/**
 * The Block control of the four action slots (post, comment, profile, community page): one form
 * that adds the block and sends the viewer back to `back`. Stateless: blocking twice changes
 * nothing, so a slot needs no idea of what is already blocked. `link` is the small ghost
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
    // Every slot is a flex row of actions, so the form is one item in it and needs no style.
    <BlockForm kind={kind} fields={{ intent: 'add', kind, target, back }}>
      <Button type="submit" variant={look === 'link' ? 'ghost' : 'neutral'} size={look === 'link' ? 'sm' : 'md'}>
        {label}
      </Button>
    </BlockForm>
  );
}
