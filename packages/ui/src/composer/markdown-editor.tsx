import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton } from '../components/icon-button.tsx';
import { Notice } from '../components/notice.tsx';
import { Prose } from '../components/prose.tsx';
import { Text } from '../components/text.tsx';
import { TextArea } from '../components/mux-text-area.tsx';
import { ToggleButton, ToggleButtonGroup } from '../components/toggle-button-group.tsx';
import { Toolbar } from '../components/toolbar.tsx';
import { Tooltip } from '../components/tooltip.tsx';
import {
  BoldIcon,
  BulletListIcon,
  CodeIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  NumberedListIcon,
  QuoteIcon,
  SpoilerIcon,
  StrikeIcon,
} from './editor-icons.tsx';
import { bulletList, code, heading, link, numberedList, quote, wrap, type Insert } from './insert.ts';
import { useHydrated } from './use-hydrated.ts';

export interface MarkdownEditorLabels {
  /** Names the row of formatting buttons. */
  toolbar: string;
  bold: string;
  italic: string;
  strikethrough: string;
  link: string;
  quote: string;
  code: string;
  bulletList: string;
  numberedList: string;
  heading: string;
  spoiler: string;
  /** What a new link shows before it is filled in: the link's text and its address. */
  linkText: string;
  linkUrl: string;
  /** Names the Write and Preview pair. */
  view: string;
  write: string;
  preview: string;
  previewLoading: string;
  previewEmpty: string;
  previewFailed: string;
}

export interface MarkdownEditorProps {
  /** The field's name in the form. */
  name: string;
  /** The textarea's name for assistive technology; the page shows its own visible label. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  labels: MarkdownEditorLabels;
  /** The spoiler button's edit: core's `insertSpoiler` with the localised title bound (ui imports no core). */
  insertSpoiler: Insert;
  /** The server's rendering of the text, the same renderer the published page uses. */
  renderPreview: (source: string) => Promise<string>;
  /** Shown above the rendered text in Preview, such as the post's title. */
  previewLead?: ReactNode;
  rows?: number;
  description?: ReactNode;
  invalid?: boolean;
  errorMessage?: ReactNode;
  disabled?: boolean;
  /** Ctrl or Command with Enter in the text. */
  onSubmitShortcut?: () => void;
  className?: string;
}

type Preview = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; html: string } | { status: 'failed' };

/**
 * A plain textarea with a row of buttons that insert Markdown at the selection, and a Write and
 * Preview pair. The text is never rendered in the browser: Preview asks the server through
 * `renderPreview`, so it shows what will be published. The buttons and the pair need
 * JavaScript, so they stay disabled until the page has hydrated; the textarea works without it.
 * Edits go through `execCommand('insertText')` so that Undo still works after a button.
 */
export function MarkdownEditor({
  name,
  label,
  value,
  onChange,
  labels,
  insertSpoiler,
  renderPreview,
  previewLead,
  rows = 9,
  description,
  invalid,
  errorMessage,
  disabled,
  onSubmitShortcut,
  className,
}: MarkdownEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const requested = useRef(0);
  const enhanced = useHydrated();
  const errorId = useId();
  const [view, setView] = useState<'write' | 'preview'>('write');
  const [preview, setPreview] = useState<Preview>({ status: 'idle' });

  // A re-render after an edit must not move the caret off the edit's own selection.
  useLayoutEffect(() => {
    const area = root.current?.querySelector('textarea');
    if (area && selection.current) area.setSelectionRange(selection.current.start, selection.current.end);
    selection.current = null;
  }, [value]);

  function apply(insert: Insert) {
    const area = root.current?.querySelector('textarea');
    if (!area) return;
    const next = insert(area.value, area.selectionStart, area.selectionEnd);
    if (next.value !== area.value) {
      selection.current = { start: next.selectionStart, end: next.selectionEnd };
      area.focus();
      area.select();
      // The browser's own edit keeps the undo history; where it refuses, the controlled value does the job.
      if (!document.execCommand('insertText', false, next.value)) onChange(next.value);
    }
    area.setSelectionRange(next.selectionStart, next.selectionEnd);
    area.focus();
  }

  const actions: { label: string; icon: ReactNode; shortcut?: string; insert: Insert }[] = [
    { label: labels.bold, icon: <BoldIcon />, shortcut: 'Ctrl+B', insert: wrap('**') },
    { label: labels.italic, icon: <ItalicIcon />, shortcut: 'Ctrl+I', insert: wrap('*') },
    { label: labels.strikethrough, icon: <StrikeIcon />, insert: wrap('~~') },
    { label: labels.link, icon: <LinkIcon />, shortcut: 'Ctrl+K', insert: link({ text: labels.linkText, url: labels.linkUrl }) },
    { label: labels.quote, icon: <QuoteIcon />, insert: quote },
    { label: labels.code, icon: <CodeIcon />, insert: code },
    { label: labels.bulletList, icon: <BulletListIcon />, insert: bulletList },
    { label: labels.numberedList, icon: <NumberedListIcon />, insert: numberedList },
    { label: labels.heading, icon: <HeadingIcon />, insert: heading },
    { label: labels.spoiler, icon: <SpoilerIcon />, insert: insertSpoiler },
  ];
  const shortcuts: Record<string, Insert | undefined> = { b: actions[0]?.insert, i: actions[1]?.insert, k: actions[3]?.insert };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !(event.target instanceof HTMLTextAreaElement)) return;
    if (event.key === 'Enter' && onSubmitShortcut) {
      event.preventDefault();
      onSubmitShortcut();
      return;
    }
    const insert = shortcuts[event.key.toLowerCase()];
    if (!insert) return;
    event.preventDefault();
    apply(insert);
  }

  async function show(next: 'write' | 'preview') {
    setView(next);
    if (next === 'write') return;
    const mine = ++requested.current;
    if (value.trim() === '') return setPreview({ status: 'idle' });
    setPreview({ status: 'loading' });
    try {
      const html = await renderPreview(value);
      if (mine === requested.current) setPreview({ status: 'ready', html });
    } catch {
      if (mine === requested.current) setPreview({ status: 'failed' });
    }
  }

  const off = !enhanced || disabled;
  return (
    <div className={className ? `pb-md ${className}` : 'pb-md'} ref={root} onKeyDown={onKeyDown}>
      <div className="pb-md__head">
        <ToggleButtonGroup
          aria-label={labels.view}
          selectionMode="single"
          disallowEmptySelection
          size="sm"
          selectedIds={[view]}
          onSelectionChange={([next]) => (next === 'write' || next === 'preview') && void show(next)}
          disabled={off}
        >
          <ToggleButton id="write">{labels.write}</ToggleButton>
          <ToggleButton id="preview">{labels.preview}</ToggleButton>
        </ToggleButtonGroup>
        {view === 'write' && (
          <Toolbar aria-label={labels.toolbar} className="pb-md__bar">
            {actions.map(({ label: name, icon, shortcut, insert }) => (
              <Tooltip
                key={name}
                content={shortcut ? `${name} (${shortcut})` : name}
                trigger={
                  <IconButton aria-label={name} size="sm" disabled={off} onActivate={() => apply(insert)}>
                    {icon}
                  </IconButton>
                }
              />
            ))}
          </Toolbar>
        )}
      </div>
      {/* The write pane stays mounted while previewing, so the form still carries the text. */}
      <div className="pb-md__write" hidden={view === 'preview'}>
        {/* Mux UI's TextArea parts rather than the shared TextAreaField, for the error: once hydrated
            nothing else tells a person what is wrong, so it is an alert, and an error that appears
            after the first render is linked to the field only by an id it already has (Mux UI rc.6). */}
        <TextArea.Root value={value} onChange={onChange} invalid={invalid} disabled={disabled}>
          <TextArea.Label className="pb-sr">{label}</TextArea.Label>
          <TextArea.TextArea name={name} rows={rows} />
          {description && <TextArea.Description>{description}</TextArea.Description>}
          {invalid && errorMessage && (
            // React Aria's FieldError, under TextArea.Error, drops a role, so the alert is inside it.
            <TextArea.Error id={errorId}>
              <span role="alert">{errorMessage}</span>
            </TextArea.Error>
          )}
        </TextArea.Root>
      </div>
      {view === 'preview' && (
        <div className="pb-md__preview" aria-live="polite" aria-busy={preview.status === 'loading'}>
          {preview.status === 'loading' && (
            <Text as="p" color="muted">
              {labels.previewLoading}
            </Text>
          )}
          {preview.status === 'idle' && (
            <Text as="p" color="muted">
              {labels.previewEmpty}
            </Text>
          )}
          {preview.status === 'failed' && (
            <Notice tone="danger" role="alert">
              {labels.previewFailed}
            </Notice>
          )}
          {preview.status === 'ready' && (
            <>
              {previewLead}
              <Prose html={preview.html} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
