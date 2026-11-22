import { TextArea } from '@peblish/ui/components/mux-text-area';
import { Text } from '@peblish/ui/components/text';
import type { ReactNode, TextareaHTMLAttributes } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { Denial } from '../-denial.tsx';
import { AdminPage } from '../-page.tsx';
import type { Access } from './-access.ts';

// Pieces the admin Settings and Pages routes share. The admin stylesheet is linked by the
// admin layout route (admin/route.tsx), so every admin page has it.

/** A section heading inside an admin page (Commons: label text in the strong colour). */
export function SectionTitle({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <Text as="h2" variant="label" size="md" id={id} className="adm-section__title">
      {children}
    </Text>
  );
}

/** What a page says when the visitor may not use it: not an admin, two-factor is off, or this session skipped it. */
export function AccessNotice({ access, title }: { access: Exclude<Access, 'ok'>; title: string }) {
  const { t } = useTranslate();
  return (
    <AdminPage title={title} className="adm-page">
      <Denial
        access={access}
        copy={{
          needsTwoFactor: t('admin', 'access.needsTwoFactor'),
          securityLink: t('admin', 'access.securityLink'),
          notAdmin: t('admin', 'access.notAdmin'),
        }}
      />
    </AdminPage>
  );
}

/**
 * A labelled multi-line field on Mux UI's TextArea parts, with its hint and, when marked, its
 * error, both tied to the control. Native textarea attributes (`name`, `rows`, `form`) reach the
 * control; the value goes to the field root, which owns it.
 */
export function AreaField({
  label,
  hint,
  error,
  defaultValue,
  value,
  ...area
}: { label: string; hint?: ReactNode; error?: string | undefined } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <TextArea.Root
      invalid={Boolean(error)}
      defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
      value={value === undefined ? undefined : String(value)}
    >
      <TextArea.Label>{label}</TextArea.Label>
      <TextArea.TextArea {...area} />
      {hint && <TextArea.Description>{hint}</TextArea.Description>}
      {error && <TextArea.Error>{error}</TextArea.Error>}
    </TextArea.Root>
  );
}
