import { BlockAction } from '../../../settings/blocks/-ui/block-action.tsx';
import type { ContentActionProps } from '../../../-actions/props.ts';
import { isWithheld } from '../../-withheld.ts';

/** Block the post's author. Hidden on the viewer's own post, on a deleted one and where the page names no author (no one to block). */
export function PostBlock({ author, viewer, deleted, back }: ContentActionProps) {
  if (author.id === viewer.actorId || deleted || isWithheld(author) || author.kind === 'Group') return null;
  return <BlockAction kind="person" target={author.id} back={back} />;
}
