import type { Profile } from '@playarr/shared';
import { Check, Pencil, Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { usePrefs } from '../lib/prefs';
import { switchProfile, useProfileAction, useProfiles } from '../lib/queries';
import { Dialog } from './Dialog';
import { SettingsSection } from './SettingsControls';

const INPUT =
  'h-10 w-full rounded-lg border border-line bg-ink-900 px-3 text-[15px] text-paper outline-none transition focus:border-accent';
const BUTTON =
  'inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-paper transition hover:bg-paper/5 disabled:opacity-40';

/** The profile this device listens as: the one it picked, else the first. */
export function useCurrentProfile(): Profile | undefined {
  const { data } = useProfiles();
  const picked = usePrefs((s) => s.profileId);
  return data?.find((p) => p.id === picked) ?? data?.[0];
}

/** Settings → Profiles: who listens. Each has their own mixes, stats, history and ListenBrainz account. */
export function ProfilesPanel() {
  const { data: profiles, error } = useProfiles();
  const current = useCurrentProfile();
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Profile | null>(null);
  const create = useProfileAction((n: string) => api.createProfile(n));
  const remove = useProfileAction((id: number) => api.deleteProfile(id));

  if (error) return <p className="text-sm text-red-300/80">{error.message}</p>;
  if (!profiles) return <div aria-busy="true" className="h-40 max-w-prose animate-pulse rounded-lg bg-paper/5" />;

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim(), { onSuccess: () => setName('') });
  };

  return (
    <div>
      <SettingsSection
        title="Who listens"
        description="Each person gets their own mixes, listening stats, history and ListenBrainz account. Favorites and playlists are shared by everyone. Pick who listens on this device."
      >
        <ul role="radiogroup" aria-label="Who listens on this device" className="divide-y divide-line">
          {profiles.map((p) => (
            <Row key={p.id} profile={p} chosen={p.id === current?.id} onRemove={profiles.length > 1 ? () => setRemoving(p) : undefined} />
          ))}
        </ul>
        <form onSubmit={add} className="mt-5 flex max-w-md gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="New profile’s name" className={INPUT} maxLength={40} />
          <button type="submit" disabled={!name.trim() || create.isPending} className={cn(BUTTON, 'shrink-0')}>
            <UserPlus className="size-4" /> Add
          </button>
        </form>
      </SettingsSection>

      <Dialog open={!!removing} onClose={() => setRemoving(null)} title={`Remove ${removing?.name}?`}>
        <div className="space-y-5 p-5">
          <p className="text-[15px] text-paper-dim">Their listening history, mixes and stats are deleted. Favorites and playlists stay.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRemoving(null)} className={BUTTON}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() =>
                removing &&
                remove.mutate(removing.id, {
                  onSuccess: () => {
                    if (usePrefs.getState().profileId === removing.id) switchProfile(profiles.find((p) => p.id !== removing.id)!.id);
                  },
                  onSettled: () => setRemoving(null),
                })
              }
              className="inline-flex h-10 items-center rounded-full bg-red-400/90 px-5 text-[14px] font-medium text-ink-950 transition hover:bg-red-400"
            >
              Remove
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function Row({ profile, chosen, onRemove }: { profile: Profile; chosen: boolean; onRemove?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const rename = useProfileAction((n: string) => api.renameProfile(profile.id, n));
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== profile.name) rename.mutate(name.trim(), { onSuccess: () => setEditing(false) });
    else setEditing(false);
  };
  return (
    <li className="flex items-center gap-3 py-2">
      <button
        type="button"
        role="radio"
        aria-checked={chosen}
        aria-label={`${profile.name} listens on this device`}
        onClick={() => switchProfile(profile.id)}
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-full border transition',
          chosen ? 'border-accent bg-accent text-accent-ink' : 'border-paper/25 hover:border-paper/50',
        )}
      >
        {chosen && <Check className="size-3.5" strokeWidth={3} />}
      </button>
      {editing ? (
        <form onSubmit={save} className="flex flex-1 gap-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" className={INPUT} maxLength={40} />
          <button type="submit" className={cn(BUTTON, 'shrink-0')}>
            Save
          </button>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-[15px] text-paper">
            {profile.name}
            {chosen && <span className="ml-2 text-[13px] text-muted">this device</span>}
          </span>
          <button
            type="button"
            aria-label={`Rename ${profile.name}`}
            onClick={() => setEditing(true)}
            className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper"
          >
            <Pencil className="size-4" />
          </button>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${profile.name}`}
              onClick={onRemove}
              className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </>
      )}
    </li>
  );
}
