import { BlockAction } from '../../../settings/blocks/-ui/block-action.tsx';
import type { ProfileActionProps } from '../../../-actions/props.ts';

/** Block the person whose profile this is. The profile page does not render it for the viewer's own page or for a person already blocked. */
export function ProfileBlock({ person, viewer, back }: ProfileActionProps) {
  if (person.id === viewer.actorId) return null;
  return <BlockAction kind="person" target={person.id} back={back} look="button" />;
}
