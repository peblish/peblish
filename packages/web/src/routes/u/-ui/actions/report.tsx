import type { ProfileActionProps } from '../../../-actions/props.ts';
import { PersonReport } from '../../../report/-ui/slots.tsx';

/** The Report action on a profile (lane REP). */
export function ProfileReport(props: ProfileActionProps) {
  return <PersonReport {...props} />;
}
