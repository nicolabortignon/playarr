import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

/** "⋯" button with a popover menu, portaled so it escapes scroll/overflow containers. */
export function Menu({ items, label = 'More actions', className }: { items: MenuItem[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, up: false });
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const height = items.length * 40 + 12;
    const up = r.bottom + height > window.innerHeight - 16;
    setPos({ top: up ? r.top - height - 4 : r.bottom + 4, left: Math.max(8, r.right - 220), up });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'pointerdown' && (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    menu.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={cn('grid size-9 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper', className)}
      >
        <MoreHorizontal className="size-[18px]" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            style={{ top: pos.top, left: pos.left }}
            className={cn(
              'fixed z-[150] w-[220px] origin-top-right animate-[fade_.15s_ease-out] rounded-lg border border-line bg-ink-800/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl',
              pos.up && 'origin-bottom-right',
            )}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-paper-dim transition outline-none hover:bg-paper/8 hover:text-paper focus-visible:bg-paper/8 focus-visible:text-paper"
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
