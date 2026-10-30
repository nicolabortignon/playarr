import { Link, useParams } from 'react-router';
import { SourcesPanel } from '../components/SourcesPanel';
import { cn } from '../lib/cn';
import { PageTitle } from './Albums';

const PANELS = [
  { id: 'sources', label: 'Sources', ready: true },
  { id: 'playback', label: 'Playback', ready: false },
  { id: 'requests', label: 'Requests', ready: false },
  { id: 'appearance', label: 'Appearance', ready: false },
] as const;

export function SettingsPage() {
  const { panel } = useParams();
  const current = PANELS.find((p) => p.id === panel && p.ready) ?? PANELS[0];
  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Settings" />
      <nav aria-label="Settings" className="scrollbar-none mb-10 flex gap-6 overflow-x-auto border-b border-line">
        {PANELS.map((p) =>
          p.ready ? (
            <Link
              key={p.id}
              to={`/settings/${p.id}`}
              aria-current={p.id === current.id ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 pb-3 text-[15px] whitespace-nowrap transition-colors',
                p.id === current.id ? 'border-accent text-paper' : 'border-transparent text-paper-dim/70 hover:text-paper',
              )}
            >
              {p.label}
            </Link>
          ) : (
            <span key={p.id} title="Coming later" className="-mb-px border-b-2 border-transparent pb-3 text-[15px] whitespace-nowrap text-muted/50">
              {p.label}
            </span>
          ),
        )}
      </nav>
      {current.id === 'sources' && <SourcesPanel />}
    </div>
  );
}
