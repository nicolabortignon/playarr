/** The listener's local time: mixes follow their clock (hour, day, week), not the server's. */
export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
  /** ISO week, e.g. "2026-W44": Discovery Weekly changes on Mondays. */
  week: string;
  month: number;
  day: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A valid IANA time zone, else undefined (the server's own). */
export function validTimeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export function localTime(now: Date, timeZone?: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday!),
    week: isoWeek(year, month, day),
    month,
    day,
  };
}

function isoWeek(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday); // the week's Thursday decides its year
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** When the next local hour, day or week (Monday) starts, as an instant. */
export function nextBoundary(now: Date, local: LocalTime, unit: 'hour' | 'day' | 'week'): Date {
  const intoHour = (local.minute * 60 + local.second) * 1000;
  if (unit === 'hour') return new Date(now.getTime() - intoHour + 3_600_000);
  const intoDay = local.hour * 3_600_000 + intoHour;
  const days = unit === 'day' ? 1 : ((8 - local.weekday) % 7 || 7);
  return new Date(now.getTime() - intoDay + days * 86_400_000);
}

/** Hours apart on a clock face (23 and 1 are 2 apart). */
export const hourDistance = (a: number, b: number) => Math.min((a - b + 24) % 24, (b - a + 24) % 24);
