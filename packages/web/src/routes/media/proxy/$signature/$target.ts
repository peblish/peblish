import { edgeConfig } from '@peblish/core/edge/config';
import { publicAnswerTags } from '@peblish/core/edge/public';
import { mediaProxyKey, type MediaContent } from '@peblish/core/media/proxy-url';
import { contentShown } from '@peblish/core/media/reference';
import type { Viewer } from '@peblish/core/posts/read';
import { readSetting } from '@peblish/core/settings/read';
import { createFileRoute } from '@tanstack/react-router';
import { formSession } from '../../../../server/auth.ts';
import { proxyResponse } from '../-handler.ts';

// GET /media/proxy/<signature>/<target>: a remote image, fetched on the viewer's behalf. The
// URLs are made by siteMarkdown() (packages/web/src/server/markdown.ts) and imageSource().
export const Route = createFileRoute('/media/proxy/$signature/$target')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        // The answer may depend on who asks (a removed post's image for its moderators, a sensitive
        // community's banner), so it is read for this viewer and is `private`, unless edge caching
        // is configured and one consistent read after the fetch finds it public for everyone
        // (-handler.ts). A HEAD is never public: it is answered by this handler too, and a shared
        // cache has no reason to hold a body-less answer. A refusal is never cached. The browser's
        // Hide NSFW cookies are not read: they decide how a page covers sensitive content, not
        // whether the viewer may see it (core media/reference.ts).
        const shown = async (content: MediaContent) => {
          const { session } = await formSession(request);
          const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
          return contentShown(content, viewer);
        };
        const config = edgeConfig();
        return proxyResponse(params.signature, params.target, {
          key: await mediaProxyKey(),
          enabled: await readSetting('remote_media.enabled'),
          contentShown: shown,
          signal: request.signal,
          edge: request.method === 'GET' && config ? { publicTags: (check) => publicAnswerTags(check, config.zoneId) } : null,
        });
      },
    },
  },
});
