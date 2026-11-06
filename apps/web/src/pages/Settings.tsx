import { AudioLines, AudioWaveform, ChevronLeft, ChevronRight, CircleArrowUp, Download, FolderOpen, Palette, Sparkles, Users, type LucideIcon } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { AccountsPanel } from '../components/AccountsPanel';
import { AnalysisPanel } from '../components/AnalysisPanel';
import { AppearancePanel } from '../components/AppearancePanel';
import { Button, IconButton } from '../components/Button';
import { MixesPanel } from '../components/MixesPanel';
import { NavRow } from '../components/NavRow';
import { PageHeader } from '../components/PageHeader';
import { PlaybackPanel } from '../components/PlaybackPanel';
import { RequestsPanel } from '../components/RequestsPanel';
import { SourcesPanel } from '../components/SourcesPanel';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { cn } from '../lib/cn';
import { useIsMember } from '../lib/queries';
import { useDesktopLayout } from '../lib/useMediaQuery';

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
const REQUESTS: Panel = { id: 'requests', label: 'Requests', icon: Download, scope: EVERYONE, Panel: RequestsPanel };
const UPDATES: Panel = { id: 'updates', label: 'Updates', icon: CircleArrowUp, scope: EVERYONE, Panel: UpdatesPanel };

interface Group {
  title: string;
  /** Under the group in the phone's list. */
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

/** What a panel opened from the phone's list remembers, so its back button returns to the list rather than adding one. */
const FROM_LIST = { fromSettings: true };

/**
 * Settings. On a phone, a list in groups, each row opening its panel (with a way back to the list); on wider screens,
 * the panels as tabs, which hint at more when they don't all fit.
 */
export function SettingsPage() {
  const { panel } = useParams();
  const wide = useDesktopLayout();
  const groups = useSettingsGroups();
  const panels = groups.flatMap((g) => g.panels);
  const current = panels.find((p) => p.id === panel);

  if (!wide && !current) return <SettingsList groups={groups} />;
  const shown = current ?? panels[0]!;
  const { Panel } = shown;
  return (
    <div className="max-w-4xl px-5 pt-6 md:px-10 md:pt-14">
      {wide ? (
        <>
          <PageHeader title="Settings" />
          <Tabs groups={groups} current={shown.id} />
          {shown.scope && <p className="-mt-6 mb-8 type-small text-muted">{shown.scope}</p>}
        </>
      ) : (
        <>
          <BackToList />
          <PageHeader title={shown.label} description={shown.scope} />
        </>
      )}
      <Panel />
    </div>
  );
}

/** A phone's Settings: the groups as lists, each row a panel; the app's version at the foot, as on iOS. */
function SettingsList({ groups }: { groups: Group[] }) {
  return (
    <div className="max-w-3xl px-5 pt-8">
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

/** A panel on a phone: back to the list it was opened from, or to it, for a panel opened from elsewhere. */
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
 * The panels as tabs, a line between the groups. When they don't all fit, the strip fades at the side with more,
 * which arrows scroll to with a mouse (a finger swipes); the tab open is kept in view.
 */
function Tabs({ groups, current }: { groups: Group[]; current: string }) {
  const strip = useRef<HTMLElement>(null);
  const [more, setMore] = useState({ before: false, after: false });
  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const before = el.scrollLeft > 1;
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.before === before && m.after === after ? m : { before, after }));
  }, []);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    sizes?.observe(el);
    return () => sizes?.disconnect();
  }, [measure]);
  useEffect(() => {
    strip.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  const scroll = (dir: 1 | -1) => strip.current?.scrollBy({ left: dir * strip.current.clientWidth * 0.6, behavior: 'smooth' });
  const fade = (on: boolean) => (on ? 'transparent' : 'black');
  const mask = `linear-gradient(to right, ${fade(more.before)}, black 3rem, black calc(100% - 3rem), ${fade(more.after)})`;

  return (
    <div className="relative mb-10" data-more-before={more.before || undefined} data-more-after={more.after || undefined}>
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-line" />
      <nav
        ref={strip}
        aria-label="Settings"
        onScroll={measure}
        className="scrollbar-none relative flex items-stretch gap-6 overflow-x-auto overflow-y-hidden"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {groups.map((group, i) => (
          <Fragment key={group.title}>
            {i > 0 && <span aria-hidden className="mb-3 w-px shrink-0 bg-line" />}
            {group.panels.map((p) => (
              <Link
                key={p.id}
                to={`/settings/${p.id}`}
                aria-current={p.id === current ? 'page' : undefined}
                className={cn(
                  'shrink-0 border-b-2 pb-3 type-body whitespace-nowrap transition-colors',
                  p.id === current ? 'border-accent text-paper' : 'border-transparent text-paper-dim hover:text-paper',
                )}
              >
                {p.label}
              </Link>
            ))}
          </Fragment>
        ))}
      </nav>
      {/* With a mouse, arrows to what's out of sight; a finger swipes the strip. */}
      {more.before && (
        <IconButton label="Earlier settings" onClick={() => scroll(-1)} className="absolute top-0 -left-3 hidden bg-ink-900 pointer-fine:grid">
          <ChevronLeft className="size-4.5" />
        </IconButton>
      )}
      {more.after && (
        <IconButton label="More settings" onClick={() => scroll(1)} className="absolute top-0 -right-3 hidden bg-ink-900 pointer-fine:grid">
          <ChevronRight className="size-4.5" />
        </IconButton>
      )}
    </div>
  );
}
