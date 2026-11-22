import type { ThreadFacts } from '@peblish/core/posts/facts';
import type { Fact } from '@peblish/ui/components/fact-list';
import { Time } from '@peblish/ui/components/time';
import { useTranslate } from '../../../i18n/use-translate.ts';

/** A language tag as the reader's language names it ("German"), else the tag itself. */
function languageName(tag: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * The thread's facts for the post rail's In this thread (Commons, the mock's PostPanels): how many
 * people took part ("1,000+" past one read's bound), when it last moved, and its language, each
 * "Unknown" where this server cannot say. Nothing for a post withheld from this reader.
 */
export function useThreadFacts(facts: ThreadFacts | null): Fact[] {
  const { t, locale } = useTranslate();
  if (!facts) return [];
  const number = new Intl.NumberFormat(locale);
  const unknown = t('facts', 'unknown');
  return [
    {
      key: 'people',
      label: t('facts', 'thread.participants'),
      value: facts.more
        ? t('facts', 'thread.participantsMore', { count: number.format(facts.participants) })
        : number.format(facts.participants),
    },
    {
      key: 'activity',
      label: t('facts', 'thread.lastActivity'),
      value: facts.lastActivityAt ? <Time iso={facts.lastActivityAt} locale={locale} /> : unknown,
    },
    { key: 'language', label: t('facts', 'thread.language'), value: facts.language ? languageName(facts.language, locale) : unknown },
  ];
}
