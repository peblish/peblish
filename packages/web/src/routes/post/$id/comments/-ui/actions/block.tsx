import { BlockAction } from '../../../../../settings/blocks/-ui/block-action.tsx';
import type { ContentActionProps } from '../../../../../-actions/props.ts';

/** Block the comment's author. Hidden on the viewer's own comment and on a deleted one (no one to block). */
export function CommentBlock({ author, viewer, deleted, back }: ContentActionProps) {
  if (author.id === viewer.actorId || deleted || author.kind === 'Group') return null;
  return <BlockAction kind="person" target={author.id} back={back} />;
}
