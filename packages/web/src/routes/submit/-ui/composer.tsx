import { insertSpoiler } from '@peblish/core/markdown/toolbar';
import { normalizeTitle, postTitleMaxLength } from '@peblish/core/posts/input';
import { markdownMaxLength } from '@peblish/schema/markdown';
import { Button } from '@peblish/ui/components/button';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { TextField } from '@peblish/ui/components/text-field';
import { MarkdownEditor } from '@peblish/ui/composer/markdown-editor';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { type } from 'arktype';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { firstProblem } from '../-fields.ts';
import { loadCommunityPanel, previewBody } from '../-load.ts';
import {
  asComposerError,
  errorField,
  postTypes,
  type ComposerData,
  type ComposerError,
  type CommunityPanel,
  type PostType,
} from '../-types.ts';
import { CommunityAside } from './community-aside.tsx';
import { CommunityPicker } from './community-picker.tsx';
import { clearDraft, readDraft, removeUnscopedDrafts, writeDraft } from './drafts.ts';
import { ErrorText } from './error-text.tsx';
import { useEditorLabels } from './labels.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

export type ReadyData = Extract<ComposerData, { status: 'ready' }>;

export interface ComposerProps {
  data: ReadyData;
  /** The refusal the page was reached by, without JavaScript. */
  error?: ComposerError;
  /** Posted or saved: the page or sheet goes to this path. */
  onDone: (path: string) => void;
  /** Discard: the page goes back, the sheet closes. */
  onDiscard: () => void;
  /** The sheet is dismissable: what was written and not sent is kept as a draft when it unmounts. */
  keepOnClose?: boolean;
}

interface Form {
  community: string | null;
  type: PostType;
  title: string;
  url: string;
  body: string;
  alt: string;
  nsfw: boolean;
}

const pristine = (form: Form) => form.title === '' && form.url === '' && form.body === '';

/**
 * The post being edited or an empty form, with what was typed before a refusal (without
 * JavaScript) laid over it: typed words win over the saved ones. An edit keeps its post's type,
 * and a new post's community was already chosen by the loader from the words and the URL.
 */
function startingForm({ data }: Pick<ComposerProps, 'data'>): Form {
  const { edit, kept } = data;
  const base: Form = edit
    ? {
        community: edit.community,
        type: edit.url ? 'link' : 'text',
        title: edit.title,
        url: edit.url ?? '',
        body: edit.bodyMd,
        alt: '',
        nsfw: edit.sensitive,
      }
    : { community: data.selected, type: 'text', title: '', url: '', body: '', alt: '', nsfw: false };
  if (!kept) return base;
  return {
    ...base,
    ...(!edit && { type: kept.type === 'image' && !data.uploads ? 'text' : kept.type }),
    title: kept.title,
    url: kept.url,
    body: kept.body,
    alt: kept.alt,
    nsfw: kept.nsfw,
  };
}

/**
 * The composer form (composer-page): community, post type, title, link or image or body, and
 * the NSFW flag, with the chosen community's rules beside it. A plain form that posts to /submit
 * and works without JavaScript (the type choice switches fields by CSS alone); once hydrated it
 * posts by fetch, keeps what was typed through a refusal, and offers the toolbar, Preview and
 * drafts. The page and the sheet both render this.
 */
export function Composer({ data, error: initialError, onDone, onDiscard, keepOnClose }: ComposerProps) {
  const { t, locale } = useTranslate();
  const editorLabels = useEditorLabels();
  const { edit, actorId, kept } = data;
  const [form, setForm] = useState(() => startingForm({ data }));
  const [panel, setPanel] = useState<CommunityPanel | null>(data.panel);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<'saved' | 'restored' | 'not-saved' | null>(null);
  const enhanced = useHydrated();
  const formElement = useRef<HTMLFormElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const panelRequest = useRef(0);
  // What the unmount cleanup needs to know, read at that moment.
  const latest = useRef(form);
  const finished = useRef(false);
  useEffect(() => {
    latest.current = form;
  });

  // Starting on a community that has a saved draft (a new post, nothing typed yet) restores it.
  useEffect(() => {
    removeUnscopedDrafts();
    if (edit || kept || !pristine(form)) return;
    const draft = readDraft({ actorId, community: form.community });
    if (draft) {
      setForm((current) => ({ ...current, ...draft }));
      setNote('restored');
    }
    // Once, on arrival: the community chosen later restores its draft in choose().
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // Dismissing the sheet with writing in it keeps it as a draft, so Escape never loses a post.
  useEffect(
    () => () => {
      const last = latest.current;
      if (keepOnClose && !finished.current && !edit && !pristine(last) && last.type !== 'image') {
        writeDraft(
          { actorId, community: last.community },
          { type: last.type, title: last.title, url: last.url, body: last.body, nsfw: last.nsfw },
        );
      }
    },
    [keepOnClose, edit, actorId],
  );

  function choose(id: string) {
    const request = ++panelRequest.current;
    setError(undefined);
    setPanel(null);
    void loadCommunityPanel({ data: { id } }).then(({ panel: next }) => {
      if (request !== panelRequest.current) return;
      setPanel(next);
      // Gone since the list was made (removed, deleted): it is not a choice any more.
      if (next === null) setForm((current) => (current.community === id ? { ...current, community: null } : current));
    });
    // A community with a saved draft gets it back, unless something is already typed.
    const draft = pristine(form) ? readDraft({ actorId, community: id }) : null;
    if (draft) setNote('restored');
    setForm({ ...form, ...draft, community: id });
  }

  function change(patch: Partial<Form>) {
    setError(undefined);
    setNote(null);
    setForm((current) => ({ ...current, ...patch }));
  }

  const chosen = data.communities.find(({ id }) => id === form.community);
  const canPost = panel?.canPost ?? chosen?.canPost ?? true;
  const titleLength = [...normalizeTitle(form.title)].length;
  const forced = panel?.sensitive === true;
  const problem = (field: ReturnType<typeof errorField>) => (error && errorField(error) === field ? error : undefined);
  const fieldError = (field: NonNullable<ReturnType<typeof errorField>>) => {
    const code = problem(field);
    return code ? <ErrorText code={code} /> : undefined;
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = firstProblem({
      creating: !edit,
      community: form.community,
      type: form.type,
      title: form.title,
      url: form.url,
      body: form.body,
      hasImage: (file.current?.files?.length ?? 0) > 0,
    });
    if (found) return setError(found);
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/submit', {
        method: 'POST',
        body: new FormData(event.currentTarget),
        headers: { accept: 'application/json' },
      });
      // Not JSON at all (a proxy's error page): the server did not decide this, and nothing is wrong with the connection.
      const answer = await response.json().then(Answer, () => undefined);
      if (!answer || answer instanceof type.errors) return setError('generic');
      if (answer.redirect) {
        finished.current = true;
        clearDraft({ actorId, community: form.community });
        onDone(answer.redirect);
      } else setError(asComposerError(answer.error) ?? 'generic');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  function saveDraft() {
    if (form.type === 'image') return;
    setNote(
      writeDraft(
        { actorId, community: form.community },
        { type: form.type, title: form.title, url: form.url, body: form.body, nsfw: form.nsfw },
      )
        ? 'saved'
        : 'not-saved',
    );
  }

  function discard() {
    finished.current = true;
    clearDraft({ actorId, community: form.community });
    onDiscard();
  }

  return (
    <div className="cmp">
      <form
        ref={formElement}
        className="cmp__form"
        method="post"
        action="/submit"
        encType="multipart/form-data"
        noValidate
        aria-busy={busy}
        onSubmit={submit}
      >
        {edit ? (
          <>
            <input type="hidden" name="edit" value={edit.id} />
            {/* The post's type cannot change, but the CSS that shows its fields reads this radio like the choice below. */}
            <input type="radio" name="type" value={form.type} defaultChecked hidden />
            <p className="cmp__editing">{t('composer', 'edit.in', { community: panel ? `!${panel.handle}` : '' })}</p>
          </>
        ) : (
          <>
            <CommunityPicker communities={data.communities} value={form.community} onChange={choose} error={fieldError('community')} />
            <fieldset className="cmp__types">
              <legend className="pb-sr">{t('composer', 'type.label')}</legend>
              {postTypes.map((kind) => (
                <label key={kind} className="cmp__type">
                  <input
                    type="radio"
                    name="type"
                    value={kind}
                    checked={form.type === kind}
                    disabled={kind === 'image' && !data.uploads}
                    aria-describedby={kind === 'image' && !data.uploads ? 'cmp-image-off' : undefined}
                    onChange={() => change({ type: kind })}
                  />
                  <span>{t('composer', `type.${kind}`)}</span>
                </label>
              ))}
            </fieldset>
            {!data.uploads && (
              <p id="cmp-image-off" className="cmp__note">
                {t('composer', 'type.imageOff')}
              </p>
            )}
          </>
        )}

        <TextField
          label={t('composer', 'title.label')}
          name="title"
          value={form.title}
          onChange={(title) => change({ title })}
          description={t('composer', 'title.count', { count: titleLength, max: postTitleMaxLength })}
          invalid={problem('title') !== undefined || titleLength > postTitleMaxLength}
          errorMessage={fieldError('title') ?? t('composer', 'error.title.too_long')}
          className="cmp__field"
        />

        <div className="cmp__only-link">
          <TextField
            label={t('composer', 'url.label')}
            name="url"
            type="url"
            placeholder="https://"
            value={form.url}
            onChange={(url) => change({ url })}
            description={t('composer', 'url.hint')}
            invalid={problem('url') !== undefined}
            errorMessage={fieldError('url')}
            className="cmp__field"
          />
        </div>

        {data.uploads && !edit && (
          <div className="cmp__only-image">
            <div className="cmp__field">
              <label htmlFor="cmp-image">{t('composer', 'image.label')}</label>
              <input
                ref={file}
                id="cmp-image"
                type="file"
                name="image"
                accept="image/jpeg,image/png,image/webp,image/gif"
                aria-invalid={problem('image') !== undefined}
                aria-describedby="cmp-image-hint"
              />
              <span id="cmp-image-hint" className="pb-muted">
                {t('composer', 'image.hint')}
              </span>
              {fieldError('image') && <p role="alert">{fieldError('image')}</p>}
            </div>
            <TextField
              label={t('composer', 'alt.label')}
              name="alt"
              value={form.alt}
              onChange={(alt) => change({ alt })}
              description={t('composer', 'alt.hint')}
              className="cmp__field"
            />
          </div>
        )}

        <div className="cmp__only-text cmp__field">
          <span id="cmp-body-label" className="cmp__label">
            {t('composer', 'body.label')} <span className="pb-muted">{t('composer', 'body.optional')}</span>
          </span>
          <MarkdownEditor
            name="body"
            label={t('composer', 'body.label')}
            value={form.body}
            onChange={(body) => change({ body })}
            labels={editorLabels}
            insertSpoiler={(value, start, end) => insertSpoiler(value, start, end, t('composer', 'editor.spoilerTitle'))}
            renderPreview={async (source) => {
              const rendered = await previewBody({ data: { source, ...(edit && { postId: edit.id }) } });
              if (!rendered) throw new Error('preview refused');
              return rendered.html;
            }}
            previewLead={form.title ? <h3>{normalizeTitle(form.title)}</h3> : undefined}
            description={t('composer', 'body.hint', { max: new Intl.NumberFormat(locale).format(markdownMaxLength) })}
            invalid={problem('body') !== undefined || form.body.length > markdownMaxLength}
            errorMessage={fieldError('body') ?? t('composer', 'error.body.too_long')}
            onSubmitShortcut={() => formElement.current?.requestSubmit()}
          />
        </div>

        <Checkbox
          name="nsfw"
          checked={form.nsfw || forced}
          disabled={forced}
          onChange={(nsfw) => change({ nsfw })}
          description={forced ? t('composer', 'nsfw.forced') : t('composer', 'nsfw.hint')}
        >
          {t('composer', 'nsfw.label')}
        </Checkbox>

        {error && errorField(error) === null && (
          <p className="cmp__error" role="alert">
            <ErrorText code={error} />
          </p>
        )}
        {!canPost && (
          <p className="cmp__error" role="alert">
            <ErrorText code="community.posting_restricted" />
          </p>
        )}

        <div className="cmp__actions">
          <Button type="submit" variant="primary" disabled={busy || !canPost}>
            {edit ? t('composer', 'actions.save') : t('composer', 'actions.post')}
          </Button>
          {!edit && (
            <Button type="button" onActivate={saveDraft} disabled={!enhanced || busy || form.type === 'image'}>
              {t('composer', 'actions.draft')}
            </Button>
          )}
          {edit ? (
            <a className="pb-linkbutton" href={`/post/${edit.id}`}>
              {t('composer', 'actions.cancel')}
            </a>
          ) : (
            <button type="button" className="pb-linkbutton" onClick={discard} disabled={!enhanced}>
              {t('composer', 'actions.discard')}
            </button>
          )}
          <span className="cmp__spacer" />
          <span className="pb-muted">{t('composer', 'as', { handle: data.me })}</span>
        </div>
        <p className="pb-muted" role="status">
          {note && t('composer', `draft.${note}`)}
        </p>
      </form>
      <CommunityAside panel={panel} loading={form.community !== null && panel === null} />
    </div>
  );
}
