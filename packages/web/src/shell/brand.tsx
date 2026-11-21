import { BrandLockup } from '@peblish/ui/brand/brand';
import type { BrandPack } from '@peblish/ui/brand/pack.ts';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';

/**
 * The site's name, linking home: in the desktop header (`pb-brand`, which e2e/support/site-name.ts
 * reads, so only the header has it) and in the phone's top bar (`pb-bar-brand`). With a brand pack the
 * pack's mark stands for it, with the wordmark beside it in the header only, and the name names the
 * link; without one the name is the link's text.
 */
export function Brand({ siteName, pack, className }: { siteName: string; pack: BrandPack | null; className: 'pb-brand' | 'pb-bar-brand' }) {
  if (pack)
    return (
      <Link className={`${className} pb-link-quiet`} href="/" aria-label={siteName}>
        <BrandLockup pack={pack} siteName={siteName} withText={className === 'pb-brand'} />
      </Link>
    );
  return (
    <Link className={`${className} pb-link-quiet`} href="/">
      <Text variant="title" size="sm" truncate>
        {siteName}
      </Text>
    </Link>
  );
}
