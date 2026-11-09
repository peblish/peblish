import { mediaProxyKey } from '@peblish/core/media/proxy-url';
import { readSetting } from '@peblish/core/settings/read';
import { createFileRoute } from '@tanstack/react-router';
import { proxyResponse } from '../-handler.ts';

// GET /media/proxy/<signature>/<target>: a remote image, fetched on the viewer's behalf. The
// URLs are made by siteMarkdown() (packages/web/src/server/markdown.ts) and imageSource().
export const Route = createFileRoute('/media/proxy/$signature/$target')({
  server: {
    handlers: {
      GET: async ({ params }) =>
        proxyResponse(params.signature, params.target, { key: await mediaProxyKey(), enabled: await readSetting('remote_media.enabled') }),
    },
  },
});
