import { useSearchParams } from 'react-router';
import { Button } from './Button';

/** The address of a first step: its Settings panel, saying it's one of the owner's first steps. */
export const FIRST_STEPS = { music: '/settings/sources?first', household: '/settings/accounts?first' } as const;

/**
 * The owner's first steps after claiming the server (plan 4 §3): add their music, then invite the household, then
 * listen. Above Settings → Sources and Settings → Accounts when they're opened as a first step (`?first`), saying
 * which step it is and leading to the next; `ready` is whether this one is done (the music step: a source added).
 */
export function FirstSteps({ step, ready = true }: { step: 'music' | 'household'; ready?: boolean }) {
  const [params] = useSearchParams();
  if (!params.has('first')) return null;
  const music = step === 'music';
  return (
    <section aria-label="First steps" className="mb-10 max-w-prose rounded-xl border border-line p-5">
      <p className="mb-1 type-kicker text-muted">First steps · {music ? 1 : 2} of 2</p>
      <h2 className="type-section-title text-paper">{music ? 'Add your music' : 'Invite your household'}</h2>
      <p className="mt-2 type-body text-paper-dim">
        {music
          ? 'Point Playarr at Lidarr or a folder of music, here or on another computer; the library fills in as it reads them. More places can come later.'
          : 'Add an account for each person. Each gets a setup link to choose a password with, here or in the Playarr app.'}
      </p>
      <div className="mt-4">
        {music ? (
          <Button to={FIRST_STEPS.household} variant={ready ? 'primary' : 'ghost'}>
            {ready ? 'Next: invite your household' : 'Skip for now'}
          </Button>
        ) : (
          <Button to="/" variant="primary">
            Start listening
          </Button>
        )}
      </div>
    </section>
  );
}
