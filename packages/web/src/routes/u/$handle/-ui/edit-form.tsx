import { insertSpoiler } from '@peblish/core/markdown/toolbar';
import { bioMax, displayNameMax } from '@peblish/core/profiles/input';
import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { MarkdownEditor } from '@peblish/ui/composer/markdown-editor';
import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { userPath } from '../../../../shell/paths.ts';
import { previewBody } from '../../../submit/-load.ts';
import { useEditorLabels } from '../../../submit/-ui/labels.ts';
import type { EditData } from '../-load.ts';

const Answer = type({ 'saved?': 'boolean', 'error?': 'string' });
const known = new Set(['profile.invalid', 'auth.required', 'auth.site_banned', 'target.deleted', 'generic', 'network']);

/** The character count under a field, which turns to the danger colour past the limit. */
function Count({ count, max, over }: { count: string; max: string; over: boolean }) {
  const { t } = useTranslate();
  return (
    <Text size="sm" color="muted" className="prof-count" data-over={over || undefined}>
      {t('profiles', 'edit.count', { count, max })}
    </Text>
  );
}

/**
 * profile-edit-inline.html: the display name and the bio with Write and Preview. Posts by fetch once
 * hydrated, else natively (303 back). A plain `form`: Mux UI's Form lives in its heavy fields module,
 * and the light fields here need nothing from it.
 */
export function EditForm({ data, saved, error: initial }: { data: EditData; saved: boolean; error: string | undefined }) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const labels = useEditorLabels();
  const [displayName, setDisplayName] = useState(data.form.displayName);
  const [bio, setBio] = useState(data.form.bio);
  const [state, setState] = useState<{ saved: boolean; error: string | undefined }>({ saved, error: initial });
  const [busy, setBusy] = useState(false);
  const path = userPath(data.profile.person);
  const handle = `@${data.profile.person.handle}`;
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const overName = displayName.length > displayNameMax;
  const overBio = bio.length > bioMax;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch(`${path}/edit`, {
        method: 'POST',
        body: new URLSearchParams({ displayName, bio }),
        headers: { accept: 'application/json' },
      });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return setState({ saved: false, error: 'generic' });
      if (answer.error) return setState({ saved: false, error: answer.error });
      setState({ saved: true, error: undefined });
      await router.invalidate();
    } catch {
      setState({ saved: false, error: 'network' });
    } finally {
      setBusy(false);
    }
  }

  const errorKey = state.error && (known.has(state.error) ? state.error : 'generic');
  return (
    <form method="post" action={`${path}/edit`} aria-busy={busy} className="prof-form" onSubmit={submit}>
      <Text as="h2" variant="heading" size="sm">
        {t('profiles', 'edit.title')}
      </Text>
      {state.saved && (
        <Notice tone="success" role="status" action={<Link href={path}>{t('profiles', 'edit.view')}</Link>}>
          {t('profiles', 'edit.saved')}
        </Notice>
      )}
      {errorKey && (
        <Notice tone="danger" role="alert">
          {t('profiles', `edit.error.${errorKey}` as 'edit.error.generic', { name: displayNameMax, bio: number(bioMax) })}
        </Notice>
      )}

      <div className="prof-field">
        <TextField
          label={t('profiles', 'edit.displayName')}
          name="displayName"
          autoComplete="name"
          value={displayName}
          onChange={setDisplayName}
          description={t('profiles', 'edit.displayNameHint', { handle })}
          invalid={overName}
        />
        <Count count={number(displayName.length)} max={number(displayNameMax)} over={overName} />
        <Text size="sm" color="muted">
          {t('profiles', 'edit.handle', { handle })}
        </Text>
      </div>

      <div className="prof-field">
        {/* The editor names its textarea itself and leaves the visible label to the page. */}
        <Text as="div" variant="label">
          {t('profiles', 'edit.bio')}
        </Text>
        <MarkdownEditor
          name="bio"
          label={t('profiles', 'edit.bio')}
          value={bio}
          onChange={setBio}
          labels={labels}
          insertSpoiler={(value, start, end) => insertSpoiler(value, start, end, t('composer', 'editor.spoilerTitle'))}
          renderPreview={async (source) => {
            const rendered = await previewBody({ data: { source } });
            if (!rendered) throw new Error('preview refused');
            return rendered.html;
          }}
          rows={7}
          description={t('profiles', 'edit.bioHint')}
          invalid={overBio}
        />
        <Count count={number(bio.length)} max={number(bioMax)} over={overBio} />
      </div>

      <Text as="p" size="sm" color="muted">
        {t('profiles', 'edit.public')}
      </Text>
      <div className="prof-buttons">
        <Button type="submit" variant="primary" disabled={overName || overBio || busy}>
          {t('profiles', 'edit.save')}
        </Button>
        <Link href={path}>{t('profiles', 'edit.cancel')}</Link>
      </div>
    </form>
  );
}
