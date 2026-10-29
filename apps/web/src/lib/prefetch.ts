import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { artistHero, sized } from './api';
import { albumQuery, artistQuery, playlistQuery } from './queries';

/** A pointer resting this long on a link counts as intent; sweeping across the page doesn't. */
const HOVER_INTENT_MS = 80;
const MAX_PRELOADED = 300;

const preloaded = new Set<string>();

/** Warm the browser's (and the service worker's) image cache. */
export function preloadImage(url: string | undefined) {
  if (!url || preloaded.has(url)) return;
  preloaded.add(url);
  if (preloaded.size > MAX_PRELOADED) preloaded.delete(preloaded.values().next().value!);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

/** Fetch what a page needs before it opens: its data, the other data it waits for, and its header image. */
export function prefetchPage(client: QueryClient, path: string) {
  const [, kind, raw] = path.split('/');
  const id = Number(raw);
  if (!Number.isInteger(id)) return;
  if (kind === 'albums') {
    void client.ensureQueryData(albumQuery(id)).then((album) => {
      preloadImage(sized(album.coverUrl, 320));
      return client.prefetchQuery(artistQuery(album.artistId));
    }, noop);
  } else if (kind === 'artists') {
    void client.ensureQueryData(artistQuery(id)).then((artist) => preloadImage(artistHero(artist)), noop);
  } else if (kind === 'playlists') {
    void client.ensureQueryData(playlistQuery(id)).then((playlist) => preloadImage(sized(playlist.cover.url, 256)), noop);
  }
}

/**
 * Prefetch album, artist and playlist pages on intent: a mouse resting on a link, a finger or
 * button going down on it, or keyboard focus. By the time the click lands the page is usually ready.
 */
export function usePrefetchOnIntent() {
  const client = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prefetch = (target: EventTarget | null) => {
      const link = target instanceof Element ? target.closest('a[href]') : null;
      if (link instanceof HTMLAnchorElement && link.origin === location.origin) prefetchPage(client, link.pathname);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(timer);
      timer = setTimeout(() => prefetch(e.target), HOVER_INTENT_MS);
    };
    const onOut = () => clearTimeout(timer);
    const now = (e: Event) => prefetch(e.target);
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointerdown', now);
    document.addEventListener('focusin', now);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointerdown', now);
      document.removeEventListener('focusin', now);
    };
  }, [client]);
}

function noop() {}
