import { Button } from '@peblish/ui/components/button';
import { LinkIcon, ShareIcon } from '@peblish/ui/components/icons';
import { absoluteUrl, copyLink, shareLink, type ShareOutcome } from '@peblish/ui/components/share-link.ts';
import { Text } from '@peblish/ui/components/text';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { useEffect, useRef, useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';

/**
 * The post's Share and Copy link, as pills in its action row, and one polite status after them saying what
 * happened: "Link copied." for a moment, or, when the browser refuses the clipboard, the link itself to copy
 * by hand. Share opens the browser's share sheet (pending while it is open) and copies where there is none;
 * closing the sheet says nothing. Both need scripts: disabled until the page hydrates, and gone without them
 * (post.css). The address is built when pressed, from the page's own origin.
 */
export function PostShare({ path, title }: { path: string; title: string }) {
  const { t } = useTranslate();
  const hydrated = useHydrated();
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; link: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function tell(outcome: ShareOutcome, link: string) {
    clearTimeout(timer.current);
    if (outcome === 'copied') {
      setNotice({ text: t('posts', 'share.copied'), link: null });
      timer.current = setTimeout(() => setNotice(null), 4000);
    } else if (outcome === 'failed') setNotice({ text: t('posts', 'share.failed'), link });
  }

  async function share() {
    const link = absoluteUrl(path);
    setSharing(true);
    try {
      tell(await shareLink(link, title), link);
    } finally {
      setSharing(false);
    }
  }

  async function copy() {
    const link = absoluteUrl(path);
    tell(await copyLink(link), link);
  }

  return (
    <>
      <Button
        variant="neutral"
        size="sm"
        className="post-pill post-share"
        aria-label={t('posts', 'share.share')}
        disabled={!hydrated}
        pending={sharing}
        onActivate={() => void share()}
      >
        <ShareIcon />
        <Text className="post-pill__label">{t('posts', 'share.share')}</Text>
      </Button>
      <Button
        variant="neutral"
        size="sm"
        className="post-pill post-share"
        aria-label={t('posts', 'share.copy')}
        disabled={!hydrated}
        onActivate={() => void copy()}
      >
        <LinkIcon />
        <Text className="post-pill__label">{t('posts', 'share.copy')}</Text>
      </Button>
      <Text role="status" size="sm" color="muted" className="post-share__status">
        {notice?.text}
        {notice?.link && (
          <>
            {' '}
            <Text size="sm" className="post-share__link">
              {notice.link}
            </Text>
          </>
        )}
      </Text>
    </>
  );
}
