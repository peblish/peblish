import type { ContentActionProps, CommunityActionProps, ProfileActionProps } from '../../-actions/props.ts';
import { ReportControl } from './report-control.tsx';

// The Report slots (lane REP). One control on every surface; the slot hides itself where there
// is nothing to report: one's own content, content already removed or deleted.

export function ContentReport({ target, author, removed, deleted, viewer, back }: ContentActionProps) {
  if (viewer.actorId === author.id || removed || deleted) return null;
  return <ReportControl target={target} back={back} />;
}

export function PersonReport({ person, viewer, back }: ProfileActionProps) {
  if (viewer.actorId === person.id) return null;
  return <ReportControl target={{ kind: 'actor', id: person.id }} back={back} look="card" />;
}

export function GroupReport({ community, viewer, back }: CommunityActionProps) {
  if (viewer.actorId === community.id) return null;
  return <ReportControl target={{ kind: 'actor', id: community.id }} back={back} look="card" />;
}
