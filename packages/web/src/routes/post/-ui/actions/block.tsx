import { BlockAction } from '../../../settings/blocks/-ui/block-action.tsx';
import type { ContentActionProps } from '../../../-actions/props.ts';
import { authorWithheld } from '../../-withheld.ts';

/** Block the post's author. Hidden on the viewer's own post, on a deleted one and where the page names no author (no one to block). */
export function PostBlock({ author, viewer, deleted, back }: ContentActionProps) {
  if (author.id === viewer.actorId || deleted || authorWithheld(author) || author.kind === 'Group') return null;
  return <BlockAction kind="person" target={author.id} back={back} />;
}
