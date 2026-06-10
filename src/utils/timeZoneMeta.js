import {
  DEFAULT_STORAGE_TIME_ZONE,
  getAttendanceSettingsSync,
  sanitizeTimeZone,
} from "../services/attendanceSettingsService";
import { toMillis } from "./common";

const pad2 = (value) => String(value).padStart(2, "0");

export const formatDateTimeInZone = (dateLike, timeZone) => {
  const ms = toMillis(dateLike);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);

  const safeTimeZone = sanitizeTimeZone(timeZone, DEFAULT_STORAGE_TIME_ZONE);
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
  }).formatToParts(d);

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  if (!map.year || !map.month || !map.day || !map.hour || !map.minute || !map.second) {
    return "";
  }

  return `${map.year}-${pad2(map.month)}-${pad2(map.day)}T${pad2(map.hour)}:${pad2(map.minute)}:${pad2(map.second)}`;
};

export const resolveStorageTimeZone = () => {
  const settings = getAttendanceSettingsSync();
  return sanitizeTimeZone(settings?.storageTimeZone, DEFAULT_STORAGE_TIME_ZONE);
};

export const buildTimeZoneMeta = (
  prefix,
  dateLike = new Date(),
  explicitTimeZone = ""
) => {
  const keyPrefix = String(prefix || "").trim();
  if (!keyPrefix) return {};

  const ms = toMillis(dateLike);
  if (!Number.isFinite(ms)) return {};
  const d = new Date(ms);

  const timeZone = sanitizeTimeZone(explicitTimeZone, resolveStorageTimeZone());
  const local = formatDateTimeInZone(d, timeZone);

  return {
    [`${keyPrefix}TimeZone`]: timeZone,
    [`${keyPrefix}UtcIso`]: d.toISOString(),
    [`${keyPrefix}Local`]: local,
  };
};
