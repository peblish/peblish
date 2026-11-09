import type { ProfileActionProps } from '../../../-actions/props.ts';
import { ProfileModerateTools } from '../../../modlog/-ui/content-moderate.tsx';

/** Ban from a community the viewer moderates, and (admins) from the instance (lane MODF). */
export function ProfileModerate(props: ProfileActionProps) {
  return <ProfileModerateTools {...props} />;
}
