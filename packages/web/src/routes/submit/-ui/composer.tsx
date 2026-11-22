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
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
import { CommunityAside, CommunityRules } from './community-aside.tsx';
import { CommunityPicker } from './community-picker.tsx';
import { carried, clearDraft, holds, readDraft, removeUnscopedDrafts, writeDraft, type Draft, type DraftScope } from './drafts.ts';
import { ErrorText } from './error-text.tsx';
import { ComposerField } from './field.tsx';
import { ImageField } from './image-field.tsx';
import { directoryPaths } from '../../../shell/paths.ts';
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
  /**
   * Create post's page (Commons): lays out the form and the community's rules itself, the rules in the
   * frame's rail. Where the rail gives way, the form shows `rules` under the community picker, in an
   * aside named as the rail is (`cmp-page__rules`, shown only there). Left out (the sheet), the rules
   * are an outlined Card beside the form.
   */
  page?: (parts: { form: ReactNode; rules: ReactNode }) => ReactNode;
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
/** What a draft keeps of a text or link post. */
const toDraft = ({ type, title, url, body, nsfw }: Form): Draft => ({ type: type === 'link' ? 'link' : 'text', title, url, body, nsfw });

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
export function Composer({ data, error: initialError, onDone, onDiscard, keepOnClose, page }: ComposerProps) {
  const { t, locale } = useTranslate();
  const editorLabels = useEditorLabels();
  const { edit, actorId, kept } = data;
  const [form, setForm] = useState(() => startingForm({ data }));
  const [panel, setPanel] = useState<CommunityPanel | null>(data.panel);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState<'saved' | 'restored' | 'carried' | 'not-saved' | null>(null);
  const enhanced = useHydrated();
  const formElement = useRef<HTMLFormElement>(null);
  const panelRequest = useRef(0);
  // What the unmount cleanup needs to know, read at that moment.
  const latest = useRef(form);
  const finished = useRef(false);
  // The draft laid over the form, and where it was kept: posting or discarding clears that copy as well.
  const restored = useRef<{ scope: DraftScope; draft: Draft } | null>(null);
  useEffect(() => {
    latest.current = form;
  });

  // Whether anything was typed: text typed before the page hydrated reaches change() as the fields
  // mount, before the effect below runs, while that effect still sees the first, empty form.
  const typed = useRef(false);

  // Starting with nothing typed (a new post), the draft Browse carried comes back, wherever Create post was opened
  // after it; else the starting community's saved draft. Typed words win: the form is judged as it is when the draft
  // is laid over it.
  useEffect(() => {
    removeUnscopedDrafts();
    if (edit || kept || !pristine(form)) return;
    for (const scope of [carried(actorId), { actorId, community: form.community }]) {
      const draft = readDraft(scope);
      if (!draft) continue;
      setForm((current) => (pristine(current) ? { ...current, ...draft } : current));
      if (!typed.current) {
        restored.current = { scope, draft };
        setNote('carried' in scope ? 'carried' : 'restored');
      }
      return;
    }
    // Once, on arrival: the community chosen later restores its draft in choose().
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  /**
   * Keeps the form as its community's draft. One restored from Browse's slot lives there from then on, so the next
   * Create post does not bring back the older text.
   */
  function keep(last: Form): boolean {
    const scope = { actorId, community: last.community };
    if (!writeDraft(scope, toDraft(last))) return false;
    const from = restored.current;
    if (from && 'carried' in from.scope && holds(from.scope, from.draft)) clearDraft(from.scope);
    restored.current = { scope, draft: toDraft(last) };
    return true;
  }

  /** Posted or discarded: no copy is left, under its community or where it was restored from. */
  function forget() {
    clearDraft({ actorId, community: form.community });
    const from = restored.current;
    if (from && holds(from.scope, from.draft)) clearDraft(from.scope);
  }

  // Dismissing the sheet with writing in it keeps it as a draft, so Escape never loses a post.
  useEffect(
    () => () => {
      const last = latest.current;
      if (keepOnClose && !finished.current && !edit && !pristine(last) && last.type !== 'image') keep(last);
    },
    // `keep` reads refs and `actorId` only.
    // oxlint-disable-next-line react/exhaustive-deps
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
    if (draft) {
      restored.current = { scope: { actorId, community: id }, draft };
      setNote('restored');
    }
    setForm({ ...form, ...draft, community: id });
  }

  /** The field emptied: no community, so no rules beside the form. */
  function unchoose() {
    ++panelRequest.current;
    setPanel(null);
    setForm((current) => ({ ...current, community: null }));
  }

  /**
   * Off to the directory to find a community. What was typed goes as the draft Browse carries (drafts.ts), which
   * Create post takes back wherever it is opened next. It leaves once that is kept, and asks first when it cannot
   * be: the browser refused it, another carried draft is waiting (never replaced), or the post is an image.
   */
  function browse() {
    const leave = () => {
      // Kept here (or let go when asked), so the sheet closing behind it keeps no second copy.
      finished.current = true;
      onDone(directoryPaths.browse);
    };
    if (form.type === 'image') {
      const file = formElement.current ? new FormData(formElement.current).get('image') : null;
      const started = !pristine(form) || form.alt !== '' || (file instanceof File && file.size > 0);
      if (!started || window.confirm(t('composer', 'browse.image'))) leave();
      return;
    }
    if (pristine(form)) return leave();
    const slot = carried(actorId);
    const from = restored.current;
    const free = readDraft(slot) === null || (from !== null && 'carried' in from.scope && holds(slot, from.draft));
    if (free && writeDraft(slot, toDraft(form))) {
      // A community's draft restored here goes along with it: no copy stays behind under that community.
      if (from && !('carried' in from.scope) && holds(from.scope, from.draft)) clearDraft(from.scope);
      return leave();
    }
    if (window.confirm(t('composer', free ? 'browse.notKept' : 'browse.otherKept'))) leave();
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
        forget();
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
    setNote(keep(form) ? 'saved' : 'not-saved');
  }

  function discard() {
    finished.current = true;
    forget();
    onDiscard();
  }

  const imageOff = !data.uploads;
  // An edit names its post in the address the form posts to (-submit.ts reads it there).
  const action = edit ? `/submit?${new URLSearchParams({ edit: edit.id })}` : '/submit';
  const loadingPanel = form.community !== null && panel === null;
  const rules = page && <CommunityRules panel={panel} loading={loadingPanel} />;
  const inlineRules = rules && (
    <aside className="cmp-page__rules" aria-label={t('composer', 'panel.label')} aria-busy={loadingPanel}>
      {rules}
    </aside>
  );
  const composer = (
    // An edit's type is fixed and has no radios: the attribute shows its fields instead.
    <div className={page ? 'cmp cmp--page' : 'cmp'} data-type={edit ? form.type : undefined}>
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
          <>
            <Text as="p" className="cmp__editing">
              {t('composer', 'edit.in', { community: panel ? `!${panel.handle}` : '' })}
            </Text>
            {inlineRules}
          </>
        ) : (
          <>
            <CommunityPicker
              communities={data.communities}
              value={form.community}
              onChange={(id) => (id === null ? unchoose() : choose(id))}
              onBrowse={browse}
              error={fieldError('community')}
            />
            {inlineRules}
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
      {!page && <CommunityAside panel={panel} loading={loadingPanel} />}
    </div>
  );
  return page ? page({ form: composer, rules }) : composer;
}
