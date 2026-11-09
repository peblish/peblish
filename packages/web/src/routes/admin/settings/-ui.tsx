import { Link } from '@tanstack/react-router';
import { useId, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { DEFAULT_LOCALE } from '../../../i18n/negotiate.ts';
import { translate, type MessageKey } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { rootTitleData } from '../../../shell/title.ts';
import { authHead } from '../../auth/-ui/page.tsx';
import adminCss from './-admin.css?url';
import type { Access } from './-access.ts';

// Pieces the admin Settings and Pages routes share.

/**
 * An admin route's head: lane A's stylesheet, then this one, and the title "<page> · <site>"
 * (the shell's table has no entry for these routes, so each names its own).
 */
export const adminHead =
  (title: MessageKey<'admin'>) =>
  ({ matches }: { matches: readonly { routeId: string; loaderData?: unknown }[] }) => {
    const { locale, site } = rootTitleData(matches.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
    const { links = [] } = authHead();
    return {
      meta: [{ title: `${translate(locale, 'admin', title)} · ${site}` }],
      links: [...links, { rel: 'stylesheet', href: adminCss }],
    };
  };

/** What a page says when the visitor may not use it: not an admin, or two-factor is off. */
export function AccessNotice({ access, title }: { access: Exclude<Access, 'ok'>; title: string }) {
  const { t } = useTranslate();
  return (
    <main className="auth-page">
      <h1>{title}</h1>
      {access === 'needs-two-factor' ? (
        <p role="alert">
          {t('admin', 'access.needsTwoFactor')} <Link to="/settings/security">{t('admin', 'access.securityLink')}</Link>
        </p>
      ) : (
        <p role="alert">{t('admin', 'access.notAdmin')}</p>
      )}
    </main>
  );
}

/** A labelled multi-line field in lane A's `.fld` shape, with its hint and, when marked, its error linked to it. */
export function AreaField({
  label,
  hint,
  error,
  ...area
}: { label: string; hint?: ReactNode; error?: string | undefined } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} aria-invalid={error ? true : undefined} aria-describedby={described || undefined} {...area} />
      {hint && (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="fld-error">
          {error}
        </span>
      )}
    </div>
  );
}
