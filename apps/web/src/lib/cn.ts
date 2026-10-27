import { twMerge } from 'tailwind-merge';

/** Join class names; later Tailwind utilities override conflicting earlier ones. */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return twMerge(classes.filter(Boolean).join(' '));
}
