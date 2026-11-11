import { Button } from '@peblish/ui/components/button';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { FieldAlert, useErrorPartId, useFieldProblem } from '@peblish/ui/components/field-problem';
import { Input } from '@peblish/ui/components/input';
import { LinkedDisclosure } from '@peblish/ui/components/linked-disclosure';
import { Notice } from '@peblish/ui/components/notice';
import { Select } from '@peblish/ui/components/select';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { type } from 'arktype';
import { createContext, use, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { loadBanCounts } from '../-counts.ts';
import modCss from './mod.css?inline';

// The moderator panels (R2 pick modlog-feed): a LinkedDisclosure that opens under the post, comment
// or profile, holding a plain form posting to /modlog/act. The server renders a panel open when the
// address names it (?modFor=<panel>, which a refusal also sets with its ?modError=<code>) or with
// `defaultOpen`; without scripts the closed panel is a link to that address, and the open one is a
// plain form that posts and answers 303. Once hydrated the form posts by fetch, shows a refusal in
// place and, on success, reloads the page's data instead of navigating.

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

/** Whether the address names this panel (?modFor=<panel>), the refusal it carries if any, and the address itself. */
function useUrlPanel(panel: string) {
  const { pathname, searchStr } = useRouterState({ select: (state) => state.location });
  const params = new URLSearchParams(searchStr);
  const named = params.get('modFor') === panel;
  return { named, error: named ? (params.get('modError') ?? undefined) : undefined, pathname, params };
}

/** This page with the panel named in its query, at the panel: where the server renders it open. */
function openAddress(pathname: string, current: URLSearchParams, panel: string, id: string): string {
  const params = new URLSearchParams(current);
  params.delete('modError');
  params.set('modFor', panel);
  return `${pathname}?${params}#${id}`;
}

/**
 * The panel's refusal, read by the field it is about (a missing reason goes to the reason box),
 * and `settle`, which that field calls when its value changes: a refusal it shows is cleared, so
 * the field stops being invalid (React Aria would otherwise keep blocking the next submit).
 */
const PanelError = createContext<{ error: string | undefined; settle: (code: string) => void }>({
  error: undefined,
  settle: () => undefined,
});

export function Panel({
  panel,
  id = `mod-${panel.replace(':', '-')}`,
  summary,
  intent,
  fields,
  back,
  submit,
  defaultOpen = false,
  children,
}: {
  /** Identifies the panel in the address: `content:<id>` for remove and restore, `<intent>:<person id>` otherwise. */
  panel: string;
  /** The panel's element id, the fragment of its address; give one when a page shows two panels of the same key. */
  id?: string;
  summary: ReactNode;
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
  const url = useUrlPanel(panel);
  const [error, setError] = useState<string | undefined>(url.error);
  const [busy, setBusy] = useState(false);
  // Each success closes the panel by mounting a fresh one (the disclosure keeps its own state).
  const [done, setDone] = useState(0);

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
        setDone((count) => count + 1);
        await router.invalidate();
      } else setError(answer.error ?? 'generic');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinkedDisclosure
      key={done}
      id={id}
      className="mod-panel"
      data-testid={`mod-panel-${intent}`}
      title={summary}
      openHref={openAddress(url.pathname, url.params, panel, id)}
      defaultExpanded={done === 0 && (defaultOpen || url.named)}
    >
      <ModStyles />
      <form method="post" action="/modlog/act" className="mod-form" aria-busy={busy} onSubmit={onSubmit}>
        <HiddenFields fields={{ intent, back, ...fields }} />
        <PanelError value={{ error, settle: (code) => setError((current) => (current === code ? undefined : current)) }}>
          {children}
        </PanelError>
        {error && error !== 'reason.required' && (
          <Notice tone="danger" role="alert">
            {t('modlog', errorKey(error))}
          </Notice>
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
    </LinkedDisclosure>
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
  const panel = use(PanelError);
  const missing = panel.error === 'reason.required';
  return (
    <>
      <TextAreaField
        label={t('modlog', 'panel.reason')}
        description={t('modlog', 'panel.reasonHint')}
        name="reason"
        rows={3}
        maxLength={10000}
        required={required}
        onChange={() => panel.settle('reason.required')}
        invalid={missing}
        errorMessage={missing ? t('modlog', errorKey('reason.required')) : undefined}
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
        <UntilField required={custom} />
      </div>
      <Checkbox name="removeContent" value="on">
        {t('modlog', 'panel.removeContent')}
        {counts && <> {t('modlog', 'panel.counts', { posts: counts.posts, comments: counts.comments })}</>}
      </Checkbox>
    </>
  );
}

/**
 * The last day of a custom ban. Mux Input parts, since the facade TextField has no date type, with
 * the shared field hook, so a missing day is explained under the field in the page's language.
 * A shown problem is judged again when the length switches `required`: a missing day stops
 * counting for a fixed or permanent ban (it would otherwise keep the field invalid and cancel the
 * next submit), while a constraint that still applies stays.
 */
function UntilField({ required }: { required: boolean }) {
  const { t } = useTranslate();
  const { ref, problem, errorId, recheck } = useFieldProblem<HTMLDivElement>();
  const [judgedRequired, setJudgedRequired] = useState(required);
  if (judgedRequired !== required) {
    setJudgedRequired(required);
    if (problem) recheck();
  }
  const partId = useErrorPartId(Boolean(problem), errorId);
  return (
    <Input.Root ref={ref} required={required} invalid={problem !== undefined}>
      <Input.Label>{t('modlog', 'panel.until')}</Input.Label>
      <Input.Input type="date" name="until" />
      {problem ? (
        <Input.Error id={partId}>
          <FieldAlert>{problem}</FieldAlert>
        </Input.Error>
      ) : null}
    </Input.Root>
  );
}
