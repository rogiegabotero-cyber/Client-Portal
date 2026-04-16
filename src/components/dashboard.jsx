import React, { useEffect, useMemo, useRef, useState } from "react";
import "./dashboard.css";
import { flushSync } from "react-dom";
import { getBusinessDayKey } from "../utils/attendanceDate";
import { getBreakLogsByUserIdsInRange } from "../services/breakService";
import { getDisplayName, getUserId, pick, safeLower } from "../utils/common";
import {
  hasRealTimeOut,
  isClockedOutLog,
  isIn,
  isOut,
  pickOutTs,
  pickTs,
  tsMs,
} from "../utils/attendanceLog";
import {
  resolveScheduledDurationMinutes,
  resolveScheduledEndUtcMsForDayKey,
  resolveScheduledStartUtcMsForDayKey,
} from "../utils/scheduleTime";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LabelList,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

/* ------------------------- helpers ------------------------- */

const shortAgentLabel = (name) => {
  const raw = String(name || "").trim();
  if (!raw) return "-";
  const first = raw.split(/\s+/)[0] || raw;
  return first.length > 12 ? `${first.slice(0, 11)}.` : first;
};

const formatHoursValue = (value) => {
  const hours = Number(value);
  return Number.isFinite(hours) ? hours.toFixed(2) : "0.00";
};

const isValidTs = (log) => Number.isFinite(tsMs(pickTs(log))) || Number.isFinite(tsMs(pickOutTs(log)));

const eventTsMsFromLog = (log) => {
  const inTs = tsMs(pickTs(log));
  if (Number.isFinite(inTs)) return inTs;
  return tsMs(pickOutTs(log));
};

const pickPrimaryAttendanceLog = (dayLogs = []) => {
  const arr = Array.isArray(dayLogs) ? dayLogs : [];
  if (!arr.length) return null;

  const inLog = arr.find((l) => isIn(l));
  if (inLog) return inLog;

  let best = null;
  let bestTs = NaN;

  for (const log of arr) {
    const ts = eventTsMsFromLog(log);
    if (!best) {
      best = log;
      bestTs = ts;
      continue;
    }
    if (Number.isFinite(ts) && (!Number.isFinite(bestTs) || ts < bestTs)) {
      best = log;
      bestTs = ts;
    }
  }

  return best || arr[0] || null;
};

const buildMonthlyAttendanceBucketMap = (byDay = new Map()) => {
  const monthStats = new Map();

  for (const [dayKey, dayLogs] of byDay.entries()) {
    const primaryLog = pickPrimaryAttendanceLog(dayLogs);
    const bucket = normalizeAttendanceStatus(pick(primaryLog || {}, ["status"], ""));
    if (!bucket) continue;

    const monthKey = monthKeyFromYmd(dayKey);
    if (!monthKey) continue;

    if (!monthStats.has(monthKey)) {
      monthStats.set(monthKey, {
        counts: {},
        latestDayKey: "",
        latestBucket: null,
      });
    }

    const row = monthStats.get(monthKey);
    row.counts[bucket] = Number(row.counts[bucket] || 0) + 1;

    if (!row.latestDayKey || dayKey > row.latestDayKey) {
      row.latestDayKey = dayKey;
      row.latestBucket = bucket;
    }
  }

  const out = new Map();

  for (const [monthKey, row] of monthStats.entries()) {
    const entries = Object.entries(row.counts || {});
    if (!entries.length) continue;

    let bestBucket = row.latestBucket || entries[0][0];
    let bestCount = Number(row.counts?.[bestBucket] || 0);

    for (const [bucket, countValue] of entries) {
      const count = Number(countValue || 0);
      if (count > bestCount) {
        bestBucket = bucket;
        bestCount = count;
      } else if (count === bestCount && row.latestBucket === bucket) {
        bestBucket = bucket;
      }
    }

    out.set(monthKey, bestBucket);
  }

  return out;
};

const getDiffRawFromLogs = (sorted = []) => {
  const inLog = sorted.find((l) => isIn(l)) || null;
  const outLog = [...sorted].reverse().find((l) => isOut(l) || hasRealTimeOut(l)) || null;

  return (
    pick(inLog || {}, ["timeDiff", "diff", "difference"], "") ||
    pick(outLog || {}, ["timeDiff", "diff", "difference"], "") ||
    pick(
      sorted.find((l) => {
        const v = pick(l || {}, ["timeDiff", "diff", "difference"], "");
        return String(v).trim() !== "";
      }) || {},
      ["timeDiff", "diff", "difference"],
      ""
    )
  );
};

const parseYmdToUtcNoon = (yyyyMmDd) => {
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const ymdFromDateUtc = (d) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

const enumerateYmdRange = (startYmd, endYmd) => {
  const start = parseYmdToUtcNoon(startYmd);
  const end = parseYmdToUtcNoon(endYmd);
  if (!start || !end) return [];

  const out = [];
  const cur = new Date(start.getTime());
  while (cur.getTime() <= end.getTime()) {
    out.push(ymdFromDateUtc(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
};

const normalizeYmdRange = (startYmd, endYmd, fallbackYmd = "") => {
  const isValidYmd = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

  const fallback = isValidYmd(fallbackYmd) ? String(fallbackYmd) : "";
  let start = isValidYmd(startYmd) ? String(startYmd) : "";
  let end = isValidYmd(endYmd) ? String(endYmd) : "";

  if (!start && !end) {
    return { start: fallback, end: fallback };
  }
  if (!start) start = end;
  if (!end) end = start;
  if (!start || !end) return { start: "", end: "" };
  if (start <= end) return { start, end };
  return { start: end, end: start };
};

const countInclusiveDaysInYmdRange = (startYmd, endYmd) => {
  const start = parseYmdToUtcNoon(startYmd);
  const end = parseYmdToUtcNoon(endYmd);
  if (!start || !end) return 0;
  const diffMs = end.getTime() - start.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.floor(diffMs / 86400000) + 1;
};

const addDaysYmd = (ymd, deltaDays) => {
  const d = parseYmdToUtcNoon(ymd);
  if (!d) return ymd;
  const cur = new Date(d.getTime());
  cur.setUTCDate(cur.getUTCDate() + Number(deltaDays || 0));
  return ymdFromDateUtc(cur);
};

const firstDayOfMonthYmd = (ymd) => {
  const base = parseYmdToUtcNoon(ymd);
  if (!base) return ymd;
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
};

const lastDayOfMonthYmd = (ymd) => {
  const base = parseYmdToUtcNoon(ymd);
  if (!base) return ymd;
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0, 12, 0, 0));
  return ymdFromDateUtc(last);
};

const dayOfMonthFromYmd = (ymd) => {
  const d = parseYmdToUtcNoon(ymd);
  if (!d) return NaN;
  return d.getUTCDate();
};

const monthKeyFromYmd = (ymd) => String(ymd || "").slice(0, 7);

const prettyMonthLabel = (monthKey) => {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return monthKey || "-";
  const d = new Date(`${monthKey}-01T12:00:00Z`);
  return d.toLocaleDateString([], { month: "short", year: "numeric" });
};

const prettyDayLabel = (ymd) => {
  if (!ymd) return "-";
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

const sanitizeFileNameSegment = (value, fallback = "") => {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
};

const extractDepartmentName = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const match = raw.match(/^dept_(.+)_\d+$/i);
  if (match && match[1]) {
    return String(match[1]).trim();
  }

  return raw;
};

const WEEKDAY_LABELS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const shortWeekdayLabelFromYmd = (ymd) => {
  const d = parseYmdToUtcNoon(ymd);
  if (!d) return "-";
  return WEEKDAY_LABELS_SHORT[d.getUTCDay()] || "-";
};

const ATTENDANCE_NOTE_KEYS = [
  "notes",
  "note",
  "attendanceNotes",
  "attendanceNote",
  "comment",
  "comments",
  "remarks",
  "remark",
  "reason",
  "details",
  "description",
];

const getAttendanceNoteFromLog = (log) => {
  const statusText = String(
    pick(log || {}, ["status", "attendanceStatus", "dailyStatus", "remark"], "")
  ).trim();
  const rawNoteText = String(pick(log || {}, ATTENDANCE_NOTE_KEYS, "") || "").trim();
  if (!rawNoteText) return "";
  if (rawNoteText.toLowerCase() === statusText.toLowerCase()) return "";
  return rawNoteText;
};

const getAttendanceNotesFromDayLogs = (dayLogs = []) => {
  const logs = Array.isArray(dayLogs) ? [...dayLogs] : [];
  if (!logs.length) return "";

  logs.sort((a, b) => eventTsMsFromLog(b) - eventTsMsFromLog(a));

  const seen = new Set();
  const notes = [];

  for (const log of logs) {
    const note = getAttendanceNoteFromLog(log);
    if (!note) continue;
    const key = note.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(note);
  }

  return notes.join(" | ");
};

const getRawAttendanceStatus = (log) =>
  safeLower(
    pick(log || {}, ["status", "attendanceStatus", "dailyStatus", "remark"], "")
  ).trim();

const getAttendanceLogDedupeKey = (log = {}) => {
  const explicitId = String(
    pick(log || {}, ["id", "_id", "logId", "attendanceLogId"], "")
  ).trim();
  if (explicitId) return `id:${explicitId}`;

  const inTs = String(pickTs(log) || "").trim();
  const outTs = String(pickOutTs(log) || "").trim();
  const type = safeLower(pick(log || {}, ["type", "logType", "eventType"], "")).trim();
  const status = getRawAttendanceStatus(log);
  const userId = String(
    pick(log || {}, ["userId", "employeeUserId", "uid", "employeeId"], "")
  ).trim();
  const fallback = `${userId}|${inTs}|${outTs}|${type}|${status}`;
  if (fallback.replace(/\|/g, "").trim()) return fallback;

  return `json:${JSON.stringify(log || {})}`;
};

const mergeAttendanceLogs = (...logLists) => {
  const merged = [];
  const seen = new Set();

  for (const list of logLists) {
    if (!Array.isArray(list)) continue;
    for (const log of list) {
      if (!log || typeof log !== "object") continue;
      const key = getAttendanceLogDedupeKey(log);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(log);
    }
  }

  return merged;
};

const enumerateMonthKeys = (startMonthKey, endMonthKey) => {
  if (!startMonthKey || !endMonthKey) return [];
  const start = new Date(`${startMonthKey}-01T12:00:00Z`);
  const end = new Date(`${endMonthKey}-01T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const out = [];
  const cur = new Date(start.getTime());

  while (cur.getTime() <= end.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${y}-${m}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }

  return out;
};

const startOfWeekYmd = (ymd) => {
  const d = parseYmdToUtcNoon(ymd);
  if (!d) return ymd;
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return ymdFromDateUtc(d);
};

/* ------------------------ cutoff helpers ------------------------ */
const cutoff30OrEomForYmd = (periodEndYmd) => {
  const periodEnd = String(periodEndYmd || "");
  if (!periodEnd) return "";
  const mk = monthKeyFromYmd(periodEnd);
  const eom = lastDayOfMonthYmd(periodEnd);
  const eomDay = dayOfMonthFromYmd(eom);
  return eomDay >= 30 ? `${mk}-30` : eom;
};

const cutoffWindowFor15D = (periodEndYmd) => {
  const periodEnd = String(periodEndYmd || "");
  if (!periodEnd) return { start: "", end: "" };

  const dayNum = dayOfMonthFromYmd(periodEnd);
  const mk = monthKeyFromYmd(periodEnd);

  if (Number(dayNum) <= 15) {
    return { start: `${mk}-01`, end: `${mk}-15` };
  }

  return { start: `${mk}-16`, end: cutoff30OrEomForYmd(periodEnd) };
};

const cutoffLabelForYmd = (periodEndYmd) => {
  const w = cutoffWindowFor15D(periodEndYmd);
  if (!w.start || !w.end) return "Cutoff: -";
  return `Cutoff: ${w.start} -> ${w.end}`;
};

/* ------------------------ employee start-date helpers ------------------------ */
const normalizeStartDateYmd = (value) => {
  if (!value) return "";

  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return "";
  }

  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }

  return "";
};

const getEmployeeStartDateYmd = (employeeProfilesByUserId, userId) => {
  const profile = employeeProfilesByUserId?.[String(userId)] || null;
  return normalizeStartDateYmd(profile?.startDate);
};

const filterDayKeysByEmployeeStartDate = (dayKeys, employeeStartDateYmd) => {
  const list = Array.isArray(dayKeys) ? dayKeys : [];
  if (!employeeStartDateYmd) return list;
  return list.filter((dk) => String(dk) >= String(employeeStartDateYmd));
};

/* ------------------------ schedule helpers ------------------------ */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const weekdayNameFromYmd = (yyyyMmDd) => {
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAYS[d.getUTCDay()];
};

const getScheduleItemForDay = (schedulesByUserId, userId, dayKey) => {
  const sched = schedulesByUserId?.[String(userId)];
  if (!Array.isArray(sched) || sched.length === 0) return null;

  const targetWeekday = weekdayNameFromYmd(dayKey);
  if (!targetWeekday) return null;

  return sched.find((s) => safeLower(pick(s, ["dayOfWeek", "day", "weekday"], "")) === targetWeekday) || null;
};

const getScheduledStartUtcMsForDayKey = (
  scheduleItem,
  dayKey,
  businessTimeZone = "America/Chicago"
) => {
  return resolveScheduledStartUtcMsForDayKey(scheduleItem, dayKey, businessTimeZone);
};

const getScheduledDurationMinutesForDay = (
  schedulesByUserId,
  userId,
  dayKey,
  businessTimeZone = "America/Chicago"
) => {
  const item = getScheduleItemForDay(schedulesByUserId, userId, dayKey);
  if (!item) return null;

  const startMs = getScheduledStartUtcMsForDayKey(item, dayKey, businessTimeZone);
  const endMs = resolveScheduledEndUtcMsForDayKey(item, dayKey, businessTimeZone);

  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    return Math.round((endMs - startMs) / 60000);
  }

  return resolveScheduledDurationMinutes(item, 600);
};

/* ------------------------ status logic ------------------------ */
const resolveDailyStatus = ({
  userId,
  dayKey,
  dayLogs,
  schedulesByUserId,
  nowMs,
  endDate,
  businessTimeZone = "America/Chicago",
}) => {
  const logs = Array.isArray(dayLogs) ? dayLogs : [];
  const hasLogs = logs.length > 0;

  if (hasLogs) {
    const statuses = logs.map((log) => getRawAttendanceStatus(log)).filter(Boolean);

    if (statuses.some((s) => s.includes("no schedule"))) {
      return "No Schedule";
    }
    if (statuses.some((s) => s === "ncns" || s.includes("no show"))) {
      return "No Show";
    }

    const hasOut = logs.some((l) => isClockedOutLog(l));
    const hasIn = logs.some((l) => isIn(l));

    if (hasOut) return "Completed";
    if (statuses.some((s) => s.includes("on break"))) return "On Break";
    if (hasIn || statuses.some((s) => s.includes("live"))) return "Live";

    if (statuses.some((s) => s.includes("scheduled"))) {
      return "Scheduled";
    }

    return "No Log";
  }

  const schedArr = schedulesByUserId?.[String(userId)];
  const hasAnySchedule = Array.isArray(schedArr) && schedArr.length > 0;
  if (!hasAnySchedule) return "No Schedule";

  const schedItem = getScheduleItemForDay(schedulesByUserId, userId, dayKey);
  if (!schedItem) return "Day Off";

  const startMs = getScheduledStartUtcMsForDayKey(schedItem, dayKey, businessTimeZone);
  const GRACE_MS = 2 * 60 * 60 * 1000;
  if (!Number.isFinite(startMs)) return "Scheduled";

  const todayKey = String(endDate || "");
  const endOfDayMs = new Date(`${dayKey}T23:59:59.999Z`).getTime();
  const referenceNow = dayKey === todayKey ? nowMs : endOfDayMs;

  return referenceNow >= startMs + GRACE_MS ? "No Show" : "Scheduled";
};

/* ------------------------ payable hours helpers ------------------------ */
const computeWorkedMinutesForDay = (logs, liveNowMs = null, { applyDiff = true } = {}) => {
  const arr = Array.isArray(logs) ? logs : [];
  if (!arr.length) return null;

  const sorted = [...arr].sort((a, b) => {
    const aTs = Number.isFinite(tsMs(pickTs(a))) ? tsMs(pickTs(a)) : tsMs(pickOutTs(a));
    const bTs = Number.isFinite(tsMs(pickTs(b))) ? tsMs(pickTs(b)) : tsMs(pickOutTs(b));
    return aTs - bTs;
  });

  const inLog =
    sorted.find((l) => isIn(l) && Number.isFinite(tsMs(pickTs(l)))) ||
    null;

  if (!inLog) return null;

  const outLog =
    [...sorted].reverse().find((l) => isClockedOutLog(l)) || null;

  const start = tsMs(pickTs(inLog));
  const end = outLog
    ? (Number.isFinite(tsMs(pickOutTs(outLog)))
        ? tsMs(pickOutTs(outLog))
        : tsMs(pickTs(outLog)))
    : Number.isFinite(Number(liveNowMs))
      ? Number(liveNowMs)
      : NaN;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

  const totalMinutesBetweenInOut = Math.round((end - start) / 60000);
  if (!applyDiff) return totalMinutesBetweenInOut;

  const diffRaw = getDiffRawFromLogs(sorted);
  const diffMinutes = Number(diffRaw);
  const hasNoSchedule = sorted.some((l) =>
    safeLower(pick(l, ["status"], "")).includes("no schedule")
  );

  if (hasNoSchedule) {
    return totalMinutesBetweenInOut;
  }

  if (String(diffRaw).trim() === "" || !Number.isFinite(diffMinutes)) {
    return totalMinutesBetweenInOut;
  }

  return Math.max(0, totalMinutesBetweenInOut - Math.abs(diffMinutes));
};

const MAX_NO_SCHEDULE_MINUTES_PER_DAY = 10 * 60;
const EARLY_CLOCK_OUT_GRACE_MINUTES = 10;

const computePayableMinutesForDay = ({
  dayLogs = [],
  userId,
  dayKey,
  schedulesByUserId,
  nowMs,
  endDate,
  businessTimeZone = "America/Chicago",
}) => {
  const logs = Array.isArray(dayLogs) ? dayLogs : [];
  if (!logs.length) return null;

  const hasNoScheduleLog = logs.some((log) =>
    safeLower(pick(log, ["status"], "")).includes("no schedule")
  );
  const liveNowForDay =
    String(dayKey) === String(endDate || "") ? nowMs : null;

  const workedMinutes = computeWorkedMinutesForDay(
    logs,
    liveNowForDay
  );

  if (!Number.isFinite(workedMinutes) || workedMinutes <= 0) return null;

  if (hasNoScheduleLog) {
    return Math.min(workedMinutes, MAX_NO_SCHEDULE_MINUTES_PER_DAY);
  }

  const scheduledMinutes = getScheduledDurationMinutesForDay(
    schedulesByUserId,
    userId,
    dayKey,
    businessTimeZone
  );

  if (Number.isFinite(scheduledMinutes) && scheduledMinutes > 0) {
    const cappedWorkedMinutes = Math.min(workedMinutes, scheduledMinutes);
    const minutesShort = scheduledMinutes - cappedWorkedMinutes;

    if (minutesShort >= 0 && minutesShort <= EARLY_CLOCK_OUT_GRACE_MINUTES) {
      return scheduledMinutes;
    }

    return cappedWorkedMinutes;
  }

  return workedMinutes;
};

const buildByDayMap = (
  logs,
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago"
) => {
  const valid = Array.isArray(logs)
    ? logs.filter((l) => isValidTs(l) || Number.isFinite(tsMs(pickOutTs(l))))
    : [];

  const byDay = new Map();

  for (const log of valid) {
    const baseTs = Number.isFinite(tsMs(pickTs(log))) ? pickTs(log) : pickOutTs(log);
    const dk = getBusinessDayKey(baseTs, attendanceResetTime, businessTimeZone);
    if (!dk) continue;

    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk).push(log);
  }

  return byDay;
};
/* ---------------------------- pie helper ---------------------------- */
const buildPieConicGradient = (slices, total) => {
  const safeTotal = Math.max(1, Number(total) || 0);
  let cur = 0;

  const parts = slices.map((s) => {
    const val = Math.max(0, Number(s.value) || 0);
    const deg = (val / safeTotal) * 360;
    const a0 = cur;
    const a1 = cur + deg;
    cur = a1;
    return `${s.color} ${a0}deg ${a1}deg`;
  });

  if (cur < 360) parts.push(`rgba(255,255,255,0.08) ${cur}deg 360deg`);
  return `conic-gradient(${parts.join(", ")})`;
};

const minDayKeyFromLogs = (
  logs,
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago"
) => {
  const valid = Array.isArray(logs)
    ? logs.filter((l) => isValidTs(l) || Number.isFinite(tsMs(pickOutTs(l))))
    : [];
  let best = null;
  for (const l of valid) {
    const baseTs = Number.isFinite(tsMs(pickTs(l))) ? pickTs(l) : pickOutTs(l);
    const dk = getBusinessDayKey(baseTs, attendanceResetTime, businessTimeZone);
    if (!dk) continue;
    if (best == null || dk < best) best = dk;
  }
  return best;
};

/* ------------------------ break log helpers ------------------------ */
const toMillisFromFirestoreValue = (value) => {
  if (!value) return NaN;

  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();

  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const formatBreakTimestamp = (value, timeZone = "America/Chicago") => {
  const ms = toMillisFromFirestoreValue(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString(undefined, {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
  });
};

const formatBreakTimeOnly = (value, timeZone = "America/Chicago") => {
  const ms = toMillisFromFirestoreValue(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: String(timeZone || "").trim() || "America/Chicago",
  });
};

const formatBreakDurationMinutes = (startValue, endValue) => {
  const startMs = toMillisFromFirestoreValue(startValue);
  const endMs = toMillisFromFirestoreValue(endValue);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return "";
  }

  const mins = Math.max(0, Math.round((endMs - startMs) / 60000));
  return `${mins} minute${mins === 1 ? "" : "s"}`;
};

/* ------------------------ monthly attendance chart helpers ------------------------ */
const ATTENDANCE_BUCKETS = [
  { key: "early", label: "Early", color: "#4b9fea" },
  { key: "onTime", label: "On Time", color: "#66bb6a" },
  { key: "late", label: "Late", color: "#f39c12" },
  { key: "pto", label: "PTO", color: "#8e44ad" },
  { key: "absent", label: "Absent", color: "#e74c3c" },
  { key: "ncns", label: "NCNS", color: "#4b5563" },
];

const ATTENDANCE_SCORE_WEIGHTS = {
  early: 1.2,
  onTime: 1.0,
  late: 0.35,
  pto: 0.75,
  absent: 0.05,
  ncns: 0,
};
const ATTENDANCE_SCORE_BEST_DAY_POINTS = 1.2;
const AGENT_ATTENDANCE_MONTH_ALL = "ALL";
const PAYABLE_MONTH_SELECT_NONE = "";

const SUMMARY_ROWS_PREVIEW = 20;
const AGENT_DONUTS_PREVIEW = 24;

const buildBucketEmployeeTooltip = (label, names) => {
  const list = Array.isArray(names) ? names : [];
  if (list.length === 0) return `${label}\nNo employees in this bucket for the current range.`;
  return `${label}\n${list.join("\n")}`;
};

const normalizeAttendanceStatus = (rawStatus = "") => {
  const s = safeLower(rawStatus).replace(/\s+/g, " ").trim();

  if (!s) return null;

  if (s.includes("early")) return "early";
  if (s === "on time" || s.includes("on-time") || s.includes("ontime")) return "onTime";
  if (s.includes("late")) return "late";
  if (s.includes("pto")) return "pto";
  if (s.includes("absent")) return "absent";
  if (s.includes("ncns")) return "ncns";
  if (s.includes("no call") || s.includes("no-show") || s.includes("no show")) return "ncns";

  return null;
};

const buildAttendanceMonthlyBreakdown = (
  logs = [],
  endDate = "",
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago"
) => {
  const validLogs = Array.isArray(logs)
    ? logs.filter((l) => isValidTs(l) || Number.isFinite(tsMs(pickOutTs(l))))
    : [];
  if (!validLogs.length) {
    return {
      chartData: [],
      total: 0,
      avgPerMonth: 0,
      firstMonth: "",
      lastMonth: "",
    };
  }

  const byDay = buildByDayMap(validLogs, attendanceResetTime, businessTimeZone);
  const sortedDayKeys = Array.from(byDay.keys()).sort((a, b) => a.localeCompare(b));
  const firstDayKey = sortedDayKeys[0];
  const firstMonth = monthKeyFromYmd(firstDayKey);
  const lastMonth = monthKeyFromYmd(endDate || sortedDayKeys[sortedDayKeys.length - 1]);

  const monthKeys = enumerateMonthKeys(firstMonth, lastMonth);
  const monthMap = new Map();

  for (const mk of monthKeys) {
    monthMap.set(mk, {
      monthKey: mk,
      label: prettyMonthLabel(mk),
      early: 0,
      onTime: 0,
      late: 0,
      pto: 0,
      absent: 0,
      ncns: 0,
      total: 0,
    });
  }

  for (const dayKey of sortedDayKeys) {
    const dayLogs = [...(byDay.get(dayKey) || [])].sort((a, b) => {
      const aTs = Number.isFinite(tsMs(pickTs(a))) ? tsMs(pickTs(a)) : tsMs(pickOutTs(a));
      const bTs = Number.isFinite(tsMs(pickTs(b))) ? tsMs(pickTs(b)) : tsMs(pickOutTs(b));
      return aTs - bTs;
    });

    const inLog = dayLogs.find((l) => isIn(l)) || dayLogs[0] || null;
    const rawStatus = pick(inLog || {}, ["status"], "");
    const bucket = normalizeAttendanceStatus(rawStatus);

    if (!bucket) continue;

    const mk = monthKeyFromYmd(dayKey);
    if (!monthMap.has(mk)) {
      monthMap.set(mk, {
        monthKey: mk,
        label: prettyMonthLabel(mk),
        early: 0,
        onTime: 0,
        late: 0,
        pto: 0,
        absent: 0,
        ncns: 0,
        total: 0,
      });
    }

    const row = monthMap.get(mk);
    row[bucket] += 1;
    row.total += 1;
  }

  const chartData = Array.from(monthMap.values());
  const total = chartData.reduce((sum, row) => sum + (row.total || 0), 0);
  const avgPerMonth = chartData.length ? total / chartData.length : 0;

  return {
    chartData,
    total,
    avgPerMonth,
    firstMonth,
    lastMonth,
  };
};

const MonthlyAttendanceTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;

  const row = payload[0]?.payload || {};
  const total = Number(row.total || 0);

  return (
    <div className="dashTooltipCard">
      <div className="dashTooltipTitle">
        {label}
      </div>

      {ATTENDANCE_BUCKETS.map((item) => {
        const value = Number(row[item.key] || 0);
        const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";

        return (
          <div key={item.key} className="dashTooltipRow">
            <div className="dashTooltipLegendItem">
              <span className={`dashTooltipDot dash-tone-${item.key}`} />
              <span>{item.label}</span>
            </div>
            <div className="dashTooltipRowValue">
              {value} ({pct}%)
            </div>
          </div>
        );
      })}

      <div className="dashTooltipTotalRow">
        <span>Total</span>
        <span>{total}</span>
      </div>
    </div>
  );
};

const PayableHoursTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;

  const row = payload[0]?.payload || {};
  return (
    <div className="dashTooltipCard">
      <div className="dashTooltipTitle">
        {label}
      </div>
      <div className="dashTooltipLine">
        Payable Hours: <strong>{formatHoursValue(row.hours)}</strong>
      </div>
      <div className="dashTooltipLine">
        Completed Duties: <strong>{Number(row.completedCount || 0)}</strong>
      </div>
      <div className="dashTooltipHint">
        Counted only from the employee profile start date onward.
      </div>
    </div>
  );
};

export default function Dashboard({
  employees = [],
  loading = false,
  error = "",
  startDate,
  endDate,
  rangeDays = 1,
  logsByUserId = {},
  schedulesByUserId = {},
  nowMs,
  onFetchFullHistory,
  historyByUserId = {},
  loadingHistoryByUserId = {},
  historyErrorByUserId = {},
  breakLogsByUserId = {},
  announcements = [],
  loadingAnnouncements = false,
  announcementsError = "",
  viewerRole = "",
  employeeProfilesByUserId = {},
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago",
}) {
  const [hoursWindow, setHoursWindow] = useState("today");
  const [chartReady, setChartReady] = useState(false);
  const [selectedPerfUserId, setSelectedPerfUserId] = useState("");
  const [payableGraphWindow, setPayableGraphWindow] = useState("week");
  const [payableGraphUserId, setPayableGraphUserId] = useState("ALL");
  const [payableDisplayMode, setPayableDisplayMode] = useState("graph");
  const [payableCustomStartDate, setPayableCustomStartDate] = useState(() =>
    firstDayOfMonthYmd(String(endDate || ""))
  );
  const [payableCustomEndDate, setPayableCustomEndDate] = useState(() => String(endDate || ""));
  const [selectedPayableMonth, setSelectedPayableMonth] = useState(() =>
    monthKeyFromYmd(endDate || "")
  );
  const [selectedAgentAttendanceMonth, setSelectedAgentAttendanceMonth] = useState(() =>
    monthKeyFromYmd(endDate || "")
  );
  const [isPrinting, setIsPrinting] = useState(false);
  const [printChartSize, setPrintChartSize] = useState({ width: 900, height: 330 });
  const [showAllSummaryRows, setShowAllSummaryRows] = useState(false);
  const [showAllAgentRates, setShowAllAgentRates] = useState(false);
  const attendancePieRef = useRef(null);
  const attendanceHoleRef = useRef(null);
  const pieTooltipRef = useRef(null);
  const payableChartWrapRef = useRef(null);
  const agentDonutRefs = useRef(new Map());
  const requestedAllHistoryRef = useRef(new Set());
  const originalDocumentTitleRef = useRef("");
  const breakRangeRequestRef = useRef(0);
  const breakRangeCacheRef = useRef(new Map());
  const [rangeBreakLogsByUserId, setRangeBreakLogsByUserId] = useState({});
  const [loadingRangeBreakLogs, setLoadingRangeBreakLogs] = useState(false);
  const [pieTooltip, setPieTooltip] = useState({
    visible: false,
    left: 0,
    top: 0,
    key: "",
    label: "",
    color: "",
    count: 0,
    names: [],
  });

  const normalizedViewerRole = safeLower(viewerRole);
  const hasViewerPermissions = !!normalizedViewerRole;
  const isVisitorViewer = normalizedViewerRole === "visitor";
  const canViewBreakLog = hasViewerPermissions && !isVisitorViewer;
  const canViewPayablePanel = hasViewerPermissions && !isVisitorViewer;

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setChartReady(true);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const measurePayableChartForPrint = () => {
    const node = payableChartWrapRef.current;
    if (!node) return { width: 900, height: 330 };

    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    const widthRaw = Number(rect?.width || node.offsetWidth || 0);
    const heightRaw = Number(rect?.height || node.offsetHeight || 0);

    const width = Math.max(640, Math.floor(widthRaw || 0));
    const height = Math.max(220, Math.floor(heightRaw || 0));

    setPrintChartSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height }
    );

    return { width, height };
  };

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const restoreDocumentTitle = () => {
      if (typeof document === "undefined") return;
      if (!originalDocumentTitleRef.current) return;
      document.title = originalDocumentTitleRef.current;
      originalDocumentTitleRef.current = "";
    };

    const handleBeforePrint = () => {
      flushSync(() => {
        measurePayableChartForPrint();
        setIsPrinting(true);
      });
    };
    const handleAfterPrint = () => {
      setIsPrinting(false);
      restoreDocumentTitle();
    };

    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("afterprint", handleAfterPrint);

    const mediaQuery =
      typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
    const handleMediaQueryChange = (event) => {
      const matches = !!event?.matches;
      if (matches) {
        flushSync(() => {
          measurePayableChartForPrint();
          setIsPrinting(true);
        });
        return;
      }
      setIsPrinting(false);
      restoreDocumentTitle();
    };

    if (mediaQuery) {
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handleMediaQueryChange);
      } else if (typeof mediaQuery.addListener === "function") {
        mediaQuery.addListener(handleMediaQueryChange);
      }
    }

    return () => {
      window.removeEventListener("beforeprint", handleBeforePrint);
      window.removeEventListener("afterprint", handleAfterPrint);
      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === "function") {
          mediaQuery.removeEventListener("change", handleMediaQueryChange);
        } else if (typeof mediaQuery.removeListener === "function") {
          mediaQuery.removeListener(handleMediaQueryChange);
        }
      }
      restoreDocumentTitle();
    };
  }, []);

  const setHoursWindowAndCollapseLists = (nextWindow) => {
    setHoursWindow(nextWindow);
    setShowAllSummaryRows(false);
    setShowAllAgentRates(false);
  };

  useEffect(() => {
    if (hoursWindow !== "all") {
      requestedAllHistoryRef.current.clear();
    }
  }, [hoursWindow]);

  const validEmployees = useMemo(
    () => (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e)),
    [employees]
  );

  const defaultPayableCustomStartDate = useMemo(() => {
    const currentEnd = String(endDate || "");
    return currentEnd ? firstDayOfMonthYmd(currentEnd) : "";
  }, [endDate]);

  const defaultPayableCustomEndDate = useMemo(() => String(endDate || ""), [endDate]);

  const effectivePayableCustomStartDate = useMemo(() => {
    const current = String(payableCustomStartDate || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(current)
      ? current
      : defaultPayableCustomStartDate;
  }, [payableCustomStartDate, defaultPayableCustomStartDate]);

  const effectivePayableCustomEndDate = useMemo(() => {
    const current = String(payableCustomEndDate || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(current)
      ? current
      : defaultPayableCustomEndDate;
  }, [payableCustomEndDate, defaultPayableCustomEndDate]);

  const availablePayableMonths = useMemo(() => {
    const months = new Set();
    const appendMonth = (monthKey) => {
      if (/^\d{4}-\d{2}$/.test(String(monthKey || ""))) {
        months.add(String(monthKey));
      }
    };

    appendMonth(monthKeyFromYmd(endDate || ""));

    const targetEmployees =
      payableGraphUserId === "ALL"
        ? validEmployees
        : validEmployees.filter((emp) => String(getUserId(emp)) === String(payableGraphUserId));

    for (const emp of targetEmployees) {
      const userId = String(getUserId(emp));
      const rangeLogs = Array.isArray(logsByUserId?.[userId]) ? logsByUserId[userId] : [];
      const historyLogs = Array.isArray(historyByUserId?.[userId]) ? historyByUserId[userId] : [];
      const sourceLogs = historyLogs.length ? historyLogs : rangeLogs;

      for (const log of sourceLogs) {
        const inMs = tsMs(pickTs(log));
        const outMs = tsMs(pickOutTs(log));
        const baseTs = Number.isFinite(inMs) ? inMs : outMs;
        if (!Number.isFinite(baseTs)) continue;

        const dayKey = getBusinessDayKey(baseTs, attendanceResetTime, businessTimeZone);
        appendMonth(monthKeyFromYmd(dayKey));
      }
    }

    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }, [
    payableGraphUserId,
    validEmployees,
    logsByUserId,
    historyByUserId,
    endDate,
    attendanceResetTime,
    businessTimeZone,
  ]);

  const effectiveSelectedPayableMonth = useMemo(() => {
    if (
      /^\d{4}-\d{2}$/.test(String(selectedPayableMonth || "")) &&
      availablePayableMonths.includes(String(selectedPayableMonth))
    ) {
      return String(selectedPayableMonth);
    }
    if (availablePayableMonths.length) return availablePayableMonths[0];
    const fallback = monthKeyFromYmd(endDate || "");
    return /^\d{4}-\d{2}$/.test(fallback) ? fallback : PAYABLE_MONTH_SELECT_NONE;
  }, [availablePayableMonths, selectedPayableMonth, endDate]);

  const payableMonthOptions = useMemo(() => {
    if (availablePayableMonths.length) return availablePayableMonths;
    return /^\d{4}-\d{2}$/.test(effectiveSelectedPayableMonth)
      ? [effectiveSelectedPayableMonth]
      : [];
  }, [availablePayableMonths, effectiveSelectedPayableMonth]);

  const payableYearOptions = useMemo(() => {
    const years = new Set();
    for (const monthKey of payableMonthOptions) {
      const year = String(monthKey || "").slice(0, 4);
      if (/^\d{4}$/.test(year)) years.add(year);
    }
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [payableMonthOptions]);

  const effectiveSelectedPayableYear = useMemo(() => {
    const fromMonth = String(effectiveSelectedPayableMonth || "").slice(0, 4);
    if (/^\d{4}$/.test(fromMonth)) return fromMonth;
    if (payableYearOptions.length) return payableYearOptions[0];

    const fallbackYear = String(endDate || "").slice(0, 4);
    return /^\d{4}$/.test(fallbackYear) ? fallbackYear : "";
  }, [effectiveSelectedPayableMonth, payableYearOptions, endDate]);

  const handlePayableMonthSelect = (monthKey) => {
    const value = String(monthKey || "");
    setSelectedPayableMonth(value);
    if (!/^\d{4}-\d{2}$/.test(value)) return;

    const monthStart = `${value}-01`;
    const activeEndDate = String(endDate || "");
    const activeEndMonth = monthKeyFromYmd(activeEndDate);
    const monthEnd =
      value === activeEndMonth && activeEndDate
        ? activeEndDate
        : lastDayOfMonthYmd(monthStart);

    setPayableCustomStartDate(monthStart);
    setPayableCustomEndDate(monthEnd);
    setPayableGraphWindow("custom");
  };

  const handlePayableYearSelect = (yearValue) => {
    const year = String(yearValue || "");
    if (!/^\d{4}$/.test(year)) return;

    const yearMonths = payableMonthOptions.filter((monthKey) =>
      String(monthKey).startsWith(`${year}-`)
    );

    if (yearMonths.length) {
      handlePayableMonthSelect(yearMonths[0]);
      return;
    }

    handlePayableMonthSelect(`${year}-01`);
  };

  const effectiveSelectedPerfUserId = useMemo(() => {
    if (!validEmployees.length) return "";

    const exists = validEmployees.some(
      (emp) => String(getUserId(emp)) === String(selectedPerfUserId)
    );

    return exists
      ? String(selectedPerfUserId)
      : String(getUserId(validEmployees[0]));
  }, [validEmployees, selectedPerfUserId]);

  useEffect(() => {
    if (!onFetchFullHistory || !effectiveSelectedPerfUserId) return;

    const uid = String(effectiveSelectedPerfUserId);
    const alreadyHave = Array.isArray(historyByUserId?.[uid]) && historyByUserId[uid].length > 0;
    const isLoading = !!loadingHistoryByUserId?.[uid];

    if (!alreadyHave && !isLoading) {
      onFetchFullHistory(uid);
    }
  }, [effectiveSelectedPerfUserId, onFetchFullHistory, historyByUserId, loadingHistoryByUserId]);

  const dashPeriod = useMemo(() => {
    const periodEnd = String(endDate || "");
    if (!periodEnd) {
      return {
        label: "-",
        start: "",
        end: "",
        dayKeys: [],
        isAll: false,
        isMonthly: false,
        monthKeys: [],
        note: "",
      };
    }

    if (hoursWindow === "today") {
      const keys = enumerateYmdRange(periodEnd, periodEnd);
      return {
        label: "Today",
        start: periodEnd,
        end: periodEnd,
        dayKeys: keys,
        isAll: false,
        isMonthly: false,
        monthKeys: [],
        note: "",
      };
    }

    if (hoursWindow === "yesterday") {
      const yesterday = addDaysYmd(periodEnd, -1);
      const keys = enumerateYmdRange(yesterday, yesterday);
      return {
        label: "Yesterday",
        start: yesterday,
        end: yesterday,
        dayKeys: keys,
        isAll: false,
        isMonthly: false,
        monthKeys: [],
        note: "",
      };
    }

    if (hoursWindow === "15") {
      const w = cutoffWindowFor15D(periodEnd);
      const keys = w.start && w.end ? enumerateYmdRange(w.start, w.end) : [];
      return {
        label: "Cutoff (15D)",
        start: w.start,
        end: w.end,
        dayKeys: keys,
        isAll: false,
        isMonthly: false,
        monthKeys: [],
        note: "",
      };
    }

    if (hoursWindow === "30") {
      const start = addDaysYmd(periodEnd, -29);
      const keys = enumerateYmdRange(start, periodEnd);
      return {
        label: "Last 30 days",
        start,
        end: periodEnd,
        dayKeys: keys,
        isAll: false,
        isMonthly: false,
        monthKeys: [],
        note: "",
      };
    }

    let minDay = null;
    let minProfileStart = null;
    const list = Array.isArray(employees) ? employees : [];
    for (const emp of list) {
      const uid = getUserId(emp);
      if (!uid) continue;
      const key = String(uid);

      const profileStart = getEmployeeStartDateYmd(employeeProfilesByUserId, key);
      if (profileStart && (minProfileStart == null || profileStart < minProfileStart)) {
        minProfileStart = profileStart;
      }

      const hist = Array.isArray(historyByUserId?.[key]) ? historyByUserId[key] : [];
      const rangeLogs = Array.isArray(logsByUserId?.[key]) ? logsByUserId[key] : [];
      const logsForStart = hist.length ? hist : rangeLogs;
      const m = minDayKeyFromLogs(logsForStart, attendanceResetTime, businessTimeZone);
      if (m && (minDay == null || m < minDay)) minDay = m;
    }

    const start = minDay || minProfileStart || String(startDate || periodEnd);
    const allKeys = enumerateYmdRange(start, periodEnd);

    return {
      label: "All time",
      start,
      end: periodEnd,
      dayKeys: allKeys,
      isAll: true,
      isMonthly: false,
      monthKeys: [],
      note: "",
    };
  }, [
    hoursWindow,
    endDate,
    employees,
    historyByUserId,
    logsByUserId,
    employeeProfilesByUserId,
    startDate,
    attendanceResetTime,
    businessTimeZone,
  ]);

  useEffect(() => {
    let active = true;
    const defer =
      typeof queueMicrotask === "function"
        ? queueMicrotask
        : (fn) => Promise.resolve().then(fn);
    const scheduleState = (callback) => {
      defer(() => {
        if (!active) return;
        callback();
      });
    };
    const clearRangeBreakLogs = () => {
      scheduleState(() => {
        setRangeBreakLogsByUserId({});
        setLoadingRangeBreakLogs(false);
      });
    };

    if (!canViewBreakLog) {
      clearRangeBreakLogs();
      return () => {
        active = false;
      };
    }

    if (hoursWindow === "today") {
      clearRangeBreakLogs();
      return () => {
        active = false;
      };
    }

    if (!dashPeriod.start || !dashPeriod.end) {
      clearRangeBreakLogs();
      return () => {
        active = false;
      };
    }

    const userIds = validEmployees
      .map((emp) => String(getUserId(emp) || "").trim())
      .filter(Boolean)
      .sort();

    if (!userIds.length) {
      clearRangeBreakLogs();
      return () => {
        active = false;
      };
    }

    const cacheKey = [
      hoursWindow,
      dashPeriod.start,
      dashPeriod.end,
      attendanceResetTime,
      businessTimeZone,
      userIds.join(","),
    ].join("|");
    const cached = breakRangeCacheRef.current.get(cacheKey);
    if (cached) {
      scheduleState(() => {
        setRangeBreakLogsByUserId(cached);
        setLoadingRangeBreakLogs(false);
      });
      return () => {
        active = false;
      };
    }

    breakRangeRequestRef.current += 1;
    const requestId = breakRangeRequestRef.current;
    scheduleState(() => {
      setLoadingRangeBreakLogs(true);
    });

    getBreakLogsByUserIdsInRange(userIds, {
      startDayKey: dashPeriod.start,
      endDayKey: dashPeriod.end,
      attendanceResetTime,
      businessTimeZone,
    })
      .then((rows) => {
        if (!active || requestId !== breakRangeRequestRef.current) return;
        const safeRows = rows && typeof rows === "object" ? rows : {};
        breakRangeCacheRef.current.set(cacheKey, safeRows);
        setRangeBreakLogsByUserId(safeRows);
      })
      .catch((err) => {
        if (!active || requestId !== breakRangeRequestRef.current) return;
        console.error("Failed to load break logs for dashboard range:", err);
        setRangeBreakLogsByUserId({});
      })
      .finally(() => {
        if (active && requestId === breakRangeRequestRef.current) {
          setLoadingRangeBreakLogs(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    canViewBreakLog,
    hoursWindow,
    dashPeriod.start,
    dashPeriod.end,
    validEmployees,
    attendanceResetTime,
    businessTimeZone,
  ]);

  useEffect(() => {
    if (!onFetchFullHistory) return;

    const needDays =
      hoursWindow === "today"
        ? 1
        : hoursWindow === "yesterday"
          ? 2
        : hoursWindow === "15"
          ? 16
          : hoursWindow === "30"
            ? 30
            : Infinity;

    const needHistory = hoursWindow === "all" || Number(rangeDays) < needDays;
    if (!needHistory) return;

    const list = Array.isArray(employees) ? employees : [];
    for (const emp of list) {
      const uid = getUserId(emp);
      if (!uid) continue;

      const key = String(uid);
      const isLoading = !!loadingHistoryByUserId?.[key];
      if (hoursWindow === "all") {
        if (!requestedAllHistoryRef.current.has(key) && !isLoading) {
          requestedAllHistoryRef.current.add(key);
          onFetchFullHistory(key);
        }
        continue;
      }

      const alreadyHave = Array.isArray(historyByUserId?.[key]) && historyByUserId[key].length > 0;
      if (!alreadyHave && !isLoading) onFetchFullHistory(key);
    }
  }, [hoursWindow, rangeDays, onFetchFullHistory, employees, historyByUserId, loadingHistoryByUserId]);

  useEffect(() => {
    if (!onFetchFullHistory || !validEmployees.length) return;

    const customRange = normalizeYmdRange(
      effectivePayableCustomStartDate,
      effectivePayableCustomEndDate,
      String(endDate || "")
    );
    const customNeedDays = Math.max(1, countInclusiveDaysInYmdRange(customRange.start, customRange.end));
    const needDays =
      payableGraphWindow === "day"
        ? 1
        : payableGraphWindow === "week"
          ? 7
          : payableGraphWindow === "15"
            ? 16
            : payableGraphWindow === "month"
              ? 31
              : payableGraphWindow === "custom"
                ? customNeedDays
              : Infinity;

    const customNeedsOlderHistory =
      payableGraphWindow === "custom" &&
      customRange.start &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(startDate || "")) &&
      customRange.start < String(startDate);
    const needHistory =
      payableGraphWindow === "all" ||
      customNeedsOlderHistory ||
      Number(rangeDays) < needDays;
    if (!needHistory) return;

    const targetEmployees =
      payableGraphUserId === "ALL"
        ? validEmployees
        : validEmployees.filter((emp) => String(getUserId(emp)) === String(payableGraphUserId));

    for (const emp of targetEmployees) {
      const uid = String(getUserId(emp));
      const alreadyHave = Array.isArray(historyByUserId?.[uid]) && historyByUserId[uid].length > 0;
      const isLoading = !!loadingHistoryByUserId?.[uid];
      if (!alreadyHave && !isLoading) onFetchFullHistory(uid);
    }
  }, [
    payableGraphWindow,
    payableGraphUserId,
    validEmployees,
    historyByUserId,
    loadingHistoryByUserId,
    onFetchFullHistory,
    rangeDays,
    startDate,
    endDate,
    effectivePayableCustomStartDate,
    effectivePayableCustomEndDate,
  ]);

  const attendanceContextByUserId = useMemo(() => {
    const ctx = {};

    for (const emp of validEmployees) {
      const userId = String(getUserId(emp));
      const name = getDisplayName(emp);

      const rangeLogs = Array.isArray(logsByUserId?.[userId]) ? logsByUserId[userId] : [];
      const histLogs = Array.isArray(historyByUserId?.[userId]) ? historyByUserId[userId] : [];
      const logsForAttendance = mergeAttendanceLogs(rangeLogs, histLogs);
      const byDay = buildByDayMap(logsForAttendance, attendanceResetTime, businessTimeZone);

      ctx[userId] = {
        userId,
        name,
        byDay,
        monthBucketByMonth: buildMonthlyAttendanceBucketMap(byDay),
        firstDayKey: minDayKeyFromLogs(logsForAttendance, attendanceResetTime, businessTimeZone),
      };
    }

    return ctx;
  }, [validEmployees, logsByUserId, historyByUserId, attendanceResetTime, businessTimeZone]);

  const dashStatusNowMs = useMemo(() => {
    const todayKey = String(endDate || "");
    return dashPeriod.dayKeys.includes(todayKey) ? nowMs : 0;
  }, [dashPeriod.dayKeys, endDate, nowMs]);

  const data = useMemo(() => {
    const validEmployeesInner = validEmployees;
    const visibleDayKeys = dashPeriod.dayKeys.length ? dashPeriod.dayKeys : [String(endDate || "")].filter(Boolean);

    const rows = [];

    for (const emp of validEmployeesInner) {
      const userId = String(getUserId(emp));
      const context = attendanceContextByUserId[userId] || null;
      const name = context?.name || getDisplayName(emp);
      const byDay = context?.byDay || new Map();

      for (const dayKey of visibleDayKeys) {
        const dayLogs = byDay.get(dayKey) || [];
        const status = resolveDailyStatus({
          userId,
          dayKey,
          dayLogs,
          schedulesByUserId,
          nowMs: dashStatusNowMs,
          endDate,
          businessTimeZone,
        });
        rows.push({ userId, name, dayKey, status });
      }
    }

    const counts = {
      total: rows.length,
      completed: 0,
      live: 0,
      noShow: 0,
      scheduled: 0,
      dayOff: 0,
      noSchedule: 0,
      noLog: 0,
    };

    for (const r of rows) {
      const s = safeLower(r.status);
      if (s === "completed") counts.completed += 1;
      else if (s === "live" || s === "on break") counts.live += 1;
      else if (s === "no show") counts.noShow += 1;
      else if (s === "scheduled") counts.scheduled += 1;
      else if (s === "day off") counts.dayOff += 1;
      else if (s === "no schedule") counts.noSchedule += 1;
      else counts.noLog += 1;
    }

    return { validEmployees: validEmployeesInner, rows, counts, visibleDayKeys };
  }, [
    validEmployees,
    attendanceContextByUserId,
    schedulesByUserId,
    dashStatusNowMs,
    endDate,
    dashPeriod.dayKeys,
    businessTimeZone,
  ]);

  const availableAgentAttendanceMonths = useMemo(() => {
    const months = new Set();
    const endMonth = monthKeyFromYmd(endDate || "");
    if (/^\d{4}-\d{2}$/.test(endMonth)) months.add(endMonth);

    for (const emp of data.validEmployees) {
      const userId = String(getUserId(emp));
      const context = attendanceContextByUserId[userId] || null;
      const byDay = context?.byDay;
      if (!byDay || typeof byDay.keys !== "function") continue;

      for (const dayKey of byDay.keys()) {
        const monthKey = monthKeyFromYmd(dayKey);
        if (/^\d{4}-\d{2}$/.test(monthKey)) months.add(monthKey);
      }
    }

    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }, [data.validEmployees, attendanceContextByUserId, endDate]);

  const effectiveSelectedAgentAttendanceMonth = useMemo(() => {
    if (selectedAgentAttendanceMonth === AGENT_ATTENDANCE_MONTH_ALL) {
      return AGENT_ATTENDANCE_MONTH_ALL;
    }
    if (availableAgentAttendanceMonths.includes(selectedAgentAttendanceMonth)) {
      return selectedAgentAttendanceMonth;
    }
    if (!availableAgentAttendanceMonths.length) return AGENT_ATTENDANCE_MONTH_ALL;
    return availableAgentAttendanceMonths[0];
  }, [availableAgentAttendanceMonths, selectedAgentAttendanceMonth]);

  const agentAttendanceDayKeys = useMemo(() => {
    if (effectiveSelectedAgentAttendanceMonth === AGENT_ATTENDANCE_MONTH_ALL) {
      if (!availableAgentAttendanceMonths.length) return [];

      const newestMonth = availableAgentAttendanceMonths[0];
      const oldestMonth = availableAgentAttendanceMonths[availableAgentAttendanceMonths.length - 1];
      const start = `${oldestMonth}-01`;
      const endMonth = monthKeyFromYmd(endDate || "");
      const end =
        endMonth === newestMonth && endDate
          ? String(endDate)
          : lastDayOfMonthYmd(`${newestMonth}-01`);

      return enumerateYmdRange(start, end);
    }

    if (!/^\d{4}-\d{2}$/.test(effectiveSelectedAgentAttendanceMonth)) return [];

    const start = `${effectiveSelectedAgentAttendanceMonth}-01`;
    const endMonth = monthKeyFromYmd(endDate || "");
    const end =
      endMonth === effectiveSelectedAgentAttendanceMonth && endDate
        ? String(endDate)
        : lastDayOfMonthYmd(start);

    return enumerateYmdRange(start, end);
  }, [effectiveSelectedAgentAttendanceMonth, endDate, availableAgentAttendanceMonths]);

  const attendanceBreakdown = useMemo(() => {
    const counts = {
      early: 0,
      onTime: 0,
      late: 0,
      pto: 0,
      absent: 0,
      ncns: 0,
    };
    const employeeSetsByBucket = ATTENDANCE_BUCKETS.reduce((acc, item) => {
      acc[item.key] = new Set();
      return acc;
    }, {});

    let eligibleDays = 0;
    const isMonthlyAllWindow = !!dashPeriod.isMonthly;
    const monthKeysForWindow = Array.isArray(dashPeriod.monthKeys) ? dashPeriod.monthKeys : [];

    for (const emp of data.validEmployees) {
      const userId = String(getUserId(emp));
      const context = attendanceContextByUserId[userId] || null;
      const employeeName = context?.name || getDisplayName(emp);
      const firstDayKey = context?.firstDayKey || "";
      if (!firstDayKey) continue;

      if (isMonthlyAllWindow) {
        const monthBucketByMonth = context?.monthBucketByMonth || new Map();

        for (const monthKey of monthKeysForWindow) {
          if (`${monthKey}-01` < firstDayKey) continue;

          eligibleDays += 1;

          const bucket = monthBucketByMonth.get(monthKey);
          if (!bucket) continue;

          counts[bucket] += 1;
          employeeSetsByBucket[bucket].add(employeeName);
        }
      } else {
        const byDay = context?.byDay || new Map();

        for (const dayKey of dashPeriod.dayKeys) {
          if (dayKey < firstDayKey) continue;

          eligibleDays += 1;

          const dayLogs = byDay.get(dayKey) || [];
          if (!dayLogs.length) continue;

          const primaryLog = pickPrimaryAttendanceLog(dayLogs);
          const bucket = normalizeAttendanceStatus(pick(primaryLog || {}, ["status"], ""));

          if (bucket) {
            counts[bucket] += 1;
            employeeSetsByBucket[bucket].add(employeeName);
          }
        }
      }
    }

    const total = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
    const employeesByBucket = ATTENDANCE_BUCKETS.reduce((acc, item) => {
      const names = Array.from(employeeSetsByBucket[item.key] || []);
      acc[item.key] = names.sort((a, b) => a.localeCompare(b));
      return acc;
    }, {});

    return { counts, total, eligibleDays, employeesByBucket };
  }, [
    data.validEmployees,
    attendanceContextByUserId,
    dashPeriod.isMonthly,
    dashPeriod.monthKeys,
    dashPeriod.dayKeys,
  ]);

  const attendanceSlices = useMemo(() => {
    const safeTotal = Number(attendanceBreakdown.total || 0);
    const values = ATTENDANCE_BUCKETS.map((item) =>
      Number(attendanceBreakdown.counts[item.key] || 0)
    );

    return ATTENDANCE_BUCKETS.map((item, idx) => {
      const value = values[idx];
      const cumulativeBefore = values.slice(0, idx).reduce((sum, n) => sum + n, 0);
      const cumulativeAfter = cumulativeBefore + value;

      const startDeg = safeTotal > 0 ? (cumulativeBefore / safeTotal) * 360 : 0;
      const endDeg = safeTotal > 0 ? (cumulativeAfter / safeTotal) * 360 : 0;

      return {
        key: item.key,
        label: item.label,
        color: item.color,
        value,
        startDeg,
        endDeg,
        names: attendanceBreakdown.employeesByBucket?.[item.key] || [],
      };
    });
  }, [attendanceBreakdown]);

  const pieBackground = useMemo(() => {
    const slices = attendanceSlices.map((slice) => ({
      label: slice.label,
      value: slice.value,
      color: slice.color,
    }));

    return buildPieConicGradient(slices, attendanceBreakdown.total);
  }, [attendanceSlices, attendanceBreakdown.total]);

  const legend = useMemo(
    () =>
      ATTENDANCE_BUCKETS.map((item) => ({
        key: item.key,
        label: item.label,
        value: attendanceBreakdown.counts[item.key],
        color: item.color,
      })),
    [attendanceBreakdown]
  );
  const attendanceSummaryRowCount = useMemo(() => {
    const lengths = legend.map(
      (item) => (attendanceBreakdown.employeesByBucket?.[item.key] || []).length
    );
    return Math.max(1, ...lengths);
  }, [legend, attendanceBreakdown.employeesByBucket]);
  const attendanceSummaryRowsVisible = showAllSummaryRows
    ? attendanceSummaryRowCount
    : Math.min(attendanceSummaryRowCount, SUMMARY_ROWS_PREVIEW);
  const hiddenSummaryRows = Math.max(0, attendanceSummaryRowCount - attendanceSummaryRowsVisible);

  const agentAttendanceRates = useMemo(() => {
    const rows = [];

    for (const emp of data.validEmployees) {
      const userId = String(getUserId(emp));
      const context = attendanceContextByUserId[userId] || null;
      const name = context?.name || getDisplayName(emp);
      const firstDayKey = context?.firstDayKey || "";
      const counts = ATTENDANCE_BUCKETS.reduce((acc, item) => {
        acc[item.key] = 0;
        return acc;
      }, {});

      const eligibleDayKeys = firstDayKey
        ? agentAttendanceDayKeys.filter((dayKey) => dayKey >= firstDayKey)
        : [...agentAttendanceDayKeys];

      const byDay = context?.byDay || new Map();

      for (const dayKey of eligibleDayKeys) {
        const dayLogs = byDay.get(dayKey) || [];
        if (!dayLogs.length) continue;

        const primaryLog = pickPrimaryAttendanceLog(dayLogs);
        const bucket = normalizeAttendanceStatus(pick(primaryLog || {}, ["status"], ""));
        if (bucket && counts[bucket] !== undefined) counts[bucket] += 1;
      }

      const totalCounted = ATTENDANCE_BUCKETS.reduce(
        (sum, item) => sum + Number(counts[item.key] || 0),
        0
      );
      const totalDays = eligibleDayKeys.length;
      const weightedScorePoints =
        Number(counts.early || 0) * ATTENDANCE_SCORE_WEIGHTS.early +
        Number(counts.onTime || 0) * ATTENDANCE_SCORE_WEIGHTS.onTime +
        Number(counts.late || 0) * ATTENDANCE_SCORE_WEIGHTS.late +
        Number(counts.pto || 0) * ATTENDANCE_SCORE_WEIGHTS.pto +
        Number(counts.absent || 0) * ATTENDANCE_SCORE_WEIGHTS.absent +
        Number(counts.ncns || 0) * ATTENDANCE_SCORE_WEIGHTS.ncns;
      const rate =
        totalCounted > 0
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round(
                  (weightedScorePoints /
                    (totalCounted * ATTENDANCE_SCORE_BEST_DAY_POINTS)) *
                    100
                )
              )
            )
          : 0;
      const pieBackground = buildPieConicGradient(
        ATTENDANCE_BUCKETS.map((item) => ({
          label: item.label,
          value: Number(counts[item.key] || 0),
          color: item.color,
        })),
        totalCounted
      );
      const tooltipSummary = ATTENDANCE_BUCKETS.map(
        (item) => `${item.label}: ${Number(counts[item.key] || 0)}`
      ).join(" | ");

      rows.push({
        userId,
        name,
        shortName: shortAgentLabel(name),
        rate,
        totalDays,
        counts,
        totalCounted,
        pieBackground,
        tooltipSummary: `${tooltipSummary} | Score model: Early/On Time up, Late/Absent/NCNS down`,
      });
    }

    return rows.sort((a, b) => {
      if (b.rate !== a.rate) return b.rate - a.rate;
      if (Number(b.counts.early || 0) !== Number(a.counts.early || 0)) {
        return Number(b.counts.early || 0) - Number(a.counts.early || 0);
      }
      if (Number(b.counts.onTime || 0) !== Number(a.counts.onTime || 0)) {
        return Number(b.counts.onTime || 0) - Number(a.counts.onTime || 0);
      }
      if (Number(a.counts.late || 0) !== Number(b.counts.late || 0)) {
        return Number(a.counts.late || 0) - Number(b.counts.late || 0);
      }
      if (Number(a.counts.absent || 0) !== Number(b.counts.absent || 0)) {
        return Number(a.counts.absent || 0) - Number(b.counts.absent || 0);
      }
      if (Number(a.counts.ncns || 0) !== Number(b.counts.ncns || 0)) {
        return Number(a.counts.ncns || 0) - Number(b.counts.ncns || 0);
      }
      return a.name.localeCompare(b.name);
    });
  }, [
    data.validEmployees,
    attendanceContextByUserId,
    agentAttendanceDayKeys,
  ]);
  const visibleAgentAttendanceRates = showAllAgentRates
    ? agentAttendanceRates
    : agentAttendanceRates.slice(0, AGENT_DONUTS_PREVIEW);
  const hiddenAgentAttendanceRates = Math.max(
    0,
    agentAttendanceRates.length - visibleAgentAttendanceRates.length
  );
  const agentAttendanceEmptyText =
    effectiveSelectedAgentAttendanceMonth === AGENT_ATTENDANCE_MONTH_ALL
      ? "No agent data for all months."
      : "No agent data for this month.";

  useEffect(() => {
    if (attendancePieRef.current) {
      attendancePieRef.current.style.background = pieBackground;
    }
  }, [pieBackground]);

  useEffect(() => {
    for (const agent of visibleAgentAttendanceRates) {
      const node = agentDonutRefs.current.get(agent.userId);
      if (!node) continue;
      node.style.background = agent.pieBackground;
    }
  }, [visibleAgentAttendanceRates]);

  useEffect(() => {
    if (!pieTooltip.visible || !pieTooltipRef.current) return;
    pieTooltipRef.current.style.left = `${pieTooltip.left}px`;
    pieTooltipRef.current.style.top = `${pieTooltip.top}px`;
  }, [pieTooltip.visible, pieTooltip.left, pieTooltip.top]);

  const registerAgentDonutRef = (userId) => (node) => {
    if (!node) {
      agentDonutRefs.current.delete(userId);
      return;
    }
    agentDonutRefs.current.set(userId, node);
  };

  const hidePieTooltip = () => {
    setPieTooltip((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  };

  const handleAttendancePieMouseMove = (event) => {
    if (attendanceBreakdown.total <= 0 || !attendancePieRef.current) {
      hidePieTooltip();
      return;
    }

    const pieRect = attendancePieRef.current.getBoundingClientRect();
    const cx = pieRect.width / 2;
    const cy = pieRect.height / 2;
    const x = event.clientX - pieRect.left;
    const y = event.clientY - pieRect.top;
    const dx = x - cx;
    const dy = y - cy;

    const distance = Math.hypot(dx, dy);
    const outerRadius = Math.min(pieRect.width, pieRect.height) / 2;

    const holeRect = attendanceHoleRef.current?.getBoundingClientRect?.();
    const innerRadius = holeRect
      ? Math.min(holeRect.width, holeRect.height) / 2
      : outerRadius * 0.58;

    if (distance < innerRadius || distance > outerRadius) {
      hidePieTooltip();
      return;
    }

    const angleFromTopClockwise = (Math.atan2(dy, dx) * 180) / Math.PI;
    const normalizedAngle = (angleFromTopClockwise + 450) % 360;

    let activeSlice =
      attendanceSlices.find(
        (slice) =>
          slice.value > 0 &&
          normalizedAngle >= slice.startDeg &&
          normalizedAngle < slice.endDeg
      ) || null;

    if (!activeSlice) {
      const nonZero = attendanceSlices.filter((slice) => slice.value > 0);
      const lastSlice = nonZero.length ? nonZero[nonZero.length - 1] : null;
      if (lastSlice && normalizedAngle >= lastSlice.startDeg && normalizedAngle <= 360) {
        activeSlice = lastSlice;
      }
    }

    if (!activeSlice) {
      hidePieTooltip();
      return;
    }

    const tooltipWidth = 300;
    const tooltipHeight = 160;
    let left = event.clientX + 14;
    let top = event.clientY + 14;

    if (left + tooltipWidth > window.innerWidth) {
      left = Math.max(12, event.clientX - tooltipWidth - 14);
    }
    if (top + tooltipHeight > window.innerHeight) {
      top = Math.max(12, event.clientY - tooltipHeight - 14);
    }

    setPieTooltip({
      visible: true,
      left,
      top,
      key: activeSlice.key,
      label: activeSlice.label,
      color: activeSlice.color,
      count: activeSlice.value,
      names: activeSlice.names,
    });
  };

  const rangeLabel =
    dashPeriod.isAll && dashPeriod.note
      ? `${dashPeriod.start} -> ${dashPeriod.end}  |  ${dashPeriod.note}`
      : dashPeriod.start && dashPeriod.end
        ? `${dashPeriod.start} -> ${dashPeriod.end}`
        : Number(rangeDays) === 1
          ? String(endDate || "")
          : `${String(startDate || "")} -> ${String(endDate || "")}`;

  const payableGraphPeriod = useMemo(() => {
    const end = String(endDate || "");
    if (!end) return { label: "-", start: "", end: "", dayKeys: [], isMonthly: false, monthKeys: [] };

    if (payableGraphWindow === "day") {
      return {
        label: "Today",
        start: end,
        end,
        dayKeys: [end],
        isMonthly: false,
        monthKeys: [],
      };
    }

    if (payableGraphWindow === "week") {
      const start = startOfWeekYmd(end);
      return {
        label: "This Week",
        start,
        end,
        dayKeys: enumerateYmdRange(start, end),
        isMonthly: false,
        monthKeys: [],
      };
    }

    if (payableGraphWindow === "15") {
      const cutoff = cutoffWindowFor15D(end);
      return {
        label: "Cutoff (15D)",
        start: cutoff.start,
        end: cutoff.end,
        dayKeys: cutoff.start && cutoff.end ? enumerateYmdRange(cutoff.start, cutoff.end) : [],
        isMonthly: false,
        monthKeys: [],
      };
    }

    if (payableGraphWindow === "month") {
      const monthKey =
        /^\d{4}-\d{2}$/.test(String(effectiveSelectedPayableMonth || ""))
          ? String(effectiveSelectedPayableMonth)
          : monthKeyFromYmd(end);
      const start = `${monthKey}-01`;
      const monthEnd =
        monthKey === monthKeyFromYmd(end) ? end : lastDayOfMonthYmd(start);
      return {
        label: `Month (${prettyMonthLabel(monthKey)})`,
        start,
        end: monthEnd,
        dayKeys: enumerateYmdRange(start, monthEnd),
        isMonthly: false,
        monthKeys: [],
      };
    }

    if (payableGraphWindow === "custom") {
      const customRange = normalizeYmdRange(
        effectivePayableCustomStartDate,
        effectivePayableCustomEndDate,
        end
      );
      return {
        label: "Custom Range",
        start: customRange.start,
        end: customRange.end,
        dayKeys:
          customRange.start && customRange.end
            ? enumerateYmdRange(customRange.start, customRange.end)
            : [],
        isMonthly: false,
        monthKeys: [],
      };
    }

    let minDay = null;
    const targetEmployees =
      payableGraphUserId === "ALL"
        ? validEmployees
        : validEmployees.filter((emp) => String(getUserId(emp)) === String(payableGraphUserId));

    for (const emp of targetEmployees) {
      const uid = String(getUserId(emp));
      const histLogs = Array.isArray(historyByUserId?.[uid]) ? historyByUserId[uid] : [];
      const rangeLogs = Array.isArray(logsByUserId?.[uid]) ? logsByUserId[uid] : [];
      const allLogs = histLogs.length ? histLogs : rangeLogs;
      const m = minDayKeyFromLogs(allLogs, attendanceResetTime, businessTimeZone);
      if (m && (minDay == null || m < minDay)) minDay = m;
    }

    const start = minDay || String(startDate || end);
    const allKeys = enumerateYmdRange(start, end);

    return {
      label: "All",
      start,
      end,
      dayKeys: allKeys,
      isMonthly: false,
      monthKeys: [],
    };
  }, [
    payableGraphWindow,
    payableGraphUserId,
    endDate,
    effectiveSelectedPayableMonth,
    effectivePayableCustomStartDate,
    effectivePayableCustomEndDate,
    validEmployees,
    historyByUserId,
    logsByUserId,
    startDate,
    attendanceResetTime,
    businessTimeZone,
  ]);

  const payableNowMs = useMemo(() => {
    const todayKey = String(endDate || "");
    if (payableGraphPeriod.isMonthly) {
      return payableGraphPeriod.start <= todayKey && todayKey <= payableGraphPeriod.end ? nowMs : 0;
    }
    return payableGraphPeriod.dayKeys.includes(todayKey) ? nowMs : 0;
  }, [payableGraphPeriod.isMonthly, payableGraphPeriod.start, payableGraphPeriod.end, payableGraphPeriod.dayKeys, endDate, nowMs]);

  const payableHoursChart = useMemo(() => {
    const targetEmployees =
      payableGraphUserId === "ALL"
        ? validEmployees
        : validEmployees.filter((emp) => String(getUserId(emp)) === String(payableGraphUserId));

    const employeeContexts = targetEmployees.map((emp) => {
      const userId = String(getUserId(emp));
      const employeeStartDateYmd = getEmployeeStartDateYmd(employeeProfilesByUserId, userId);
      const rangeLogs = Array.isArray(logsByUserId?.[userId]) ? logsByUserId[userId] : [];
      const histLogs = Array.isArray(historyByUserId?.[userId]) ? historyByUserId[userId] : [];
      const logsForHours = histLogs.length ? histLogs : rangeLogs;

      return {
        userId,
        employeeName: getDisplayName(emp),
        employeeStartDateYmd,
        byDay: buildByDayMap(logsForHours, attendanceResetTime, businessTimeZone),
      };
    });

    const computeDayTotals = (dayKey) => {
      let totalMinutes = 0;
      let completedCount = 0;
      const detailRows = [];

      for (const ctx of employeeContexts) {
        if (ctx.employeeStartDateYmd && String(dayKey) < String(ctx.employeeStartDateYmd)) {
          continue;
        }

        const dayLogs = ctx.byDay.get(dayKey) || [];
        if (!dayLogs.length) continue;

        const payableMinutes = computePayableMinutesForDay({
          dayLogs,
          userId: ctx.userId,
          dayKey,
          schedulesByUserId,
          nowMs: payableNowMs,
          endDate,
          businessTimeZone,
        });

        if (Number.isFinite(payableMinutes) && payableMinutes > 0) {
          totalMinutes += payableMinutes;
          completedCount += 1;
          detailRows.push({
            dayKey,
            dayShort: shortWeekdayLabelFromYmd(dayKey),
            attendanceNote: getAttendanceNotesFromDayLogs(dayLogs),
            userId: ctx.userId,
            employeeName: ctx.employeeName,
            hours: payableMinutes / 60,
          });
        }
      }

      return { totalMinutes, completedCount, detailRows };
    };

    const sortPrintRows = (rows = []) =>
      [...rows].sort(
        (a, b) =>
          String(a.dayKey || "").localeCompare(String(b.dayKey || "")) ||
          String(a.employeeName || "").localeCompare(String(b.employeeName || ""))
      );

    if (payableGraphPeriod.isMonthly) {
      const endMonthKey = monthKeyFromYmd(payableGraphPeriod.end);
      const monthPrintRows = [];

      const monthRows = payableGraphPeriod.monthKeys.map((monthKey) => {
        const monthStart = `${monthKey}-01`;
        const monthEnd =
          monthKey === endMonthKey ? payableGraphPeriod.end : lastDayOfMonthYmd(monthStart);
        const monthDays = enumerateYmdRange(monthStart, monthEnd);

        let totalMinutes = 0;
        let completedCount = 0;

        for (const dayKey of monthDays) {
          const dayTotals = computeDayTotals(dayKey);
          totalMinutes += dayTotals.totalMinutes;
          completedCount += dayTotals.completedCount;
          if (dayTotals.detailRows.length) {
            monthPrintRows.push(
              ...dayTotals.detailRows.map((detailRow) => ({
                ...detailRow,
                monthKey,
              }))
            );
          }
        }

        return {
          dayKey: monthKey,
          monthKey,
          label: prettyMonthLabel(monthKey),
          hours: totalMinutes / 60,
          completedCount,
        };
      });

      const filteredRowsForDisplay =
        payableGraphUserId === "ALL"
          ? monthRows.filter(
              (row) => Number(row.hours || 0) > 0 || Number(row.completedCount || 0) > 0
            )
          : (() => {
              const employeeStartDateYmd = getEmployeeStartDateYmd(
                employeeProfilesByUserId,
                payableGraphUserId
              );
              const startMonthKey = monthKeyFromYmd(employeeStartDateYmd);
              return startMonthKey
                ? monthRows.filter((row) => row.monthKey >= startMonthKey)
                : monthRows;
            })();

      const totalHours = filteredRowsForDisplay.reduce(
        (sum, row) => sum + Number(row.hours || 0),
        0
      );
      const totalCompleted = filteredRowsForDisplay.reduce(
        (sum, row) => sum + Number(row.completedCount || 0),
        0
      );

      return {
        rows: filteredRowsForDisplay,
        printRows: sortPrintRows(monthPrintRows),
        totalHours,
        totalCompleted,
        label: payableGraphPeriod.label,
        start: filteredRowsForDisplay.length
          ? filteredRowsForDisplay[0].label
          : prettyMonthLabel(monthKeyFromYmd(payableGraphPeriod.start)),
        end: filteredRowsForDisplay.length
          ? filteredRowsForDisplay[filteredRowsForDisplay.length - 1].label
          : prettyMonthLabel(monthKeyFromYmd(payableGraphPeriod.end)),
      };
    }

    const dayPrintRows = [];
    const dayRows = payableGraphPeriod.dayKeys.map((dayKey) => {
      const dayTotals = computeDayTotals(dayKey);
      if (dayTotals.detailRows.length) {
        dayPrintRows.push(...dayTotals.detailRows);
      }

      return {
        dayKey,
        label: prettyDayLabel(dayKey),
        hours: dayTotals.totalMinutes / 60,
        completedCount: dayTotals.completedCount,
      };
    });

    const filteredRowsForDisplay =
      payableGraphUserId === "ALL"
        ? dayRows.filter(
            (row) => Number(row.hours || 0) > 0 || Number(row.completedCount || 0) > 0
          )
        : filterDayKeysByEmployeeStartDate(
            dayRows.map((row) => row.dayKey),
            getEmployeeStartDateYmd(employeeProfilesByUserId, payableGraphUserId)
          )
            .map((allowedDayKey) => dayRows.find((row) => row.dayKey === allowedDayKey))
            .filter(Boolean);

    const totalHours = filteredRowsForDisplay.reduce((sum, row) => sum + Number(row.hours || 0), 0);
    const totalCompleted = filteredRowsForDisplay.reduce(
      (sum, row) => sum + Number(row.completedCount || 0),
      0
    );
    const visibleDayKeys = new Set(filteredRowsForDisplay.map((row) => row.dayKey));
    const filteredPrintRows = dayPrintRows.filter((row) => visibleDayKeys.has(row.dayKey));

    return {
      rows: filteredRowsForDisplay,
      printRows: sortPrintRows(filteredPrintRows),
      totalHours,
      totalCompleted,
      label: payableGraphPeriod.label,
      start: filteredRowsForDisplay.length
        ? filteredRowsForDisplay[0].dayKey
        : payableGraphPeriod.start,
      end: filteredRowsForDisplay.length
        ? filteredRowsForDisplay[filteredRowsForDisplay.length - 1].dayKey
        : payableGraphPeriod.end,
    };
  }, [
    payableGraphUserId,
    validEmployees,
    payableGraphPeriod,
    logsByUserId,
    historyByUserId,
    schedulesByUserId,
    payableNowMs,
    endDate,
    employeeProfilesByUserId,
    attendanceResetTime,
    businessTimeZone,
  ]);

  const anyHistoryLoading = useMemo(() => {
    const needDays =
      hoursWindow === "today"
        ? 1
        : hoursWindow === "yesterday"
          ? 2
        : hoursWindow === "15"
          ? 16
          : hoursWindow === "30"
            ? 30
            : Infinity;

    const needHistory = hoursWindow === "all" || Number(rangeDays) < needDays;
    if (!needHistory) return false;

    for (const emp of data.validEmployees) {
      const uid = String(getUserId(emp));
      if (loadingHistoryByUserId?.[uid]) return true;
    }
    return false;
  }, [hoursWindow, rangeDays, data.validEmployees, loadingHistoryByUserId]);

  const anyHistoryErrors = useMemo(() => {
    const needDays =
      hoursWindow === "today"
        ? 1
        : hoursWindow === "yesterday"
          ? 2
        : hoursWindow === "15"
          ? 16
          : hoursWindow === "30"
            ? 30
            : Infinity;

    const needHistory = hoursWindow === "all" || Number(rangeDays) < needDays;
    if (!needHistory) return "";

    const msgs = [];
    for (const emp of data.validEmployees) {
      const uid = String(getUserId(emp));
      const msg = historyErrorByUserId?.[uid];
      if (msg) msgs.push(`${getDisplayName(emp)}: ${msg}`);
    }
    return msgs.slice(0, 2).join("  |  ");
  }, [hoursWindow, rangeDays, data.validEmployees, historyErrorByUserId]);

  const breakLogSourceByUserId = useMemo(
    () => (hoursWindow === "today" ? breakLogsByUserId : rangeBreakLogsByUserId),
    [hoursWindow, breakLogsByUserId, rangeBreakLogsByUserId]
  );

  const breakLogRows = useMemo(() => {
    if (!Array.isArray(dashPeriod.dayKeys) || dashPeriod.dayKeys.length === 0) return [];

    const dayKeySet = new Set(dashPeriod.dayKeys);
    const rows = [];

    for (const emp of data.validEmployees) {
      const userId = String(getUserId(emp));
      const name = getDisplayName(emp);
      const logs = Array.isArray(breakLogSourceByUserId?.[userId]) ? breakLogSourceByUserId[userId] : [];

      for (const log of logs) {
        const startedAt = log?.startedAt || log?.createdAt || null;
        const endedAt = log?.endedAt || null;
        const startedAtMs = toMillisFromFirestoreValue(startedAt);
        const endedAtMs = toMillisFromFirestoreValue(endedAt);

        if (startedAt && Number.isFinite(startedAtMs)) {
          const dayKey = getBusinessDayKey(startedAtMs, attendanceResetTime, businessTimeZone);
          if (dayKeySet.has(dayKey)) {
            rows.push({
              id: `${String(log?.id || userId)}-break-${startedAtMs}`,
              name,
              action: "Break",
              actionTime: startedAt,
              totalText: "",
            });
          }
        }

        if (endedAt && Number.isFinite(endedAtMs)) {
          const dayKey = getBusinessDayKey(endedAtMs, attendanceResetTime, businessTimeZone);
          if (dayKeySet.has(dayKey)) {
            rows.push({
              id: `${String(log?.id || userId)}-back-${endedAtMs}`,
              name,
              action: "Back",
              actionTime: endedAt,
              totalText: formatBreakDurationMinutes(startedAt, endedAt),
            });
          }
        }
      }
    }

    rows.sort((a, b) => {
      const aMs = toMillisFromFirestoreValue(a.actionTime);
      const bMs = toMillisFromFirestoreValue(b.actionTime);
      return bMs - aMs;
    });

    return rows;
  }, [
    data.validEmployees,
    dashPeriod.dayKeys,
    breakLogSourceByUserId,
    attendanceResetTime,
    businessTimeZone,
  ]);

  const breakLogEmptyText = useMemo(() => {
    if (hoursWindow === "today") return "No break logs today";
    if (hoursWindow === "yesterday") return "No break logs yesterday";
    if (hoursWindow === "15") return "No break logs for the last 15 days";
    if (hoursWindow === "30") return "No break logs for the last 30 days";
    return "No break logs for all time";
  }, [hoursWindow]);

  const sidebarAnnouncements = useMemo(() => {
    const rows = Array.isArray(announcements) ? announcements : [];
    const nowForWindowMs = Number.isFinite(nowMs) ? nowMs : 0;

    const list = rows
      .map((item) => {
        const text = String(
          pick(item, ["note", "announcement", "announcementNote", "message", "text"], "")
        ).trim();
        if (!text) return null;

        const headline = String(pick(item, ["headline", "title", "subject"], "")).trim() || "Announcement";
        const createdAtMs = toMillisFromFirestoreValue(item?.createdAt);
        const publishAtMs = toMillisFromFirestoreValue(item?.publishAt);
        const expiresAtMs = toMillisFromFirestoreValue(item?.expiresAt);
        const deletedAtMs = toMillisFromFirestoreValue(item?.deletedAt);

        if (Number.isFinite(deletedAtMs)) return null;
        if (Number.isFinite(publishAtMs) && nowForWindowMs < publishAtMs) return null;
        if (Number.isFinite(expiresAtMs) && nowForWindowMs > expiresAtMs) return null;

        const postedAtMs =
          Number.isFinite(publishAtMs) ? publishAtMs : Number.isFinite(createdAtMs) ? createdAtMs : NaN;
        const preview =
          text.length > 140 ? `${text.slice(0, 140).trimEnd()}...` : text;

        return {
          id:
            String(item?.id || "").trim() ||
            `${headline}-${String(item?.createdByUserId || "").trim()}-${Number.isFinite(postedAtMs) ? postedAtMs : "now"}`,
          headline,
          preview,
          postedAtMs,
        };
      })
      .filter(Boolean);

    list.sort((a, b) => {
      const aMs = Number.isFinite(a.postedAtMs) ? a.postedAtMs : 0;
      const bMs = Number.isFinite(b.postedAtMs) ? b.postedAtMs : 0;
      return bMs - aMs;
    });

    return list.slice(0, 6);
  }, [announcements, nowMs]);

  const formatSidebarAnnouncementDate = (ms) => {
    if (!Number.isFinite(ms)) return "Recent";
    return new Date(ms).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
    });
  };

  const agentsOnBreak = useMemo(() => {
    const out = [];

    for (const emp of data.validEmployees) {
      const userId = String(getUserId(emp));
      const logs = Array.isArray(breakLogsByUserId?.[userId]) ? breakLogsByUserId[userId] : [];
      const active = logs.find((log) => log?.isActive && !log?.endedAt);

      if (active) {
        out.push({
          userId,
          name: getDisplayName(emp),
          startedAt: active?.startedAt || active?.createdAt || null,
        });
      }
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [data.validEmployees, breakLogsByUserId]);

  const selectedPerfEmployee = useMemo(() => {
    return (
      validEmployees.find(
        (emp) => String(getUserId(emp)) === String(effectiveSelectedPerfUserId)
      ) || null
    );
  }, [validEmployees, effectiveSelectedPerfUserId]);

  const selectedPerfHistory = useMemo(() => {
    if (!effectiveSelectedPerfUserId) return [];
    return Array.isArray(historyByUserId?.[String(effectiveSelectedPerfUserId)])
      ? historyByUserId[String(effectiveSelectedPerfUserId)]
      : [];
  }, [effectiveSelectedPerfUserId, historyByUserId]);

  const monthlyAttendance = useMemo(() => {
    return buildAttendanceMonthlyBreakdown(
      selectedPerfHistory,
      endDate,
      attendanceResetTime,
      businessTimeZone
    );
  }, [selectedPerfHistory, endDate, attendanceResetTime, businessTimeZone]);

  const selectedPerfLoading = effectiveSelectedPerfUserId
    ? !!loadingHistoryByUserId?.[String(effectiveSelectedPerfUserId)]
    : false;

  const selectedPerfError = effectiveSelectedPerfUserId
    ? historyErrorByUserId?.[String(effectiveSelectedPerfUserId)] || ""
    : "";

  const selectedPayableEmployees = useMemo(
    () =>
      payableGraphUserId === "ALL"
        ? validEmployees
        : validEmployees.filter((emp) => String(getUserId(emp)) === String(payableGraphUserId)),
    [payableGraphUserId, validEmployees]
  );

  const payableGraphUserLabel = useMemo(() => {
    if (payableGraphUserId === "ALL") return "Whole Team";
    const selected = validEmployees.find(
      (emp) => String(getUserId(emp)) === String(payableGraphUserId)
    );
    return selected ? getDisplayName(selected) : "Selected Employee";
  }, [payableGraphUserId, validEmployees]);

  const payablePrintDepartment = useMemo(() => {
    const departments = Array.from(
      new Set(
        selectedPayableEmployees
          .map((emp) =>
            sanitizeFileNameSegment(
              extractDepartmentName(
                pick(emp || {}, ["department", "departmentName"], "")
              ),
              ""
            )
          )
          .filter(Boolean)
      )
    );

    if (departments.length === 1) return departments[0];
    if (departments.length > 1) return "Multiple Departments";

    const envDepartmentId = sanitizeFileNameSegment(
      extractDepartmentName(import.meta.env.VITE_HYACINTH_DEPARTMENT_ID),
      ""
    );
    return envDepartmentId || "Department";
  }, [selectedPayableEmployees]);

  const payablePrintStart = String(payableHoursChart?.start ?? payableGraphPeriod?.start ?? "");
  const payablePrintEnd = String(payableHoursChart?.end ?? payableGraphPeriod?.end ?? "");

  const payablePrintRangeSegment =
    payablePrintStart && payablePrintEnd
      ? payablePrintStart === payablePrintEnd
        ? payablePrintStart
        : `${payablePrintStart}_to_${payablePrintEnd}`
      : payablePrintStart || payablePrintEnd || "DateRange";

  const payablePrintFileName = useMemo(
    () => `${payablePrintDepartment}_${payablePrintRangeSegment}_Payable Hours`,
    [payablePrintDepartment, payablePrintRangeSegment]
  );

  const payablePrintRowsByEmployee = useMemo(() => {
    const sourceRows = Array.isArray(payableHoursChart.printRows) ? payableHoursChart.printRows : [];
    if (!sourceRows.length) return [];

    const byEmployee = new Map();
    for (const row of sourceRows) {
      const userId = String(row?.userId || "");
      if (!userId) continue;
      if (!byEmployee.has(userId)) byEmployee.set(userId, []);
      byEmployee.get(userId).push(row);
    }

    const orderedEmployeeIds = selectedPayableEmployees
      .map((emp) => String(getUserId(emp)))
      .filter((userId, idx, arr) => userId && arr.indexOf(userId) === idx);

    const fallbackEmployeeIds = Array.from(byEmployee.keys()).sort((a, b) => a.localeCompare(b));
    const targetEmployeeIds = orderedEmployeeIds.length ? orderedEmployeeIds : fallbackEmployeeIds;

    return targetEmployeeIds
      .map((userId) => {
        const rows = [...(byEmployee.get(userId) || [])].sort((a, b) =>
          String(a?.dayKey || "").localeCompare(String(b?.dayKey || ""))
        );
        if (!rows.length) return null;

        const employeeName =
          rows[0]?.employeeName ||
          getDisplayName(selectedPayableEmployees.find((emp) => String(getUserId(emp)) === userId)) ||
          `User ${userId}`;

        return {
          userId,
          employeeName,
          rows,
        };
      })
      .filter(Boolean);
  }, [payableHoursChart.printRows, selectedPayableEmployees]);

  const payableTableColumnDayKeys = useMemo(() => {
    const periodDayKeys = (Array.isArray(payableGraphPeriod.dayKeys) ? payableGraphPeriod.dayKeys : [])
      .map((key) => String(key || "").trim())
      .filter(Boolean);
    if (periodDayKeys.length) return periodDayKeys;

    const fallbackDayKeys = (Array.isArray(payableHoursChart.rows) ? payableHoursChart.rows : [])
      .map((row) => String(row?.dayKey || "").trim())
      .filter(Boolean);
    if (!fallbackDayKeys.length) return [];

    return Array.from(new Set(fallbackDayKeys)).sort((a, b) => a.localeCompare(b));
  }, [payableGraphPeriod.dayKeys, payableHoursChart.rows]);

  const payableTableMatrixRows = useMemo(() => {
    const sourceRows = Array.isArray(payableHoursChart.printRows) ? payableHoursChart.printRows : [];
    const targetDayKeys = payableTableColumnDayKeys;
    if (!targetDayKeys.length) return [];

    const hoursByUserIdByDayKey = new Map();
    for (const row of sourceRows) {
      const userId = String(row?.userId || "").trim();
      const dayKey = String(row?.dayKey || "").trim();
      if (!userId || !dayKey) continue;

      if (!hoursByUserIdByDayKey.has(userId)) {
        hoursByUserIdByDayKey.set(userId, new Map());
      }

      const byDay = hoursByUserIdByDayKey.get(userId);
      const prev = Number(byDay.get(dayKey) || 0);
      byDay.set(dayKey, prev + Number(row?.hours || 0));
    }

    return selectedPayableEmployees.map((employee) => {
      const userId = String(getUserId(employee) || "").trim();
      const employeeName = getDisplayName(employee);
      const employeeStartDateYmd = getEmployeeStartDateYmd(employeeProfilesByUserId, userId);
      const dayMap = hoursByUserIdByDayKey.get(userId) || new Map();

      let totalHours = 0;
      const dayValues = targetDayKeys.map((dayKey) => {
        if (employeeStartDateYmd && String(dayKey) < String(employeeStartDateYmd)) {
          return null;
        }
        const value = Number(dayMap.get(dayKey) || 0);
        if (Number.isFinite(value) && value > 0) totalHours += value;
        return Number.isFinite(value) ? value : 0;
      });

      return {
        userId,
        employeeName,
        dayValues,
        totalHours,
      };
    });
  }, [
    payableHoursChart.printRows,
    payableTableColumnDayKeys,
    selectedPayableEmployees,
    employeeProfilesByUserId,
  ]);

  const PRINT_BAR_SIZE = 14;
  const PRINT_BAR_GAP = 7;
  const printBarChartHeight = (() => {
    const rowCount = Math.max(1, Number(payableHoursChart?.rows?.length || 0));
    const rowsHeight = rowCount * (PRINT_BAR_SIZE + PRINT_BAR_GAP);
    const contentHeight = rowsHeight + 54;
    const measuredHeight = Number(printChartSize?.height || 0);
    return Math.max(260, contentHeight, measuredHeight);
  })();

  const handlePrintPayableWindow = () => {
    if (typeof window === "undefined") return;

    if (typeof document !== "undefined") {
      if (!originalDocumentTitleRef.current) {
        originalDocumentTitleRef.current = document.title;
      }
      document.title = payablePrintFileName;
    }

    flushSync(() => {
      measurePayableChartForPrint();
      setIsPrinting(true);
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          window.print();
        } catch {
          if (typeof document !== "undefined" && originalDocumentTitleRef.current) {
            document.title = originalDocumentTitleRef.current;
            originalDocumentTitleRef.current = "";
          }
          setIsPrinting(false);
        }
      });
    });
  };

  return (
    <div className="dashX">
      <div className="dashHeader">
        <div className="title-div">
          <h3 className="kpiValue"><strong>Total count: </strong> {attendanceBreakdown.total}</h3>
        </div>

        <div className="dashHeaderRight">
          {loading ? <div className="dashLoading" /> : null}
          {!loading && error ? <div className="dashError">{error}</div> : null}
        </div>

        <div className="windowBtns">
          <button
            type="button"
            className={`windowBtn ${hoursWindow === "today" ? "isActive" : ""}`}
            onClick={() => setHoursWindowAndCollapseLists("today")}
          >
            TODAY
          </button>
          <button
            type="button"
            className={`windowBtn ${hoursWindow === "yesterday" ? "isActive" : ""}`}
            onClick={() => setHoursWindowAndCollapseLists("yesterday")}
          >
            YESTERDAY
          </button>
          <button
            type="button"
            className={`windowBtn ${hoursWindow === "15" ? "isActive" : ""}`}
            onClick={() => setHoursWindowAndCollapseLists("15")}
          >
            15D
          </button>
          <button
            type="button"
            className={`windowBtn ${hoursWindow === "30" ? "isActive" : ""}`}
            onClick={() => setHoursWindowAndCollapseLists("30")}
          >
            30D
          </button>
          <button
            type="button"
            className={`windowBtn ${hoursWindow === "all" ? "isActive" : ""}`}
            onClick={() => setHoursWindowAndCollapseLists("all")}
          >
            ALL
          </button>
        </div>
      </div>

      <div className="dashLayout">
        <div className="dashMain">
          <div className="topBar">
            <div className="kpi">
              <div className="kpiLabel">EARLY</div>
              <div className="kpiValue">{attendanceBreakdown.counts.early}</div>
            </div>

            <div className="kpi">
              <div className="kpiLabel">ON TIME</div>
              <div className="kpiValue">{attendanceBreakdown.counts.onTime}</div>
            </div>

            <div className="kpi">
              <div className="kpiLabel">LATE</div>
              <div className="kpiValue">{attendanceBreakdown.counts.late}</div>
            </div>

            <div className="kpi">
              <div className="kpiLabel">PTO</div>
              <div className="kpiValue">{attendanceBreakdown.counts.pto}</div>
            </div>

            <div className="kpi">
              <div className="kpiLabel">ABSENT</div>
              <div className="kpiValue">{attendanceBreakdown.counts.absent}</div>
            </div>

            <div className="kpi">
              <div className="kpiLabel">NCNS</div>
              <div className="kpiValue">{attendanceBreakdown.counts.ncns}</div>
            </div>

            {hoursWindow === "today" ? (
              <div id="kpi" className="kpi">
                <div className="kpiLabel">LIVE</div>
                <div className="kpiValue">{data.counts.live}</div>
              </div>
            ) : null}
          </div>

          <div className="grid">
            <div className="panel p-att">
              <div className="panelHead">Attendance Breakdown</div>

              <div className="panelBody">
                <div className="attWrap">
                  <div
                    className="attPie"
                    ref={attendancePieRef}
                    onMouseMove={handleAttendancePieMouseMove}
                    onMouseLeave={hidePieTooltip}
                  >
                    <div className="attHole" ref={attendanceHoleRef}>
                      <div className="attHoleLabel">Range</div>
                      <div className="attHoleValue">{rangeLabel}</div>

                      <div className="attHoleLabel attHoleLabelSpacing">Total Counted</div>
                      <div className="attHoleTotal">{attendanceBreakdown.total}</div>
                    </div>
                  </div>

                  <div className="attSummaryTableWrap attSummaryTableWrapInline">
                    <table className="attSummaryTable">
                      <thead>
                        <tr>
                          {legend.map((x) => (
                            <th key={`summary-head-${x.key}`}>
                              <span className="attSummaryHead">
                              <span
                                  className={`dot attSummaryDot dash-tone-${x.key}`}
                                  title={buildBucketEmployeeTooltip(
                                    x.label,
                                    attendanceBreakdown.employeesByBucket?.[x.key]
                                  )}
                                />
                                <span className="attSummaryHeadLabel">{x.label}</span>
                                <span className="attSummaryHeadCount">{x.value}</span>
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: attendanceSummaryRowsVisible }).map((_, rowIdx) => (
                          <tr key={`summary-row-${rowIdx}`}>
                            {legend.map((x) => {
                              const names = attendanceBreakdown.employeesByBucket?.[x.key] || [];
                              const name = names[rowIdx] || "";

                              return (
                                <td
                                  key={`${x.key}-name-${rowIdx}`}
                                  className={`attSummaryNameCell ${name ? "" : "isEmpty"}`}
                                >
                                  {name || "-"}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {hiddenSummaryRows > 0 ? (
                      <div className="attSummaryFooter">
                        <button
                          type="button"
                          className="attSummaryToggleBtn"
                          onClick={() => setShowAllSummaryRows(true)}
                        >
                          Show all names ({hiddenSummaryRows} more)
                        </button>
                      </div>
                    ) : null}

                    <div className="attMeta">
                      Employees: {data.validEmployees.length} | {dashPeriod.isMonthly ? "Eligible Months" : "Eligible Days"}: {attendanceBreakdown.eligibleDays}
                    </div>
                  </div>

                  {pieTooltip.visible ? (
                    <div
                      className="pieSliceTooltip"
                      ref={pieTooltipRef}
                    >
                      <div className="pieSliceTooltipHead">
                        <span className={`dot dash-tone-${pieTooltip.key}`} />
                        <span>
                          {pieTooltip.label} ({pieTooltip.count})
                        </span>
                      </div>
                      {pieTooltip.names.length === 0 ? (
                        <div className="pieSliceTooltipEmpty">
                          No employees in this bucket for the current range.
                        </div>
                      ) : (
                        <div className="pieSliceTooltipList">{pieTooltip.names.join(", ")}</div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="updateSidebar">
          <div className="panelHead center">Agents On Break</div>

          <div className="panelBody">
            <div className="updateBody">
              <div className="updateBox">
                <div className="payTableWrap">
                  <table className="payTable">
                    <thead>
                      <tr>
                        <th className="payThLeft">Agent</th>
                        <th className="payThRight">Since</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentsOnBreak.length === 0 ? (
                        <tr>
                          <td className="payEmpty" colSpan={2}>
                            No agents currently on break
                          </td>
                        </tr>
                      ) : (
                        agentsOnBreak.map((agent) => (
                          <tr key={agent.userId}>
                            <td className="payTdName">{agent.name}</td>
                            <td
                              className="payTdHours"
                              title={formatBreakTimestamp(agent.startedAt, businessTimeZone)}
                            >
                              {formatBreakTimeOnly(agent.startedAt, businessTimeZone)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          {canViewBreakLog ? (
            <>
              <div className="panelHead center">Break Log ({dashPeriod.label})</div>

              <div className="panelBody">
                <div className="updateBody">
                  <div className="updateBox">
                    <div id="updateBox" className="payTableWrap">
                      <table className="payTable">
                        <thead>
                          <tr>
                            <th className="payThLeft">Name</th>
                            <th className="payThRight">Action</th>
                            <th className="payThRight">Time</th>
                            <th className="payThRight">Total</th>
                          </tr>
                        </thead>

                        <tbody>
                          {loadingRangeBreakLogs && hoursWindow !== "today" ? (
                            <tr>
                              <td className="payEmpty" colSpan={4}>
                                Loading break logs for selected range...
                              </td>
                            </tr>
                          ) : breakLogRows.length === 0 ? (
                            <tr>
                              <td className="payEmpty" colSpan={4}>
                                {breakLogEmptyText}
                              </td>
                            </tr>
                          ) : (
                            breakLogRows.map((row) => (
                              <tr key={row.id}>
                                <td className="payTdName">{row.name}</td>
                                <td className="payTdHours">{row.action}</td>
                                <td
                                  className="payTdHours"
                                  title={formatBreakTimestamp(row.actionTime, businessTimeZone)}
                                >
                                  {formatBreakTimeOnly(row.actionTime, businessTimeZone)}
                                </td>
                                <td className="payTdHours">{row.totalText || "-"}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          <div className="panelHead center">Announcements</div>

          <div className="panelBody">
            <div className="updateBody">
              <div className="updateBox">
                <div className="payTableWrap">
                  <table className="payTable">
                    <thead>
                      <tr>
                        <th className="payThLeft">Announcement</th>
                        <th className="payThRight">Posted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadingAnnouncements ? (
                        <tr>
                          <td className="payEmpty" colSpan={2}>
                            Loading announcements...
                          </td>
                        </tr>
                      ) : announcementsError ? (
                        <tr>
                          <td className="payEmpty" colSpan={2}>
                            {announcementsError}
                          </td>
                        </tr>
                      ) : sidebarAnnouncements.length === 0 ? (
                        <tr>
                          <td className="payEmpty" colSpan={2}>
                            No active announcements.
                          </td>
                        </tr>
                      ) : (
                        sidebarAnnouncements.map((item) => (
                          <tr key={`dash-announcement-${item.id}`}>
                            <td className="payTdName">
                              <div className="dashAnnouncementHeadline">{item.headline}</div>
                              <div className="dashAnnouncementPreview">{item.preview}</div>
                            </td>
                            <td
                              className="payTdHours"
                              title={formatSidebarAnnouncementDate(item.postedAtMs)}
                            >
                              {formatSidebarAnnouncementDate(item.postedAtMs)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

        </aside>

        
      </div>

      <div className="agentAttendancePanel">
        <div className="agentAttendancePanelTop">
          <div className="agentAttendancePanelHead">
            Best Attendance Per Employee (Early/On Time weighted, Late/Absent lower score)
          </div>
          <div className="agentAttendanceMonthFilter">
            <label htmlFor="agent-attendance-month-filter">Month</label>
            <select
              id="agent-attendance-month-filter"
              className="agentAttendanceMonthSelect"
              value={effectiveSelectedAgentAttendanceMonth}
              onChange={(e) => setSelectedAgentAttendanceMonth(e.target.value)}
            >
              <option value={AGENT_ATTENDANCE_MONTH_ALL}>All months</option>
              {availableAgentAttendanceMonths.map((monthKey) => (
                <option key={`agent-att-month-${monthKey}`} value={monthKey}>
                  {prettyMonthLabel(monthKey)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="agentAttendanceLegend">
          {ATTENDANCE_BUCKETS.map((item) => (
            <span key={`agent-legend-${item.key}`} className="agentAttendanceLegendItem">
              <span className={`dot dash-tone-${item.key}`} />
              <span>{item.label}</span>
            </span>
          ))}
        </div>

        {agentAttendanceRates.length === 0 ? (
          <div className="agentAttendanceEmpty">{agentAttendanceEmptyText}</div>
        ) : (
          <>
            <div className="agentAttendanceStrip">
              {visibleAgentAttendanceRates.map((agent) => (
                <div
                  key={`agent-att-${agent.userId}`}
                  className="agentAttendanceItem"
                  title={`Score: ${agent.rate}% | ${agent.tooltipSummary}`}
                >
                  <div
                    className="agentAttendanceDonut"
                    ref={registerAgentDonutRef(agent.userId)}
                  >
                    <div className="agentAttendanceCenter">{agent.rate}%</div>
                  </div>
                  <div className="agentAttendanceName">{agent.shortName}</div>
                </div>
              ))}
            </div>

            {hiddenAgentAttendanceRates > 0 ? (
              <div
                className="agentAttendanceFoot"
              >
                <button
                  type="button"
                  className="attSummaryToggleBtn"
                  onClick={() => setShowAllAgentRates(true)}
                >
                  Show all agents ({hiddenAgentAttendanceRates} more)
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {canViewPayablePanel ? (
      <div className="panel p-payable">
        <div className="panelHead center">Accounting Window</div>

        <div className="panelBody">
          <div className="updateBody">
            <div className="updateBox" id="updateBox1">
              <div className="updateItem">Daily Payable Hours Graph</div>

              <div className="payableWindowBtns noPrint">
                <div className="buttons-div">
                  <button
                    type="button"
                    className={`windowBtn ${payableGraphWindow === "week" ? "isActive" : ""}`}
                    onClick={() => setPayableGraphWindow("week")}
                  >
                    This Week
                  </button>
                  <button
                    type="button"
                    className={`windowBtn ${payableGraphWindow === "15" ? "isActive" : ""}`}
                    onClick={() => setPayableGraphWindow("15")}
                  >
                    15D
                  </button>
                  <button
                    type="button"
                    className={`windowBtn ${payableGraphWindow === "month" ? "isActive" : ""}`}
                    onClick={() => setPayableGraphWindow("month")}
                  >
                    Monthly
                  </button>
                  <button
                    type="button"
                    className={`windowBtn ${payableGraphWindow === "custom" ? "isActive" : ""}`}
                    onClick={() => setPayableGraphWindow("custom")}
                  >
                    Custom
                  </button>
                  <button
                    type="button"
                    className={`windowBtn ${payableGraphWindow === "all" ? "isActive" : ""}`}
                    onClick={() => setPayableGraphWindow("all")}
                  >
                    All
                  </button>
                </div>
                

                <div className="payableAgentSelectWrap">
                  <select
                    className="select-emp"
                    value={payableGraphUserId}
                    onChange={(e) => setPayableGraphUserId(e.target.value)}
                  >
                    <option value="ALL">Whole Team</option>
                    {validEmployees.map((emp) => {
                      const uid = String(getUserId(emp));
                      return (
                        <option key={uid} value={uid}>
                          {getDisplayName(emp)}
                        </option>
                      );
                    })}
                  </select>

                  <div className="payableManualFilters">
                    <label className="payableDateField" htmlFor="payable-range-from">
                      <span>From</span>
                      <input
                        id="payable-range-from"
                        className="payableDateInput"
                        type="date"
                        value={effectivePayableCustomStartDate}
                        onChange={(e) => {
                          setPayableCustomStartDate(e.target.value);
                          setPayableGraphWindow("custom");
                        }}
                      />
                    </label>
                    <label className="payableDateField" htmlFor="payable-range-to">
                      <span>To</span>
                      <input
                        id="payable-range-to"
                        className="payableDateInput"
                        type="date"
                        value={effectivePayableCustomEndDate}
                        onChange={(e) => {
                          setPayableCustomEndDate(e.target.value);
                          setPayableGraphWindow("custom");
                        }}
                      />
                    </label>
                    <label className="payableYearField" htmlFor="payable-year-select">
                      <span>Year</span>
                      <select
                        id="payable-year-select"
                        className="payableMonthSelect"
                        value={effectiveSelectedPayableYear}
                        onChange={(e) => handlePayableYearSelect(e.target.value)}
                      >
                        <option value={PAYABLE_MONTH_SELECT_NONE}>Select year</option>
                        {payableYearOptions.map((yearValue) => (
                          <option key={`payable-year-${yearValue}`} value={yearValue}>
                            {yearValue}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button
                    type="button"
                    className="windowBtn payablePrintBtn"
                    onClick={handlePrintPayableWindow}
                  >
                    Print
                  </button>
                </div>
              </div>

              

              

              <div className="payableSummaryPanels">
                <div className="payableSummaryPanel range">
                  <div className="payableSummaryLabel">Range</div>
                  <div className="payableSummaryMain">{payableHoursChart.label}</div>
                  <div className="payableSummarySub">
                    {payableHoursChart.start} -&gt; {payableHoursChart.end}
                  </div>
                  <div className="payableViewToggle noPrint" role="group" aria-label="Payable display mode">
                    <button
                      type="button"
                      className={`payableViewBtn ${payableDisplayMode === "graph" ? "isActive" : ""}`}
                      onClick={() => setPayableDisplayMode("graph")}
                    >
                      Graph
                    </button>
                    <button
                      type="button"
                      className={`payableViewBtn ${payableDisplayMode === "table" ? "isActive" : ""}`}
                      onClick={() => setPayableDisplayMode("table")}
                    >
                      Table
                    </button>
                  </div>
                  {payableGraphWindow === "15" ? (
                    <div className="payableSummaryMeta">
                      Cutoff: {cutoffLabelForYmd(endDate)}
                    </div>
                  ) : null}
                </div>

                <div className="payableSummaryPanel total">
                  <div className="payableSummaryLabel">Total Payable Hours</div>
                  <div className="payableSummaryMain">{formatHoursValue(payableHoursChart.totalHours)} hrs</div>
                </div>

                <div className="payableSummaryPanel duties">
                  <div className="payableSummaryLabel">Completed Duties Count</div>
                  <div className="payableSummaryMain">{payableHoursChart.totalCompleted}</div>
                </div>
              </div>

              {anyHistoryLoading ? (
                <div className="sideHint">
                  Loading extra history so the chart can use full attendance records...
                </div>
              ) : null}
              {anyHistoryErrors ? <div className="sideError">{anyHistoryErrors}</div> : null}

              <div className="payablePrintHeader printOnly">
                <div className="payablePrintTitle">Daily Payable Hours</div>
                <div className="payablePrintSub">
                  Employee: {payableGraphUserLabel} | Range: {payableHoursChart.start} -&gt;{" "}
                  {payableHoursChart.end}
                </div>
              </div>

              {payableDisplayMode === "table" && !isPrinting ? (
                <div className="payTableWrap payableScreenTableWrap">
                  <table className="payTable">
                    <thead>
                      <tr>
                        <th className="payThLeft payableMatrixNameCol">Name</th>
                        {payableTableColumnDayKeys.map((dayKey) => (
                          <th
                            key={`payable-day-column-${dayKey}`}
                            className="payThRight payableMatrixDateHead"
                            title={prettyDayLabel(dayKey)}
                          >
                            {dayKey}
                          </th>
                        ))}
                        <th className="payThRight payableMatrixTotalCol">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payableTableMatrixRows.length === 0 ||
                      payableTableColumnDayKeys.length === 0 ? (
                        <tr>
                          <td
                            className="payEmpty"
                            colSpan={Math.max(2, payableTableColumnDayKeys.length + 2)}
                          >
                            No payable data in this range.
                          </td>
                        </tr>
                      ) : (
                        payableTableMatrixRows.map((row) => (
                          <tr key={`payable-screen-row-${row.userId || row.employeeName}`}>
                            <td className="payTdName payableMatrixNameCol">{row.employeeName}</td>
                            {payableTableColumnDayKeys.map((dayKey, colIdx) => {
                              const value = row.dayValues[colIdx];
                              const isUnavailable = value === null;
                              return (
                                <td
                                  key={`payable-cell-${row.userId}-${dayKey}`}
                                  className={`payTdHours ${isUnavailable ? "payableMatrixMuted" : ""}`}
                                >
                                  {isUnavailable ? "-" : formatHoursValue(value)}
                                </td>
                              );
                            })}
                            <td className="payTdHours payableMatrixTotalCol">
                              {formatHoursValue(row.totalHours)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="payableChartWrap" ref={payableChartWrapRef}>
                  {chartReady ? (
                    isPrinting ? (
                      <BarChart
                        width={printChartSize.width}
                        height={printBarChartHeight}
                        data={payableHoursChart.rows}
                        layout="vertical"
                        margin={{ top: 10, right: 56, left: 20, bottom: 10 }}
                        barCategoryGap={PRINT_BAR_GAP}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                        <XAxis
                          type="number"
                          dataKey="hours"
                          domain={[0, "auto"]}
                          tickFormatter={formatHoursValue}
                          tick={{ fontSize: 11, fill: "rgba(0, 0, 0, 0.72)" }}
                        />
                        <YAxis
                          type="category"
                          dataKey="label"
                          width={84}
                          interval={0}
                          allowDecimals
                          tick={{ fontSize: 11, fill: "rgba(0, 0, 0, 0.72)" }}
                        />
                        <Tooltip content={<PayableHoursTooltip />} />
                        <Bar
                          dataKey="hours"
                          fill="#66bb6a"
                          radius={[0, 6, 6, 0]}
                          barSize={PRINT_BAR_SIZE}
                          minPointSize={4}
                          isAnimationActive={false}
                        >
                          <LabelList
                            dataKey="hours"
                            position="right"
                            formatter={formatHoursValue}
                            fill="rgba(0, 0, 0, 0.82)"
                            fontSize={11}
                          />
                        </Bar>
                      </BarChart>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={payableHoursChart.rows}
                          margin={{ top: 10, right: 50, left: 0, bottom: 10 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 11, fill: "rgba(0, 0, 0, 0.72)" }}
                            interval={0}
                          />
                          <YAxis
                            allowDecimals
                            tick={{ fontSize: 11, fill: "rgba(0, 0, 0, 0.72)" }}
                          />
                          <Tooltip content={<PayableHoursTooltip />} />
                          <Line
                            type="monotone"
                            dataKey="hours"
                            stroke="#66bb6a"
                            strokeWidth={3}
                            dot={{ r: 4 }}
                            activeDot={{ r: 6 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    )
                  ) : (
                    <div className="perfEmpty">Preparing chart...</div>
                  )}
                </div>
              )}

              <div className="payablePrintTableWrap printOnly">
                <div className="payablePrintMetaLine">
                  Selected Employee: <strong>{payableGraphUserLabel}</strong>
                </div>
                {payableGraphUserId === "ALL" ? (
                  <div className="payablePrintDayGroups">
                    {payablePrintRowsByEmployee.length === 0 ? (
                      <div className="payEmpty">No completed payable hours in the selected range.</div>
                    ) : (
                      payablePrintRowsByEmployee.map((employeeGroup) => (
                        <div
                          key={`payable-print-employee-${employeeGroup.userId}`}
                          className="payablePrintDayGroup"
                        >
                          <div className="payablePrintDayTitle">
                            {employeeGroup.employeeName}
                          </div>
                          <table className="payablePrintTable">
                            <thead>
                              <tr>
                                <th className="payThLeft">Date</th>
                                <th className="payThLeft">Day</th>
                                <th className="payThRight">Completed Hours</th>
                                <th className="payThLeft">Notes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {employeeGroup.rows.length === 0 ? (
                                <tr>
                                  <td className="payEmpty" colSpan={4}>
                                    No completed payable hours.
                                  </td>
                                </tr>
                              ) : (
                                employeeGroup.rows.map((row) => (
                                  <tr key={`payable-print-${employeeGroup.userId}-${row.dayKey}`}>
                                    <td className="payTdName">{row.dayKey}</td>
                                    <td className="payTdName">
                                      {row.dayShort || shortWeekdayLabelFromYmd(row.dayKey)}
                                    </td>
                                    <td className="payTdHours">{formatHoursValue(row.hours)}</td>
                                    <td className="payTdName">{row.attendanceNote || "-"}</td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  <table className="payablePrintTable">
                    <thead>
                      <tr>
                        <th className="payThLeft">Date</th>
                        <th className="payThLeft">Day</th>
                        <th className="payThLeft">Employee</th>
                        <th className="payThRight">Completed Hours</th>
                        <th className="payThLeft">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payableHoursChart.printRows.length === 0 ? (
                        <tr>
                          <td className="payEmpty" colSpan={5}>
                            No completed payable hours in this range.
                          </td>
                        </tr>
                      ) : (
                        payableHoursChart.printRows.map((row) => (
                          <tr key={`payable-print-${row.dayKey}-${row.userId}`}>
                            <td className="payTdName">{row.dayKey}</td>
                            <td className="payTdName">
                              {row.dayShort || shortWeekdayLabelFromYmd(row.dayKey)}
                            </td>
                            <td className="payTdName">{row.employeeName}</td>
                            <td className="payTdHours">{formatHoursValue(row.hours)}</td>
                            <td className="payTdName">{row.attendanceNote || "-"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      ) : null}

      <div className="panel p-heat">
        <div className="panelHead">
          <div className="panel1">
            <h3>Attendance Breakdown per Month</h3>
            <p>Monthly attendance patterns and trends</p>
          </div>

          <div className="panel2">
            <div className="avgmonth">
              <h3>Avg/Month</h3>
              <h2>{Math.round(monthlyAttendance.avgPerMonth || 0)}</h2>
            </div>

            <div className="avgmonth">
              <div>
                <h3>Total</h3>
                <h2>{monthlyAttendance.total}</h2>
              </div>
            </div>
          </div>
        </div>

        <div className="select-divv">
          <select
            className="select-emp"
            value={selectedPerfUserId}
            onChange={(e) => setSelectedPerfUserId(e.target.value)}
          >
            {validEmployees.map((emp) => {
              const uid = String(getUserId(emp));
              return (
                <option key={uid} value={uid}>
                  {getDisplayName(emp)}
                </option>
              );
            })}
          </select>
        </div>

        <div className="panelBody panelBodyFill">
          <div className="perfBody">
            {selectedPerfLoading ? (
              <div className="perfEmpty">Loading attendance history...</div>
            ) : selectedPerfError ? (
              <div className="perfEmpty">{selectedPerfError}</div>
            ) : !selectedPerfEmployee ? (
              <div className="perfEmpty">No employee selected.</div>
            ) : monthlyAttendance.chartData.length === 0 ? (
              <div className="perfEmpty">No attendance data available for this employee.</div>
            ) : (
              <>
                <div className="perfTop">
                  <div className="perfTopLeft">
                    Employee: <span className="perfTopValue">{getDisplayName(selectedPerfEmployee)}</span>
                  </div>
                  <div className="perfTopRight">
                    Range:{" "}
                    <span className="perfTopValue">
                      {monthlyAttendance.firstMonth
                        ? `${prettyMonthLabel(monthlyAttendance.firstMonth)} -> ${prettyMonthLabel(monthlyAttendance.lastMonth)}`
                        : "-"}
                    </span>
                  </div>
                </div>

                <div className="monthlyLegend">
                  {ATTENDANCE_BUCKETS.map((item) => (
                    <div
                      key={item.key}
                      className="monthlyLegendItem"
                    >
                      <span className={`monthlyLegendDot dash-tone-${item.key}`} />
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>

                <div className="perfChartWrap">
                  <div className="perfChartInner">
                    {chartReady ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={monthlyAttendance.chartData}
                          margin={{ top: 10, right: 0, left: 0, bottom: 10 }}
                          barCategoryGap={22}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0)" />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 11, fill: "rgba(0, 0, 0, 0.72)" }}
                            interval={0}
                          />
                          <YAxis
                            allowDecimals={false}
                            tick={{ fontSize: 11, fill: "rgba(0, 0, 0, 0.72)" }}
                          />
                          <Tooltip content={<MonthlyAttendanceTooltip />} />
                          <Bar dataKey="early" stackId="attendance" fill="#4b9fea" radius={[0, 0, 0, 0]} />
                          <Bar dataKey="onTime" stackId="attendance" fill="#66bb6a" radius={[0, 0, 0, 0]} />
                          <Bar dataKey="late" stackId="attendance" fill="#f39c12" radius={[0, 0, 0, 0]} />
                          <Bar dataKey="pto" stackId="attendance" fill="#8e44ad" radius={[0, 0, 0, 0]} />
                          <Bar dataKey="absent" stackId="attendance" fill="#e74c3c" radius={[0, 0, 0, 0]} />
                          <Bar dataKey="ncns" stackId="attendance" fill="#4b5563" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="perfEmpty">Preparing chart...</div>
                    )}
                  </div>
                </div>

                <div className="perfFoot">
                  Counts are grouped by month using the same attendance history records loaded for the selected employee.
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
