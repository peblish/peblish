import { Button } from '@peblish/ui/components/button';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { Disclosure } from '@peblish/ui/components/disclosure';
import { Input } from '@peblish/ui/components/input';
import { Select } from '@peblish/ui/components/select';
import { Text } from '@peblish/ui/components/text';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { type } from 'arktype';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { loadBanCounts } from '../-counts.ts';
import modCss from './mod.css?inline';

// The moderator panels (R2 pick modlog-feed): a Mux Disclosure that opens under the post, comment
// or profile, holding a plain form posting to /modlog/act. Opening one needs JavaScript; a panel
// the server renders open (a refusal's ?modError=...&modFor=..., or `defaultOpen`) is a plain
// form that posts and answers 303 without it. Once hydrated the form posts by fetch, shows a
// refusal in place and, on success, reloads the page's data instead of navigating.

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });

const errors = new Set<string>([
  'auth.required',
  'auth.admin_required',
  'admin.two_factor_required',
  'auth.site_banned',
  'mod.moderator_required',
  'mod.announce_mismatch',
  'community.banned',
  'community.removed',
  'community.deleted',
  'target.not_found',
  'target.deleted',
  'target.removed',
  'target.not_removed',
  'target.protected',
  'target.banned',
  'target.not_banned',
  'target.site_banned',
  'target.not_site_banned',
  'ban.origin_mismatch',
  'ban.not_remote',
  'form.invalid',
  'reason.required',
  'peer.local_instance',
  'peer.invalid_domain',
  'network',
]);

/** A refusal code as one we have a message for. */
export const errorKey = (code: string): MessageKey<'modlog'> => `error.${errors.has(code) ? code : 'generic'}` as MessageKey<'modlog'>;

/**
 * The stylesheet of the panels; every page that shows one renders this and React hoists and
 * dedupes it into the head. It is inline on purpose: a linked stylesheet with a precedence makes
 * React wait for it, which streams the page in a hidden box that only a script reveals, and these
 * forms must work without one.
 */
export const ModStyles = () => (
  <style href="mod-panels" precedence="mod-panels">
    {modCss}
  </style>
);

/** The refusal in the address, if it is for this panel. */
function useUrlError(panel: string): string | undefined {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const params = new URLSearchParams(search);
  return params.get('modFor') === panel ? (params.get('modError') ?? undefined) : undefined;
}

export function Panel({
  panel,
  summary,
  intent,
  fields,
  back,
  submit,
  defaultOpen = false,
  children,
}: {
  /** Identifies the panel in the address after a refusal: `content:<id>` for remove and restore, `<intent>:<person id>` otherwise. */
  panel: string;
  summary: string;
  intent: 'remove' | 'restore' | 'ban' | 'unban' | 'site_ban' | 'site_unban';
  /** The target, as hidden fields. */
  fields: Record<string, string>;
  back: string;
  submit: string;
  /** Open from the start, for a page that is the confirmation (the Bans tab). */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslate();
  const router = useRouter();
  const urlError = useUrlError(panel);
  const [error, setError] = useState<string | undefined>(urlError);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(defaultOpen || urlError !== undefined);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) if (typeof value === 'string') body.append(name, value);
    setBusy(true);
    try {
      const response = await fetch('/modlog/act', { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return setError('generic');
      if (answer.ok) {
        setError(undefined);
        setOpen(false);
        await router.invalidate();
      } else setError(answer.error ?? 'generic');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mod-panel" data-testid={`mod-panel-${intent}`}>
      <ModStyles />
      <Disclosure title={summary} expanded={open} onExpandedChange={setOpen}>
        <form method="post" action="/modlog/act" className="mod-form" aria-busy={busy} onSubmit={onSubmit}>
          <HiddenFields fields={{ intent, back, ...fields }} />
          {children}
          {error && (
            <Text as="p" size="sm" className="mod-error" role="alert">
              {t('modlog', errorKey(error))}
            </Text>
          )}
          <div className="mod-actions">
            <Button
              type="submit"
              variant={intent.endsWith('unban') || intent === 'restore' ? 'neutral' : 'primary'}
              size="sm"
              disabled={busy}
            >
              {submit}
            </Button>
          </div>
        </form>
      </Disclosure>
    </div>
  );
}

/** Values the form posts that nobody types, as Mux inputs of type hidden. */
export function HiddenFields({ fields }: { fields: Record<string, string> }) {
  return Object.entries(fields).map(([name, value]) => <Input.Input key={name} type="hidden" name={name} value={value} />);
}

/** The reason box and the "show in the public modlog" switch every panel has. */
export function ReasonFields({
  required,
}: {
  required: boolean;
  /** Unused since Mux ties labels to fields; kept for callers. */ id: string;
}) {
  const { t } = useTranslate();
  return (
    <>
      <TextAreaField
        label={t('modlog', 'panel.reason')}
        description={t('modlog', 'panel.reasonHint')}
        name="reason"
        rows={3}
        maxLength={10000}
        required={required}
      />
      <Checkbox name="public" value="on" defaultChecked description={t('modlog', 'panel.publicHint')}>
        {t('modlog', 'panel.public')}
      </Checkbox>
    </>
  );
}

/** Length of a ban, and "Also remove their content" with the counts of what it would remove (fetched when the panel is shown). */
export function BanFields({
  person,
  community,
}: {
  /** Unused since Mux ties labels to fields; kept for callers. */
  id: string;
  person: string;
  community?: string;
}) {
  const { t } = useTranslate();
  const [counts, setCounts] = useState<{ posts: number; comments: number } | null>(null);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    let live = true;
    loadBanCounts({ data: { person, ...(community ? { community } : {}) } })
      .then((found) => live && setCounts(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [person, community]);
  return (
    <>
      <div className="mod-length">
        <Select
          label={t('modlog', 'panel.length')}
          name="duration"
          defaultValue="7"
          onChange={(value) => setCustom(value === 'custom')}
          items={[
            { id: '1', label: t('modlog', 'panel.d1') },
            { id: '7', label: t('modlog', 'panel.d7') },
            { id: '30', label: t('modlog', 'panel.d30') },
            { id: 'permanent', label: t('modlog', 'panel.permanent') },
            { id: 'custom', label: t('modlog', 'panel.custom') },
          ]}
        />
        {/* Mux Input parts, not the facade TextField, which has no date type. */}
        <Input.Root required={custom}>
          <Input.Label>{t('modlog', 'panel.until')}</Input.Label>
          <Input.Input type="date" name="until" />
        </Input.Root>
      </div>
      <Checkbox name="removeContent" value="on">
        {t('modlog', 'panel.removeContent')}
        {counts && <> {t('modlog', 'panel.counts', { posts: counts.posts, comments: counts.comments })}</>}
      </Checkbox>
    </>
  );
}
