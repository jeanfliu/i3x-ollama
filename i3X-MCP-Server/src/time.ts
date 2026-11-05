const RELATIVE_RE = /^(?:last\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)$/i;

const UNIT_MS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

export function parseDurationMs(input: string): number | null {
  const m = input.trim().match(RELATIVE_RE);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * UNIT_MS[unit];
}

/**
 * Parse a time input that may be:
 *   - an absolute ISO 8601 / RFC 3339 string
 *   - "now"
 *   - a relative duration like "1h", "last 30m", "7d"  (interpreted as "ago" when role=start, as "now" when role=end)
 *   - "today" / "yesterday"
 */
export function parseTimeInput(input: string, role: "start" | "end", now = new Date()): Date {
  const s = input.trim().toLowerCase();
  if (s === "now") return now;
  if (s === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (s === "yesterday") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return d;
  }
  const durMs = parseDurationMs(input);
  if (durMs !== null) {
    if (role === "start") return new Date(now.getTime() - durMs);
    return now;
  }
  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Cannot parse time "${input}". Use RFC 3339 (e.g. "2026-06-12T10:00:00Z"), a relative duration ("1h", "last 30m", "7d"), "now", "today", or "yesterday".`);
  }
  return parsed;
}

export function toRfc3339(d: Date): string {
  return d.toISOString();
}
