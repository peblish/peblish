import { BlockAction } from '../../../settings/blocks/-ui/block-action.tsx';
import type { ContentActionProps } from '../../../-actions/props.ts';

/** Block the post's author. Hidden on the viewer's own post and on a deleted one (no one to block). */
export function PostBlock({ author, viewer, deleted, back }: ContentActionProps) {
  if (author.id === viewer.actorId || deleted || author.kind === 'Group') return null;
  return <BlockAction kind="person" target={author.id} back={back} />;
}
