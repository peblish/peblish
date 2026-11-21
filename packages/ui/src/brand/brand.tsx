import { MarkIcon } from '../components/icons.tsx';
import { Text } from '../components/text.tsx';
import type { BrandPack } from './pack.ts';

/**
 * A pack's mark and, with `withText` (the desktop header; the phone bar shows the mark alone), its wordmark
 * beside it, or the site's name where the name does not contain the wordmark, so the link's name, the site
 * name, always holds the word it shows (label in name). Hidden from assistive technology: the link around it
 * is named by the site name, which is also what a site with no pack shows instead.
 */
export function BrandLockup({ pack, siteName, withText }: { pack: BrandPack; siteName: string; withText: boolean }) {
  const named = siteName.toLowerCase().includes(pack.wordmark.toLowerCase());
  return (
    <span className="pb-brand-lockup" aria-hidden="true">
      <MarkIcon mark={pack.mark} className="pb-brand-lockup__mark" />
      {withText &&
        (named ? (
          <Text className="pb-brand-lockup__wordmark">{pack.wordmark}</Text>
        ) : (
          <Text className="pb-brand-lockup__name" variant="title" size="sm" truncate>
            {siteName}
          </Text>
        ))}
    </span>
  );
}
