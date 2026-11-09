import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Prose } from '../components/prose.tsx';
import { TextAreaField } from '../components/text-area.tsx';
import { Toolbar } from '../components/toolbar.tsx';
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

  const actions: { label: string; glyph?: ReactNode; shortcut?: string; insert: Insert }[] = [
    { label: labels.bold, glyph: <b>B</b>, shortcut: 'Ctrl+B', insert: wrap('**') },
    { label: labels.italic, glyph: <i>I</i>, shortcut: 'Ctrl+I', insert: wrap('*') },
    { label: labels.strikethrough, glyph: <s>S</s>, insert: wrap('~~') },
    { label: labels.link, shortcut: 'Ctrl+K', insert: link({ text: labels.linkText, url: labels.linkUrl }) },
    { label: labels.quote, insert: quote },
    { label: labels.code, insert: code },
    { label: labels.bulletList, insert: bulletList },
    { label: labels.numberedList, glyph: '1.', insert: numberedList },
    { label: labels.heading, glyph: 'H', insert: heading },
    { label: labels.spoiler, insert: insertSpoiler },
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

  return (
    <div className={className ? `pb-md ${className}` : 'pb-md'} ref={root} onKeyDown={onKeyDown}>
      <div className="pb-md__views" role="group" aria-label={labels.view}>
        {(['write', 'preview'] as const).map((id) => (
          <button
            key={id}
            type="button"
            className="pb-md__view"
            aria-pressed={view === id}
            disabled={!enhanced || disabled}
            onClick={() => void show(id)}
          >
            {labels[id]}
          </button>
        ))}
      </div>
      {/* The write pane stays mounted while previewing, so the form still carries the text. */}
      <div className="pb-md__write" hidden={view === 'preview'}>
        <Toolbar aria-label={labels.toolbar} className="pb-md__bar">
          {actions.map(({ label: name, glyph, shortcut, insert }) => (
            <button
              key={name}
              type="button"
              className="pb-md__btn"
              title={shortcut ? `${name} (${shortcut})` : name}
              disabled={!enhanced || disabled}
              onClick={() => apply(insert)}
            >
              {/* A symbol is hidden from assistive technology; the name it stands for is read instead. */}
              {glyph === undefined ? (
                name
              ) : (
                <>
                  <span aria-hidden="true">{glyph}</span>
                  <span className="pb-sr">{name}</span>
                </>
              )}
            </button>
          ))}
        </Toolbar>
        <TextAreaField
          label={label}
          hideLabel
          name={name}
          rows={rows}
          value={value}
          onChange={onChange}
          description={description}
          invalid={invalid}
          errorMessage={errorMessage}
          disabled={disabled}
          className="pb-md__field"
        />
      </div>
      {view === 'preview' && (
        <div className="pb-md__preview" aria-live="polite" aria-busy={preview.status === 'loading'}>
          {preview.status === 'loading' && <p className="pb-muted">{labels.previewLoading}</p>}
          {preview.status === 'idle' && <p className="pb-muted">{labels.previewEmpty}</p>}
          {preview.status === 'failed' && <p role="alert">{labels.previewFailed}</p>}
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
