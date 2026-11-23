import type { PostView } from '@peblish/schema/views';
import { useRouter } from '@tanstack/react-router';
import { SaveForm } from '../../../saved/-ui/save-form.tsx';

/**
 * Save or Unsave the post (lane f-saves), beside the other action slots for a signed-in viewer. Hidden
 * on a withheld post (deleted, or removed for this viewer) unless it is saved, so a save can still be
 * dropped. After the change the page's data reloads, so the control reads the new state.
 */
export function PostSave({ post, withheld, back }: { post: PostView; withheld: boolean; back: string }) {
  const router = useRouter();
  if (withheld && !post.saved) return null;
  return <SaveForm postId={post.id} title={post.title} saved={post.saved === true} back={back} onDone={() => router.invalidate()} />;
}
