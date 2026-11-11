import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export interface BadgeLabels {
  admin: string;
  moderator: string;
  /** The post's author, on their own comments. */
  op: string;
}

/** A role mark whose text comes from `labels`. */
export type BadgeRole = 'admin' | 'moderator' | 'op';

/**
 * The colour of a badge. Roles and `bot` have their own hues; the rest are the status tones.
 * Each maps to one of Mux UI's TagGroup hues (foreground on its weak tint), which follow the colour scheme.
 */
export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'admin' | 'moderator' | 'op' | 'bot';

/** Named marks with a fixed tone, so every page colours the same state alike. */
export type BadgeKind =
  BadgeRole | 'bot' | 'you' | 'pinned' | 'locked' | 'nsfw' | 'nsfl' | 'removed' | 'deleted' | 'pending' | 'restricted' | 'private';

export const badgeTones: Record<BadgeKind, BadgeTone> = {
  admin: 'admin',
  moderator: 'moderator',
  op: 'op',
  bot: 'bot',
  you: 'op',
  pinned: 'brand',
  locked: 'neutral',
  nsfw: 'danger',
  nsfl: 'danger',
  removed: 'warning',
  deleted: 'neutral',
  pending: 'warning',
  restricted: 'neutral',
  private: 'neutral',
};

export type BadgeProps = Omit<ComponentPropsWithoutRef<'span'>, 'children'> &
  (
    | { kind: BadgeRole; labels: BadgeLabels; tone?: never; children?: never }
    | { kind?: BadgeKind; tone?: BadgeTone; labels?: never; children: ReactNode }
  );

/**
 * A static label: a role beside a name (`<Badge kind="moderator" labels={labels} />`), a post or
 * community state (`<Badge kind="nsfw">NSFW</Badge>`), or a status (`<Badge tone="success">On</Badge>`).
 * `tone` wins over the kind's own tone. Not interactive; for a count that needs a name, pass
 * `role="img"` and `aria-label`.
 */
export function Badge({ kind, tone, labels, children, className, ...rest }: BadgeProps) {
  const resolved = tone ?? (kind ? badgeTones[kind] : 'neutral');
  const text = labels && (kind === 'admin' || kind === 'moderator' || kind === 'op') ? labels[kind] : children;
  return (
    <span {...rest} className={['pb-badge', `pb-badge--${resolved}`, className].filter(Boolean).join(' ')}>
      {text}
    </span>
  );
}
