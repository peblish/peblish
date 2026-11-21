import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './button.tsx';
import { Text } from './text.tsx';
import { TextAreaField } from './text-area.tsx';

export interface ReplyBarLabels {
  /** The bar's name for assistive technology: "Reply". */
  region: string;
  /** The text field's label (visually hidden). */
  field: string;
  placeholder: string;
  submit: string;
  /** "Replying to" before the comment's author. */
  replyingTo: string;
  /** Switches the target from the comment to the post itself. */
  postInstead: string;
  cancel: string;
}

export interface ReplyBarProps {
  /** The comment being answered; null when the reply goes to the post itself. */
  target: { handle: string; excerpt: string } | null;
  labels: ReplyBarLabels;
  /** Called with the text when the form is submitted (the button, or Ctrl or Command with Enter). Without it the browser posts the form to `action`. */
  onSubmit?: (body: string) => void | Promise<void>;
  /** Where the form posts without JavaScript, with `fields` added to its query string (the parent id, the page it came from): the endpoint reads them there. */
  action?: string;
  fields?: Readonly<Record<string, string>>;
  /** Switches the reply to the post. Shown only while `target` is set. */
  onPostInstead?: () => void;
  /** Closes the bar. */
  onCancel?: () => void;
  /** A reply is being sent: the field keeps its text and focus but takes no typing, and Reply shows it is busy. */
  pending?: boolean;
  /** Error text for the field, such as a refusal's message. */
  error?: string;
  /** Sticks to the bottom of the screen (the default). False lays it out in the page, for a gallery or a test. */
  docked?: boolean;
}

/** `action` with `fields` in its query string. */
function withFields(action: string | undefined, fields: Readonly<Record<string, string>> | undefined) {
  if (!fields || Object.keys(fields).length === 0) return action;
  const base = action ?? '';
  return `${base}${base.includes('?') ? '&' : '?'}${new URLSearchParams(fields)}`;
}

/**
 * The thread's docked reply (Commons): the last thing in the comments, sticky to the bottom of the window
 * on the page's own opaque surface under a hairline, so it stays in view while the comments run on below
 * and comes to rest under the last one. It says who is being answered, with "post instead" and cancel, and
 * holds the Markdown text field and Reply. A plain form, so it posts without JavaScript when given an
 * `action`; once hydrated it calls `onSubmit` instead. Its height stays within the scroll padding the frame
 * keeps for a docked bar (web/src/shell/shell.css), so a focused element is never left under it.
 */
export function ReplyBar({
  target,
  labels,
  onSubmit,
  action,
  fields,
  onPostInstead,
  onCancel,
  pending,
  error,
  docked = true,
}: ReplyBarProps) {
  const [body, setBody] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    if (!onSubmit) return;
    event.preventDefault();
    if (pending || body.trim() === '') return;
    try {
      await onSubmit(body);
      setBody('');
    } catch {
      // The caller shows the refusal (the `error` prop); the text stays.
    }
  }

  function shortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target instanceof HTMLTextAreaElement) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }

  return (
    <form
      className={docked ? 'pb-reply' : 'pb-reply pb-reply--inline'}
      method="post"
      action={withFields(action, fields)}
      aria-label={labels.region}
      aria-busy={pending || undefined}
      onSubmit={submit}
      onKeyDown={shortcut}
    >
      {target && (
        <div className="pb-reply__to">
          <Text size="sm" truncate className="pb-reply__who">
            <Text size="sm" color="muted">
              {labels.replyingTo}
            </Text>{' '}
            <Text size="sm" variant="label">
              {target.handle}
            </Text>{' '}
            <Text size="sm" color="muted">
              {target.excerpt}
            </Text>
          </Text>
          {onPostInstead && (
            <Button variant="ghost" size="sm" className="pb-reply__action" onActivate={onPostInstead}>
              {labels.postInstead}
            </Button>
          )}
          {onCancel && (
            <Button variant="ghost" size="sm" className="pb-reply__action" onActivate={onCancel}>
              {labels.cancel}
            </Button>
          )}
        </div>
      )}
      <div className="pb-reply__input">
        <TextAreaField
          label={labels.field}
          hideLabel
          className="pb-reply__field"
          name="body"
          rows={2}
          placeholder={labels.placeholder}
          value={body}
          onChange={setBody}
          // Not disabled while sending: a disabled field would drop the focus it holds.
          readOnly={pending}
          required
          invalid={error !== undefined}
          errorMessage={error}
        />
        <Button type="submit" variant="primary" className="pb-reply__send" pending={pending} showTextWhileLoading>
          {labels.submit}
        </Button>
      </div>
    </form>
  );
}

/**
 * Says, where the docked reply would be, why there is none: the post is locked or closed, the reader must
 * sign in or verify their address first. `icon` goes before the words (a lock); `children` may hold a link.
 */
export function ReplyNotice({ icon, children, className }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Text as="p" size="sm" color="muted" role="status" className={['pb-reply-notice', className].filter(Boolean).join(' ')}>
      {icon}
      <span>{children}</span>
    </Text>
  );
}
