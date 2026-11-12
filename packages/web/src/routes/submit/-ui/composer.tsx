import { insertSpoiler } from '@peblish/core/markdown/toolbar';
import { normalizeTitle, postTitleMaxLength } from '@peblish/core/posts/input';
import { markdownMaxLength } from '@peblish/schema/markdown';
import { Button } from '@peblish/ui/components/button';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { RadioField } from '@peblish/ui/components/radio-field';
import { RadioGroup } from '@peblish/ui/components/radio-group';
import { Text } from '@peblish/ui/components/text';
import { MarkdownEditor } from '@peblish/ui/composer/markdown-editor';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { type } from 'arktype';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { altTextMaxLength, firstProblem } from '../-fields.ts';
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
import { ComposerField } from './field.tsx';
import { ImageField } from './image-field.tsx';
import { useEditorLabels } from './labels.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

/**
 * Posts the form as fetch would, through XMLHttpRequest because only it reports how much of the
 * body has gone (the image's progress bar). Resolves with the answer's text; rejects when the
 * connection fails.
 */
function send(action: string, body: FormData, onProgress: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', action);
    request.setRequestHeader('accept', 'application/json');
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () => resolve(request.responseText));
    request.addEventListener('error', () => reject(new Error('network')));
    request.addEventListener('abort', () => reject(new Error('network')));
    request.send(body);
  });
}

const parseAnswer = (text: string) => {
  try {
    return Answer(JSON.parse(text));
  } catch {
    return undefined;
  }
};

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
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState<'saved' | 'restored' | 'not-saved' | null>(null);
  const enhanced = useHydrated();
  const formElement = useRef<HTMLFormElement>(null);
  const panelRequest = useRef(0);
  // What the unmount cleanup needs to know, read at that moment.
  const latest = useRef(form);
  const finished = useRef(false);
  useEffect(() => {
    latest.current = form;
  });

  // Whether anything was typed: text typed before the page hydrated reaches change() as the fields
  // mount, before the effect below runs, while that effect still sees the first, empty form.
  const typed = useRef(false);

  // Starting on a community that has a saved draft (a new post, nothing typed yet) restores it.
  // Typed words win: the form is judged as it is when the draft is laid over it.
  useEffect(() => {
    removeUnscopedDrafts();
    if (edit || kept || !pristine(form)) return;
    const draft = readDraft({ actorId, community: form.community });
    if (draft) {
      setForm((current) => (pristine(current) ? { ...current, ...draft } : current));
      if (!typed.current) setNote('restored');
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
    typed.current = true;
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
    const body = new FormData(event.currentTarget);
    const image = body.get('image');
    const hasImage = image instanceof File && image.size > 0;
    const found = firstProblem({
      creating: !edit,
      community: form.community,
      type: form.type,
      title: form.title,
      url: form.url,
      body: form.body,
      alt: form.alt,
      hasImage,
    });
    if (found) return setError(found);
    setBusy(true);
    setError(undefined);
    const sendsImage = form.type === 'image' && hasImage;
    if (sendsImage) setProgress(0);
    try {
      const text = await send(action, body, (percent) => sendsImage && setProgress(percent));
      // Not JSON at all (a proxy's error page): the server did not decide this, and nothing is wrong with the connection.
      const answer = parseAnswer(text);
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
      setProgress(null);
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

  const imageOff = !data.uploads;
  // An edit names its post in the address the form posts to (-submit.ts reads it there).
  const action = edit ? `/submit?${new URLSearchParams({ edit: edit.id })}` : '/submit';
  return (
    // An edit's type is fixed and has no radios: the attribute shows its fields instead.
    <div className="cmp" data-type={edit ? form.type : undefined}>
      <form
        ref={formElement}
        className="cmp__form"
        method="post"
        action={action}
        encType="multipart/form-data"
        noValidate
        aria-busy={busy}
        onSubmit={submit}
      >
        {edit ? (
          <Text as="p" className="cmp__editing">
            {t('composer', 'edit.in', { community: panel ? `!${panel.handle}` : '' })}
          </Text>
        ) : (
          <>
            <CommunityPicker communities={data.communities} value={form.community} onChange={choose} error={fieldError('community')} />
            {/* Real radios: the choice posts without JavaScript, and the CSS shows each type's fields by the checked one. */}
            <RadioGroup
              aria-label={t('composer', 'type.label')}
              name="type"
              orientation="horizontal"
              value={form.type}
              onChange={(kind) => {
                const next = postTypes.find((candidate) => candidate === kind);
                if (next) change({ type: next });
              }}
              className="cmp__types"
            >
              {postTypes.map((kind) => (
                <RadioField.Root key={kind} value={kind} disabled={kind === 'image' && imageOff}>
                  <RadioField.Button>
                    <RadioField.Indicator>
                      <RadioField.Dot />
                    </RadioField.Indicator>
                    {t('composer', `type.${kind}`)}
                  </RadioField.Button>
                  {kind === 'image' && imageOff && <RadioField.Description>{t('composer', 'type.imageOff')}</RadioField.Description>}
                </RadioField.Root>
              ))}
            </RadioGroup>
          </>
        )}

        <ComposerField
          label={t('composer', 'title.label')}
          name="title"
          value={form.title}
          onChange={(title) => change({ title })}
          description={t('composer', 'title.count', { count: titleLength, max: postTitleMaxLength })}
          invalid={problem('title') !== undefined || titleLength > postTitleMaxLength}
          error={fieldError('title') ?? t('composer', 'error.title.too_long')}
          className="cmp__field"
        />

        <div className="cmp__only-link">
          <ComposerField
            label={t('composer', 'url.label')}
            name="url"
            type="url"
            placeholder="https://"
            value={form.url}
            onChange={(url) => change({ url })}
            description={t('composer', 'url.hint')}
            invalid={problem('url') !== undefined}
            error={fieldError('url')}
            className="cmp__field"
          />
        </div>

        {data.uploads && !edit && (
          <div className="cmp__only-image">
            <ImageField error={fieldError('image')} progress={progress} />
            <ComposerField
              label={t('composer', 'alt.label')}
              name="alt"
              value={form.alt}
              onChange={(alt) => change({ alt })}
              description={t('composer', 'alt.hint')}
              invalid={problem('alt') !== undefined || form.alt.length > altTextMaxLength}
              error={fieldError('alt') ?? t('composer', 'error.alt.too_long')}
              className="cmp__field"
            />
          </div>
        )}

        <div className="cmp__only-text cmp__field">
          <Text as="span" variant="label" size="sm" id="cmp-body-label">
            {t('composer', 'body.label')}{' '}
            <Text color="muted" variant="label" size="sm">
              {t('composer', 'body.optional')}
            </Text>
          </Text>
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
            previewLead={
              form.title ? (
                <Text as="h3" variant="title" size="md">
                  {normalizeTitle(form.title)}
                </Text>
              ) : undefined
            }
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
          <Notice tone="danger" role="alert">
            <ErrorText code={error} />
          </Notice>
        )}
        {!canPost && (
          <Notice tone="danger" role="alert">
            <ErrorText code="community.posting_restricted" />
          </Notice>
        )}

        <div className="cmp__actions">
          <Button type="submit" variant="primary" disabled={busy || !canPost}>
            {edit ? t('composer', 'actions.save') : t('composer', 'actions.post')}
          </Button>
          {!edit && (
            <Button variant="neutral" onActivate={saveDraft} disabled={!enhanced || busy || form.type === 'image'}>
              {t('composer', 'actions.draft')}
            </Button>
          )}
          {edit ? (
            <Link href={`/post/${edit.id}`}>{t('composer', 'actions.cancel')}</Link>
          ) : (
            <Button variant="ghost" onActivate={discard} disabled={!enhanced}>
              {t('composer', 'actions.discard')}
            </Button>
          )}
          <span className="cmp__spacer" />
          <Text color="muted">{t('composer', 'as', { handle: data.me })}</Text>
        </div>
        <Text as="p" color="muted" role="status" className="cmp__status">
          {note && t('composer', `draft.${note}`)}
        </Text>
      </form>
      <CommunityAside panel={panel} loading={form.community !== null && panel === null} />
    </div>
  );
}
