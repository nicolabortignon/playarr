import { Link, useParams } from 'react-router';
import { AppearancePanel } from '../components/AppearancePanel';
import { PlaybackPanel } from '../components/PlaybackPanel';
import { RequestsPanel } from '../components/RequestsPanel';
import { SourcesPanel } from '../components/SourcesPanel';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { cn } from '../lib/cn';
import { PageTitle } from './Albums';

const PANELS = [
  { id: 'sources', label: 'Sources', scope: undefined, Panel: SourcesPanel },
  { id: 'playback', label: 'Playback', scope: 'These settings are for this device.', Panel: PlaybackPanel },
  { id: 'requests', label: 'Requests', scope: 'These settings apply to everyone.', Panel: RequestsPanel },
  { id: 'appearance', label: 'Appearance', scope: 'These settings are for this device.', Panel: AppearancePanel },
  { id: 'updates', label: 'Updates', scope: 'These settings apply to everyone.', Panel: UpdatesPanel },
] as const;

export function SettingsPage() {
  const { panel } = useParams();
  const current = PANELS.find((p) => p.id === panel) ?? PANELS[0];
  const { Panel } = current;
  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Settings" />
      <nav aria-label="Settings" className="scrollbar-none mb-10 flex gap-6 overflow-x-auto border-b border-line">
        {PANELS.map((p) => (
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
        ))}
      </nav>
      {current.scope && <p className="-mt-6 mb-8 text-[13px] text-muted">{current.scope}</p>}
      <Panel />
    </div>
  );
}
