import { pick, safeLower } from "./common";
import { isClockedOutLog, isIn } from "./attendanceLog";
import { resolveScheduleItemForInstant, resolveScheduledStartUtcMsForDayKey } from "./scheduleTime";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const weekdayNameFromYmd = (yyyyMmDd) => {
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAYS[d.getUTCDay()];
};

export const getRawAttendanceStatus = (log) =>
  safeLower(pick(log || {}, ["status", "attendanceStatus", "dailyStatus", "remark"], "")).trim();

const getScheduleItemForDay = (schedulesByUserId, userId, dayKey) => {
  const sched = schedulesByUserId?.[String(userId)];
  if (!Array.isArray(sched) || sched.length === 0) return null;

  const targetWeekday = weekdayNameFromYmd(dayKey);
  if (!targetWeekday) return null;

  const matches = sched.filter(
    (s) => safeLower(pick(s, ["dayOfWeek", "day", "weekday"], "")) === targetWeekday
  );
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];

  // Split-shift days can have more than one schedule row for the same
  // weekday (e.g. a morning block and a separate evening block). Use
  // whichever starts earliest so a missed first shift still surfaces as
  // "No Show" instead of being masked by a later shift's later start time.
  return matches
    .slice()
    .sort((a, b) => {
      const aStart = resolveScheduledStartUtcMsForDayKey(a, dayKey);
      const bStart = resolveScheduledStartUtcMsForDayKey(b, dayKey);
      const aOk = Number.isFinite(aStart);
      const bOk = Number.isFinite(bStart);
      if (aOk && bOk) return aStart - bStart;
      if (aOk) return -1;
      if (bOk) return 1;
      return 0;
    })[0];
};

const getScheduledStartUtcMsForDayKey = (scheduleItem, dayKey, businessTimeZone = "America/Chicago") =>
  resolveScheduledStartUtcMsForDayKey(scheduleItem, dayKey, businessTimeZone);

const computeBaseDailyStatus = ({
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
    if (statuses.some((s) => s.includes("absent"))) {
      return "Absent";
    }
    if (statuses.some((s) => s.includes("pto") || s.includes("leave") || s.includes("vacation"))) {
      return "PTO";
    }
    if (statuses.some((s) => s.includes("holiday"))) {
      return "Holiday";
    }
    if (statuses.some((s) => s.includes("day off") || s.includes("rest day"))) {
      return "Day Off";
    }

    const hasOut = logs.some((l) => isClockedOutLog(l));
    const hasIn = logs.some((l) => isIn(l));

    if (hasOut) return "Completed";
    if (statuses.some((s) => s.includes("completed") || s.includes("complete"))) return "Completed";
    if (statuses.some((s) => s.includes("on break"))) return "On Break";
    if (hasIn || statuses.some((s) => s.includes("live"))) return "Live";
    if (
      statuses.some(
        (s) =>
          s.includes("present") ||
          s.includes("on time") ||
          s.includes("on-time") ||
          s.includes("ontime") ||
          s.includes("early") ||
          s.includes("late")
      )
    ) {
      return "Live";
    }

    if (statuses.some((s) => s.includes("scheduled"))) {
      return "Scheduled";
    }

    return "No Log";
  }

  const schedArr = schedulesByUserId?.[String(userId)];
  const hasAnySchedule = Array.isArray(schedArr) && schedArr.length > 0;
  if (!hasAnySchedule) return "No Schedule";

  const todayKey = String(endDate || "");
  const isLiveToday = dayKey === todayKey;

  // Live "today" must be resolved per-schedule-row timezone against the actual current
  // instant, since the viewing device's own timezone may differ from the row's.
  const liveMatch = isLiveToday ? resolveScheduleItemForInstant(schedArr, nowMs) : null;
  const schedItem = isLiveToday
    ? liveMatch?.scheduleItem || null
    : getScheduleItemForDay(schedulesByUserId, userId, dayKey);
  if (!schedItem) return "Day Off";

  const startMs = isLiveToday
    ? liveMatch.startMs
    : getScheduledStartUtcMsForDayKey(schedItem, dayKey, businessTimeZone);
  const GRACE_MS = 2 * 60 * 60 * 1000;
  if (!Number.isFinite(startMs)) return "Scheduled";

  const endOfDayMs = new Date(`${dayKey}T23:59:59.999Z`).getTime();
  const referenceNow = isLiveToday ? nowMs : endOfDayMs;

  return referenceNow >= startMs + GRACE_MS ? "No Show" : "Scheduled";
};

// Single source of truth for "today's attendance status" label - shared by
// the dashboard's Team Attendance grid and the Inbound/New Lead panel, which
// must show byte-identical status text for the same employee at the same
// instant. Do not fork this logic; import it wherever a per-day attendance
// status string is needed.
//
// isOnBreak is the live break-tracking flag (activeBreaksByUserId), which is
// a separate system from attendance logs - starting/ending a break never
// writes "on break" into a log's status text, so the base computation above
// can only catch it if something else happens to have stamped that text.
// This overlay (matching the same pattern already used in AttendancePage.jsx
// and ManageEmployee.jsx) is what actually makes a real, live break show up
// as "On Break" today instead of "Live".
export const resolveDailyStatus = ({ isOnBreak = false, ...args }) => {
  const baseLabel = computeBaseDailyStatus(args);
  const isToday = String(args.dayKey || "") === String(args.endDate || "");

  if (isOnBreak && isToday && baseLabel === "Live") {
    return "On Break";
  }

  return baseLabel;
};
