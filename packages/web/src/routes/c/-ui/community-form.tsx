import { insertSpoiler } from '@peblish/core/markdown/toolbar';
import { Button } from '@peblish/ui/components/button';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { TextField } from '@peblish/ui/components/text-field';
import { MarkdownEditor } from '@peblish/ui/composer/markdown-editor';
import { useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { openInRouter } from '../../../shell/client-links.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, editCommunityPath, newCommunityPath } from '../../../shell/paths.ts';
import { previewBody } from '../../submit/-load.ts';
import { useEditorLabels } from '../../submit/-ui/labels.ts';
import { errorKey } from '../-errors.ts';
import { useHydrated } from './use-hydrated.ts';
import { communityRulesMax, formLanguages, problemsOf, readFormValues, type FieldProblem, type FormValues } from '../-form.ts';

// The community form after the R2 mock community-form-page: one page with a section index and a
// sticky save bar, for a new community (admins) and the edit page (owner, moderator, admin). It
// posts to its own address and works without JavaScript; hydrated, it checks the fields with the
// function the server uses, posts by fetch and keeps what was typed when something is refused.

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
        <h1>{message(creating ? 'form.title.create' : 'form.title.edit')}</h1>
        {handle !== null && <p className="cm-muted">!{handle}</p>}
      </header>
      <div className="cm-form-layout">
        <nav className="cm-index" aria-label={message('form.index')}>
          <ul>
            {sections.map((section) => (
              <li key={section}>
                <a href={`#${section}`}>{message(`form.section.${section}`)}</a>
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
            <p role="alert" className="cm-error">
              {t('communities', errorKey(failure))}
            </p>
          )}
          {Object.keys(problems).length > 0 && (
            <p role="alert" className="cm-error">
              {message('form.error.summary')}
            </p>
          )}

          <section id="basics" aria-labelledby="basics-title">
            <h2 id="basics-title">{message('form.section.basics')}</h2>
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
              <p>
                <strong>{message('form.address')}</strong> !{handle} <span className="cm-tag">{message('form.fixed')}</span>
                <br />
                <span className="cm-muted">{message('form.name.fixed')}</span>
              </p>
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
          </section>

          <section id="rules" aria-labelledby="rules-title">
            <h2 id="rules-title">{message('form.section.rules')}</h2>
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
                  <input type="hidden" name={`rules.${index}.body`} value={row.body} />
                  <span className="cm-rule-buttons">
                    <button
                      type="button"
                      disabled={!hydrated || index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={message('form.rule.up', { n: index + 1 })}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={!hydrated || index === rows.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={message('form.rule.down', { n: index + 1 })}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      disabled={!hydrated}
                      onClick={() => setRows((current) => current.filter((other) => other.key !== row.key))}
                      aria-label={message('form.rule.remove', { n: index + 1 })}
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <p className={problems.rules ? 'cm-error' : 'cm-muted'} role={problems.rules ? 'alert' : undefined}>
              {problems.rules ? message('form.error.rules') : message('form.rules.count', { count: filledRules, max: communityRulesMax })}
            </p>
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
          </section>

          <section id="images" aria-labelledby="images-title">
            <h2 id="images-title">{message('form.section.images')}</h2>
            {(['icon', 'banner'] as const).map((kind) => (
              <p key={kind}>
                <label>
                  {message(`form.images.${kind}`)} <input type="file" disabled />
                </label>{' '}
                {uploadsOff && <span className="cm-tag">{message('form.images.off')}</span>}
                <br />
                <span className="cm-muted">{message(`form.images.${kind}Hint`)}</span>
              </p>
            ))}
            {uploadsOff && <p className="cm-muted">{message('form.images.note')}</p>}
          </section>

          <section id="content" aria-labelledby="content-title">
            <h2 id="content-title">{message('form.section.content')}</h2>
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
            <fieldset className="cm-languages">
              <legend>{message('form.languages.legend')}</legend>
              {formLanguages.map((code) => (
                <Checkbox key={code} name={`lang.${code}`} defaultChecked={initial.languages.includes(code)}>
                  {message(`form.language.${code}`)}
                </Checkbox>
              ))}
              <p className="cm-muted">{message('form.languages.hint')}</p>
            </fieldset>
          </section>

          <section id="visibility" aria-labelledby="visibility-title">
            <h2 id="visibility-title">{message('form.section.visibility')}</h2>
            <Checkbox name="discoverable" defaultChecked={initial.discoverable} description={message('form.discoverable.hint')}>
              {message('form.discoverable.label')}
            </Checkbox>
            <Checkbox name="indexable" defaultChecked={initial.indexable} description={message('form.indexable.hint')}>
              {message('form.indexable.label')}
            </Checkbox>
          </section>

          {!creating && <p className="cm-muted">{message('form.log')}</p>}

          <div className="cm-savebar">
            <Button type="submit" variant="primary" pending={busy}>
              {message(creating ? 'form.create' : 'form.save')}
            </Button>
            <a href={creating ? '/' : communityPath({ handle })}>{message('form.cancel')}</a>
            {creating && <span className="cm-tag">{message('form.adminOnly')}</span>}
            <span role="status" className="cm-muted">
              {dirty ? message('form.dirty') : ''}
            </span>
          </div>
        </form>
      </div>
    </main>
  );
}
