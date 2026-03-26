import React, { useMemo, useState, useEffect } from "react";
import "./attendancePage.css";
import { getBusinessDayKey } from "../utils/attendanceDate";
import {
  getDisplayName,
  getProfileImageUrl,
  getUserId,
  pick,
  safeLower,
} from "../utils/common";
import {
  getEventTs,
  isClockedOutLog,
  isIn,
  tsMs,
} from "../utils/attendanceLog";

/* ------------------------- helpers (ids, strings) ------------------------- */

const initials = (name = "") => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
};

const VIEWER_TIME_ZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/* --------------------------- styling helpers ---------------------------- */
const statusBadgeClass = (status) => {
  const s = safeLower(status);

  if (s.includes("on break")) return "break";

  if (
    s.includes("day off") ||
    s.includes("rest day") ||
    s.includes("holiday") ||
    s.includes("leave") ||
    s.includes("vacation") ||
    s.includes("no schedule")
  ) {
    return "dayoff";
  }

  if (
    s.includes("scheduled") ||
    s.includes("on time") ||
    s.includes("early") ||
    s.includes("present") ||
    s.includes("logged")
  ) {
    return "scheduled";
  }

  if (
    s.includes("no show") ||
    s.includes("ncns") ||
    s.includes("absent") ||
    s.includes("no log")
  ) {
    return "warn";
  }

  if (s.includes("completed") || s.includes("complete")) return "done";
  if (s.includes("live") || s.includes("late")) return "notimeout";

  return "warn";
};

const toTitle = (v = "") =>
  String(v)
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());

const getRawStatus = (log) =>
  pick(log || {}, ["status", "attendanceStatus", "dailyStatus", "remark"], "").trim();

/* --------------------------- time helpers ------------------------------- */
const isValidTs = (log) => Number.isFinite(tsMs(getEventTs(log)));

const isNcnsInLog = (log) => {
  if (!isIn(log)) return false;
  const status = safeLower(pick(log, ["status"], "")).trim();
  return status === "ncns";
};

const dayKeyFromTs = (
  ts,
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago"
) => {
  return getBusinessDayKey(ts, attendanceResetTime, businessTimeZone);
};

const getLogDayKey = (
  log,
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago"
) => {
  const explicitDayKey = pick(
    log || {},
    [
      "dayKey",
      "businessDay",
      "businessDate",
      "attendanceDate",
      "logDate",
      "date",
      "workDate",
    ],
    ""
  );

  if (explicitDayKey && /^\d{4}-\d{2}-\d{2}$/.test(String(explicitDayKey))) {
    return String(explicitDayKey);
  }

  const ts = getEventTs(log);
  if (ts && Number.isFinite(tsMs(ts))) {
    return dayKeyFromTs(ts, attendanceResetTime, businessTimeZone);
  }

  return "";
};

const groupLogsByBusinessDay = (
  logs = [],
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago"
) => {
  const byDay = new Map();

  for (const log of Array.isArray(logs) ? logs : []) {
    const dk = getLogDayKey(log, attendanceResetTime, businessTimeZone);
    if (!dk) continue;

    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk).push(log);
  }

  return byDay;
};

const formatTs = (ts, timeZone = VIEWER_TIME_ZONE) => {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);

  return new Intl.DateTimeFormat([], {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
};

const formatTimeOnly = (ts, timeZone = VIEWER_TIME_ZONE) => {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);

  return new Intl.DateTimeFormat([], {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
};

const minutesToHrsMinText = (minutes) => {
  const mins = Number(minutes);
  if (!Number.isFinite(mins)) return "-";
  const totalMinutes = Math.round(mins);
  const hrs = Math.floor(totalMinutes / 60);
  const remMin = Math.abs(totalMinutes % 60);
  return `${hrs}h ${String(remMin).padStart(2, "0")}m`;
};

const prettyDate = (yyyyMmDd, timeZone = VIEWER_TIME_ZONE) => {
  if (!yyyyMmDd) return "-";
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return yyyyMmDd;
  return new Intl.DateTimeFormat([], {
    timeZone,
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(d);
};

const prettyDayName = (yyyyMmDd, timeZone = VIEWER_TIME_ZONE) => {
  if (!yyyyMmDd) return "-";
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat([], {
    timeZone,
    weekday: "long",
  }).format(d);
};

/* ------------------- enumerate YYYY-MM-DD range ------------------- */
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

const addDaysYmd = (ymd, deltaDays) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
};

/* ---------------------- timezone helpers ---------------------- */
const getWeekdayInTimeZoneFromYmd = (yyyyMmDd, timeZone) => {
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;

  return safeLower(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
    }).format(d)
  );
};

const getScheduleTimeZone = (scheduleItem, fallbackTimeZone = "UTC") =>
  pick(scheduleItem || {}, ["timeRegion", "timezone", "timeZone", "tz"], fallbackTimeZone);

const getTimeZoneOffsetMs = (utcMs, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  return asUtc - utcMs;
};

/* ---------------------- log-first session building ---------------------- */
const sortLogsByEventTime = (logs = []) =>
  [...(Array.isArray(logs) ? logs : [])]
    .filter((l) => Number.isFinite(tsMs(getEventTs(l))))
    .sort((a, b) => tsMs(getEventTs(a)) - tsMs(getEventTs(b)));

const buildSessionsFromLogs = (
  logs = [],
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago"
) => {
  const sorted = sortLogsByEventTime(logs);
  const sessions = [];
  let openSession = null;

  for (const log of sorted) {
    const eventTs = getEventTs(log);
    if (!eventTs) continue;

    if (isIn(log)) {
      if (openSession) {
        sessions.push(openSession);
      }

      openSession = {
        dayKey: dayKeyFromTs(eventTs, attendanceResetTime, businessTimeZone),
        logs: [log],
        inLog: log,
        outLog: null,
      };
      continue;
    }

    if (isClockedOutLog(log)) {
      if (openSession) {
        openSession.logs.push(log);
        openSession.outLog = log;
        sessions.push(openSession);
        openSession = null;
      } else {
        sessions.push({
          dayKey: dayKeyFromTs(eventTs, attendanceResetTime, businessTimeZone),
          logs: [log],
          inLog: null,
          outLog: log,
        });
      }
    }
  }

  if (openSession) {
    sessions.push(openSession);
  }

  return sessions;
};

/* ---------------------- best in/out log selection ----------------------- */
const bestTimeInLog = (sorted) => {
  const inLog = sorted.find((l) => isValidTs(l) && isIn(l));
  if (inLog) return inLog;
  return sorted.find((l) => isValidTs(l)) || null;
};

const bestTimeOutLog = (sorted) => {
  const outLog = [...sorted].reverse().find((l) => isClockedOutLog(l));
  if (outLog) return outLog;
  return null;
};

const getDiffRawFromLogs = (sorted = []) => {
  const inLog = sorted.find((l) => isIn(l)) || null;
  const outLog = [...sorted].reverse().find((l) => isClockedOutLog(l)) || null;

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

const normalizeStatusFromLogs = (logs = []) => {
  const statuses = logs
    .map((l) => safeLower(getRawStatus(l)).trim())
    .filter(Boolean);

  if (!statuses.length) return "";

  if (statuses.some((s) => s.includes("no schedule"))) return "No Schedule";
  if (statuses.some((s) => s === "ncns" || s.includes("no show"))) return "No Show";
  if (statuses.some((s) => s.includes("day off") || s.includes("rest day"))) return "Day Off";
  if (statuses.some((s) => s.includes("holiday"))) return "Holiday";
  if (statuses.some((s) => s.includes("leave"))) return "Leave";
  if (statuses.some((s) => s.includes("vacation"))) return "Vacation";
  if (statuses.some((s) => s.includes("absent"))) return "Absent";
  if (statuses.some((s) => s.includes("on break"))) return "On Break";
  if (statuses.some((s) => s.includes("completed") || s.includes("complete"))) return "Completed";
  if (statuses.some((s) => s.includes("late"))) return "Late";
  if (statuses.some((s) => s.includes("early out"))) return "Early Out";
  if (statuses.some((s) => s.includes("early in"))) return "Early In";
  if (statuses.some((s) => s.includes("on time"))) return "On Time";
  if (statuses.some((s) => s.includes("present"))) return "Present";

  return toTitle(statuses[0]);
};

/* --------------------------- worked minutes ----------------------------- */
const computeWorkedMinutes = (logs) => {
  const arr = Array.isArray(logs) ? logs : [];
  if (!arr.length) return null;

  const sorted = sortLogsByEventTime(arr);

  const inLog = sorted.find((l) => isIn(l)) || null;
  const outLog = [...sorted].reverse().find((l) => isClockedOutLog(l)) || null;

  if (!inLog || !outLog) return null;

  const start = tsMs(getEventTs(inLog));
  const end = tsMs(getEventTs(outLog));

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

  const totalMinutesBetweenInOut = Math.round((end - start) / 60000);

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

/* ---------------------- build FULL HISTORY table rows ---------------------- */
const buildHistoryRows = (
  logs = [],
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago"
) => {
  const sessions = buildSessionsFromLogs(logs, attendanceResetTime, businessTimeZone);
  if (!sessions.length) return [];

  const rows = sessions.map((session) => {
    const sorted = sortLogsByEventTime(session.logs || []);
    const inLog = session.inLog || sorted.find((l) => isIn(l)) || null;
    const outLog = session.outLog || [...sorted].reverse().find((l) => isClockedOutLog(l)) || null;

    const inTs = inLog ? getEventTs(inLog) : "";
    const outTs = outLog ? getEventTs(outLog) : "";

    const inStatus = inLog ? getRawStatus(inLog) : "";
    const outStatus = outLog ? "Complete" : "-";

    const diffRaw = getDiffRawFromLogs(sorted);
    const diffText = String(diffRaw ?? "").trim();

    const difference =
      diffText !== "" && diffText.startsWith("-")
        ? `${diffText.slice(1)}m`
        : diffText !== "" && !Number.isNaN(Number(diffText))
          ? `${diffText}m`
          : "-";

    const durationMin = computeWorkedMinutes(sorted);
    const duration = durationMin == null ? "-" : minutesToHrsMinText(durationMin);

    const notes =
      pick(inLog || {}, ["notes"], "") ||
      pick(outLog || {}, ["notes"], "") ||
      "-";

    return {
      key: `${session.dayKey}:${pick(inLog || outLog || {}, ["id"], Math.random().toString(36))}`,
      date: prettyDate(session.dayKey, businessTimeZone),
      day: prettyDayName(session.dayKey, businessTimeZone),
      inTime: inTs ? formatTimeOnly(inTs, VIEWER_TIME_ZONE) : "-",
      inStatus: inStatus || (inTs ? "Logged" : "-"),
      difference,
      outTime: outTs ? formatTimeOnly(outTs, VIEWER_TIME_ZONE) : "-",
      outStatus,
      duration,
      notes,
      dayKey: session.dayKey,
    };
  });

  rows.sort((a, b) => String(b.dayKey).localeCompare(String(a.dayKey)));
  return rows;
};

/* ------------------------ schedule helpers ------------------------ */
const getScheduleItemForDay = (
  schedulesByUserId,
  userId,
  dayKey,
  fallbackTimeZone = "UTC"
) => {
  const sched = schedulesByUserId?.[String(userId)];
  if (!Array.isArray(sched) || sched.length === 0) return null;

  for (const item of sched) {
    const tz = getScheduleTimeZone(item, fallbackTimeZone);
    const targetWeekday = getWeekdayInTimeZoneFromYmd(dayKey, tz);
    const itemWeekday = safeLower(pick(item, ["dayOfWeek", "day", "weekday"], ""));
    if (itemWeekday === targetWeekday) return item;
  }

  return null;
};

const getScheduledStartUtcMsForDayKey = (
  scheduleItem,
  dayKey,
  fallbackTimeZone = "UTC"
) => {
  if (!scheduleItem || !dayKey) return NaN;

  const tz = getScheduleTimeZone(scheduleItem, fallbackTimeZone);
  const hhmm = pick(scheduleItem, ["timeIn", "startTime", "shiftStart"], "");

  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return NaN;

  const [hourStr, minuteStr] = hhmm.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return NaN;

  const [year, month, day] = String(dayKey)
    .split("-")
    .map((n) => Number(n));

  if (!year || !month || !day) return NaN;

  const approxUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMs = getTimeZoneOffsetMs(approxUtcMs, tz);

  return Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMs;
};

const getScheduleDurationMinutes = (scheduleItem) => {
  const durationHours = Number(
    pick(scheduleItem || {}, ["shiftDuration", "hours", "durationHours"], NaN)
  );
  return Number.isFinite(durationHours) ? Math.round(durationHours * 60) : 600;
};

const getApplicableScheduleCandidates = (
  schedulesByUserId,
  userId,
  dayKey,
  fallbackTimeZone = "UTC"
) => {
  const candidates = [];
  const prevDayKey = addDaysYmd(dayKey, -1);

  const sameDayItem = getScheduleItemForDay(
    schedulesByUserId,
    userId,
    dayKey,
    fallbackTimeZone
  );
  const prevDayItem = getScheduleItemForDay(
    schedulesByUserId,
    userId,
    prevDayKey,
    fallbackTimeZone
  );

  if (sameDayItem) {
    const startMs = getScheduledStartUtcMsForDayKey(
      sameDayItem,
      dayKey,
      fallbackTimeZone
    );
    const durationMinutes = getScheduleDurationMinutes(sameDayItem);

    candidates.push({
      scheduleItem: sameDayItem,
      sourceDayKey: dayKey,
      startMs,
      endMs: Number.isFinite(startMs)
        ? startMs + durationMinutes * 60_000
        : NaN,
    });
  }

  if (prevDayItem) {
    const startMs = getScheduledStartUtcMsForDayKey(
      prevDayItem,
      prevDayKey,
      fallbackTimeZone
    );
    const durationMinutes = getScheduleDurationMinutes(prevDayItem);

    candidates.push({
      scheduleItem: prevDayItem,
      sourceDayKey: prevDayKey,
      startMs,
      endMs: Number.isFinite(startMs)
        ? startMs + durationMinutes * 60_000
        : NaN,
    });
  }

  return candidates;
};

const resolveDailyStatus = ({
  userId,
  dayKey,
  dayLogs,
  schedulesByUserId,
  endDate,
  businessTimeZone = "UTC",
}) => {
  const logs = Array.isArray(dayLogs) ? dayLogs : [];
  const hasLogs = logs.length > 0;

  if (hasLogs) {
    const rawStatus = normalizeStatusFromLogs(logs);
    if (rawStatus) return rawStatus;

    if (logs.some((l) => isNcnsInLog(l))) {
      return "No Show";
    }

    const hasIn = logs.some((l) => isIn(l));
    const hasOut = logs.some((l) => isClockedOutLog(l));

    if (hasOut) return "Completed";
    if (hasIn) return "Live";

    return "Logged";
  }

  /* schedule fallback only when there are zero logs */
  const schedArr = schedulesByUserId?.[String(userId)];
  const hasAnySchedule = Array.isArray(schedArr) && schedArr.length > 0;

  if (!hasAnySchedule) return "No Schedule";

  const candidates = getApplicableScheduleCandidates(
    schedulesByUserId,
    userId,
    dayKey,
    businessTimeZone
  );

  if (!candidates.length) return "Day Off";

  const sameDayCandidate = candidates.find((c) => c.sourceDayKey === dayKey) || null;

  /* Off day: no schedule assigned for this exact day */
  if (!sameDayCandidate) return "Day Off";
  if (!Number.isFinite(sameDayCandidate.startMs)) return "Day Off";

  /* Scheduled only applies to the current business day */
  if (String(dayKey) === String(endDate || "")) {
    return "Scheduled";
  }

  return "No Log";
};

export default function AttendancePage({
  employees = [],
  rangeOptions = [1, 2, 7, 14, 30],
  rangeDays = 1,
  setRangeDays,
  startDate,
  endDate,
  logsByUserId = {},
  errorsByUserId = {},
  schedulesByUserId = {},
  loading = false,
  error = "",
  onReload,
  onFetchFullHistory,
  historyByUserId = {},
  loadingHistoryByUserId = {},
  historyErrorByUserId = {},
  activeBreaksByUserId = {},
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago",
  pageData = null,
}) {
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRow, setDrawerRow] = useState(null);

  const [historyLimit, setHistoryLimit] = useState(30);

  const openDrawer = (row) => {
    setDrawerRow(row);
    setHistoryLimit(30);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => setDrawerRow(null), 220);
  };

  const validEmployees = useMemo(
    () => (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e)),
    [employees]
  );
  const profileImagesByUserId =
    pageData?.profileImagesByUserId && typeof pageData.profileImagesByUserId === "object"
      ? pageData.profileImagesByUserId
      : {};

  const dateKeys = useMemo(() => enumerateYmdRange(startDate, endDate), [startDate, endDate]);
  const perUserErrorCount = Object.keys(errorsByUserId || {}).length;

  const rows = useMemo(() => {
    const out = [];

    for (const emp of validEmployees) {
      const userId = String(getUserId(emp));
      const name = getDisplayName(emp);
      const email = pick(emp || {}, ["email"], "");
      const mappedProfileImage = String(profileImagesByUserId?.[userId] || "").trim();
      const profileImage = mappedProfileImage || getProfileImageUrl(emp);

      const logs = Array.isArray(logsByUserId?.[userId]) ? logsByUserId[userId] : [];
      const byDay = groupLogsByBusinessDay(logs, attendanceResetTime, businessTimeZone);

      for (const dayKey of dateKeys) {
        const arr = byDay.get(dayKey) || [];
        const timedLogs = sortLogsByEventTime(arr);

        const timeInLog = timedLogs.length ? bestTimeInLog(timedLogs) : null;
        const timeOutLog = timedLogs.length ? bestTimeOutLog(timedLogs) : null;

        const timeInTs = timeInLog ? getEventTs(timeInLog) : "";
        const timeOutTs = timeOutLog ? getEventTs(timeOutLog) : "";
        const totalMinutes = timedLogs.length ? computeWorkedMinutes(timedLogs) : null;

        const schedItem = getScheduleItemForDay(
          schedulesByUserId,
          userId,
          dayKey,
          businessTimeZone
        );
        const schedTz = getScheduleTimeZone(schedItem, businessTimeZone);

        const tzSource = timeInLog || timeOutLog || timedLogs[0] || arr[0] || {};
        const logDeviceTz = pick(tzSource, ["deviceTimezone", "deviceTZ"], "");
        const logSchedTz = pick(tzSource, ["scheduleTimezone", "scheduleTZ"], "");

        const deviceTz = logDeviceTz || VIEWER_TIME_ZONE;

        const baseStatus = resolveDailyStatus({
          userId,
          dayKey,
          dayLogs: arr,
          schedulesByUserId,
          endDate,
          businessTimeZone,
        });

        const isOnBreak = !!activeBreaksByUserId?.[userId];
        const status =
          isOnBreak && dayKey === endDate && safeLower(baseStatus) === "live"
            ? "On Break"
            : baseStatus;

        out.push({
          key: `${userId}:${dayKey}`,
          userId,
          name,
          email,
          profileImg: profileImage,
          dayKey,
          status,
          timeInTs,
          timeOutTs,
          totalMinutes,
          deviceTz,
          schedTz: logSchedTz || schedTz,
          businessTz: businessTimeZone,
          rawLogs: arr,
        });
      }
    }

    out.sort((a, b) => {
      const d = String(b.dayKey).localeCompare(String(a.dayKey));
      if (d !== 0) return d;
      return a.name.localeCompare(b.name);
    });

    return out;
  }, [
    logsByUserId,
    validEmployees,
    schedulesByUserId,
    dateKeys,
    activeBreaksByUserId,
    endDate,
    attendanceResetTime,
    businessTimeZone,
    profileImagesByUserId,
  ]);

  const visibleRows = useMemo(() => {
    if (Number(rangeDays) === 1) return rows.filter((r) => r.dayKey === endDate);
    return rows;
  }, [rows, rangeDays, endDate]);

  const filtered = useMemo(() => {
    const q = safeLower(query).trim();
    if (!q) return visibleRows;
    return visibleRows.filter(
      (r) =>
        safeLower(r.name).includes(q) ||
        safeLower(r.email).includes(q) ||
        safeLower(r.userId).includes(q) ||
        safeLower(r.dayKey).includes(q) ||
        safeLower(r.status).includes(q)
    );
  }, [visibleRows, query]);

  const kpis = useMemo(() => {
    const total = visibleRows.length;
    const completed = visibleRows.filter((r) => safeLower(r.status) === "completed").length;
    const live = visibleRows.filter((r) => safeLower(r.status) === "live").length;
    const onBreak = visibleRows.filter((r) => safeLower(r.status) === "on break").length;
    const absent = visibleRows.filter((r) => safeLower(r.status) === "no show").length;
    const noSchedule = visibleRows.filter((r) => safeLower(r.status) === "no schedule").length;

    return { total, completed, live, onBreak, absent, noSchedule };
  }, [visibleRows]);

  useEffect(() => {
    const uid = drawerRow?.userId ? String(drawerRow.userId) : null;
    if (!drawerOpen || !uid || !onFetchFullHistory) return;
    onFetchFullHistory(uid);
  }, [drawerOpen, drawerRow, onFetchFullHistory]);

  const drawerHistoryLogs = useMemo(() => {
    const uid = drawerRow?.userId ? String(drawerRow.userId) : null;
    if (!uid) return [];
    return Array.isArray(historyByUserId?.[uid]) ? historyByUserId[uid] : [];
  }, [drawerRow, historyByUserId]);

  const drawerHistoryRows = useMemo(
    () => buildHistoryRows(drawerHistoryLogs, attendanceResetTime, businessTimeZone),
    [drawerHistoryLogs, attendanceResetTime, businessTimeZone]
  );

  const drawerHistoryLoading = useMemo(() => {
    const uid = drawerRow?.userId ? String(drawerRow.userId) : null;
    return uid ? !!loadingHistoryByUserId?.[uid] : false;
  }, [drawerRow, loadingHistoryByUserId]);

  const drawerHistoryError = useMemo(() => {
    const uid = drawerRow?.userId ? String(drawerRow.userId) : null;
    return uid ? historyErrorByUserId?.[uid] || "" : "";
  }, [drawerRow, historyErrorByUserId]);

  return (
    <div className="attx">
      <div className="attxTop">
        <div className="attxTopRight">
          <div className="attxControls">
            <button id="badeng" className="attxBtn" onClick={onReload} disabled={loading}>
              {loading ? "Loading..." : "Reload"}
            </button>

            <div className="attxPill">
              Rows: <span className="attxPillValue">{filtered.length}</span>
            </div>
          </div>
        </div>
      </div>

      {error && <div className="attxAlert">{error}</div>}

      <div className="attxKpis">
        <div className="attxTile">
          <div className="attxTileLabel">Rows</div>
          <div className="attxTileValue">{kpis.total}</div>
          <div className="attxTileHint">One per employee per workday</div>
        </div>

        <div className="attxTile">
          <div className="attxTileLabel">Absent</div>
          <div className="attxTileValue">{kpis.absent}</div>
          <div className="attxTileHint">Only when API IN status is NCNS</div>
        </div>

        <div className="attxTile">
          <div className="attxTileLabel">Live</div>
          <div className="attxTileValue">{kpis.live}</div>
          <div className="attxTileHint">Has time-in, no time-out</div>
        </div>

        <div className="attxTile">
          <div className="attxTileLabel">On Break</div>
          <div className="attxTileValue">{kpis.onBreak}</div>
          <div className="attxTileHint">Active break override for today</div>
        </div>

        <div className="attxTile">
          <div className="attxTileLabel">Completed</div>
          <div className="attxTileValue">{kpis.completed}</div>
          <div className="attxTileHint">Has time-out</div>
        </div>
      </div>

      <div className="attxField">
        <div className="attxField1">
          <div className="attxLabel">Search</div>
          <input
            className="attxInput"
            placeholder="Search name / email / userId / date / status..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="badenggg">
          Showing: {startDate} -&gt; {endDate} ({rangeDays === 1 ? "Today" : `Last ${rangeDays} days`})
          <div>
            {rangeOptions.map((n) => (
              <button
                key={n}
                type="button"
                className={`attxBtn ${rangeDays === n ? "active" : ""}`}
                onClick={() => setRangeDays?.(n)}
                disabled={loading}
                title={n === 1 ? "Today" : n === 2 ? "Yesterday -> Today" : `Last ${n} days`}
              >
                {n}
              </button>
            ))}

            <button
              type="button"
              className="attxBtn"
              onClick={() => setRangeDays?.((d) => Math.max(1, d - 1))}
              disabled={loading}
              title="Decrease range"
            >
              -
            </button>

            <button
              type="button"
              className="attxBtn"
              onClick={() => setRangeDays?.((d) => Math.min(60, d + 1))}
              disabled={loading}
              title="Increase range"
            >
              +
            </button>

            <div className="attxPill attxPillToday">
              Today: <span className="attxPillValue">{endDate}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="attxCard">
        <div className="attxCardHead">
          <div className="attxTitleWrap attxTitleWrapCard">
            <div className="attxTitle attxTitleCard">Attendance</div>
            <div className="attxSub attxSubCard">
              Range: {startDate} -&gt; {endDate}  |  Users: {validEmployees.length}
              {perUserErrorCount ? `  |  Errors: ${perUserErrorCount}` : ""}
            </div>
          </div>
          <div className="attxCardMetaWrap">
            <div className="attxCardTitle">Daily Attendance</div>
            <div className="attxCardMeta">
              Showing {filtered.length} of {visibleRows.length}
            </div>
          </div>
        </div>

        <div className="attxTableWrap">
          <table className="attxTable">
            <thead>
              <tr>
                <th>User</th>
                <th>Date</th>
                <th>Status</th>
                <th>Time In</th>
                <th>Time Out</th>
                <th>Total Hours</th>
                <th>Timezones</th>
                <th>Details</th>
              </tr>
            </thead>

            <tbody>
              {validEmployees.length === 0 && !loading && !error ? (
                <tr>
                  <td colSpan={8} className="attxTableEmpty">
                    No employees found (or userId not detected).
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="attxTableEmpty">
                    No rows match your search/range.
                  </td>
                </tr>
              ) : (
                filtered.slice(0, 400).map((r) => (
                  <tr className="attxTr" key={r.key}>
                    <td>
                      <div className="attxPerson">
                        <div className="attxAvatar" aria-label={r.name}>
                          {r.profileImg ? (
                            <img
                              src={r.profileImg}
                              alt={`${r.name} profile`}
                              className="attxAvatarImg"
                              loading="lazy"
                            />
                          ) : (
                            initials(r.name)
                          )}
                        </div>
                        <div>
                          <div className="attxName">{r.name}</div>
                          <div className="attxEmail">{r.email || r.userId}</div>
                        </div>
                      </div>
                    </td>

                    <td>
                      <span className="chip mid">{r.dayKey}</span>
                    </td>

                    <td>
                      <span className={`attxBadge ${statusBadgeClass(r.status)}`}>
                        <span className="attxDot" />
                        {r.status}
                      </span>
                    </td>

                    <td>{formatTs(r.timeInTs, r.deviceTz)}</td>
                    <td>{formatTs(r.timeOutTs, r.deviceTz)}</td>

                    <td>
                      {r.totalMinutes == null ? (
                        <span className="chip mid">-</span>
                      ) : (
                        <span className="chip good">{minutesToHrsMinText(r.totalMinutes)}</span>
                      )}
                    </td>

                    <td>
                      <div className="attxTzView">View: {r.deviceTz}</div>
                      <div className="attxEmail">Sched: {r.schedTz || "-"}</div>
                      <div className="attxEmail">Biz: {r.businessTz}</div>
                    </td>

                    <td>
                      <button className="attxExpand" type="button" onClick={() => openDrawer(r)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {loading && (
            <div className="attxLoadingOverlay" role="status" aria-live="polite">
              <div className="attxLoadingModal">
                <div className="attxSpinner" />
                <div className="attxLoadingText">Fetching attendance logs...</div>
                <div className="attxLoadingSub">
                  Range: {startDate} -&gt; {endDate}  |  Users: {validEmployees.length}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {drawerOpen && (
        <div
          className="attxDrawerBackdrop"
          onClick={closeDrawer}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Escape" && closeDrawer()}
        />
      )}

      <div className={`attxDrawer ${drawerOpen ? "open" : ""}`} role="dialog" aria-modal="true">
        <div className="attxDrawerHead">
          <div className="attxDrawerIdentity">
            <div className="attxDrawerTitle">Attendance Records</div>
            <div className="attxDrawerPerson">
              <div className="attxAvatar" aria-label={drawerRow?.name || "Employee"}>
                {drawerRow?.profileImg ? (
                  <img
                    src={drawerRow.profileImg}
                    alt={`${drawerRow?.name || "Employee"} profile`}
                    className="attxAvatarImg"
                    loading="lazy"
                  />
                ) : (
                  initials(drawerRow?.name || "")
                )}
              </div>
              <div className="attxDrawerMeta">
                <div className="attxDrawerName">{drawerRow?.name || "-"}</div>
                <div className="attxDrawerSub">{drawerRow?.email || drawerRow?.userId || "-"}</div>
              </div>
            </div>
          </div>

          <button className="attxDrawerClose" type="button" onClick={closeDrawer}>
            X
          </button>
        </div>

        <div className="attxDrawerBody">
          <div className="attxHistoryTop">
            <div className="attxHistoryMeta">
              {drawerHistoryLoading
                ? "Loading history..."
                : `Showing ${Math.min(historyLimit, drawerHistoryRows.length)} of ${drawerHistoryRows.length} records`}
            </div>

            {drawerHistoryError ? (
              <div className="attxAlert attxAlertFlat">
                {drawerHistoryError}
              </div>
            ) : null}
          </div>

          <div className="attxHistoryTableWrap">
            <table className="attxHistoryTable">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Day</th>
                  <th colSpan={3}>IN</th>
                  <th colSpan={3}>OUT</th>
                  <th>Notes</th>
                </tr>
                <tr>
                  <th />
                  <th />
                  <th>Time</th>
                  <th>Status</th>
                  <th>Difference</th>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th />
                </tr>
              </thead>

              <tbody>
                {drawerHistoryLoading ? (
                  <tr>
                    <td colSpan={9} className="attxHistoryEmpty">
                      Fetching full attendance history...
                    </td>
                  </tr>
                ) : drawerHistoryRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="attxHistoryEmpty">
                      No attendance records found.
                    </td>
                  </tr>
                ) : (
                  drawerHistoryRows.slice(0, historyLimit).map((r) => (
                    <tr key={r.key}>
                      <td>{r.date}</td>
                      <td>{r.day}</td>
                      <td className="attxHistTime">{r.inTime}</td>
                      <td>
                        <span className={`attxHistPill ${statusBadgeClass(r.inStatus)}`}>{r.inStatus}</span>
                      </td>
                      <td>{r.difference}</td>
                      <td className="attxHistTime">{r.outTime}</td>
                      <td>
                        <span className={`attxHistPill ${r.outStatus === "Complete" ? "done" : "warn"}`}>
                          {r.outStatus}
                        </span>
                      </td>
                      <td>{r.duration}</td>
                      <td className="attxHistoryNotes">{r.notes}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {!drawerHistoryLoading && drawerHistoryRows.length > historyLimit && (
            <div className="attxHistoryMore">
              <button className="attxBtn" type="button" onClick={() => setHistoryLimit((n) => n + 30)}>
                Load more
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

