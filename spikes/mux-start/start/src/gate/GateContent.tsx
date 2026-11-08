import {
  Button,
  ColorModeToggle,
  DateField,
  Dialog,
  Menu,
  NumberField,
  Select,
  Table,
  Tabs,
  ToastProvider,
  Tooltip,
  Virtualizer,
  useToast,
  type MuxUISelection,
} from '@muxui/react';
import { Markdown } from '@muxui/react/markdown';
import { TextEditor, type TextEditorDocument, type TextEditorNode } from '@muxui/react/text-editor';
import { useEffect, useState } from 'react';

const MARKDOWN_SOURCE = `## Markdown probe

A paragraph with **bold**, _emphasis_, \`inline code\` and ~~struck text~~.

| Name | Role |
| --- | --- |
| Ada | Mathematician |
| Grace | Admiral |

\`\`\`ts
const answer: number = 42;
\`\`\`
`;

const TABLE_ROWS = Array.from({ length: 10 }, (_, index) => ({
  id: `row-${index + 1}`,
  name: `Member ${index + 1}`,
  karma: String((index + 1) * 137),
}));

const VIRTUAL_ITEMS = Array.from({ length: 20 }, (_, index) => ({
  id: `item-${index + 1}`,
  label: `Virtual item ${String(index + 1).padStart(2, '0')}`,
}));

/** Plain text of an editor document, for the e2e assertion. */
function documentText(node: TextEditorDocument | TextEditorNode): string {
  if (node.type === 'text') return node.text;
  if (!('content' in node) || !node.content) return '';
  return node.content.map((child: TextEditorNode) => documentText(child)).join(node.type === 'doc' ? '\n' : '');
}

function ToastAction() {
  const { add } = useToast();
  return <Button onActivate={() => add('Saved from the gate', { title: 'Gate toast' })}>Show toast</Button>;
}

type GateProps = {
  locale: string;
  variant: 'i18n' | 'plain' | 'quiet';
  /** Re-render the gate once after mount, as most apps do incidentally. The quiet variant does not. */
  postMountRender?: boolean;
};

export function GateContent({ locale, variant, postMountRender = true }: GateProps) {
  const [clicks, setClicks] = useState(0);
  const [selection, setSelection] = useState<MuxUISelection>([]);
  const [menuAction, setMenuAction] = useState('');
  const [tab, setTab] = useState('hot');
  const [editorText, setEditorText] = useState('');
  const [, setMounted] = useState(false);

  // The page hydration marker the e2e suite waits for. It lives here, not in the root:
  // TanStack Router wraps the root Outlet's child in a Suspense boundary, which React
  // hydrates in a later pass than the root shell, so a root effect fires too early.
  useEffect(() => {
    document.documentElement.dataset.hydrated = '1';
    if (postMountRender) setMounted(true);
  }, [postMountRender]);

  // Diagnostic: counts the gate's commits on <html> so the e2e probe can see post-hydration renders.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.gateCommits = String(Number(root.dataset.gateCommits ?? '0') + 1);
  });

  return (
    <ToastProvider>
      <main className="gate" data-gate-variant={variant}>
        <header className="row">
          <h1>Mux UI hydration gate</h1>
          <span data-testid="server-locale">{locale}</span>
          <ColorModeToggle defaultMode="light">Dark mode</ColorModeToggle>
        </header>

        <section aria-labelledby="h-button">
          <h2 id="h-button">Button</h2>
          <div className="row">
            <Button onActivate={() => setClicks((count) => count + 1)}>Count clicks</Button>
            <output data-testid="click-count">{clicks}</output>
          </div>
          <div className="nested-scope" data-muxui-theme="standard-lagoon" data-muxui-color-scheme="dark" data-testid="nested-dark-scope">
            <Button variant="neutral">Nested dark scope</Button>
          </div>
        </section>

        <section aria-labelledby="h-dialog">
          <h2 id="h-dialog">Dialog</h2>
          <Dialog title="Gate dialog" trigger={<Button>Open dialog</Button>}>
            The dialog opened on the first click.
          </Dialog>
        </section>

        <section aria-labelledby="h-menu">
          <h2 id="h-menu">Menu</h2>
          <div className="row">
            <Menu.Root onAction={(item) => setMenuAction(item?.id ?? '')}>
              <Menu.Trigger>Post actions</Menu.Trigger>
              <Menu.Popup>
                <Menu.List aria-label="Post actions">
                  <Menu.Item id="upvote">Upvote</Menu.Item>
                  <Menu.Item id="save">Save</Menu.Item>
                  <Menu.Item id="report">Report</Menu.Item>
                </Menu.List>
              </Menu.Popup>
            </Menu.Root>
            <output data-testid="menu-action">{menuAction}</output>
          </div>
        </section>

        <section aria-labelledby="h-tabs">
          <h2 id="h-tabs">Tabs</h2>
          <Tabs
            aria-label="Sort"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'hot', label: 'Hot', panel: 'Hot posts panel' },
              { id: 'new', label: 'New', panel: 'New posts panel' },
              { id: 'top', label: 'Top', panel: 'Top posts panel' },
            ]}
          />
        </section>

        <section aria-labelledby="h-table">
          <h2 id="h-table">Table</h2>
          <Table
            aria-label="Members"
            selectionMode="multiple"
            selectedIds={selection}
            onSelectionChange={setSelection}
            columns={[
              { id: 'name', label: 'Name', isRowHeader: true },
              { id: 'karma', label: 'Karma' },
            ]}
            rows={TABLE_ROWS}
          />
          <output data-testid="table-selection">{selection === 'all' ? 'all' : selection.join(',')}</output>
        </section>

        <section aria-labelledby="h-select">
          <h2 id="h-select">Select</h2>
          <Select label="Community" items={['fediverse', 'selfhosted', 'linux']} />
        </section>

        <section aria-labelledby="h-toast">
          <h2 id="h-toast">Toast</h2>
          <ToastAction />
        </section>

        <section aria-labelledby="h-tooltip">
          <h2 id="h-tooltip">Tooltip</h2>
          <Tooltip trigger={<Button variant="neutral">Hover for help</Button>} content="Tooltip content" />
        </section>

        <section aria-labelledby="h-locale">
          <h2 id="h-locale">Locale-dependent fields</h2>
          <div className="row">
            <div data-testid="number-field">
              {/* Mux defaults step to 1, which would snap 1234.5 to 1235. */}
              <NumberField label="Bounty" defaultValue={1234.5} step={0.01} formatOptions={{ style: 'currency', currency: 'EUR' }} />
            </div>
            <div data-testid="date-field">
              <DateField label="Posted" defaultValue="2026-11-08" />
            </div>
          </div>
        </section>

        <section aria-labelledby="h-markdown">
          <h2 id="h-markdown">Markdown</h2>
          <Markdown source={MARKDOWN_SOURCE} data-testid="markdown" />
        </section>

        <section aria-labelledby="h-editor">
          <h2 id="h-editor">TextEditor</h2>
          <TextEditor
            label="Comment"
            placeholder="Write a comment"
            onChange={(value) => setEditorText(documentText(value))}
          />
          <output data-testid="editor-text">{editorText}</output>
        </section>

        <section aria-labelledby="h-virtualizer">
          <h2 id="h-virtualizer">Virtualizer</h2>
          <Virtualizer aria-label="Virtual feed" items={VIRTUAL_ITEMS} height={160} itemHeight={32} />
        </section>
      </main>
    </ToastProvider>
  );
}
