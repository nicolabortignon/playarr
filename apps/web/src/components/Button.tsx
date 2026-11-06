import { LoaderCircle } from 'lucide-react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '../lib/cn';

/** docs/design.md, Controls. Primary is the one main action on a screen; danger destroys something. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** Large 48 (a page's action row, an empty page's action), regular 40 (dialogs, panels), small 32 (in a card or a row). */
export type ButtonSize = 'large' | 'regular' | 'small';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 active:brightness-95',
  secondary: 'border border-paper/15 text-paper hover:border-paper/35 hover:bg-paper/5 active:border-paper/35 active:bg-paper/5',
  ghost: 'text-paper-dim hover:bg-paper/5 hover:text-paper active:bg-paper/5',
  danger: 'bg-danger text-ink-950 hover:brightness-110 active:brightness-95',
};

const SIZES: Record<ButtonSize, { box: string; padding: string; withIcon: string; icon: string }> = {
  large: { box: 'h-12 gap-2 type-body', padding: 'px-6', withIcon: 'pl-5 pr-6', icon: '*:size-5' },
  regular: { box: 'h-10 gap-2 type-body', padding: 'px-5', withIcon: 'pl-4 pr-5', icon: '*:size-4.5' },
  // Drawn 32 tall, it still takes 44 to tap on touch screens.
  small: { box: 'h-8 gap-1.5 text-sm tap-target', padding: 'px-3.5', withIcon: 'pl-3 pr-3.5', icon: '*:size-4' },
};

interface CommonProps {
  /** Secondary unless said. */
  variant?: ButtonVariant;
  /** Regular unless said. */
  size?: ButtonSize;
  /** A leading icon (`<Shuffle />`), sized to the button: 20, 18 or 16. */
  icon?: ReactNode;
  /** The label, in sentence case. */
  children: ReactNode;
  className?: string;
  /** For the label alone, e.g. to hide it as the action row narrows. */
  labelClassName?: string;
}

type AsButton = CommonProps &
  Omit<ComponentPropsWithRef<'button'>, keyof CommonProps> & {
    to?: undefined;
    /** Under way: disabled, the icon spins, and the label may say so ("Requesting…"). */
    pending?: boolean;
    pendingLabel?: ReactNode;
  };
type AsLink = CommonProps & Omit<LinkProps, keyof CommonProps> & { ref?: ComponentPropsWithRef<'a'>['ref'] };

/** A `<button>`, or with `to`, a link drawn the same ("Back home"). */
export type ButtonProps = AsButton | AsLink;

/** Every action is this capsule: sentence case, Schibsted Grotesk medium, an optional leading icon. */
export function Button({ variant = 'secondary', size = 'regular', icon, children, className, labelClassName, ...props }: ButtonProps) {
  const pending = props.to === undefined && props.pending;
  const s = SIZES[size];
  const classes = cn(
    'relative inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap transition select-none active:not-disabled:scale-98 disabled:opacity-40',
    s.box,
    icon || pending ? s.withIcon : s.padding,
    VARIANTS[variant],
    variant === 'primary' && size === 'large' && 'shadow-glow',
    className,
  );
  const glyph = pending ? <LoaderCircle className="animate-spin" /> : icon;
  const content = (label: ReactNode) => (
    <>
      {glyph && (
        <span aria-hidden className={cn('grid shrink-0 place-items-center', s.icon)}>
          {glyph}
        </span>
      )}
      <span className={labelClassName}>{label}</span>
    </>
  );

  if (props.to !== undefined) {
    return (
      <Link {...props} className={classes}>
        {content(children)}
      </Link>
    );
  }
  const { pending: _, pendingLabel, type = 'button', disabled, ...button } = props;
  return (
    <button type={type} disabled={disabled || pending} aria-busy={pending || undefined} {...button} className={classes}>
      {content(pending && pendingLabel ? pendingLabel : children)}
    </button>
  );
}

interface IconCommonProps {
  /** Its accessible name: an icon alone says nothing to a screen reader. */
  label: string;
  /** Large is 48, for the action row; regular is 44 to tap on touch screens and 36 with a mouse. */
  size?: 'regular' | 'large';
  /** A paper ring round it, as in the action row; the default for large. */
  outlined?: boolean;
  /** The icon, 20 (`size-5`). */
  children: ReactNode;
  className?: string;
}

type IconAsButton = IconCommonProps & Omit<ComponentPropsWithRef<'button'>, keyof IconCommonProps | 'aria-label'> & { to?: undefined };
type IconAsLink = IconCommonProps & Omit<LinkProps, keyof IconCommonProps | 'aria-label'> & { ref?: ComponentPropsWithRef<'a'>['ref'] };

/** A round button that is only an icon, always with a name. With `to`, a link drawn the same. */
export function IconButton({ label, size = 'regular', outlined = size === 'large', className, ...props }: IconAsButton | IconAsLink) {
  const classes = cn(
    'relative inline-grid shrink-0 place-items-center rounded-full transition disabled:opacity-40',
    size === 'large' ? 'size-12' : 'size-11 pointer-fine:size-9',
    outlined
      ? 'border border-paper/15 text-paper hover:border-paper/35 hover:bg-paper/5 active:border-paper/35 active:bg-paper/5'
      : 'text-muted hover:bg-paper/8 hover:text-paper active:bg-paper/8',
    className,
  );
  if (props.to !== undefined) return <Link {...props} aria-label={label} className={classes} />;
  const { type = 'button', ...button } = props;
  return <button type={type} {...button} aria-label={label} className={classes} />;
}
