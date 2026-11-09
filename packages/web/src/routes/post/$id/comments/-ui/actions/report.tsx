import type { ContentActionProps } from '../../../../../-actions/props.ts';
import { ContentReport } from '../../../../../report/-ui/slots.tsx';

/** The Report action on a comment row (lane REP). */
export function CommentReport(props: ContentActionProps) {
  return <ContentReport {...props} />;
}
