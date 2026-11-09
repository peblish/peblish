import type { CommentView } from '@peblish/schema/views';

export interface CommentNode {
  comment: CommentView;
  children: CommentNode[];
  /** Every comment under this one that the list holds. */
  descendants: number;
}

/**
 * Builds the tree from a flat list in display order. A comment whose parent is not in the
 * list (the top of a "continue this thread" subtree) is a root; siblings keep their order in
 * the list, so the server's sort decides what comes first.
 */
export function buildCommentTree(comments: readonly CommentView[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const comment of comments) nodes.set(comment.id, { comment, children: [], descendants: 0 });
  const roots: CommentNode[] = [];
  for (const comment of comments) {
    const node = nodes.get(comment.id);
    if (!node) continue;
    const parent = comment.parentId === null ? undefined : nodes.get(comment.parentId);
    (parent ? parent.children : roots).push(node);
  }
  const count = (node: CommentNode): number => (node.descendants = node.children.reduce((sum, child) => sum + 1 + count(child), 0));
  // An explicit stack would avoid recursion limits, but the server caps a thread at depth 50.
  roots.forEach(count);
  return roots;
}
