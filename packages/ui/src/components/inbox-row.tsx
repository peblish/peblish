import { type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Avatar } from './avatar.tsx';
import { Button } from './button.tsx';
import { AtSignIcon, ReplyIcon, ShieldIcon, UserCheckIcon, UserXIcon } from './icons.tsx';
import { Text } from './text.tsx';
import { TextAreaField } from './text-area.tsx';

/**
 * What the row's mark shows: the person's initial with a reply or mention glyph, or a moderator's or
 * the account's glyph; `follow` is a community's acceptance of the person's request to join.
 */
export type InboxMark = 'reply' | 'mention' | 'moderator' | 'ban' | 'unban' | 'follow';

export interface InboxRowProps {
  unread: boolean;
  mark: InboxMark;
  /** The person's initial, for a reply's or a mention's avatar. */
  initial?: string;
  /**
   * The first line: who did what. On an unread row it starts with words for assistive technology
   * ("Unread"), since the dot beside it is drawn only.
   */
  headline: ReactNode;
  /** After the headline, on its line: the age. */
  age?: ReactNode;
  /** The line under it: the post's title as a link, and where. A press on the row's own space follows its first link. */
  context?: ReactNode;
  /** The quote, the reason and its links. */
  children?: ReactNode;
  /** The row's buttons. */
  actions: ReactNode;
  /** The inline reply (InboxReply) and what it says once sent. */
  reply?: ReactNode;
  /** `data-kind` on the row, for styles and tests. */
  kind?: string;
}

/** A press on a row's own space, not on a control or a link, and not the end of a text selection. */
const rowPress = (event: MouseEvent<HTMLElement>) =>
  !event.defaultPrevented &&
  !(event.target as Element).closest('a, button, input, textarea, select, form, [role="button"]') &&
  !window.getSelection()?.toString();

const glyphs = {
  mention: AtSignIcon,
  reply: ReplyIcon,
  moderator: ShieldIcon,
  ban: UserXIcon,
  unban: UserCheckIcon,
  follow: UserCheckIcon,
} as const;

/**
 * One notice in the inbox (Commons' InboxRow), as a list item: an unread dot (drawn, beside words in the
 * headline), the mark, the headline with its age, the context link, the caller's quote and links, the
 * row's actions, and its inline reply. A press on the row's own space follows the context link, so the
 * text stays selectable and the link is the one way in for the keyboard.
 */
export function InboxRow({ unread, mark, initial, headline, age, context, children, actions, reply, kind }: InboxRowProps) {
  const Glyph = glyphs[mark];
  const person = mark === 'reply' || mark === 'mention';
  const open = (event: MouseEvent<HTMLElement>) => {
    if (!rowPress(event)) return;
    const link = event.currentTarget.querySelector<HTMLAnchorElement>('.pb-notice__context a');
    link?.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      }),
    );
  };
  return (
    // The row's press is a pointer shortcut to its context link, which the keyboard reaches itself.
    <li className="pb-notice" data-read={unread ? undefined : ''} data-kind={kind} data-link={context ? '' : undefined} onClick={open}>
      <span className="pb-notice__dot" aria-hidden="true" />
      {person ? (
        <span className="pb-notice__mark" aria-hidden="true">
          <Avatar.Root size="md">
            <Avatar.Fallback>{initial || '?'}</Avatar.Fallback>
          </Avatar.Root>
          <span className="pb-notice__kind">
            <Glyph />
          </span>
        </span>
      ) : (
        <span className="pb-notice__glyph" aria-hidden="true">
          <Glyph />
        </span>
      )}
      <div className="pb-notice__main">
        <Text as="p" size="sm" className="pb-notice__title">
          <span className="pb-notice__headline">{headline}</span>
          {age && (
            <Text size="sm" color="muted" className="pb-notice__age">
              {age}
            </Text>
          )}
        </Text>
        {context && (
          <Text as="p" size="sm" color="muted" className="pb-notice__context">
            {context}
          </Text>
        )}
        {children}
        <div className="pb-notice__actions">{actions}</div>
        {reply}
      </div>
    </li>
  );
}

export interface InboxReplyLabels {
  /** The field's name, visually hidden ("Reply to @ada"); also its placeholder. */
  field: string;
  send: string;
  cancel: string;
}

export interface InboxReplyProps {
  id: string;
  labels: InboxReplyLabels;
  value: string;
  onChange: (value: string) => void;
  /** Called on Send (or Ctrl or Command with Enter). Without it the browser posts the form to `action`. */
  onSubmit?: () => void;
  /** Closes the field (Cancel, or Escape in it); the text stays with the caller, and a reply being sent still goes. */
  onCancel: () => void;
  /** Where the form posts without JavaScript, the reply's fields in its query (the comment form's endpoint). */
  action: string;
  pending?: boolean;
  /** The refusal, under the field; the text stays. */
  error?: string;
}

/**
 * A reply written in place under a notice: a plain form, so it posts to `action` before scripts run;
 * once hydrated the caller sends it (`onSubmit`). The caller moves focus into it when the reader opens it.
 */
export function InboxReply({ id, labels, value, onChange, onSubmit, onCancel, action, pending, error }: InboxReplyProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    if (!onSubmit) return;
    event.preventDefault();
    if (value.trim() !== '' && !pending) onSubmit();
  }

  function keys(event: KeyboardEvent<HTMLFormElement>) {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    // The script checks for an empty reply itself; the browser's check would also hold back a resend while a refusal marks the field invalid.
    <form
      id={id}
      className="pb-notice__reply"
      method="post"
      action={action}
      noValidate={onSubmit !== undefined}
      onSubmit={submit}
      onKeyDown={keys}
    >
      <TextAreaField
        label={labels.field}
        hideLabel
        name="body"
        rows={2}
        placeholder={labels.field}
        value={value}
        onChange={onChange}
        readOnly={pending}
        required
        invalid={error !== undefined}
        errorMessage={error}
      />
      <div className="pb-notice__actions">
        <Button variant="ghost" size="sm" onActivate={onCancel}>
          {labels.cancel}
        </Button>
        <Button type="submit" variant="primary" size="sm" pending={pending} aria-keyshortcuts="Control+Enter Meta+Enter">
          {labels.send}
        </Button>
      </div>
    </form>
  );
}
