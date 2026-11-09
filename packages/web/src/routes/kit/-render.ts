import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { createMarkdownRenderer } from '../../server/markdown.ts';
import { isKitEnabled } from './-enabled.ts';
import { deepThreadSamples, proseMarkdown, proseRemoteHtml, threadSamples, withBodies } from './-samples.ts';

/**
 * The gallery's bodies, rendered on the server the way a post or thread page renders them:
 * Markdown through the site renderer, a remote object's HTML through the sanitiser. `Prose`
 * and `CommentThread` therefore show real pipeline output, not hand-written markup. It is a
 * public endpoint of its own, so it refuses (404) when the gallery is off, not only the route.
 */
export const loadKitContent = createServerFn({ method: 'GET' }).handler(async () => {
  if (!isKitEnabled()) throw notFound();
  const renderer = await createMarkdownRenderer();
  const render = (source: string, id: string) => renderer.render(source, { idPrefix: id }).html;
  return {
    thread: withBodies(threadSamples, render),
    deepThread: withBodies(deepThreadSamples, render),
    markdown: renderer.render(proseMarkdown, { idPrefix: 'kit' }).html,
    remote: renderer.sanitize(proseRemoteHtml, { baseUrl: 'https://piefed.example/post/1' }).html,
  };
});
