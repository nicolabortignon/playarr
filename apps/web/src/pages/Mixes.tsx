import { SlidersHorizontal } from 'lucide-react';
import { Button } from '../components/Button';
import { MixCard } from '../components/Mixes';
import { ErrorState, Skeleton } from '../components/Section';
import { useMixes } from '../lib/queries';
import { GRID, PageTitle } from './Albums';

/** Made for you: every generated mix, and where to tune them. */
export function MixesPage() {
  const { data: mixes, error, isPending, refetch } = useMixes();
  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Made for you" count={mixes?.length}>
        <Button to="/settings/mixes" icon={<SlidersHorizontal />}>
          Tune your mixes
        </Button>
      </PageTitle>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <div className={GRID}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
      ) : mixes.length ? (
        <div className={GRID}>
          {mixes.map((m, i) => (
            <MixCard key={m.key} mix={m} style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }} />
          ))}
        </div>
      ) : (
        <p className="max-w-md text-[15px] text-paper-dim">
          No mixes yet. They appear as you listen and as Playarr learns about your library’s songs (their genres,
          years and sound), which takes a little while after adding music.
        </p>
      )}
    </div>
  );
}
