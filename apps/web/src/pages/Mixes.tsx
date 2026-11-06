import { SlidersHorizontal, Sparkles } from 'lucide-react';
import { Button } from '../components/Button';
import { MixCard } from '../components/Mixes';
import { PageHeader } from '../components/PageHeader';
import { CardSkeletons, EmptyState, ErrorState } from '../components/States';
import { useMixes } from '../lib/queries';
import { GRID } from './Albums';

/** Made for you: every generated mix, and where to tune them. */
export function MixesPage() {
  const { data: mixes, error, isPending, refetch } = useMixes();
  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader
        title="Made for you"
        count={mixes?.length || undefined}
        actions={
          <Button to="/settings/mixes" icon={<SlidersHorizontal />}>
            Tune your mixes
          </Button>
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <div className={GRID}>
          <CardSkeletons />
        </div>
      ) : mixes.length ? (
        <div className={GRID}>
          {mixes.map((m, i) => (
            <MixCard key={m.key} mix={m} style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Sparkles}
          title="Your mixes are on their way."
          hint="They appear as you listen, and as Playarr learns your library."
          action="lucky"
        />
      )}
    </div>
  );
}
