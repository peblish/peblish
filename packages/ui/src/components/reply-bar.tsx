import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from './button.tsx';
import { Card } from './card.tsx';
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
  /** Disables the field and button while a reply is being sent. */
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
 * The reply bar docked to the bottom of the thread (thread-docked): a raised Mux Card with who
 * you are answering, "post instead", cancel, and a text field. A plain form, so it posts
 * without JavaScript when given an `action`; once hydrated it calls `onSubmit` instead.
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
    if (body.trim() === '') return;
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
      onSubmit={submit}
      onKeyDown={shortcut}
    >
      <Card.Root variant={docked ? 'elevated' : 'outlined'} padding="sm" className="pb-reply__box">
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
              <Button variant="ghost" size="sm" onActivate={onPostInstead}>
                {labels.postInstead}
              </Button>
            )}
            {onCancel && (
              <Button variant="ghost" size="sm" onActivate={onCancel}>
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
            disabled={pending}
            required
            invalid={error !== undefined}
            errorMessage={error}
          />
          <Button type="submit" variant="primary" disabled={pending}>
            {labels.submit}
          </Button>
        </div>
      </Card.Root>
    </form>
  );
}
