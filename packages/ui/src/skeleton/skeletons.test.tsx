import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { FeedSkeleton, InboxSkeleton, RailSkeleton, ThreadSkeleton } from './skeletons.tsx';

test('the shapes are hidden from assistive technology and the label is the one status', () => {
  for (const host of [
    <FeedSkeleton key="feed" density="card" label="Loading posts" />,
    <RailSkeleton key="rail" label="Loading posts" />,
    <ThreadSkeleton key="thread" label="Loading posts" />,
    <InboxSkeleton key="inbox" label="Loading posts" />,
  ]) {
    const html = renderToStaticMarkup(host);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toMatch(/<div aria-hidden="true" class="pb-skeleton__shapes">/);
    expect(html).not.toMatch(/<(a|button|input)\b/);
  }
  expect(renderToStaticMarkup(<RailSkeleton />)).not.toContain('role="status"');
});

test('a feed reserves its rows in the density, in PostRow layout', () => {
  const rows = (density: 'card' | 'classic' | 'compact') =>
    renderToStaticMarkup(<FeedSkeleton density={density} />).match(new RegExp(`class="pb-post" data-density="${density}"`, 'g'))?.length;
  expect([rows('card'), rows('classic'), rows('compact')]).toEqual([4, 6, 8]);
  expect(renderToStaticMarkup(<FeedSkeleton density="card" />)).toContain('pb-post__media');
});
