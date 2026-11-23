import { commentPermalink, postPermalink } from '@peblish/core/posts/permalink';
import { expect, test } from 'vitest';
import { commentPath, postPath } from './paths.ts';

// Core builds the views' permalinks without web's paths; they must stay the pages web serves.
test("core's permalinks are the origin and the paths of the post and comment pages", () => {
  const origin = 'https://feddit.test';
  const postId = '0192f5a0-1234-7abc-8def-0123456789ab';
  const commentId = '0192f5a0-1234-7abc-8def-0123456789ac';
  expect(postPermalink(origin, postId)).toBe(`${origin}${postPath(postId)}`);
  expect(commentPermalink(origin, postId, commentId)).toBe(`${origin}${commentPath(postId, commentId)}`);
});
