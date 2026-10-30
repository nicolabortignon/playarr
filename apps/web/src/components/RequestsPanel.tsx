import type { RequestSettingsInfo, RequestSettingsPatch } from '@playarr/shared';
import { ChevronDown, Loader2, RotateCw, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api';
import { formatBytes } from '../lib/format';
import { useRequestSettings, useSaveRequestSettings } from '../lib/queries';
import { AwayNotice, Field, SettingsSection, Switch } from './SettingsControls';

const SELECT =
  'h-11 w-full appearance-none truncate rounded-lg border border-line bg-ink-900 pr-9 pl-3 text-[15px] text-paper outline-none transition focus:border-accent disabled:opacity-50';
const DEFAULT_LABEL = 'Lidarr’s default';

/** Settings → Requests: whether people can request albums, and what Lidarr does with them. For everyone. */
export function RequestsPanel() {
  const { data, error, refetch, isFetching } = useRequestSettings();
  const save = useSaveRequestSettings();
  const change = (patch: RequestSettingsPatch) => save.mutate(patch);

  if (error instanceof ApiError && error.status === 403) {
    return <AwayNotice>Settings can be changed from your home network.</AwayNotice>;
  }
  if (error && !data) return <p className="text-sm text-red-300/80">{error.message}</p>;
  if (!data) return <PanelSkeleton />;

  if (!data.lidarr) {
    return (
      <p className="max-w-prose text-[15px] text-paper-dim">
        Requests need a Lidarr source. You can add one in{' '}
        <Link to="/settings/sources" className="text-accent hover:underline">
          Sources
        </Link>
        .
      </p>
    );
  }

  return (
    <div>
      <SettingsSection title="Requests">
        <div className="divide-y divide-line">
          <Switch
            label="Let people request albums"
            description="Off hides every Request button, for everyone, and Playarr refuses new requests."
            checked={data.enabled}
            onChange={(enabled) => change({ enabled })}
          />
          <Switch
            label="Search for an album as soon as it’s requested"
            description="Off only adds the album to Lidarr as wanted, and Lidarr searches for it on its own schedule."
            checked={data.searchOnAdd}
            onChange={(searchOnAdd) => change({ searchOnAdd })}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Where new artists go"
        description="When a request brings in an artist Lidarr doesn’t have yet, it’s added with these. Artists already in Lidarr keep their own."
      >
        <Destination info={data} onChange={change} retry={() => void refetch()} retrying={isFetching} />
      </SettingsSection>
    </div>
  );
}

function Destination({
  info,
  onChange,
  retry,
  retrying,
}: {
  info: RequestSettingsInfo;
  onChange: (patch: RequestSettingsPatch) => void;
  retry: () => void;
  retrying: boolean;
}) {
  if (!info.options) {
    return (
      <div className="rounded-lg border border-line px-4 py-3">
        <p className="flex items-start gap-2 text-sm text-red-300/80">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>Couldn’t get the choices from Lidarr{info.error ? `: ${info.error}` : '.'}</span>
        </p>
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-full border border-line px-4 text-[13px] text-paper transition hover:bg-paper/5 disabled:opacity-50"
        >
          {retrying ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />} Retry
        </button>
      </div>
    );
  }
  const { rootFolders, qualityProfiles, metadataProfiles } = info.options;
  return (
    <div className="space-y-4">
      <Choice
        label="Root folder"
        value={info.rootFolderPath}
        options={rootFolders.map((r) => ({
          value: r.path,
          label: r.freeSpace !== undefined ? `${r.path} · ${formatBytes(r.freeSpace)} free` : r.path,
        }))}
        onChange={(v) => onChange({ rootFolderPath: v ?? null })}
      />
      <Choice
        label="Quality profile"
        value={info.qualityProfileId}
        options={qualityProfiles.map((p) => ({ value: p.id, label: p.name }))}
        onChange={(v) => onChange({ qualityProfileId: v ?? null })}
      />
      <Choice
        label="Metadata profile"
        value={info.metadataProfileId}
        options={metadataProfiles.map((p) => ({ value: p.id, label: p.name }))}
        onChange={(v) => onChange({ metadataProfileId: v ?? null })}
      />
      <p className="text-[13px] text-muted">
        {DEFAULT_LABEL} is the root folder’s own setting, or the value in Playarr’s .env file when there is one.
      </p>
    </div>
  );
}

/** A select whose first option means "nothing chosen here". */
function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string }[];
  onChange: (v: T | undefined) => void;
}) {
  // A choice Lidarr no longer has still shows, so it's clear why the default is used.
  const missing = value !== undefined && !options.some((o) => o.value === value);
  return (
    <Field label={label}>
      <span className="relative block">
        <select
          value={value === undefined ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            const picked = options.find((o) => String(o.value) === raw);
            onChange(picked?.value ?? (missing && raw === String(value) ? value : undefined));
          }}
          className={SELECT}
        >
          <option value="">{DEFAULT_LABEL}</option>
          {missing && <option value={String(value)}>{`${typeof value === 'number' ? `#${value}` : value} (no longer in Lidarr)`}</option>}
          {options.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />
      </span>
    </Field>
  );
}

function PanelSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="max-w-prose space-y-3">
      {[0, 1].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-paper/5" />
      ))}
      <div className="mt-10 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-11 animate-pulse rounded-lg bg-paper/5" />
        ))}
      </div>
    </div>
  );
}
