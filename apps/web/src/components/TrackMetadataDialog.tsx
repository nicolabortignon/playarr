import type { FileTags, TrackCopyMetadata, TrackMetadata } from '@playarr/shared';
import { Check, Copy, ExternalLink, Play, RefreshCw, ScanSearch } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { formatDetails, formatTime } from '../lib/format';
import { useRematchFile, useTrackMetadata } from '../lib/queries';
import { toast } from '../lib/toast';
import { useUI } from '../lib/ui';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { SlowLookup } from './SlowLookup';
import { InlineError } from './States';

/** Track menu → Show metadata: everything Playarr knows about a song, and where each file of it is. */
export function TrackMetadataDialog() {
  const id = useUI((s) => s.metadataTrackId);
  const close = useUI((s) => s.closeMetadata);
  const { data, error, isPending, isFetching, refetch } = useTrackMetadata(id);
  return (
    <Dialog open={id !== null} onClose={close} title="Song metadata" size="wide">
      {error ? (
        <InlineError error={error} onRetry={() => void refetch()} retrying={isFetching}>
          Couldn’t load this song’s metadata
        </InlineError>
      ) : isPending || !data ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading metadata">
          <div className="h-8 w-2/3 animate-pulse rounded bg-paper/5" />
          <div className="h-40 animate-pulse rounded-lg bg-paper/5" />
          <div className="h-32 animate-pulse rounded-lg bg-paper/5" />
        </div>
      ) : (
        <MetadataView meta={data} />
      )}
    </Dialog>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The file "Match again" acts on for the whole song: a folder file Playarr matches itself (the one that
 * plays, if it's one), else a Lidarr file (refreshed in Lidarr).
 */
export function primaryCopy(copies: TrackCopyMetadata[]): TrackCopyMetadata | undefined {
  const folder = copies.filter((c) => c.source.kind === 'folder');
  return folder.find((c) => c.playing) ?? folder[0] ?? copies.find((c) => c.playing) ?? copies[0];
}

function MetadataView({ meta: m }: { meta: TrackMetadata }) {
  const type = [m.albumType, ...m.secondaryTypes].filter(Boolean).join(' · ');
  const primary = m.pathsHidden ? undefined : primaryCopy(m.copies);
  return (
    <div className="space-y-7">
      <div className="min-w-0">
        <div className="type-body text-paper">{m.title}</div>
        <div className="type-small text-muted">
          {m.artistName} · {m.albumTitle}
        </div>
        {primary && <RematchButton key={primary.fileId} copy={primary} />}
        {m.pathsHidden && (
          <p className="mt-3 type-small text-muted">Matching a song again on MusicBrainz is for admins.</p>
        )}
      </div>

      <Section title="Song">
        <Rows
          rows={[
            ['Title', m.title],
            ['Artist', m.artistName],
            ['Album', m.albumTitle],
            ['Track', `${m.discNumber > 1 ? `${m.discNumber}-` : ''}${m.trackNumber}`],
            ['Duration', formatTime(m.duration)],
            ['Explicit', m.explicit ? 'Yes' : undefined],
            ['Album type', type || undefined],
            ['Released', m.releaseDate?.slice(0, 10)],
            ['Genres', m.genres.join(', ') || undefined],
            ['Recording', <MbId key="r" id={m.recordingId} kind="recording" />],
            ['Release group', m.albumMbid ? <MbId key="g" id={m.albumMbid} kind="release-group" /> : undefined],
            ['Artist id', m.artistMbid ? <MbId key="a" id={m.artistMbid} kind="artist" /> : undefined],
          ]}
        />
      </Section>

      <Section title={m.copies.length === 1 ? 'File' : `Files (${m.copies.length})`}>
        {m.pathsHidden && (
          <p className="mb-3 type-small text-muted">File paths and where sources live are shown to admins only.</p>
        )}
        <div className="space-y-3">
          {m.copies.map((c) => (
            // With several files, each can be matched again on its own; the main button above handles one.
            <CopyCard key={c.fileId} copy={c} rematch={m.copies.length > 1 && c.fileId !== primary?.fileId} />
          ))}
        </div>
      </Section>

      {m.analysis && (
        <Section title="Sound">
          <Rows
            rows={[
              ['Tempo', m.analysis.bpm ? `${Math.round(m.analysis.bpm)} BPM` : 'Not analyzed yet'],
              ['Beat', m.analysis.pulse !== undefined ? <Meter key="p" value={m.analysis.pulse} /> : 'Not analyzed yet'],
              ['Loudness', <Meter key="l" value={m.analysis.loudness} />],
              ['Dynamics', <Meter key="d" value={m.analysis.dynamics} />],
              ['Brightness', <Meter key="b" value={m.analysis.brightness} />],
              ['Busyness', <Meter key="u" value={m.analysis.busyness} />],
              ['Bass', <Meter key="s" value={m.analysis.bass} />],
            ]}
          />
        </Section>
      )}
    </div>
  );
}

function CopyCard({ copy: c, rematch }: { copy: TrackCopyMetadata; rematch: boolean }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="type-body text-paper">{c.source.name}</span>
        {c.source.location && <span className="type-small text-muted">· {c.source.location}</span>}
        {c.playing && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 type-badge text-accent">
            <Play className="size-3 fill-current" /> Plays
          </span>
        )}
      </div>
      <Rows
        rows={[
          ['Path', c.path ? <PathValue key="p" path={c.path} /> : undefined],
          ['Read from', c.readPath ? <PathValue key="r" path={c.readPath} /> : undefined],
          ['Format', formatDetails(c.format)],
          ['Size', formatSize(c.size)],
          ['Added', c.addedAt ? new Date(c.addedAt).toLocaleString() : undefined],
          ['Identified', c.match ? describeMatch(c.match) : undefined],
        ]}
      />
      {rematch && c.path !== undefined && <RematchButton copy={c} />}
      {c.tags && (
        <details className="mt-3">
          <summary className="cursor-pointer type-kicker text-muted hover:text-paper">Tags in the file</summary>
          <div className="mt-2">
            <Rows rows={tagRows(c.tags)} />
          </div>
        </details>
      )}
    </div>
  );
}

const REMATCH_OUTCOME: Record<string, string> = {
  auto: 'Matched on MusicBrainz. The metadata is up to date.',
  manual: 'Matched on MusicBrainz. The metadata is up to date.',
  review: 'MusicBrainz has a few possible albums: pick one in Settings → Sources → Review matches.',
  unmatched: 'Not found on MusicBrainz: the song keeps the tags in its file.',
  ignored: 'Left with the tags in its file.',
};

/**
 * Match this file on MusicBrainz again. Folder files are matched by Playarr (the whole album they're in);
 * Lidarr's files get their metadata from Lidarr, which is asked to refresh the artist.
 */
function RematchButton({ copy: c }: { copy: TrackCopyMetadata }) {
  const rematch = useRematchFile();
  const showMetadata = useUI((s) => s.showMetadata);
  const [outcome, setOutcome] = useState<{ text: string; error?: boolean } | null>(null);
  const lidarr = c.source.kind === 'lidarr';
  const run = () => {
    setOutcome(null);
    rematch.mutate(c.fileId, {
      onSuccess: (result) => {
        if (result.kind === 'lidarr') return setOutcome({ text: result.message });
        const text = REMATCH_OUTCOME[result.state] ?? 'Done.';
        // A match can give the song its real MusicBrainz id, and with it another place in the catalog: follow
        // it there (this view reloads, so the outcome goes to a toast).
        if (result.trackId && result.trackId !== useUI.getState().metadataTrackId) {
          toast(text);
          showMetadata(result.trackId);
        } else {
          setOutcome({ text });
        }
      },
      onError: (err) => setOutcome({ text: err.message, error: true }),
    });
  };
  return (
    <div className="mt-3 space-y-2">
      <Button size="small" icon={lidarr ? <RefreshCw /> : <ScanSearch />} onClick={run} pending={rematch.isPending} pendingLabel={lidarr ? 'Asking Lidarr…' : 'Matching…'}>
        {lidarr ? 'Refresh in Lidarr' : 'Match again on MusicBrainz'}
      </Button>
      {!lidarr && <SlowLookup active={rematch.isPending} what="this album" />}
      {outcome?.error ? (
        <InlineError error={outcome.text} />
      ) : (
        outcome && (
          <p role="status" className="type-small text-paper-dim">
            {outcome.text}
          </p>
        )
      )}
    </div>
  );
}

/** A path, wrapped anywhere, with a button to copy it. */
function PathValue({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <span className="flex items-start gap-2">
      <code className="min-w-0 flex-1 type-meta break-all text-paper-dim select-all">{path}</code>
      {navigator.clipboard && (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy path'}
          title={copied ? 'Copied' : 'Copy path'}
          className="grid size-6 shrink-0 place-items-center rounded text-muted transition hover:bg-paper/8 hover:text-paper"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      )}
    </span>
  );
}

function MbId({ id, kind }: { id: string; kind: 'recording' | 'release-group' | 'artist' }) {
  if (!UUID.test(id)) return <span className="type-meta text-muted">{id} (not on MusicBrainz yet)</span>;
  return (
    <a
      href={`https://musicbrainz.org/${kind}/${id}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 type-meta break-all text-accent hover:underline"
    >
      {id} <ExternalLink className="size-3.5 shrink-0" />
    </a>
  );
}

function Meter({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className="flex items-center gap-2" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="h-1 w-32 overflow-hidden rounded-full bg-paper/10">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="type-meta text-muted">{pct}</span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 type-kicker text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode | undefined][] }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 type-small">
      {rows
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="type-kicker leading-5 text-muted">{label}</dt>
            <dd className="min-w-0 break-words text-paper-dim">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const MATCH_STATES: Record<string, string> = {
  auto: 'Matched on MusicBrainz automatically',
  manual: 'Matched on MusicBrainz by you',
  review: 'Waiting for your review',
  unmatched: 'Not found on MusicBrainz: uses its tags',
  ignored: 'Left unmatched by you: uses its tags',
};

function describeMatch(m: { state: string; score?: number }): string {
  const text = MATCH_STATES[m.state] ?? m.state;
  return m.score !== undefined && (m.state === 'auto' || m.state === 'review') ? `${text} (${Math.round(m.score * 100)}%)` : text;
}

function tagRows(t: FileTags): [string, ReactNode | undefined][] {
  return [
    ['Title', t.title],
    ['Artist', t.artist],
    ['Album artist', t.albumArtist],
    ['Album', t.album],
    ['Track', t.trackNumber !== undefined ? `${t.trackNumber}${t.trackTotal ? ` of ${t.trackTotal}` : ''}` : undefined],
    ['Disc', t.discNumber?.toString()],
    ['Year', t.year?.toString()],
    ['Genres', t.genres.join(', ') || undefined],
    ['Recording', t.recordingMbid ? <MbId key="r" id={t.recordingMbid} kind="recording" /> : undefined],
    ['Release group', t.releaseGroupMbid ? <MbId key="g" id={t.releaseGroupMbid} kind="release-group" /> : undefined],
    ['Release', t.releaseId],
    ['Artist id', t.artistMbid ? <MbId key="a" id={t.artistMbid} kind="artist" /> : undefined],
    ['Album artist id', t.albumArtistMbid ? <MbId key="b" id={t.albumArtistMbid} kind="artist" /> : undefined],
  ];
}
