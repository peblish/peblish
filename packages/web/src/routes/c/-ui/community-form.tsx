import { insertSpoiler } from '@peblish/core/markdown/toolbar';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { FileTrigger } from '@peblish/ui/components/file-trigger';
import { Group } from '@peblish/ui/components/group';
import { IconButton } from '@peblish/ui/components/icon-button';
import { ArrowDown, ArrowUp, CloseIcon } from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { MarkdownEditor } from '@peblish/ui/composer/markdown-editor';
import { useRouter } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { openInRouter } from '../../../shell/client-links.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, editCommunityPath, newCommunityPath } from '../../../shell/paths.ts';
import { previewBody } from '../../submit/-load.ts';
import { useEditorLabels } from '../../submit/-ui/labels.ts';
import { errorKey } from '../-errors.ts';
import { communityRulesMax, formLanguages, problemsOf, readFormValues, type FieldProblem, type FormValues } from '../-form.ts';

// The community form after the R2 mock community-form-page, in Mux UI: one page with a section
// index, each section an outlined Card, and a sticky save bar, for a new community (admins) and
// the edit page (owner, moderator, admin). It posts to its own address and works without
// JavaScript; hydrated, it checks the fields with the function the server uses, posts by fetch
// and keeps what was typed when something is refused.

export interface CommunityFormProps {
  /** A new community, with a name to choose; else an edit of `handle`, whose name is fixed. */
  handle: string | null;
  initial: FormValues;
  /** Icon and banner uploads are off (`uploads.enabled`): their rows are shown disabled. */
  uploadsOff: boolean;
  /** A refusal the last post came back with (?error=). */
  error: string | undefined;
}

let nextKey = 0;
type Row = { key: number; title: string; body: string };

const sections = ['basics', 'rules', 'images', 'content', 'visibility'] as const;
type Section = (typeof sections)[number];

/** One part of the form: a named section holding an outlined Card with its heading. `describedBy` names a message about the whole section. */
function FormSection({ id, title, describedBy, children }: { id: Section; title: string; describedBy?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} aria-describedby={describedBy}>
      <Card.Root variant="outlined" className="cm-section">
        <Card.Header>
          <Text as="h2" variant="title" size="sm" id={`${id}-title`}>
            {title}
          </Text>
        </Card.Header>
        <Card.Body className="cm-section-body">{children}</Card.Body>
      </Card.Root>
    </section>
  );
}

export function CommunityForm({ handle, initial, uploadsOff, error }: CommunityFormProps) {
  const { t } = useTranslate();
  useRouteHydrated();
  const router = useRouter();
  const hydrated = useHydrated();
  const editorLabels = useEditorLabels();
  const creating = handle === null;
  const action = creating ? newCommunityPath : editCommunityPath(handle);
  const [description, setDescription] = useState(initial.description);
  // One empty row at the end keeps adding a rule possible before the page has hydrated.
  const [rows, setRows] = useState<Row[]>(() => [
    ...initial.rules.map((rule) => ({ key: nextKey++, ...rule })),
    ...(initial.rules.length < communityRulesMax ? [{ key: nextKey++, title: '', body: '' }] : []),
  ]);
  const [nsfl, setNsfl] = useState(initial.nsfl);
  const [nsfw, setNsfw] = useState(initial.sensitive || initial.nsfl);
  const [problems, setProblems] = useState<Partial<Record<FieldProblem, true>>>({});
  const [failure, setFailure] = useState<string | undefined>(error);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const filledRules = rows.filter((row) => row.title.trim() !== '').length;
  const move = (index: number, by: -1 | 1) =>
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row) next.splice(index + by, 0, row);
      return next;
    });
  const message = (key: string, params?: Record<string, string | number>) => t('communities', key as MessageKey<'communities'>, params);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found = problemsOf(readFormValues(data), creating);
    setProblems(found);
    setFailure(undefined);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const response = await fetch(action, { method: 'POST', body: data, headers: { accept: 'application/json' } });
      const answer = (await response.json()) as { redirect?: string; error?: string };
      if (answer.redirect) openInRouter(router, answer.redirect);
      else setFailure(answer.error ?? 'generic');
    } catch {
      setFailure('generic');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="cm-form" data-state={creating ? 'create' : 'edit'}>
      <header className="cm-form-head">
        <Text as="h1" variant="heading" size="md">
          {message(creating ? 'form.title.create' : 'form.title.edit')}
        </Text>
        {handle !== null && (
          <Text as="p" color="muted">
            !{handle}
          </Text>
        )}
      </header>
      <div className="cm-form-layout">
        <nav className="cm-index" aria-label={message('form.index')}>
          <ul>
            {sections.map((section) => (
              <li key={section}>
                <Link className="pb-link-quiet" href={`#${section}`}>
                  {message(`form.section.${section}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <form
          method="post"
          action={action}
          onSubmit={(event) => void submit(event)}
          onChange={() => setDirty(true)}
          className="cm-form-body"
          noValidate
        >
          {failure && !failure.startsWith('name.') && (
            <Notice tone="danger" role="alert">
              {t('communities', errorKey(failure))}
            </Notice>
          )}
          {Object.keys(problems).length > 0 && (
            <Notice tone="danger" role="alert">
              {message('form.error.summary')}
            </Notice>
          )}

          <FormSection id="basics" title={message('form.section.basics')}>
            {creating ? (
              <TextField
                label={message('form.name.label')}
                name="name"
                defaultValue={initial.name}
                maxLength={50}
                autoComplete="off"
                required
                description={message('form.name.hint')}
                invalid={problems.name === true || failure?.startsWith('name.') === true}
                errorMessage={t('communities', errorKey(problems.name ? 'name.invalid' : failure))}
              />
            ) : (
              <div>
                <Text as="p">
                  <Text variant="label">{message('form.address')}</Text> !{handle} <Badge>{message('form.fixed')}</Badge>
                </Text>
                <Text as="p" size="sm" color="muted">
                  {message('form.name.fixed')}
                </Text>
              </div>
            )}
            <TextField
              label={message('form.displayName.label')}
              name="displayName"
              defaultValue={initial.displayName}
              maxLength={100}
              description={message('form.displayName.hint')}
              invalid={problems.displayName === true}
              errorMessage={message('form.error.displayName')}
            />
            <MarkdownEditor
              name="description"
              label={message('form.description.label')}
              value={description}
              onChange={(value) => {
                setDescription(value);
                setDirty(true);
              }}
              labels={editorLabels}
              insertSpoiler={(value, start, end) => insertSpoiler(value, start, end, t('composer', 'editor.spoilerTitle'))}
              renderPreview={async (source) => {
                const rendered = await previewBody({ data: { source } });
                if (!rendered) throw new Error('preview refused');
                return rendered.html;
              }}
              description={message('form.description.hint')}
              invalid={problems.description === true}
              errorMessage={message('form.error.description')}
            />
          </FormSection>

          {/* The rules' own error is about the list as a whole, so it describes the section. */}
          <FormSection id="rules" title={message('form.section.rules')} describedBy={problems.rules ? 'rules-error' : undefined}>
            <ol className="cm-rule-rows">
              {rows.map((row, index) => (
                <li key={row.key}>
                  <TextField
                    label={message('form.rule.label', { n: index + 1 })}
                    name={`rules.${index}.title`}
                    value={row.title}
                    onChange={(title) =>
                      setRows((current) => current.map((other) => (other.key === row.key ? { ...other, title } : other)))
                    }
                    maxLength={200}
                  />
                  {/* The rule's text is kept as it was: this form edits titles only. */}
                  <input type="hidden" name={`rules.${index}.body`} value={row.body} />
                  <span className="cm-rule-buttons">
                    <IconButton
                      variant="ghost"
                      disabled={!hydrated || index === 0}
                      onActivate={() => move(index, -1)}
                      aria-label={message('form.rule.up', { n: index + 1 })}
                    >
                      <ArrowUp />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      disabled={!hydrated || index === rows.length - 1}
                      onActivate={() => move(index, 1)}
                      aria-label={message('form.rule.down', { n: index + 1 })}
                    >
                      <ArrowDown />
                    </IconButton>
                    <IconButton
                      variant="danger-ghost"
                      disabled={!hydrated}
                      onActivate={() => {
                        setRows((current) => current.filter((other) => other.key !== row.key));
                        setDirty(true);
                      }}
                      aria-label={message('form.rule.remove', { n: index + 1 })}
                    >
                      <CloseIcon />
                    </IconButton>
                  </span>
                </li>
              ))}
            </ol>
            {problems.rules ? (
              <Notice tone="danger" role="alert" id="rules-error">
                {message('form.error.rules')}
              </Notice>
            ) : (
              <Text as="p" size="sm" color="muted">
                {message('form.rules.count', { count: filledRules, max: communityRulesMax })}
              </Text>
            )}
            <Button
              type="button"
              variant="neutral"
              disabled={!hydrated || rows.length >= communityRulesMax}
              onActivate={() => {
                setRows((current) => [...current, { key: nextKey++, title: '', body: '' }]);
                setDirty(true);
              }}
            >
              {message('form.rules.add')}
            </Button>
          </FormSection>

          <FormSection id="images" title={message('form.section.images')}>
            {(['icon', 'banner'] as const).map((kind) => (
              <div key={kind} className="cm-image-row">
                <span className="cm-image-pick">
                  <FileTrigger acceptedFileTypes={['image/*']} disabled>
                    <Button variant="neutral" disabled>
                      {message(`form.images.${kind}`)}
                    </Button>
                  </FileTrigger>
                  {uploadsOff && <Badge>{message('form.images.off')}</Badge>}
                </span>
                <Text as="p" size="sm" color="muted">
                  {message(`form.images.${kind}Hint`)}
                </Text>
              </div>
            ))}
            {uploadsOff && (
              <Text as="p" size="sm" color="muted">
                {message('form.images.note')}
              </Text>
            )}
          </FormSection>

          <FormSection id="content" title={message('form.section.content')}>
            <Checkbox name="sensitive" checked={nsfw || nsfl} disabled={nsfl} onChange={setNsfw} description={message('form.nsfw.hint')}>
              {message('form.nsfw.label')}
            </Checkbox>
            <Checkbox
              name="nsfl"
              checked={nsfl}
              onChange={(checked) => {
                setNsfl(checked);
                setDirty(true);
              }}
              description={message('form.nsfl.hint')}
            >
              {message('form.nsfl.label')}
            </Checkbox>
            <Checkbox name="restricted" defaultChecked={initial.restricted} description={message('form.restricted.hint')}>
              {message('form.restricted.label')}
            </Checkbox>
            {/* A Mux Group named by its label; the app's Checkbox keeps each box drawn right without script. */}
            <div className="cm-languages">
              <Text as="span" variant="label" id="languages-label">
                {message('form.languages.legend')}
              </Text>
              <Group aria-labelledby="languages-label" aria-describedby="languages-hint" className="cm-language-boxes">
                {formLanguages.map((code) => (
                  <Checkbox key={code} name={`lang.${code}`} defaultChecked={initial.languages.includes(code)}>
                    {message(`form.language.${code}`)}
                  </Checkbox>
                ))}
              </Group>
              <Text as="p" size="sm" color="muted" id="languages-hint">
                {message('form.languages.hint')}
              </Text>
            </div>
          </FormSection>

          <FormSection id="visibility" title={message('form.section.visibility')}>
            <Checkbox name="discoverable" defaultChecked={initial.discoverable} description={message('form.discoverable.hint')}>
              {message('form.discoverable.label')}
            </Checkbox>
            <Checkbox name="indexable" defaultChecked={initial.indexable} description={message('form.indexable.hint')}>
              {message('form.indexable.label')}
            </Checkbox>
          </FormSection>

          {!creating && (
            <Text as="p" size="sm" color="muted">
              {message('form.log')}
            </Text>
          )}

          <div className="cm-savebar">
            <Button type="submit" variant="primary" pending={busy}>
              {message(creating ? 'form.create' : 'form.save')}
            </Button>
            <Link href={creating ? '/' : communityPath({ handle })}>{message('form.cancel')}</Link>
            {creating && <Badge>{message('form.adminOnly')}</Badge>}
            <Text size="sm" color="muted" role="status">
              {dirty ? message('form.dirty') : ''}
            </Text>
          </div>
        </form>
      </div>
    </main>
  );
}
