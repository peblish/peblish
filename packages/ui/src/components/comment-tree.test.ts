import type { CommentView } from '@peblish/schema/views';
import { expect, test } from 'vitest';
import { buildCommentTree } from './comment-tree.ts';

const comment = (id: string, parentId: string | null): CommentView => ({ id, parentId }) as CommentView;

test('replies nest under their parent in list order, and each node counts its descendants', () => {
  const tree = buildCommentTree([comment('a', null), comment('b', 'a'), comment('c', 'b'), comment('d', 'a'), comment('e', null)]);
  expect(tree.map(({ comment }) => comment.id)).toEqual(['a', 'e']);
  expect(tree[0]?.children.map(({ comment }) => comment.id)).toEqual(['b', 'd']);
  expect(tree[0]?.descendants).toBe(3);
  expect(tree[0]?.children[0]?.descendants).toBe(1);
});

test('a comment whose parent is not in the list starts a subtree', () => {
  const tree = buildCommentTree([comment('x', 'missing'), comment('y', 'x')]);
  expect(tree.map(({ comment }) => comment.id)).toEqual(['x']);
  expect(tree[0]?.children).toHaveLength(1);
});
