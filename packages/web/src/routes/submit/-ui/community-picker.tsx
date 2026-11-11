import { Card } from '@peblish/ui/components/card';
import { Handle } from '@peblish/ui/components/handle';
import { Notice } from '@peblish/ui/components/notice';
import { RadioField } from '@peblish/ui/components/radio-field';
import { RadioGroup } from '@peblish/ui/components/radio-group';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { useId, useState, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { translatePlural } from '../../../i18n/translate.ts';
import type { PickerCommunity } from '../-types.ts';

/**
 * The community list (composer-page): one radio per community, so the choice is a form field
 * that works before and without JavaScript. The filter box narrows the list once hydrated; a
 * row it hides stays in the form, so the chosen community is never dropped. A community the
 * person may not post in is disabled, with the reason beside it. Only the options scroll: the
 * group's error comes after them, always in sight, and is an alert as well as its description.
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
  const label = useId();
  const [filter, setFilter] = useState('');
  const wanted = filter.trim().toLowerCase().replace(/^!/, '');
  const shown = (community: PickerCommunity) => wanted === '' || community.handle.toLowerCase().includes(wanted);
  const describe = (community: PickerCommunity) =>
    [
      community.local ? t('composer', 'community.local') : t('composer', 'community.remote'),
      community.restricted && t('composer', 'community.modsOnly'),
      !community.canPost
        ? t('composer', 'community.disabled')
        : community.subscribers !== null && translatePlural(locale, 'composer', 'community.members', community.subscribers),
    ]
      .filter(Boolean)
      .join(', ');
  return (
    <div className="cmp__field cmp__picker">
      <Text as="span" variant="label" size="sm" id={label}>
        {t('composer', 'community.label')}
      </Text>
      <TextField
        type="search"
        label={t('composer', 'community.search')}
        hideLabel
        placeholder={t('composer', 'community.search')}
        value={filter}
        onChange={setFilter}
      />
      {communities.length > 0 && (
        <RadioGroup
          aria-labelledby={label}
          name="community"
          value={value ?? ''}
          onChange={onChange}
          invalid={error !== undefined}
          // The group's own error part is linked to it but is React Aria's FieldError, which drops a
          // role (Mux UI rc.6), so the alert is the span inside it: a Text would recolour the message.
          errorMessage={error === undefined ? undefined : <span role="alert">{error}</span>}
          className="cmp__list"
        >
          <Card.Root variant="outlined" padding="sm" className="cmp__options">
            {communities.map((community) => (
              <RadioField.Root
                key={community.id}
                value={community.id}
                disabled={!community.canPost}
                hidden={!shown(community)}
                className="cmp__row"
              >
                <RadioField.Button>
                  <RadioField.Indicator>
                    <RadioField.Dot />
                  </RadioField.Indicator>
                  <Handle prefix="!" handle={community.handle} />
                </RadioField.Button>
                <RadioField.Description>{describe(community)}</RadioField.Description>
              </RadioField.Root>
            ))}
          </Card.Root>
        </RadioGroup>
      )}
      {communities.length > 0 && communities.every((community) => !shown(community)) && (
        <Text as="p" color="muted">
          {t('composer', 'community.none')}
        </Text>
      )}
      {communities.length === 0 && (
        <Text as="p" color="muted">
          {t('composer', 'community.empty')}
        </Text>
      )}
      {communities.length === 0 && error !== undefined && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
    </div>
  );
}
