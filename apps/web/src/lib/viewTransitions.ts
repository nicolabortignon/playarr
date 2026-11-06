import { useQueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef, type MouseEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { UNSAFE_ViewTransitionContext, useLocation, useNavigate } from 'react-router';
import { reduceMotionNow, useReduceMotion } from './motion';
import { albumQuery } from './queries';
import { useUI } from './ui';

/*
 * Covers that grow (plan 7 §1): opening an album from its cover grows the cover into the album page's header, and the
 * player's cover grows into Now Playing's; going back shrinks it home. The browser's View Transitions API moves what's
 * named (index.css: only that, the rest of the page changes at once underneath); where a browser hasn't the API,
 * nothing moves, and under Reduce Motion no transition starts.
 */

/** The names a view transition moves (index.css): an album's cover, and Now Playing's cover and sheet. */
export const ALBUM_COVER = 'album-cover';
export const NOW_PLAYING_COVER = 'now-playing-cover';
export const NOW_PLAYING = 'now-playing';

/** The browser can run a view transition in the page (Chrome 111, Safari 18, Firefox 144 and later). */
export const canTransitionViews = (): boolean => typeof document !== 'undefined' && typeof document.startViewTransition === 'function';

/** Covers grow here and now: the browser can, and motion isn't reduced. For a link's `viewTransition`. */
export function useCoversGrow(): boolean {
  return !useReduceMotion() && canTransitionViews();
}

const albumIn = (pathname: string) => {
  const id = /^\/albums\/(\d+)\/?$/.exec(pathname)?.[1];
  return id === undefined ? null : Number(id);
};

/**
 * The album whose cover grows into its page, or shrinks back out of it, in the view transition React Router is running:
 * the album page is the transition's next location both ways (React Router plays going back as the way there,
 * reversed). Null between transitions, and under Reduce Motion.
 */
export function useGrowingAlbum(): number | null {
  const transition = useContext(UNSAFE_ViewTransitionContext);
  return transition.isTransitioning && !reduceMotionNow() ? albumIn(transition.nextLocation.pathname) : null;
}

/** The album page's cover's name while it grows out of a card or shrinks back into one (DetailHeader's `coverName`). */
export function useAlbumCoverName(albumId: number): string | undefined {
  return useGrowingAlbum() === albumId ? ALBUM_COVER : undefined;
}

/** Where each album's cover last grew from: the page (its history entry) and which of the album's covers there. */
const grewFrom = new Map<number, { page: string; nth: number }>();

/** The album's growing covers on the page, in order (they carry `data-grows`, their album). */
const coversOf = (albumId: number) => [...document.querySelectorAll<HTMLElement>(`[data-grows="${albumId}"]`)];

/**
 * How long a cover pressed waits for its album, when it isn't loaded yet (a tap: no pointer rested on it to load it
 * ahead), so the page opens with its cover to grow into rather than its skeleton. Past that it opens anyway.
 */
const WAIT_FOR_ALBUM_MS = 250;

/** A plain click, which the link follows here (not one opening a new tab or window). */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.defaultPrevented;

/**
 * A cover on a card that opens its album (AlbumCard, Discover's cards, Home's fanned covers). Put `ref` and `data-grows`
 * on the cover's box, `onClick` on the link and `viewTransition` on it too. A click remembers it as the cover the album
 * grows from (the page, and which of the album's covers on it: the same album can be on two shelves). While the view
 * transition runs, that cover is named: going there, so the album page's cover grows out of it; coming back, as the
 * page comes back, so the album's cover shrinks back into it, and the card it lands in (`card`, else the cover's box)
 * doesn't rise into place meanwhile.
 */
export function useGrowingCover<T extends HTMLElement = HTMLDivElement>(albumId: number | undefined, card?: RefObject<HTMLElement | null>) {
  const ref = useRef<T>(null);
  const page = useLocation().key;
  const growing = useGrowingAlbum();
  const viewTransition = useCoversGrow() && albumId !== undefined;
  const client = useQueryClient();
  const navigate = useNavigate();
  // A press waiting for its album: another doesn't open the page twice.
  const waiting = useRef(false);

  // Named before each picture is taken: layout effects run before the page that's going is pictured (React Router
  // starts the transition from an effect), and as the page that's coming mounts, before it's pictured.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = albumId !== undefined && growing === albumId ? grewFrom.get(albumId) : undefined;
    if (!from || from.page !== page || coversOf(albumId!).indexOf(el) !== from.nth) {
      // Not the cover this album grows from, or no transition (it's over): nothing left to clash with the next one.
      el.style.viewTransitionName = '';
      return;
    }
    el.style.viewTransitionName = ALBUM_COVER;
    // Mounted mid-transition, the album's cover lands here: the card (or the cover) doesn't rise into place under it.
    (card?.current ?? el).style.setProperty('animation', 'none');
  }, [albumId, growing, page, card]);

  const onClick = (e: MouseEvent) => {
    const el = ref.current;
    if (!viewTransition || !el || albumId === undefined) return;
    if (waiting.current) return e.preventDefault();
    if (!plainClick(e)) return;
    grewFrom.set(albumId, { page, nth: coversOf(albumId).indexOf(el) });
    if (client.getQueryData(albumQuery(albumId).queryKey)) return;
    // Not loaded yet: the page would open on its skeleton, with no cover to grow into. A moment for it, then go.
    e.preventDefault();
    waiting.current = true;
    const go = () => {
      waiting.current = false;
      void navigate(`/albums/${albumId}`, { viewTransition: true });
    };
    void Promise.race([client.ensureQueryData(albumQuery(albumId)), new Promise((resolve) => setTimeout(resolve, WAIT_FOR_ALBUM_MS))]).then(go, go);
  };

  return { ref, onClick, viewTransition };
}

/** Opens Now Playing, the player's cover growing into its own (plan 7 §1), its sheet fading in around it. */
export function openNowPlaying() {
  morphNowPlaying(true);
}

/** Closes Now Playing, its cover shrinking back into the player's as the sheet fades away. */
export function closeNowPlaying() {
  morphNowPlaying(false);
}

/**
 * Between the player and Now Playing through a view transition: the player's cover is named for the first picture
 * (opening), Now Playing's cover and sheet for the second, or the other way round; Now Playing opens without sliding up,
 * or closes at once (its sheet's slide would be in the picture). Where nothing can move, or with the words showing in
 * the cover's place (Lyrics), the sheet just slides.
 */
function morphNowPlaying(open: boolean) {
  const ui = useUI.getState();
  if (ui.nowPlayingOpen === open) return;
  if (!canTransitionViews() || reduceMotionNow() || ui.lyricsOpen) return ui.setNowPlaying(open);
  const done = () => useUI.setState({ coverMorph: null });
  try {
    flushSync(() => useUI.setState({ coverMorph: open ? 'player' : 'sheet' }));
    const transition = document.startViewTransition(() => {
      flushSync(() =>
        useUI.setState(
          open
            ? { coverMorph: 'sheet', nowPlayingOpen: true, nowPlayingGrown: true }
            : { coverMorph: 'player', nowPlayingOpen: false, nowPlayingGrown: false, nowPlayingCut: useUI.getState().nowPlayingCut + 1 },
        ),
      );
    });
    transition.finished.then(done, done);
  } catch {
    done();
    ui.setNowPlaying(open);
  }
}
