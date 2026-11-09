import { insertSpoiler } from '@peblish/core/markdown/toolbar';
import { bioMax, displayNameMax } from '@peblish/core/profiles/input';
import { Button } from '@peblish/ui/components/button';
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

/** profile-edit-inline.html: the display name and the bio with Write and Preview. Posts by fetch once hydrated, else natively (303 back). */
export function EditForm({ data, saved, error: initial }: { data: EditData; saved: boolean; error: string | undefined }) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const labels = useEditorLabels();
  const [displayName, setDisplayName] = useState(data.form.displayName);
  const [bio, setBio] = useState(data.form.bio);
  const [state, setState] = useState<{ saved: boolean; error: string | undefined }>({ saved, error: initial });
  const [busy, setBusy] = useState(false);
  const path = userPath(data.profile.person);
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
      <h2>{t('profiles', 'edit.title')}</h2>
      {state.saved && (
        <p className="prof-saved" role="status">
          {t('profiles', 'edit.saved')} <a href={path}>{t('profiles', 'edit.view')}</a>
        </p>
      )}
      {errorKey && (
        <p className="prof-error" role="alert">
          {t('profiles', `edit.error.${errorKey}` as 'edit.error.generic', { name: displayNameMax, bio: number(bioMax) })}
        </p>
      )}

      <div className="prof-field">
        <label htmlFor="prof-name">{t('profiles', 'edit.displayName')}</label>
        <input
          id="prof-name"
          name="displayName"
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          aria-describedby="prof-name-hint"
          aria-invalid={overName || undefined}
        />
        <span id="prof-name-hint" className="prof-hint">
          {t('profiles', 'edit.displayNameHint', { handle: `@${data.profile.person.handle}` })}
        </span>
        <span className="prof-count" data-over={overName || undefined}>
          {t('profiles', 'edit.count', { count: number(displayName.length), max: number(displayNameMax) })}
        </span>
        <span className="prof-hint">{t('profiles', 'edit.handle', { handle: `@${data.profile.person.handle}` })}</span>
      </div>

      <div className="prof-field">
        <span className="lb" id="prof-bio-label">
          {t('profiles', 'edit.bio')}
        </span>
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
        <span className="prof-count" data-over={overBio || undefined}>
          {t('profiles', 'edit.count', { count: number(bio.length), max: number(bioMax) })}
        </span>
      </div>

      <p className="prof-hint">{t('profiles', 'edit.public')}</p>
      <div className="prof-buttons">
        <Button type="submit" variant="primary" disabled={overName || overBio || busy}>
          {t('profiles', 'edit.save')}
        </Button>
        <a href={path}>{t('profiles', 'edit.cancel')}</a>
      </div>
    </form>
  );
}
