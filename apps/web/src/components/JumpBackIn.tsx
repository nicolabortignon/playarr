import { Undo2 } from 'lucide-react';
import { useRecentAlbums } from '../lib/queries';
import { toast } from '../lib/toast';
import { playAlbum } from '../player/actions';
import type { PageAction } from './States';

/**
 * Jump back in, as the action of a page that listening fills (the queue, Favorites; docs/design.md, The lines): the
 * album heard last, on any device, played from the start. Undefined while the history loads, null when nothing has
 * been heard yet (Feeling lucky fills the page then). Its glyph is iOS's (`arrow.uturn.backward`).
 */
export function useJumpBackIn(): PageAction | null | undefined {
  const { data: recent, isPending } = useRecentAlbums();
  if (isPending) return undefined;
  const last = recent?.[0];
  if (!last) return null;
  return {
    label: 'Jump back in',
    icon: <Undo2 />,
    title: `Plays “${last.title}”, the album heard last`,
    onClick: () => void playAlbum(last.id).catch((err: Error) => toast(err.message, 'error')),
  };
}
