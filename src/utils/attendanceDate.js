export const ATTENDANCE_RESET_STORAGE_KEY = "attendance_reset_time";
export const DEFAULT_ATTENDANCE_RESET_TIME = "05:00";
export const ATTENDANCE_SETTINGS_STORAGE_KEY = "hyacinth_attendance_settings_v2";
export const DEFAULT_BUSINESS_TIME_ZONE = "America/Chicago";

export function normalizeResetTime(value) {
  if (typeof value !== "string") return DEFAULT_ATTENDANCE_RESET_TIME;

  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_ATTENDANCE_RESET_TIME;

  const hh = Math.min(23, Math.max(0, Number(match[1])));
  const mm = Math.min(59, Math.max(0, Number(match[2])));

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function parseResetTime(value) {
  const normalized = normalizeResetTime(value);
  const [hours, minutes] = normalized.split(":").map(Number);

  return {
    hours,
    minutes,
    totalMinutes: hours * 60 + minutes,
  };
}

export function getStoredAttendanceResetTime() {
  try {
    return normalizeResetTime(
      localStorage.getItem(ATTENDANCE_RESET_STORAGE_KEY) || DEFAULT_ATTENDANCE_RESET_TIME
    );
  } catch {
    return DEFAULT_ATTENDANCE_RESET_TIME;
  }
}

export function getStoredBusinessTimeZone() {
  try {
    const raw = localStorage.getItem(ATTENDANCE_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_BUSINESS_TIME_ZONE;

    const parsed = JSON.parse(raw);
    const mode = String(parsed?.displayTimeZoneMode || "").trim().toLowerCase();
    const fixedValue = String(parsed?.displayTimeZone || "").trim();
    const legacyValue = String(parsed?.businessTimeZone || "").trim();

    if (mode === "fixed" && fixedValue) return fixedValue;
    if (legacyValue) return legacyValue;
    return DEFAULT_BUSINESS_TIME_ZONE;
  } catch {
    return DEFAULT_BUSINESS_TIME_ZONE;
  }
}

export function setStoredAttendanceResetTime(value) {
  const normalized = normalizeResetTime(value);

  try {
    localStorage.setItem(ATTENDANCE_RESET_STORAGE_KEY, normalized);
  } catch {
    // ignore storage errors
  }

  return normalized;
}

export function getBusinessDayKey(
  dateLike = Date.now(),
  resetTime = DEFAULT_ATTENDANCE_RESET_TIME,
  businessTimeZone = DEFAULT_BUSINESS_TIME_ZONE
) {
  const { totalMinutes } = parseResetTime(resetTime);
  const d = new Date(dateLike);

  if (Number.isNaN(d.getTime())) return null;

  const resolvedTimeZone = String(businessTimeZone || "").trim() || DEFAULT_BUSINESS_TIME_ZONE;

  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: resolvedTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_BUSINESS_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(d);
  }

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }

  const zonedPseudoUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);

  // Example: reset=05:00
  // 2026-03-14 02:00 in business timezone becomes business day 2026-03-13
  const shifted = new Date(zonedPseudoUtcMs - totalMinutes * 60_000);

  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");

  return `${y}-${m}-${dd}`;
}
