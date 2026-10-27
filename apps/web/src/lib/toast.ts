import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (message, tone = 'info') => {
    // Collapse repeats of the same message (e.g. every track failing for the same reason).
    if (get().toasts.some((t) => t.message === message)) return;
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, message, tone }].slice(-3) });
    setTimeout(() => get().dismiss(id), tone === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (message: string, tone?: Toast['tone']) => useToasts.getState().push(message, tone);
