/** A username: 1 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** A free username made from a display name: "Zoë B." → "zoe-b", or "zoe-b-2" when that's taken. */
export function usernameFrom(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'listener';
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}
