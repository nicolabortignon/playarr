import type { Account } from '@playarr/shared';
import { Settings, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { Menu } from './Menu';

/** The account's name to greet it by: its display name, else its username. */
export const accountName = (account: Pick<Account, 'name' | 'username'>) => account.name.trim() || account.username;

/** The account's initial in a circle of the accent, as on iOS; a person when the name doesn't start with a letter. */
export function AccountAvatar({ name, className }: { name: string; className?: string }) {
  const initial = /^\p{L}/u.exec(name.trim())?.[0]?.toLocaleUpperCase();
  return (
    <span aria-hidden className={cn('grid size-9 place-items-center rounded-full bg-accent text-accent-ink transition hover:brightness-110', className)}>
      {initial ? <span className="font-display text-lg leading-none">{initial}</span> : <UserRound className="size-5" />}
    </span>
  );
}

/** The account's avatar, opening Account and Settings: the corner button of the iOS app's tabs. */
export function AccountMenu({ account }: { account: Pick<Account, 'name' | 'username'> }) {
  const navigate = useNavigate();
  return (
    <Menu
      label="Account and settings"
      trigger={<AccountAvatar name={accountName(account)} />}
      items={[
        { label: 'Account', icon: UserRound, onSelect: () => navigate('/settings/accounts') },
        { label: 'Settings', icon: Settings, onSelect: () => navigate('/settings') },
      ]}
    />
  );
}
