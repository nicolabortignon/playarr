import { AudioLines, AudioWaveform, Binoculars, ChevronLeft, CircleArrowUp, FolderOpen, Palette, Sparkles, Users, type LucideIcon } from 'lucide-react';
import { useId, type ComponentType } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { AccountsPanel } from '../components/AccountsPanel';
import { AnalysisPanel } from '../components/AnalysisPanel';
import { AppearancePanel } from '../components/AppearancePanel';
import { Button } from '../components/Button';
import { MixesPanel } from '../components/MixesPanel';
import { PlaceLabel, placeLink } from '../components/Nav';
import { NavRow } from '../components/NavRow';
import { PageHeader } from '../components/PageHeader';
import { PlaybackPanel } from '../components/PlaybackPanel';
import { RequestsPanel } from '../components/RequestsPanel';
import { SourcesPanel } from '../components/SourcesPanel';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { cn } from '../lib/cn';
import { useIsMember } from '../lib/queries';
import { usePageLg } from '../lib/useMediaQuery';

interface Panel {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Whom it applies to, under its title. */
  scope?: string;
  Panel: ComponentType;
}

const DEVICE = 'These settings are for this device.';
const EVERYONE = 'These settings apply to everyone.';

const PLAYBACK: Panel = { id: 'playback', label: 'Playback', icon: AudioLines, scope: DEVICE, Panel: PlaybackPanel };
const APPEARANCE: Panel = { id: 'appearance', label: 'Appearance', icon: Palette, scope: DEVICE, Panel: AppearancePanel };
const SOURCES: Panel = { id: 'sources', label: 'Sources', icon: FolderOpen, Panel: SourcesPanel };
const ACCOUNTS: Panel = { id: 'accounts', label: 'Accounts', icon: Users, scope: 'Who signs in to this server, and what each account may hear and change.', Panel: AccountsPanel };
const MIXES: Panel = { id: 'mixes', label: 'Made for you', icon: Sparkles, scope: EVERYONE, Panel: MixesPanel };
const ANALYSIS: Panel = { id: 'analysis', label: 'Analysis', icon: AudioWaveform, scope: EVERYONE, Panel: AnalysisPanel };
const REQUESTS: Panel = { id: 'requests', label: 'Requests', icon: Binoculars, scope: EVERYONE, Panel: RequestsPanel };
const UPDATES: Panel = { id: 'updates', label: 'Updates', icon: CircleArrowUp, scope: EVERYONE, Panel: UpdatesPanel };

interface Group {
  title: string;
  /** Under the group in the list; beside the panel, only what the panel's scope doesn't say. */
  note?: string;
  panels: Panel[];
}

/**
 * Settings in groups, named and ordered as the iOS app's: this device's, then the server's for an admin; for a member,
 * their account's (their name and devices, their mixes and ListenBrainz), then the server's, which they can read but
 * not change. Your listening isn't a setting: it's in Library and the account menu (/settings/listening opens it).
 */
export function useSettingsGroups(): Group[] {
  const member = useIsMember();
  const device: Group = { title: 'This device', note: DEVICE, panels: [PLAYBACK, APPEARANCE] };
  if (!member) return [device, { title: 'Server', note: EVERYONE, panels: [SOURCES, ACCOUNTS, MIXES, ANALYSIS, REQUESTS, UPDATES] }];
  return [
    device,
    { title: 'Your account', panels: [ACCOUNTS, MIXES] },
    { title: 'Server', note: 'Only an admin can change these.', panels: [SOURCES, ANALYSIS, REQUESTS, UPDATES] },
  ];
}

/** What a panel opened from the list remembers, so its back button returns to the list rather than adding one. */
const FROM_LIST = { fromSettings: true };

/**
 * Settings. Where the page is wide enough (`usePageLg`: a 1024 px window, more with the queue column open), a column of
 * the groups beside the open panel, as iPad and Mac settings are; narrower (a phone, a narrow window), a list in
 * groups, each row opening its panel, with a way back to the list.
 */
export function SettingsPage() {
  const { panel } = useParams();
  const split = usePageLg();
  const groups = useSettingsGroups();
  const panels = groups.flatMap((g) => g.panels);
  const current = panels.find((p) => p.id === panel);

  if (!split && !current) return <SettingsList groups={groups} />;
  const shown = current ?? panels[0]!;
  const { Panel } = shown;
  if (!split) {
    return (
      <div className="max-w-4xl px-5 pt-6 md:px-10 md:pt-14">
        <BackToList />
        <PageHeader title={shown.label} description={shown.scope} />
        <Panel />
      </div>
    );
  }
  return (
    <div className="max-w-6xl px-5 pt-6 md:px-10 md:pt-14">
      <PageHeader title="Settings" />
      <div className="flex items-start gap-8">
        <SettingsColumn groups={groups} current={shown.id} />
        <div className="min-w-0 flex-1">
          {shown.scope && <p className="mb-8 type-small text-muted">{shown.scope}</p>}
          <Panel />
        </div>
      </div>
    </div>
  );
}

/** Settings as a list in groups (a phone, a narrow window): each row a panel; the app's version at the foot, as on iOS. */
function SettingsList({ groups }: { groups: Group[] }) {
  return (
    <div className="max-w-3xl px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader title="Settings" />
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title} className="mb-8">
          <h2 className="mb-1 type-kicker text-muted">{group.title}</h2>
          <div className="-mx-2">
            {group.panels.map((p) => (
              <NavRow key={p.id} to={`/settings/${p.id}`} state={FROM_LIST} icon={p.icon} label={p.label} />
            ))}
          </div>
          {group.note && <p className="mt-1 type-small text-muted">{group.note}</p>}
        </section>
      ))}
      <p className="type-meta text-muted">Playarr {__APP_VERSION__}</p>
    </div>
  );
}

/** A panel opened from the list: back to the list it was opened from, or to it, for a panel opened from elsewhere. */
function BackToList() {
  const navigate = useNavigate();
  const fromList = (useLocation().state as typeof FROM_LIST | null)?.fromSettings;
  return (
    <Button
      variant="ghost"
      size="small"
      icon={<ChevronLeft />}
      onClick={() => (fromList ? navigate(-1) : navigate('/settings', { replace: true }))}
      className="mb-3 -ml-3"
    >
      Settings
    </Button>
  );
}

/**
 * Beside the open panel: the list's groups made compact, every panel in view at any width (it never scrolls
 * sideways), the open one lit as the sidebar lights the page you're on. Kept in view as the panel scrolls. Which
 * device or server a panel is for is said above the panel; only what isn't (a member can't change the server's) is
 * said here.
 */
function SettingsColumn({ groups, current }: { groups: Group[]; current: string }) {
  const id = useId();
  return (
    <nav aria-label="Settings" className="sticky top-6 w-48 shrink-0">
      {groups.map((group, i) => (
        <div key={group.title} role="group" aria-labelledby={`${id}-${i}`} className={cn(i > 0 && 'mt-6')}>
          <h2 id={`${id}-${i}`} className="mb-1 px-3 type-kicker text-muted">
            {group.title}
          </h2>
          {group.panels.map((p) => (
            <Link key={p.id} to={`/settings/${p.id}`} aria-current={p.id === current ? 'page' : undefined} className={placeLink(p.id === current)}>
              <PlaceLabel icon={p.icon} label={p.label} current={p.id === current} />
            </Link>
          ))}
          {group.note && group.note !== DEVICE && group.note !== EVERYONE && <p className="mt-1 px-3 type-small text-muted">{group.note}</p>}
        </div>
      ))}
      <p className="mt-6 px-3 type-meta text-muted">Playarr {__APP_VERSION__}</p>
    </nav>
  );
}
