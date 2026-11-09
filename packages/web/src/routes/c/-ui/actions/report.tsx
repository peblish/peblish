import type { CommunityActionProps } from '../../../-actions/props.ts';
import { GroupReport } from '../../../report/-ui/slots.tsx';

/** The Report action on a community page (lane REP). */
export function CommunityReport(props: CommunityActionProps) {
  return <GroupReport {...props} />;
}
