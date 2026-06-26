// src/components/SchedulePage.jsx
import React, { useMemo, useState } from "react";
import "./schedule.css";
import { RotateCw } from "lucide-react";
import {
  getDisplayName,
  getProfileImageUrl,
  getUserId,
  pick,
  safeLower,
} from "../utils/common";
import {
  getScheduleTimeZone,
  resolveScheduledEndUtcMsForDayKey,
  resolveScheduledStartUtcMsForDayKey,
} from "../utils/scheduleTime";

// robust userId detection

const initials = (name = "") => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
};

const pad2 = (n) => String(n).padStart(2, "0");
const MINUTES_PER_DAY = 24 * 60;
const PH_UTC_OFFSET_HOURS = 8;
const FIXED_TIME_ZONE_OFFSETS = {
  UTC: 0,
  GMT: 0,
  Z: 0,
  HST: -10,
  PHT: 8,
  PHST: 8,
  "PH TIME": 8,
  "PHILIPPINE TIME": 8,
  "PHILIPPINE STANDARD TIME": 8,
  "ASIA/MANILA": 8,
  MANILA: 8,
};
const DISPLAY_IANA_TIME_ZONES = {
  "AMERICA/NEW_YORK": "America/New_York",
  "NEW YORK": "America/New_York",
  "EASTERN TIME": "America/New_York",
  "EASTERN STANDARD TIME": "America/New_York",
  "EASTERN DAYLIGHT TIME": "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  "AMERICA/CHICAGO": "America/Chicago",
  CHICAGO: "America/Chicago",
  "CENTRAL TIME": "America/Chicago",
  "CENTRAL STANDARD TIME": "America/Chicago",
  "CENTRAL DAYLIGHT TIME": "America/Chicago",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  "AMERICA/DENVER": "America/Denver",
  DENVER: "America/Denver",
  "MOUNTAIN TIME": "America/Denver",
  "MOUNTAIN STANDARD TIME": "America/Denver",
  "MOUNTAIN DAYLIGHT TIME": "America/Denver",
  MST: "America/Denver",
  MDT: "America/Denver",
  "AMERICA/LOS_ANGELES": "America/Los_Angeles",
  "LOS ANGELES": "America/Los_Angeles",
  "PACIFIC TIME": "America/Los_Angeles",
  "PACIFIC STANDARD TIME": "America/Los_Angeles",
  "PACIFIC DAYLIGHT TIME": "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  "AMERICA/ANCHORAGE": "America/Anchorage",
  ANCHORAGE: "America/Anchorage",
  "ALASKA TIME": "America/Anchorage",
  "ALASKA STANDARD TIME": "America/Anchorage",
  "ALASKA DAYLIGHT TIME": "America/Anchorage",
  AKST: "America/Anchorage",
  AKDT: "America/Anchorage",
  "PACIFIC/HONOLULU": "Pacific/Honolulu",
  HONOLULU: "Pacific/Honolulu",
  "HAWAII TIME": "Pacific/Honolulu",
  "HAWAII STANDARD TIME": "Pacific/Honolulu",
  HST: "Pacific/Honolulu",
};

const parseClockToMinutes = (clockValue) => {
  const raw = String(clockValue || "").trim();
  if (!raw || raw === "-") return NaN;

  const match24 = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match24) {
    const hour = Number(match24[1]);
    const minute = Number(match24[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return hour * 60 + minute;
    }
  }

  const match12 = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/);
  if (!match12) return NaN;

  let hour = Number(match12[1]);
  const minute = Number(match12[2]);
  const suffix = String(match12[3] || "").toUpperCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return NaN;
  if (suffix === "AM" && hour === 12) hour = 0;
  if (suffix === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
};

const normalizeMinutesToHHMM = (totalMinutes) => {
  const n = Number(totalMinutes);
  if (!Number.isFinite(n)) return "-";
  const minutes = ((Math.round(n) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
};

const parseOffsetPartsToHours = (sign, hourValue, minuteValue = "0") => {
  const hours = Number(hourValue);
  const minutes = Number(minuteValue || 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return NaN;
  const absolute = hours + minutes / 60;
  return sign === "-" ? -absolute : absolute;
};

const isValidIanaTimeZone = (timeZone) => {
  const tz = String(timeZone || "").trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

const resolveDisplayIanaTimeZone = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const normalized = raw.toUpperCase().replace(/\s+/g, " ");
  if (Object.prototype.hasOwnProperty.call(DISPLAY_IANA_TIME_ZONES, normalized)) {
    return DISPLAY_IANA_TIME_ZONES[normalized];
  }

  if (raw.includes("/") && isValidIanaTimeZone(raw)) return raw;

  const tokenMatch = normalized.match(
    /\b(AKDT|AKST|PDT|PST|MDT|MST|CDT|CST|EDT|EST|HST)\b/
  );
  return tokenMatch ? DISPLAY_IANA_TIME_ZONES[tokenMatch[1]] || "" : "";
};

const resolveFixedTimeZoneOffsetHours = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return NaN;

  const normalized = raw.toUpperCase().replace(/\s+/g, " ");
  if (Object.prototype.hasOwnProperty.call(FIXED_TIME_ZONE_OFFSETS, normalized)) {
    return FIXED_TIME_ZONE_OFFSETS[normalized];
  }

  const utcOffsetMatch = normalized.match(/\b(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\b/);
  if (utcOffsetMatch) {
    return parseOffsetPartsToHours(utcOffsetMatch[1], utcOffsetMatch[2], utcOffsetMatch[3]);
  }

  const bareOffsetMatch = normalized.match(/^([+-])\s*(\d{1,2})(?::?(\d{2}))?$/);
  if (bareOffsetMatch) {
    return parseOffsetPartsToHours(bareOffsetMatch[1], bareOffsetMatch[2], bareOffsetMatch[3]);
  }

  const tokenMatch = normalized.match(
    /\b(PHT|PHST|HST|UTC|GMT|Z)\b/
  );
  return tokenMatch ? FIXED_TIME_ZONE_OFFSETS[tokenMatch[1]] : NaN;
};

const convertFixedOffsetClockToPh = (clockValue, sourceOffsetHours, sourceDayOffset = 0) => {
  const clockMinutes = parseClockToMinutes(clockValue);
  const sourceOffset = Number(sourceOffsetHours);
  const dayOffset = Number(sourceDayOffset || 0);
  if (!Number.isFinite(clockMinutes) || !Number.isFinite(sourceOffset) || !Number.isFinite(dayOffset)) {
    return null;
  }

  const phOffsetMinutes = Math.round((PH_UTC_OFFSET_HOURS - sourceOffset) * 60);
  const totalMinutes = dayOffset * MINUTES_PER_DAY + clockMinutes + phOffsetMinutes;
  return {
    time: normalizeMinutesToHHMM(totalMinutes),
    dayOffset: Math.floor(totalMinutes / MINUTES_PER_DAY),
  };
};

const inferScheduleOutDayOffset = (timeIn, timeOut, fallbackDayOffset = 0) => {
  const explicitOffset = Number(fallbackDayOffset || 0);
  if (explicitOffset) return explicitOffset;

  const startMinutes = parseClockToMinutes(timeIn);
  const endMinutes = parseClockToMinutes(timeOut);
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return 0;
  return endMinutes < startMinutes ? 1 : 0;
};

const addHoursToHHMM = (hhmm, hoursToAdd) => {
  const startMin = parseClockToMinutes(hhmm);
  const hrs = Number(hoursToAdd);

  if (!Number.isFinite(startMin) || !Number.isFinite(hrs)) {
    return { outHHMM: "-", dayOffset: 0 };
  }

  const addMin = Math.round(hrs * 60);
  const total = startMin + addMin;

  const dayOffset = Math.floor(total / MINUTES_PER_DAY);
  const mod = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  const outH = Math.floor(mod / 60);
  const outM = mod % 60;

  return { outHHMM: `${pad2(outH)}:${pad2(outM)}`, dayOffset };
};

const tzChip = (tz) => (!tz || tz === "-" ? "-" : tz);

// Day-range formatting
const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_ABBR = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

const SCHEDULE_TZ_API = "api";
const SCHEDULE_TZ_PH = "ph";
const SCHEDULE_TIME_24H = "24h";
const SCHEDULE_TIME_READABLE = "readable";
const PH_TIME_ZONE = "Asia/Manila";
const SCHEDULE_REFERENCE_TIME_ZONE = "America/Chicago";
const DAY_INDEX_BY_KEY = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const normalizeDayKey = (v) => {
  const s = safeLower(v).trim();
  if (!s) return null;
  if (s.startsWith("mon")) return "monday";
  if (s.startsWith("tue")) return "tuesday";
  if (s.startsWith("wed")) return "wednesday";
  if (s.startsWith("thu")) return "thursday";
  if (s.startsWith("fri")) return "friday";
  if (s.startsWith("sat")) return "saturday";
  if (s.startsWith("sun")) return "sunday";
  return null;
};

const formatDayRanges = (dayKeys) => {
  const set = new Set((dayKeys || []).filter(Boolean));
  const ordered = DAY_KEYS.filter((d) => set.has(d));
  if (ordered.length === 0) return "No Schedule";

  const parts = [];
  let start = ordered[0];
  let prev = ordered[0];

  const pushRange = (a, b) => {
    if (a === b) parts.push(DAY_ABBR[a]);
    else parts.push(`${DAY_ABBR[a]}-${DAY_ABBR[b]}`);
  };

  for (let i = 1; i < ordered.length; i++) {
    const cur = ordered[i];
    const prevIdx = DAY_KEYS.indexOf(prev);
    const curIdx = DAY_KEYS.indexOf(cur);

    if (curIdx === prevIdx + 1) {
      prev = cur;
    } else {
      pushRange(start, prev);
      start = cur;
      prev = cur;
    }
  }
  pushRange(start, prev);

  return parts.join(", ");
};

const getScheduleTimeIn = (item) =>
  pick(item, ["timeIn", "time_in", "startTime", "shiftStart", "start"], "-");

const getScheduleTimeOut = (item) =>
  pick(item, ["timeOut", "time_out", "endTime", "shiftEnd", "end"], "-");

const getScheduleTimeZoneRaw = (item) =>
  String(
    pick(item, ["timeRegion", "timezone", "timeZone", "tz", "scheduleTimezone", "scheduleTimeZone"], "")
  ).trim();

const getScheduleDuration = (item) => {
  const value = Number(pick(item, ["shiftDuration", "hours", "durationHours"], null));
  return Number.isFinite(value) ? value : null;
};

const formatUtcIsoToHHMM = (utcIso, timeZone) => {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
};

const formatUtcMsToHHMM = (utcMs, timeZone) => {
  const ms = Number(utcMs);
  if (!Number.isFinite(ms)) return "";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
};

const formatHHMMReadable = (hhmm) => {
  const raw = String(hhmm || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return raw || "-";

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return raw || "-";

  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${pad2(minute)} ${suffix}`;
};

const formatScheduleDisplayTime = (timeValue, displayFormat = SCHEDULE_TIME_24H) => {
  const raw = String(timeValue || "").trim();
  if (!raw || raw === "-") return "-";
  return displayFormat === SCHEDULE_TIME_READABLE ? formatHHMMReadable(raw) : raw;
};

const dayKeyFromUtcMsInZone = (utcMs, timeZone) => {
  const ms = Number(utcMs);
  if (!Number.isFinite(ms)) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: String(timeZone || "").trim() || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map.year && map.month && map.day ? `${map.year}-${map.month}-${map.day}` : "";
};

const dayOffsetFromReference = (displayDayKey, referenceDayKey) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(displayDayKey || ""))) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(referenceDayKey || ""))) return 0;

  const displayMs = new Date(`${displayDayKey}T00:00:00Z`).getTime();
  const referenceMs = new Date(`${referenceDayKey}T00:00:00Z`).getTime();
  if (!Number.isFinite(displayMs) || !Number.isFinite(referenceMs)) return 0;
  return Math.round((displayMs - referenceMs) / 86400000);
};

const getDatePartsInTimeZone = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
};

const formatDateKeyFromUtcMs = (utcMs) => {
  const d = new Date(utcMs);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

const getCurrentWeekReferenceDayKey = (dayKey) => {
  const targetDayIndex = DAY_INDEX_BY_KEY[dayKey];
  if (!Number.isFinite(targetDayIndex)) return "";

  const nowParts = getDatePartsInTimeZone(new Date(), SCHEDULE_REFERENCE_TIME_ZONE);
  const currentDayIndex = DAY_INDEX_BY_KEY[safeLower(nowParts.weekday)];
  const year = Number(nowParts.year);
  const month = Number(nowParts.month);
  const day = Number(nowParts.day);
  if (
    !Number.isFinite(currentDayIndex) ||
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return "";
  }

  const currentDateUtcMs = Date.UTC(year, month - 1, day);
  const targetDateUtcMs = currentDateUtcMs + (targetDayIndex - currentDayIndex) * 86400000;
  return formatDateKeyFromUtcMs(targetDateUtcMs);
};

const buildLocalClockScheduleItem = (item, dayKey, timeIn, timeOut) => ({
  dayOfWeek: dayKey,
  timeIn,
  timeOut,
  shiftDuration: pick(item || {}, ["shiftDuration", "hours", "durationHours"], null),
  timeRegion:
    resolveDisplayIanaTimeZone(getScheduleTimeZoneRaw(item)) ||
    getScheduleTimeZoneRaw(item) ||
    getScheduleTimeZone(item),
});

const buildFixedOffsetPhScheduleDisplay = (item, fallbackDisplay = {}) => {
  const apiTimeIn = String(fallbackDisplay.timeIn || "").trim();
  const apiTimeOut = String(fallbackDisplay.timeOut || "").trim();
  const timeZoneLabel = String(fallbackDisplay.tz || getScheduleTimeZoneRaw(item) || "").trim();
  if (resolveDisplayIanaTimeZone(timeZoneLabel)) return null;

  const sourceOffsetHours = resolveFixedTimeZoneOffsetHours(timeZoneLabel);

  if (!apiTimeIn || apiTimeIn === "-" || !Number.isFinite(sourceOffsetHours)) {
    return null;
  }

  const start = convertFixedOffsetClockToPh(apiTimeIn, sourceOffsetHours);
  if (!start) return null;

  const outDayOffset = inferScheduleOutDayOffset(apiTimeIn, apiTimeOut, fallbackDisplay.dayOffset);
  const end =
    apiTimeOut && apiTimeOut !== "-"
      ? convertFixedOffsetClockToPh(apiTimeOut, sourceOffsetHours, outDayOffset)
      : null;

  return {
    timeIn: start.time,
    timeOut: end?.time || fallbackDisplay.timeOut || "-",
    timeInDayOffset: start.dayOffset,
    dayOffset: end?.dayOffset ?? Number(fallbackDisplay.dayOffset || 0),
    tz: "PH Time",
  };
};

const buildPhScheduleDisplay = (item, dayKey, fallbackDisplay = {}) => {
  const referenceDayKey = getCurrentWeekReferenceDayKey(dayKey);
  const apiTimeIn = String(fallbackDisplay.timeIn || "").trim();
  const apiTimeOut = String(fallbackDisplay.timeOut || "").trim();
  const hasApiClock = !!apiTimeIn && apiTimeIn !== "-";

  const fixedOffsetDisplay = buildFixedOffsetPhScheduleDisplay(item, fallbackDisplay);
  if (fixedOffsetDisplay) return fixedOffsetDisplay;

  const sourceItem = hasApiClock
    ? buildLocalClockScheduleItem(
        item,
        dayKey,
        apiTimeIn,
        apiTimeOut && apiTimeOut !== "-" ? apiTimeOut : ""
      )
    : item;
  const startMs = resolveScheduledStartUtcMsForDayKey(sourceItem, referenceDayKey);
  const endMs = resolveScheduledEndUtcMsForDayKey(sourceItem, referenceDayKey);

  if (!Number.isFinite(startMs)) {
    return {
      timeIn: fallbackDisplay.timeIn || "-",
      timeOut: fallbackDisplay.timeOut || "-",
      timeInDayOffset: 0,
      dayOffset: Number(fallbackDisplay.dayOffset || 0),
      tz: "PH Time",
    };
  }

  const startDisplayDayKey = dayKeyFromUtcMsInZone(startMs, PH_TIME_ZONE);
  const endDisplayDayKey = Number.isFinite(endMs) ? dayKeyFromUtcMsInZone(endMs, PH_TIME_ZONE) : "";

  return {
    timeIn: formatUtcMsToHHMM(startMs, PH_TIME_ZONE) || fallbackDisplay.timeIn || "-",
    timeOut: Number.isFinite(endMs)
      ? formatUtcMsToHHMM(endMs, PH_TIME_ZONE) || fallbackDisplay.timeOut || "-"
      : fallbackDisplay.timeOut || "-",
    timeInDayOffset: dayOffsetFromReference(startDisplayDayKey, referenceDayKey),
    dayOffset: dayOffsetFromReference(endDisplayDayKey, referenceDayKey),
    tz: "PH Time",
  };
};

const buildScheduleGroups = (
  scheduleArr = [],
  displayTimeZoneMode = SCHEDULE_TZ_API,
  displayFormat = SCHEDULE_TIME_24H
) => {
  if (!Array.isArray(scheduleArr) || scheduleArr.length === 0) return [];

  const groupsMap = new Map();

  for (const item of scheduleArr) {
    const dayKey = normalizeDayKey(pick(item, ["dayOfWeek", "day", "weekday"], ""));
    if (!dayKey) continue;

    const utcTimeIn = pick(item, ["utcTimeIn", "utcStart", "startUtc", "utcTimeStart"], "");
    const utcTimeOut = pick(item, ["utcTimeOut", "utcEnd", "endUtc", "utcTimeEnd"], "");
    const apiTimeIn = getScheduleTimeIn(item);
    const apiTimeOut = getScheduleTimeOut(item);
    const apiTimeZone = getScheduleTimeZoneRaw(item);
    const displayTimeZone = resolveDisplayIanaTimeZone(apiTimeZone) || getScheduleTimeZone(item);

    const convertedIn = utcTimeIn ? formatUtcIsoToHHMM(utcTimeIn, displayTimeZone) : "";
    const timeIn = apiTimeIn !== "-" ? apiTimeIn : convertedIn || "-";
    const duration = getScheduleDuration(item);

    const convertedOut = utcTimeOut ? formatUtcIsoToHHMM(utcTimeOut, displayTimeZone) : "";
    const hasExplicitOutValue = apiTimeOut !== "-" || !!convertedOut;
    const explicitOutValue = apiTimeOut !== "-" ? apiTimeOut : convertedOut || "";
    const { outHHMM, dayOffset } = hasExplicitOutValue
      ? { outHHMM: explicitOutValue || "-", dayOffset: 0 }
      : timeIn !== "-" && duration != null
        ? addHoursToHHMM(timeIn, duration)
        : { outHHMM: "-", dayOffset: 0 };

    const tz = apiTimeZone || (convertedIn || convertedOut ? displayTimeZone : "-");

    const displayValues =
      displayTimeZoneMode === SCHEDULE_TZ_PH
        ? buildPhScheduleDisplay(item, dayKey, { timeIn, timeOut: outHHMM, dayOffset, tz })
        : {
            timeIn,
            timeOut: outHHMM,
            timeInDayOffset: 0,
            dayOffset,
            tz,
          };

    const groupKey = JSON.stringify({
      timeIn: displayValues.timeIn,
      duration,
      timeOut: displayValues.timeOut,
      timeInDayOffset: displayValues.timeInDayOffset,
      dayOffset: displayValues.dayOffset,
      tz: displayValues.tz,
    });

    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, {
        key: groupKey,
        dayKeys: [],
        timeIn: formatScheduleDisplayTime(displayValues.timeIn, displayFormat),
        duration,
        timeOut: formatScheduleDisplayTime(displayValues.timeOut, displayFormat),
        timeInDayOffset: displayValues.timeInDayOffset,
        dayOffset: displayValues.dayOffset,
        tz: displayValues.tz,
      });
    }

    groupsMap.get(groupKey).dayKeys.push(dayKey);
  }

  const groups = Array.from(groupsMap.values()).map((group) => ({
    ...group,
    dayLabel: formatDayRanges(group.dayKeys),
  }));

  groups.sort((a, b) => {
    const aIdx = Math.min(...a.dayKeys.map((d) => DAY_KEYS.indexOf(d)).filter((n) => n >= 0));
    const bIdx = Math.min(...b.dayKeys.map((d) => DAY_KEYS.indexOf(d)).filter((n) => n >= 0));
    return aIdx - bIdx;
  });

  return groups;
};

export default function SchedulePage({
  employees = [],
  schedulesByUserId = {},
  errorsByUserId = {},
  loading = false,
  error = "",
  onReload,
  pageData = null,
}) {
  const [query, setQuery] = useState("");
  const [scheduleTimeDisplayMode, setScheduleTimeDisplayMode] = useState(SCHEDULE_TZ_API);
  const [scheduleTimeFormat, setScheduleTimeFormat] = useState(SCHEDULE_TIME_24H);
  const handleReloadClick = () => {
    if (typeof onReload === "function") {
      onReload({ force: true });
    }
  };
  const scheduleTimeDisplayLabel =
    scheduleTimeDisplayMode === SCHEDULE_TZ_PH ? "PH Time" : "API Time Zone";
  const profileImagesByUserId =
    pageData?.profileImagesByUserId && typeof pageData.profileImagesByUserId === "object"
      ? pageData.profileImagesByUserId
      : {};

  const validEmployees = (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e));

  const rows = useMemo(() => {
    const out = [];

    for (const emp of validEmployees) {
      const userId = String(getUserId(emp));
      const name = getDisplayName(emp);
      const email = pick(emp || {}, ["email"], "");
      const mappedProfileImage = String(profileImagesByUserId?.[userId] || "").trim();
      const profileImage = mappedProfileImage || getProfileImageUrl(emp);

      const scheduleArr = Array.isArray(schedulesByUserId?.[userId]) ? schedulesByUserId[userId] : [];
      const hasSchedule = scheduleArr.length > 0;
      const scheduleGroups = buildScheduleGroups(
        scheduleArr,
        scheduleTimeDisplayMode,
        scheduleTimeFormat
      );

      out.push({
        key: userId,
        userId,
        name,
        email,
        profileImg: profileImage,
        hasSchedule,
        scheduleGroups,
        tz:
          scheduleGroups.length === 1
            ? scheduleGroups[0].tz
            : scheduleGroups.length > 1
              ? "Multiple"
              : "-",
        perUserError: errorsByUserId?.[userId] || "",
        raw: scheduleArr,
      });
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [
    validEmployees,
    schedulesByUserId,
    errorsByUserId,
    profileImagesByUserId,
    scheduleTimeDisplayMode,
    scheduleTimeFormat,
  ]);

  const filtered = useMemo(() => {
    const q = safeLower(query).trim();
    if (!q) return rows;

    return rows.filter((r) => {
      const groupText = r.scheduleGroups
        .map((g) => `${g.dayLabel} ${g.timeIn} ${g.timeOut} ${g.duration ?? ""} ${g.tz}`)
        .join(" ");

      return (
        safeLower(r.name).includes(q) ||
        safeLower(r.email).includes(q) ||
        safeLower(r.userId).includes(q) ||
        safeLower(groupText).includes(q)
      );
    });
  }, [rows, query]);

  const kpis = useMemo(() => {
    const totalUsers = validEmployees.length;
    const withSchedule = rows.filter((r) => r.hasSchedule).length;
    const noSchedule = totalUsers - withSchedule;
    return { totalUsers, withSchedule, noSchedule };
  }, [validEmployees.length, rows]);

  return (
    <div className="schx">
      

      {error && <div className="schxAlert">{error}</div>}

      <div className="schxKpis">
        <div className="schxTile">
          <div className="schxTileLabel">Users</div>
          <div className="schxTileValue">{kpis.totalUsers}</div>
          <div className="schxTileHint">Valid userId detected</div>
        </div>

        <div className="schxTile">
          <div className="schxTileLabel">With Schedule</div>
          <div className="schxTileValue">{kpis.withSchedule}</div>
          <div className="schxTileHint">Non-empty schedule array</div>
        </div>

        <div className="schxTile">
          <div className="schxTileLabel">No Schedule</div>
          <div className="schxTileValue">{kpis.noSchedule}</div>
          <div className="schxTileHint">Needs assignment</div>
        </div>
      </div>

      <div className="schxCard">
        <div className="schxCardHead">
          <div className="schxCardMeta">
            Showing {filtered.length} of {rows.length}
          </div>
          <div className="schxTop">
            <div className="schxControls">
              <div className="schxField schxFieldSearch">
                <div className="schxLabel">Search</div>
                <input
                  className="schxInput"
                  placeholder="Search name / email / userId / days / time..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              <button
                className="schxBtn schxBtnIcon"
                type="button"
                onClick={handleReloadClick}
                disabled={loading}
                aria-label={loading ? "Reloading schedules" : "Reload schedules"}
                title={loading ? "Reloading schedules..." : "Reload schedules"}
              >
                <RotateCw size={16} className={loading ? "schxBtnIconSpin" : ""} />
              </button>

              <div className="schxTimezoneToggle" role="group" aria-label="Schedule time display timezone">
                <button
                  type="button"
                  className={`schxTimezoneBtn ${scheduleTimeDisplayMode === SCHEDULE_TZ_API ? "isActive" : ""}`}
                  onClick={() => setScheduleTimeDisplayMode(SCHEDULE_TZ_API)}
                  aria-pressed={scheduleTimeDisplayMode === SCHEDULE_TZ_API}
                >
                  API TZ
                </button>
                <button
                  type="button"
                  className={`schxTimezoneBtn ${scheduleTimeDisplayMode === SCHEDULE_TZ_PH ? "isActive" : ""}`}
                  onClick={() => setScheduleTimeDisplayMode(SCHEDULE_TZ_PH)}
                  aria-pressed={scheduleTimeDisplayMode === SCHEDULE_TZ_PH}
                >
                  PH Time
                </button>
              </div>

              <div className="schxTimezoneToggle" role="group" aria-label="Schedule time format">
                <button
                  type="button"
                  className={`schxTimezoneBtn ${scheduleTimeFormat === SCHEDULE_TIME_24H ? "isActive" : ""}`}
                  onClick={() => setScheduleTimeFormat(SCHEDULE_TIME_24H)}
                  aria-pressed={scheduleTimeFormat === SCHEDULE_TIME_24H}
                >
                  24H
                </button>
                <button
                  type="button"
                  className={`schxTimezoneBtn ${scheduleTimeFormat === SCHEDULE_TIME_READABLE ? "isActive" : ""}`}
                  onClick={() => setScheduleTimeFormat(SCHEDULE_TIME_READABLE)}
                  aria-pressed={scheduleTimeFormat === SCHEDULE_TIME_READABLE}
                >
                  AM/PM
                </button>
              </div>

              <div className="schxPill">
                Rows: <span className="schxPillValue">{filtered.length}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="schxTableWrap">
          <table className="schxTable">
            <thead>
              <tr>
                <th>User</th>
                <th>Days</th>
                <th>Time In ({scheduleTimeDisplayLabel})</th>
                <th>Time Out ({scheduleTimeDisplayLabel})</th>
                <th>Hours</th>
                <th>Timezone</th>
              </tr>
            </thead>

            <tbody>
              {validEmployees.length === 0 && !loading && !error ? (
                <tr>
                  <td colSpan={6} className="schxTableEmpty">
                    No employees found (or userId not detected).
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="schxTableEmpty">
                    No schedules match your search.
                  </td>
                </tr>
              ) : (
                filtered.slice(0, 400).map((r) => (
                  <tr className="schxTr" key={r.key}>
                    <td>
                      <div className="schxPerson">
                        <div className="schxAvatar" aria-label={r.name}>
                          {r.profileImg ? (
                            <img
                              src={r.profileImg}
                              alt={`${r.name} profile`}
                              className="schxAvatarImg"
                              loading="lazy"
                            />
                          ) : (
                            initials(r.name)
                          )}
                        </div>
                        <div>
                          <div className="schxName">{r.name}</div>
                          <div className="schxEmail">{r.email || r.userId}</div>
                        </div>
                      </div>

                      {r.perUserError && <div className="schxErrMini">{r.perUserError}</div>}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxChip schxChipNoSched">No Schedule</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <span key={`${r.key}-days-${idx}`} className="schxChip">
                              {g.dayLabel}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxTime">-</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <div key={`${r.key}-in-${idx}`} className="schxTimeWrap">
                              <span className="schxTime">{g.timeIn}</span>
                              {g.timeInDayOffset ? (
                                <span className="schxMiniPill">
                                  {g.timeInDayOffset > 0 ? `+${g.timeInDayOffset}d` : `${g.timeInDayOffset}d`}
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxTime">-</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <div key={`${r.key}-out-${idx}`} className="schxTimeWrap">
                              <span className="schxTime">{g.timeOut}</span>
                              {g.dayOffset > 0 && <span className="schxMiniPill">{`+${g.dayOffset}d`}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxChip schxChipGood">-</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <span key={`${r.key}-hrs-${idx}`} className="schxChip schxChipGood">
                              {g.duration == null ? "-" : `${g.duration}h`}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxChip schxChipTz">-</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <span key={`${r.key}-tz-${idx}`} className="schxChip schxChipTz">
                              {tzChip(g.tz)}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}



