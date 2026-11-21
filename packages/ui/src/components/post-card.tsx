// PostCard is PostRow's former name. Today's feed, community and profile routes still import it;
// the Commons screens move them to post-row, and then this file goes.
export {
  PostRow as PostCard,
  type Density,
  type PostRowHrefs as PostCardHrefs,
  type PostRowLabels as PostCardLabels,
  type PostRowProps as PostCardProps,
} from './post-row.tsx';
