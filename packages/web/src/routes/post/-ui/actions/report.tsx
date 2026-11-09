import type { ContentActionProps } from '../../../-actions/props.ts';
import { ContentReport } from '../../../report/-ui/slots.tsx';

/** The Report action on the post page (lane REP). */
export function PostReport(props: ContentActionProps) {
  return <ContentReport {...props} />;
}
