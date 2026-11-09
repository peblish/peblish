import { Handle } from '@peblish/ui/components/handle';
import { TextField } from '@peblish/ui/components/text-field';
import { useState, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { translatePlural } from '../../../i18n/translate.ts';
import type { PickerCommunity } from '../-types.ts';

/**
 * The community list (composer-page): one radio per community, so the choice is a form field
 * that works before and without JavaScript. The filter box narrows the list once hydrated; a
 * row it hides stays in the form, so the chosen community is never dropped. A community the
 * person may not post in is disabled, with the reason beside it.
 */
export function CommunityPicker({
  communities,
  value,
  onChange,
  error,
}: {
  communities: readonly PickerCommunity[];
  value: string | null;
  onChange: (id: string) => void;
  error?: ReactNode;
}) {
  const { t, locale } = useTranslate();
  const [filter, setFilter] = useState('');
  const wanted = filter.trim().toLowerCase().replace(/^!/, '');
  const shown = (community: PickerCommunity) => wanted === '' || community.handle.toLowerCase().includes(wanted);
  return (
    <fieldset className="cmp__field cmp__picker">
      <legend className="cmp__label">{t('composer', 'community.label')}</legend>
      <TextField
        type="search"
        label={t('composer', 'community.search')}
        hideLabel
        placeholder={t('composer', 'community.search')}
        value={filter}
        onChange={setFilter}
      />
      <ul className="cmp__list">
        {communities.map((community) => (
          <li key={community.id} hidden={!shown(community)}>
            <label className="cmp__row" data-off={community.canPost ? undefined : ''}>
              <input
                type="radio"
                name="community"
                value={community.id}
                checked={value === community.id}
                disabled={!community.canPost}
                onChange={() => onChange(community.id)}
              />
              <span>
                <Handle prefix="!" handle={community.handle} />{' '}
                <span className="pb-muted">
                  {community.local ? t('composer', 'community.local') : t('composer', 'community.remote')}
                  {community.restricted ? `, ${t('composer', 'community.modsOnly')}` : ''}
                </span>
              </span>
              <span className="pb-muted">
                {!community.canPost
                  ? t('composer', 'community.disabled')
                  : community.subscribers === null
                    ? ''
                    : translatePlural(locale, 'composer', 'community.members', community.subscribers)}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {communities.length > 0 && communities.every((community) => !shown(community)) && (
        <p className="pb-muted">{t('composer', 'community.none')}</p>
      )}
      {communities.length === 0 && <p className="pb-muted">{t('composer', 'community.empty')}</p>}
      {error && (
        <p className="cmp__error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
