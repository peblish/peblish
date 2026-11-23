import { Card } from '@peblish/ui/components/card';
import { CommunityField, type CommunityOption } from '@peblish/ui/components/community-field';
import { FieldAlert } from '@peblish/ui/components/field-problem';
import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { RadioField } from '@peblish/ui/components/radio-field';
import { RadioGroup } from '@peblish/ui/components/radio-group';
import { Text } from '@peblish/ui/components/text';
import { getRouteApi } from '@tanstack/react-router';
import { useId, useMemo, type ReactNode } from 'react';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { directoryPaths } from '../../../shell/paths.ts';
import type { PickerCommunity } from '../-types.ts';
import { pickerGroups } from './picker-groups.ts';

const root = getRouteApi('__root__');

/** "local, 12 members", "remote, subscribed, mods only, posting disabled for you". */
function useDescribe() {
  const { t, locale } = useTranslate();
  return (community: PickerCommunity) =>
    [
      community.local ? t('composer', 'community.local') : t('composer', 'community.remote'),
      community.restricted && t('composer', 'community.modsOnly'),
      !community.canPost
        ? t('composer', 'community.disabled')
        : community.subscribers !== null && translatePlural(locale, 'composer', 'community.members', community.subscribers),
    ]
      .filter(Boolean)
      .join(', ');
}

/**
 * Create post's community (composer-page): the grouped field (CommunityField), the viewer's joined communities
 * first, then the rest they may post in, then a row to the directory (`onBrowse`, which keeps what was typed). A
 * community the person may not post in is shown disabled, with the reason after it. Until the page hydrates, and for
 * good without scripts, the choice is the radio list below, posted under the same name and values.
 */
export function CommunityPicker({
  communities,
  value,
  onChange,
  onBrowse,
  error,
}: {
  communities: readonly PickerCommunity[];
  value: string | null;
  onChange: (id: string | null) => void;
  onBrowse: () => void;
  error?: ReactNode;
}) {
  const { t } = useTranslate();
  const describe = useDescribe();
  // The sidebar's communities, which the root loader already holds: the ones the viewer joined, with their display
  // names (the composer's loader has none, so a community not joined shows its handle alone).
  const shell = root.useLoaderData({ select: ({ shell }) => shell });
  const names = useMemo(() => new Map([...shell.local, ...shell.remote].map(({ id, displayName }) => [id, displayName])), [shell]);
  const groups = useMemo(() => pickerGroups(communities, new Set(names.keys())), [communities, names]);
  const option = (community: PickerCommunity): CommunityOption => ({
    id: community.id,
    displayName: names.get(community.id) || null,
    handle: community.handle,
    description: describe(community),
    disabled: !community.canPost,
  });
  return (
    <div className="cmp__field cmp__picker">
      <CommunityField
        name="community"
        groups={[
          { id: 'joined', title: t('composer', 'community.joined'), options: groups.joined.map(option) },
          { id: 'others', title: t('composer', 'community.others'), options: groups.others.map(option) },
        ]}
        value={value}
        onChange={onChange}
        onBrowse={onBrowse}
        labels={{
          label: t('composer', 'community.label'),
          placeholder: t('composer', 'community.search'),
          elsewhere: t('composer', 'community.elsewhere'),
          browse: t('composer', 'community.browse'),
          none: t('composer', 'community.none'),
        }}
        description={
          communities.length === 0 ? t('composer', 'community.empty') : groups.truncated ? t('composer', 'community.truncated') : undefined
        }
        error={error}
        required
        fallback={
          <CommunityRadios communities={communities} truncated={groups.truncated} value={value} error={error} describe={describe} />
        }
      />
    </div>
  );
}

/**
 * The choice before hydration and without scripts: one radio per community, a real form field; a closed community is disabled with its
 * reason. A list the loader cut short says so, with the directory's link in place of the field's Browse row.
 */
export function CommunityRadios({
  communities,
  truncated,
  value,
  error,
  describe,
}: {
  communities: readonly PickerCommunity[];
  truncated: boolean;
  value: string | null;
  error?: ReactNode;
  describe: (community: PickerCommunity) => string;
}) {
  const { t } = useTranslate();
  const label = useId();
  return (
    <>
      <Text as="span" variant="label" size="sm" id={label}>
        {t('composer', 'community.label')}
      </Text>
      {communities.length > 0 && (
        <RadioGroup
          aria-labelledby={label}
          name="community"
          defaultValue={value ?? ''}
          invalid={error !== undefined}
          // The group's own error part is React Aria's FieldError, which drops a role, so the alert is the span inside it.
          errorMessage={error === undefined ? undefined : <FieldAlert>{error}</FieldAlert>}
          className="cmp__list"
        >
          <Card.Root variant="outlined" padding="sm" className="cmp__options">
            {communities.map((community) => (
              <RadioField.Root key={community.id} value={community.id} disabled={!community.canPost} className="cmp__row">
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
      {truncated && (
        <Text as="p" size="sm" color="muted">
          {t('composer', 'community.truncated')} <Link href={directoryPaths.browse}>{t('composer', 'community.browse')}</Link>
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
    </>
  );
}
