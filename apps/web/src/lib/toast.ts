import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  /** A button in the toast; a toast with one stays until it's used or dismissed, unless it has a `timeout`. */
  action?: { label: string; run: () => void };
  /** Goes by itself after this many ms even with a button (an Undo for something small); held while pointed at or focused. */
  timeout?: number;
  /** Runs once the toast goes without its button used: a removal that waits for its Undo to pass is made then. */
  done?: () => void;
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, tone?: Toast['tone'], action?: Toast['action'], timeout?: number, done?: () => void) => void;
  /** Take a toast away (its time is up, or it was put off): what waited on it (`done`) goes ahead. */
  dismiss: (id: number) => void;
  /** Use a toast's button (Undo, Reload): the toast goes, and what waited on it doesn't happen. */
  act: (id: number) => void;
  /** Hold a toast while it's pointed at or has the focus, so its button can still be reached; then its time starts over. */
  hold: (id: number, held: boolean) => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** How long an Undo stays: long enough to change your mind, short enough not to pile up over every Play next. */
export const UNDO_MS = 6000;

/** At most this many toasts at once; older ones make way. */
const MAX_TOASTS = 3;

export const useToasts = create<ToastState>()((set, get) => {
  const expire = (t: Toast) => {
    clearTimeout(timers.get(t.id));
    const ms = t.action ? t.timeout : (t.timeout ?? (t.tone === 'error' ? 7000 : 3500));
    if (ms) timers.set(t.id, setTimeout(() => get().dismiss(t.id), ms));
  };
  /** Take toasts off the list, running what waited on each unless its button was used. */
  const remove = (gone: Toast[], used?: number) => {
    if (!gone.length) return;
    const ids = new Set(gone.map((t) => t.id));
    for (const id of ids) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
    set({ toasts: get().toasts.filter((t) => !ids.has(t.id)) });
    for (const t of gone) if (t.id !== used) t.done?.();
  };
  return {
    toasts: [],
    push: (message, tone = 'info', action, timeout, done) => {
      const same = get().toasts.filter((t) => t.message === message);
      // Collapse repeats of the same message (e.g. every track failing for the same reason). A new Undo replaces the
      // one before it, which then can't be taken back: the latest change is the one to undo.
      if (same.length && !action) return void done?.();
      remove(same);
      const toast: Toast = { id: nextId++, message, tone, ...(action ? { action } : {}), ...(timeout ? { timeout } : {}), ...(done ? { done } : {}) };
      const all = [...get().toasts, toast];
      set({ toasts: all.slice(-MAX_TOASTS) });
      remove(all.slice(0, -MAX_TOASTS));
      expire(toast);
    },
    dismiss: (id) => remove(get().toasts.filter((t) => t.id === id)),
    act: (id) => {
      const toast = get().toasts.find((t) => t.id === id);
      if (!toast) return;
      remove([toast], id);
      toast.action?.run();
    },
    hold: (id, held) => {
      const toast = get().toasts.find((t) => t.id === id);
      if (!toast?.timeout) return;
      if (held) clearTimeout(timers.get(id));
      else expire(toast);
    },
  };
});

export const toast = (message: string, tone?: Toast['tone'], action?: Toast['action']) =>
  useToasts.getState().push(message, tone, action);

/**
 * A change made at once, with a way back for a while: "Removed “Teardrop” from the queue · Undo". `done` runs when the
 * Undo has gone unused: for a change that waits until it can no longer be taken back.
 */
export const toastWithUndo = (message: string, undo: () => void, done?: () => void) =>
  useToasts.getState().push(message, 'info', { label: 'Undo', run: undo }, UNDO_MS, done);
