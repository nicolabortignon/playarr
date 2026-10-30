import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  /** A button in the toast; a toast with one stays until it's used or dismissed. */
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, tone?: Toast['tone'], action?: Toast['action']) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (message, tone = 'info', action) => {
    // Collapse repeats of the same message (e.g. every track failing for the same reason).
    if (get().toasts.some((t) => t.message === message)) return;
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, message, tone, ...(action ? { action } : {}) }].slice(-3) });
    if (!action) setTimeout(() => get().dismiss(id), tone === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (message: string, tone?: Toast['tone'], action?: Toast['action']) =>
  useToasts.getState().push(message, tone, action);
