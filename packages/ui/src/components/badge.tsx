export interface BadgeLabels {
  admin: string;
  moderator: string;
  /** The post's author, on their own comments. */
  op: string;
}

/** The mark beside a name: a site admin, a moderator of the community, or the post's author. */
export function Badge({ kind, labels }: { kind: 'admin' | 'moderator' | 'op'; labels: BadgeLabels }) {
  return (
    <span className={`pb-badge pb-badge--${kind}`}>
      {kind === 'moderator' ? labels.moderator : kind === 'admin' ? labels.admin : labels.op}
    </span>
  );
}
