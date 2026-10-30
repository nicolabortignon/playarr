import { constants } from 'node:fs';
import { access, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateInfo, UpdateInterval, UpdateSettings } from '@playarr/shared';

/**
 * Settings → Updates, through the folder shared with the updater container (docker/updater.sh).
 * Playarr never talks to Docker: it writes settings.json and request, and reads status.json and
 * last.log. Nothing else in the folder is read.
 */

const INTERVALS: readonly number[] = [15, 60, 360, 1440] satisfies UpdateInterval[];
const DEFAULTS: UpdateSettings = { enabled: false, intervalMinutes: 60 };
/** The updater writes a heartbeat every 30 s (every few seconds while it updates). */
const STALE_AFTER_S = 180;
const LOG_LINES = 60;
/** The log's tail is enough: never read a huge file whole. */
const LOG_MAX_BYTES = 64 * 1024;
const MAX_STATUS_BYTES = 64 * 1024;

const REASONS = {
  noDocker: 'Automatic updates need the Docker setup (docker/compose.yaml)',
  notWritable: "Playarr can't write to its update folder",
  notRunning: "The updater isn't running. Run update.sh on the server once to start it.",
};

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Status = NonNullable<UpdateInfo['status']>;

export class UpdateBridge {
  constructor(
    private readonly dir: string | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async info(): Promise<UpdateInfo> {
    const { dir } = this;
    if (!dir) return { available: false, reason: REASONS.noDocker, ...DEFAULTS, requested: false };
    const [settings, read, requested, log, writable] = await Promise.all([
      this.settings(),
      this.status(),
      exists(join(dir, 'request')),
      tail(join(dir, 'last.log')),
      canWrite(dir),
    ]);
    const fresh = read !== undefined && this.now() / 1000 - read.heartbeat < STALE_AFTER_S;
    const reason = !writable ? REASONS.notWritable : !fresh ? REASONS.notRunning : undefined;
    return {
      available: !reason,
      ...(reason ? { reason } : {}),
      ...settings,
      ...(read ? { status: read.status } : {}),
      requested,
      ...(log ? { log } : {}),
    };
  }

  async save(patch: Partial<UpdateSettings>): Promise<void> {
    const dir = this.folder();
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new UpdateError('enabled must be true or false', 400);
    if (patch.intervalMinutes !== undefined && !INTERVALS.includes(patch.intervalMinutes)) {
      throw new UpdateError(`intervalMinutes must be one of ${INTERVALS.join(', ')}`, 400);
    }
    const next: UpdateSettings = { ...(await this.settings()) };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.intervalMinutes !== undefined) next.intervalMinutes = patch.intervalMinutes;
    await write(dir, 'settings.json', `${JSON.stringify(next)}\n`);
  }

  /** Check now: the updater picks it up within 30 s, whether automatic updates are on or not. */
  async requestCheck(): Promise<void> {
    await write(this.folder(), 'request', new Date(this.now()).toISOString());
  }

  private folder(): string {
    if (!this.dir) throw new UpdateError(REASONS.noDocker, 409);
    return this.dir;
  }

  /** settings.json, each value only if well-formed (the defaults otherwise). */
  private async settings(): Promise<UpdateSettings> {
    const raw = await readJson(join(this.dir!, 'settings.json'));
    return {
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      intervalMinutes: INTERVALS.includes(raw?.intervalMinutes as number)
        ? (raw!.intervalMinutes as UpdateInterval)
        : DEFAULTS.intervalMinutes,
    };
  }

  private async status(): Promise<{ heartbeat: number; status: Status } | undefined> {
    const raw = await readJson(join(this.dir!, 'status.json'));
    if (!raw) return undefined;
    const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const sha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v) ? v : undefined);
    const state = raw.state === 'checking' || raw.state === 'failed' ? raw.state : 'idle';
    const deployed = sha(raw.deployed);
    const latest = sha(raw.latest);
    const error = typeof raw.error === 'string' && raw.error ? raw.error.slice(0, 500) : undefined;
    return {
      heartbeat: seconds(raw.heartbeat),
      status: {
        state,
        lastCheck: seconds(raw.lastCheck),
        lastUpdate: seconds(raw.lastUpdate),
        ...(deployed ? { deployed } : {}),
        ...(latest ? { latest } : {}),
        ...(error ? { error } : {}),
      },
    };
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function canWrite(dir: string): Promise<boolean> {
  return access(dir, constants.W_OK).then(
    () => true,
    () => false,
  );
}

/** A JSON object from a small regular file; anything else (missing, damaged, huge) reads as undefined. */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_STATUS_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function tail(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    const length = Math.min(info.size, LOG_MAX_BYTES);
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, info.size - length);
      const lines = buffer.toString('utf8').replace(/\s+$/, '').split('\n');
      // A partial first line when the file was cut.
      if (info.size > length) lines.shift();
      const text = lines.slice(-LOG_LINES).join('\n');
      return text || undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** Write next to it and rename, so the updater never reads half a file. */
async function write(dir: string, name: string, content: string): Promise<void> {
  const path = join(dir, name);
  try {
    await writeFile(`${path}.new`, content, { mode: 0o664 });
    await rename(`${path}.new`, path);
  } catch {
    throw new UpdateError(REASONS.notWritable, 409);
  }
}
