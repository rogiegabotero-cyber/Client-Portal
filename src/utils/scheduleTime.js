const DEFAULT_SCHEDULE_TIME_ZONE = "America/Chicago";

const pick = (obj, keys, fallback = "") => {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).length) return value;
  }
  return fallback;
};

const START_UTC_KEYS = [
  "utcTimeIn",
  "utcStart",
  "startUtc",
  "utcTimeStart",
  "utc_time_in",
  "utc_start",
  "timeInUtc",
  "timeInUTC",
];
const END_UTC_KEYS = [
  "utcTimeOut",
  "utcEnd",
  "endUtc",
  "utcTimeEnd",
  "utc_time_out",
  "utc_end",
  "timeOutUtc",
  "timeOutUTC",
];
const START_LOCAL_KEYS = ["timeIn", "time_in", "startTime", "shiftStart", "start"];
const END_LOCAL_KEYS = ["timeOut", "time_out", "endTime", "shiftEnd", "end"];
const TIME_ZONE_KEYS = [
  "timeRegion",
  "timezone",
  "timeZone",
  "tz",
  "scheduleTimezone",
  "scheduleTimeZone",
];

const isValidDayKey = (dayKey) => /^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ""));

const parseHhMm = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const match24 = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match24) {
    const hour = Number(match24[1]);
    const minute = Number(match24[2]);
    const second = Number(match24[3] || 0);

    if (
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      !Number.isFinite(second) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59 ||
      second < 0 ||
      second > 59
    ) {
      return null;
    }

    return { hour, minute, second };
  }

  const match12 = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (!match12) return null;

  let hour = Number(match12[1]);
  const minute = Number(match12[2]);
  const second = Number(match12[3] || 0);
  const ampm = String(match12[4] || "").toUpperCase();

  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second) ||
    hour < 1 ||
    hour > 12 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  if (ampm === "AM") {
    if (hour === 12) hour = 0;
  } else if (ampm === "PM") {
    if (hour < 12) hour += 12;
  } else {
    return null;
  }

  return { hour, minute, second };
};

const parseUtcMs = (value) => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

const partsFromUtcMs = (ms) => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
};

const parseEpochToMs = (value) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return NaN;
    return Math.abs(value) < 1e11 ? value * 1000 : value;
  }

  const n = Number(String(value || "").trim());
  if (!Number.isFinite(n)) return NaN;
  return Math.abs(n) < 1e11 ? n * 1000 : n;
};

const parseUtcClockParts = (value) => {
  if (value == null) return null;

  if (typeof value?.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? partsFromUtcMs(ms) : null;
  }

  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? partsFromUtcMs(d.getTime()) : null;
  }

  if (value instanceof Date) return partsFromUtcMs(value.getTime());

  if (typeof value === "object") {
    const seconds = Number(value.seconds ?? value._seconds);
    const nanos = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
    if (Number.isFinite(seconds)) {
      const ms = seconds * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1e6);
      return partsFromUtcMs(ms);
    }
  }

  const epochMs = parseEpochToMs(value);
  if (Number.isFinite(epochMs)) {
    const epochParts = partsFromUtcMs(epochMs);
    if (epochParts) return epochParts;
  }

  const raw = String(value || "").trim();
  if (!raw) return null;

  const clock = parseHhMm(raw);
  if (clock) return clock;

  const dateTimeNoTz = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dateTimeNoTz) {
    const hour = Number(dateTimeNoTz[4]);
    const minute = Number(dateTimeNoTz[5]);
    const second = Number(dateTimeNoTz[6] || 0);
    if (
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      Number.isFinite(second) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59 &&
      second >= 0 &&
      second <= 59
    ) {
      return { hour, minute, second };
    }
  }

  const parsed = parseUtcMs(raw);
  return Number.isFinite(parsed) ? partsFromUtcMs(parsed) : null;
};

const normalizeTimeZoneValue = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const upper = raw.toUpperCase();
  if (upper === "UTC" || upper === "GMT" || upper === "Z") return "UTC";
  if (raw.includes("/")) return raw;
  return "";
};

const getSafeTimeZone = (timeZone, fallback = DEFAULT_SCHEDULE_TIME_ZONE) => {
  const preferred =
    normalizeTimeZoneValue(timeZone) ||
    normalizeTimeZoneValue(fallback) ||
    DEFAULT_SCHEDULE_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: preferred }).format(new Date(0));
    return preferred;
  } catch {
    return DEFAULT_SCHEDULE_TIME_ZONE;
  }
};

const getTimeZoneOffsetMs = (utcMs, timeZone) => {
  const safeTimeZone = getSafeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));

  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  const pseudoUtcMs = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  return pseudoUtcMs - utcMs;
};

const rebaseUtcIsoToDay = (utcIso, dayKey) => {
  if (!isValidDayKey(dayKey)) return NaN;

  const parts = parseUtcClockParts(utcIso);
  if (!parts) return NaN;

  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  const ss = String(parts.second).padStart(2, "0");
  return parseUtcMs(`${dayKey}T${hh}:${mm}:${ss}.000Z`);
};

const clockInZoneToUtcMs = (dayKey, hhmm, timeZone) => {
  if (!isValidDayKey(dayKey)) return NaN;

  const parsed = parseHhMm(hhmm);
  if (!parsed) return NaN;

  const [year, month, day] = String(dayKey)
    .split("-")
    .map((n) => Number(n));

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;

  const approxUtcMs = Date.UTC(year, month - 1, day, parsed.hour, parsed.minute, parsed.second);
  const offsetMs = getTimeZoneOffsetMs(approxUtcMs, timeZone);
  return approxUtcMs - offsetMs;
};

export const getScheduleTimeZone = (scheduleItem, fallback = DEFAULT_SCHEDULE_TIME_ZONE) => {
  const raw = pick(scheduleItem || {}, TIME_ZONE_KEYS, fallback);
  return getSafeTimeZone(raw, fallback);
};

export const resolveScheduledStartUtcMsForDayKey = (scheduleItem, dayKey) => {
  if (!scheduleItem || !isValidDayKey(dayKey)) return NaN;

  let hadUtcStartSource = false;
  for (const key of START_UTC_KEYS) {
    const raw = scheduleItem?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    hadUtcStartSource = true;

    const rebasedUtc = rebaseUtcIsoToDay(raw, dayKey);
    if (Number.isFinite(rebasedUtc)) return rebasedUtc;
  }

  if (hadUtcStartSource) {
    return NaN;
  }

  const localClock = pick(scheduleItem, START_LOCAL_KEYS, "");
  if (localClock) {
    // Schedule local time fields are authored in schedule timezone;
    // when missing, default to business baseline timezone (CST).
    const tz = getScheduleTimeZone(scheduleItem, DEFAULT_SCHEDULE_TIME_ZONE);
    const convertedUtc = clockInZoneToUtcMs(dayKey, localClock, tz);
    if (Number.isFinite(convertedUtc)) return convertedUtc;
  }

  return NaN;
};

export const resolveScheduledDurationMinutes = (scheduleItem, defaultMinutes = 600) => {
  const rawHours = Number(pick(scheduleItem || {}, ["shiftDuration", "hours", "durationHours"], NaN));
  if (Number.isFinite(rawHours) && rawHours > 0) return Math.round(rawHours * 60);
  return Math.max(1, Math.round(Number(defaultMinutes) || 600));
};

export const resolveScheduledEndUtcMsForDayKey = (
  scheduleItem,
  dayKey
) => {
  if (!scheduleItem || !isValidDayKey(dayKey)) return NaN;

  const startMs = resolveScheduledStartUtcMsForDayKey(scheduleItem, dayKey);
  if (!Number.isFinite(startMs)) return NaN;

  let hadUtcEndSource = false;
  for (const key of END_UTC_KEYS) {
    const raw = scheduleItem?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    hadUtcEndSource = true;

    const rebasedUtc = rebaseUtcIsoToDay(raw, dayKey);
    if (Number.isFinite(rebasedUtc)) {
      return rebasedUtc >= startMs ? rebasedUtc : rebasedUtc + 24 * 60 * 60 * 1000;
    }
  }

  if (hadUtcEndSource) return NaN;

  const localClock = pick(scheduleItem, END_LOCAL_KEYS, "");
  if (localClock) {
    const tz = getScheduleTimeZone(scheduleItem, DEFAULT_SCHEDULE_TIME_ZONE);
    const convertedUtc = clockInZoneToUtcMs(dayKey, localClock, tz);
    if (Number.isFinite(convertedUtc)) {
      return convertedUtc >= startMs ? convertedUtc : convertedUtc + 24 * 60 * 60 * 1000;
    }
  }

  const durationMinutes = resolveScheduledDurationMinutes(scheduleItem, 600);
  return startMs + durationMinutes * 60_000;
};
