import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  /** A button in the toast; a toast with one stays until it's used or dismissed, unless it has a `timeout`. */
  action?: { label: string; run: () => void };
  /** Goes by itself after this many ms even with a button (an Undo for something small); held while pointed at or focused. */
  timeout?: number;
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, tone?: Toast['tone'], action?: Toast['action'], timeout?: number) => void;
  dismiss: (id: number) => void;
  /** Hold a toast while it's pointed at or has the focus, so its button can still be reached; then its time starts over. */
  hold: (id: number, held: boolean) => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** How long an Undo stays: long enough to change your mind, short enough not to pile up over every Play next. */
export const UNDO_MS = 6000;

export const useToasts = create<ToastState>()((set, get) => {
  const expire = (t: Toast) => {
    clearTimeout(timers.get(t.id));
    const ms = t.action ? t.timeout : (t.timeout ?? (t.tone === 'error' ? 7000 : 3500));
    if (ms) timers.set(t.id, setTimeout(() => get().dismiss(t.id), ms));
  };
  return {
    toasts: [],
    push: (message, tone = 'info', action, timeout) => {
      // Collapse repeats of the same message (e.g. every track failing for the same reason).
      if (get().toasts.some((t) => t.message === message)) return;
      const toast: Toast = { id: nextId++, message, tone, ...(action ? { action } : {}), ...(timeout ? { timeout } : {}) };
      set({ toasts: [...get().toasts, toast].slice(-3) });
      expire(toast);
    },
    dismiss: (id) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
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

/** A change made at once, with a way back for a while: "“Teardrop” plays next · Undo". */
export const toastWithUndo = (message: string, undo: () => void) => useToasts.getState().push(message, 'info', { label: 'Undo', run: undo }, UNDO_MS);
