import React, { useEffect, useMemo, useRef, useState } from "react";
import "./employee_dashboard.css";
import { startBreak, endBreak, DAILY_BREAK_LIMIT_MINUTES } from "../services/breakService";
import ConfirmModal from "./ConfirmModal";
import {
  getScheduleTimeZone,
  resolveScheduledDurationMinutes,
  resolveScheduledEndUtcMsForDayKey,
  resolveScheduledStartUtcMsForDayKey,
} from "../utils/scheduleTime";
import { getDisplayName, getProfileImageUrl, getUserId, pick, toMillis, toText } from "../utils/common";

/* ----------------------------- helpers ----------------------------- */
const buildFallbackHeadline = (text) => {
  const raw = toText(text);
  if (!raw) return "Announcement";
  return raw.length > 64 ? `${raw.slice(0, 64)}...` : raw;
};

const normalize = (value = "") => String(value || "").trim().toLowerCase();

const truncateText = (value = "", maxLen = 120) => {
  const raw = toText(value);
  if (!raw) return "";
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, Math.max(1, maxLen)).trimEnd()}...`;
};

const initialsFromName = (value = "") => {
  const parts = toText(value).split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
};

const toDateOnly = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

const getTaskDaysUntilDeadline = (deadlineDate) => {
  const ymd = toDateOnly(deadlineDate);
  if (!ymd) return null;

  const todayYmd = new Date().toISOString().slice(0, 10);
  const todayStart = new Date(`${todayYmd}T00:00:00`).getTime();
  const dueStart = new Date(`${ymd}T00:00:00`).getTime();
  if (!Number.isFinite(todayStart) || !Number.isFinite(dueStart)) return null;

  return Math.floor((dueStart - todayStart) / 86400000);
};

const formatTaskStatusLabel = (status = "") => {
  const raw = String(status || "").trim();
  if (!raw) return "Pending";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
};

const getTaskStatusMeta = (task = {}) => {
  const status = normalize(task?.status).replace(/\s+/g, "_");
  if (status === "completed") return { label: "Completed", tone: "completed" };
  if (status === "to_be_check") return { label: "To Be Check", tone: "review" };

  const days = getTaskDaysUntilDeadline(task?.deadlineDate);
  if (Number.isFinite(days) && days < 0) return { label: "Overdue", tone: "overdue" };
  if (days === 0) return { label: "Due Today", tone: "today" };
  if (days === 1) return { label: "Due Tomorrow", tone: "warning" };
  if (status === "in progress" || status === "in_progress") {
    return { label: "In Progress", tone: "inprogress" };
  }

  return { label: formatTaskStatusLabel(task?.status), tone: "pending" };
};

const getTaskDeadlineSortMs = (task = {}) => {
  const datePart = toDateOnly(task?.deadlineDate);
  if (!datePart) return Number.POSITIVE_INFINITY;

  const rawTime = String(task?.deadlineTime || "").trim();
  const timePart = /^\d{1,2}:\d{2}$/.test(rawTime) ? rawTime.padStart(5, "0") : "00:00";
  const ms = new Date(`${datePart}T${timePart}:00`).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
};

const getTaskDeadlineMonthKey = (task = {}, businessTimeZone = "America/Chicago") => {
  const datePart = toDateOnly(task?.deadlineDate);
  if (!datePart) return "";
  const ms = new Date(`${datePart}T12:00:00Z`).getTime();
  if (!Number.isFinite(ms)) return "";
  return monthKeyFromMsInZone(ms, businessTimeZone);
};

const getTaskAssigneeLabel = (task = {}) => {
  const assignees = Array.isArray(task?.assignees) ? task.assignees : [];
  const assigneeNames = assignees.map((row) => toText(row?.name)).filter(Boolean);
  if (assigneeNames.length > 0) return assigneeNames.join(", ");

  const employeeName = toText(task?.employeeName);
  if (employeeName) return employeeName;

  const assigneeIds = Array.isArray(task?.employeeUserIds)
    ? task.employeeUserIds.map((id) => toText(id)).filter(Boolean)
    : [];
  if (assigneeIds.length > 0) return assigneeIds.join(", ");

  const singleAssigneeId = toText(task?.employeeUserId);
  if (singleAssigneeId) return singleAssigneeId;

  return "Unassigned";
};

const formatTaskDeadlineLabel = (task = {}, businessTimeZone = "America/Chicago") => {
  const datePart = toDateOnly(task?.deadlineDate);
  if (!datePart) return "No deadline";

  const dueDate = new Date(`${datePart}T12:00:00Z`);
  const dateLabel = Number.isNaN(dueDate.getTime())
    ? datePart
    : dueDate.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
      });
  const timeLabel = String(task?.deadlineTime || "").trim();
  return timeLabel ? `${dateLabel} | ${timeLabel}` : dateLabel;
};

const pickTs = (log) => pick(log, ["timestamp", "createdAt", "time"], "");

const tsMs = (ts) => {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const getPartsInTimeZone = (dateLike, timeZone) => {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
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
  for (const p of parts) map[p.type] = p.value;

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
  };
};

const dayKeyFromTsInZone = (ts, timeZone) => {
  const parts = getPartsInTimeZone(ts, timeZone);
  if (!parts) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const monthKeyFromMsInZone = (ms, timeZone) => {
  const parts = getPartsInTimeZone(ms, timeZone);
  if (!parts) return "";
  return `${parts.year}-${parts.month}`;
};

const pad2 = (n) => String(n).padStart(2, "0");

const addHoursToHHMM = (hhmm, hoursToAdd) => {
  const [hRaw, mRaw] = String(hhmm || "").split(":").map(Number);
  const hrs = Number(hoursToAdd);

  if (!Number.isFinite(hRaw) || !Number.isFinite(mRaw) || !Number.isFinite(hrs)) {
    return { outHHMM: "-", dayOffset: 0 };
  }

  const startMin = hRaw * 60 + mRaw;
  const addMin = Math.round(hrs * 60);
  const total = startMin + addMin;

  const dayOffset = Math.floor(total / (24 * 60));
  const mod = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);

  const outH = Math.floor(mod / 60);
  const outM = mod % 60;

  return { outHHMM: `${pad2(outH)}:${pad2(outM)}`, dayOffset };
};

const getScheduleTimeIn = (item) =>
  pick(item, ["timeIn", "time_in", "startTime", "shiftStart", "start"], "-");

const getScheduleTimeOut = (item) =>
  pick(item, ["timeOut", "time_out", "endTime", "shiftEnd", "end"], "-");

const getScheduleTimeZoneRaw = (item) =>
  String(
    pick(item, ["timeRegion", "timezone", "timeZone", "tz", "scheduleTimezone", "scheduleTimeZone"], "")
  ).trim();

const getScheduleDurationHours = (item) => {
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

export default function EmployeeDashboard({
  employees = [],
  announcements = [],
  assignments = [],
  schedulesByUserId = {},
  logsByUserId = {},
  loadingAssignments = false,
  assignmentsError = "",
  onFetchFullHistory,
  historyByUserId = {},
  loadingHistoryByUserId = {},
  historyErrorByUserId = {},
  nowMs,
  endDate,
  businessTimeZone = "America/Chicago",
  selectedEmployeeId,
  onSelectEmployeeId,
  activeBreaksByUserId = {},
  breakUsageByUserId = {},
  onBreakStatusChanged,
  onOpenTaskDetails,
  pageData = null,
}) {
  const requestedHistoryRef = useRef(new Set());

  const employeeIds = useMemo(
    () =>
      (Array.isArray(employees) ? employees : [])
        .map((e) => String(getUserId(e) ?? ""))
        .filter(Boolean),
    [employees]
  );

  const [localSelectedId, setLocalSelectedId] = useState("");
  const [breakLoading, setBreakLoading] = useState(false);
  const [breakError, setBreakError] = useState("");
  const [breakConfirmAction, setBreakConfirmAction] = useState("");
  const [taskStatusFilter, setTaskStatusFilter] = useState("active");
  const [isTaskFilterOpen, setIsTaskFilterOpen] = useState(false);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const [selectedAnnouncement, setSelectedAnnouncement] = useState(null);
  const panelRef = useRef(null);
  const taskFilterDrawerRef = useRef(null);
  const [panelHeightPx, setPanelHeightPx] = useState(null);

  const viewerRole = normalize(
    pageData?.viewer?.role || pageData?.currentUser?.role || pageData?.user?.role || ""
  );

  const viewerUserId = String(
    pageData?.viewer?.userId ||
      pageData?.viewer?.uid ||
      pageData?.viewer?.id ||
      pageData?.currentUser?.userId ||
      pageData?.currentUser?.uid ||
      pageData?.currentUser?.id ||
      pageData?.user?.userId ||
      pageData?.user?.uid ||
      pageData?.user?.id ||
      ""
  ).trim();

  const lockedEmployeeId = useMemo(() => {
    if (viewerRole !== "employee") return "";
    if (!viewerUserId) return "";
    return employeeIds.find((id) => String(id) === viewerUserId) || viewerUserId;
  }, [viewerRole, viewerUserId, employeeIds]);

  const canSwitchEmployee = viewerRole !== "employee" && employeeIds.length > 1;

  const effectiveSelectedId = useMemo(() => {
    if (lockedEmployeeId) return lockedEmployeeId;

    const fromParent = String(selectedEmployeeId || "");
    if (fromParent) return fromParent;

    if (localSelectedId) return localSelectedId;

    return employeeIds[0] || "";
  }, [lockedEmployeeId, selectedEmployeeId, localSelectedId, employeeIds]);

  const setSelected = (id) => {
    const requestedId = String(id || "");

    const nextId = lockedEmployeeId
      ? lockedEmployeeId
      : canSwitchEmployee
        ? requestedId
        : employeeIds[0] || effectiveSelectedId || "";

    if (typeof onSelectEmployeeId === "function") {
      onSelectEmployeeId(nextId);
    } else {
      setLocalSelectedId(nextId);
    }
  };

  useEffect(() => {
    if (!lockedEmployeeId) return;

    if (String(selectedEmployeeId || "") !== lockedEmployeeId) {
      if (typeof onSelectEmployeeId === "function") {
        onSelectEmployeeId(lockedEmployeeId);
      } else {
        setLocalSelectedId(lockedEmployeeId);
      }
    }
  }, [lockedEmployeeId, selectedEmployeeId, onSelectEmployeeId]);

  const employee = useMemo(
    () =>
      (Array.isArray(employees) ? employees : []).find(
        (e) => String(getUserId(e) ?? "") === String(effectiveSelectedId)
      ) || null,
    [employees, effectiveSelectedId]
  );

  const announcementRows = useMemo(() => {
    if (Array.isArray(announcements) && announcements.length) return announcements;
    if (Array.isArray(pageData?.announcements)) return pageData.announcements;
    return Array.isArray(announcements) ? announcements : [];
  }, [announcements, pageData]);

  const assignmentRows = useMemo(() => {
    if (Array.isArray(assignments) && assignments.length) return assignments;
    if (Array.isArray(pageData?.assignments)) return pageData.assignments;
    return Array.isArray(assignments) ? assignments : [];
  }, [assignments, pageData]);

  const tasksLoading = !!loadingAssignments || !!pageData?.loading?.assignments;
  const tasksError = String(assignmentsError || pageData?.errors?.assignments || "").trim();
  const profileImagesByUserId =
    pageData?.profileImagesByUserId && typeof pageData.profileImagesByUserId === "object"
      ? pageData.profileImagesByUserId
      : {};
  const employeesByUserId = useMemo(() => {
    const map = new Map();
    for (const row of Array.isArray(employees) ? employees : []) {
      const userId = toText(getUserId(row));
      if (!userId) continue;
      map.set(userId, row);
    }
    return map;
  }, [employees]);

  const getTaskAssignees = (task = {}) => {
    const out = [];
    const seen = new Set();

    const pushAssignee = (rawUserId, rawName, rawImg) => {
      const userId = toText(rawUserId);
      const dedupeKey = userId || `name:${toText(rawName).toLowerCase()}`;
      if (dedupeKey && seen.has(dedupeKey)) return;
      if (dedupeKey) seen.add(dedupeKey);

      const employeeRow = userId ? employeesByUserId.get(userId) : null;
      const displayName =
        toText(rawName) || (employeeRow ? toText(getDisplayName(employeeRow)) : "") || userId || "Unassigned";
      const mappedProfileImg = userId ? toText(profileImagesByUserId?.[userId]) : "";
      const profileImg =
        toText(rawImg) ||
        mappedProfileImg ||
        (employeeRow ? getProfileImageUrl(employeeRow) : "");

      out.push({
        userId,
        name: displayName,
        profileImg,
      });
    };

    const assignees = Array.isArray(task?.assignees) ? task.assignees : [];
    for (const assignee of assignees) {
      pushAssignee(
        assignee?.userId || assignee?.employeeUserId || assignee?.uid || assignee?.id,
        assignee?.name || assignee?.employeeName || assignee?.displayName || assignee?.email,
        assignee?.profileImg || assignee?.profileImage || assignee?.profileImageUrl
      );
    }

    const assigneeIds = Array.isArray(task?.employeeUserIds)
      ? task.employeeUserIds.map((id) => toText(id)).filter(Boolean)
      : [];
    for (const id of assigneeIds) {
      pushAssignee(id, "", "");
    }

    const singleAssigneeId = toText(task?.employeeUserId);
    if (singleAssigneeId) pushAssignee(singleAssigneeId, "", "");

    const taskEmployeeName = toText(task?.employeeName);
    if (taskEmployeeName && out.length === 0) {
      pushAssignee("", taskEmployeeName, "");
    }

    if (out.length === 0) {
      out.push({
        userId: "",
        name: "Unassigned",
        profileImg: "",
      });
    }

    return out;
  };

  const employeeTasks = useMemo(() => {
    const rows = (Array.isArray(assignmentRows) ? assignmentRows : [])
      .slice()
      .sort((a, b) => {
        const aCompleted = normalize(a?.status) === "completed";
        const bCompleted = normalize(b?.status) === "completed";
        if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

        const aDue = getTaskDeadlineSortMs(a);
        const bDue = getTaskDeadlineSortMs(b);
        if (aDue !== bDue) return aDue - bDue;

        const aUpdated = toMillis(a?.updatedAt) || toMillis(a?.createdAt) || 0;
        const bUpdated = toMillis(b?.updatedAt) || toMillis(b?.createdAt) || 0;
        return bUpdated - aUpdated;
      });

    return rows;
  }, [assignmentRows]);

  const filteredEmployeeTasks = useMemo(() => {
    const list = Array.isArray(employeeTasks) ? employeeTasks : [];
    if (taskStatusFilter === "thisMonth") {
      const currentMonthKey = monthKeyFromMsInZone(nowMs || Date.now(), businessTimeZone);
      if (!currentMonthKey) return [];
      return list.filter((task) => getTaskDeadlineMonthKey(task, businessTimeZone) === currentMonthKey);
    }
    if (taskStatusFilter === "completed") {
      return list.filter((task) => normalize(task?.status) === "completed");
    }
    if (taskStatusFilter === "active") {
      return list.filter((task) => normalize(task?.status) !== "completed");
    }
    return list;
  }, [employeeTasks, taskStatusFilter, nowMs, businessTimeZone]);

  const taskFilterCounts = useMemo(() => {
    const list = Array.isArray(employeeTasks) ? employeeTasks : [];
    const completed = list.filter((task) => normalize(task?.status) === "completed").length;
    const currentMonthKey = monthKeyFromMsInZone(nowMs || Date.now(), businessTimeZone);
    const thisMonth = currentMonthKey
      ? list.filter((task) => getTaskDeadlineMonthKey(task, businessTimeZone) === currentMonthKey)
          .length
      : 0;
    const all = list.length;
    return {
      all,
      active: Math.max(0, all - completed),
      completed,
      thisMonth,
    };
  }, [employeeTasks, nowMs, businessTimeZone]);

  const TASK_FILTER_OPTIONS = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "completed", label: "Completed" },
    { key: "thisMonth", label: "This Month" },
  ];
  const activeTaskFilterLabel =
    TASK_FILTER_OPTIONS.find((option) => option.key === taskStatusFilter)?.label || "Active";

  const handleTaskFilterSelect = (nextFilter) => {
    setTaskStatusFilter(String(nextFilter || "active"));
    setIsTaskFilterOpen(false);
  };

  useEffect(() => {
    if (!isTaskFilterOpen) return;

    const handlePointerDown = (event) => {
      if (!taskFilterDrawerRef.current) return;
      if (taskFilterDrawerRef.current.contains(event.target)) return;
      setIsTaskFilterOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") setIsTaskFilterOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isTaskFilterOpen]);

  useEffect(() => {
    const uid = String(effectiveSelectedId || "");
    if (!uid || !onFetchFullHistory) return;

    const existing = Array.isArray(historyByUserId?.[uid]) && historyByUserId[uid].length > 0;
    const loading = !!loadingHistoryByUserId?.[uid];

    if (existing || loading || requestedHistoryRef.current.has(uid)) return;

    requestedHistoryRef.current.add(uid);
    Promise.resolve(onFetchFullHistory(uid)).catch(() => {
      requestedHistoryRef.current.delete(uid);
    });
  }, [effectiveSelectedId, onFetchFullHistory, historyByUserId, loadingHistoryByUserId]);

  const todaySchedule = useMemo(() => {
    const sched = schedulesByUserId?.[String(effectiveSelectedId)];
    if (!Array.isArray(sched) || sched.length === 0) return null;

    const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    const weekdayNameFromYmd = (yyyyMmDd) => {
      const d = new Date(`${yyyyMmDd}T12:00:00Z`);
      if (Number.isNaN(d.getTime())) return null;
      return WEEKDAYS[d.getUTCDay()];
    };

    const targetWeekday = weekdayNameFromYmd(endDate);
    if (!targetWeekday) return null;

    const todayItem =
      sched.find(
        (s) =>
          String(pick(s, ["dayOfWeek", "day", "weekday"], "")).toLowerCase() === targetWeekday
      ) || null;

    if (!todayItem) return null;

    const utcTimeIn = pick(todayItem, ["utcTimeIn", "utcStart", "startUtc", "utcTimeStart"], "");
    const utcTimeOut = pick(todayItem, ["utcTimeOut", "utcEnd", "endUtc", "utcTimeEnd"], "");
    const apiTimeIn = getScheduleTimeIn(todayItem);
    const apiTimeOut = getScheduleTimeOut(todayItem);
    const apiTimeZone = getScheduleTimeZoneRaw(todayItem);
    const scheduleTimeZone = getScheduleTimeZone(todayItem);
    const displayTimeZone = scheduleTimeZone;
    const convertedInFromUtc =
      utcTimeIn ? formatUtcIsoToHHMM(utcTimeIn, displayTimeZone) : "";
    const convertedIn = convertedInFromUtc;
    const timeIn = apiTimeIn !== "-" ? apiTimeIn : convertedIn || "-";
    const durationHours = getScheduleDurationHours(todayItem);
    const convertedOutFromUtc =
      utcTimeOut ? formatUtcIsoToHHMM(utcTimeOut, displayTimeZone) : "";
    const convertedOut = convertedOutFromUtc;
    const { outHHMM } = apiTimeOut !== "-"
      ? { outHHMM: apiTimeOut, dayOffset: 0 }
      : convertedOut
        ? { outHHMM: convertedOut, dayOffset: 0 }
        : timeIn !== "-" && durationHours != null
          ? addHoursToHHMM(timeIn, durationHours)
          : { outHHMM: "-", dayOffset: 0 };

    const startMs = resolveScheduledStartUtcMsForDayKey(todayItem, endDate);
    const endMs = resolveScheduledEndUtcMsForDayKey(todayItem, endDate);
    const durationMinutes =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? Math.round((endMs - startMs) / 60000)
        : resolveScheduledDurationMinutes(todayItem, 600);

    return {
      raw: todayItem,
      dayLabel:
        pick(todayItem, ["dayOfWeek", "day", "weekday"], "") ||
        new Date(`${endDate}T12:00:00Z`).toLocaleDateString(undefined, {
          weekday: "long",
          timeZone: scheduleTimeZone,
        }),
      startTimeLabel: timeIn || "-",
      endTimeLabel: outHHMM || "-",
      durationLabel: durationHours == null ? "-" : `${durationHours}h`,
      durationMinutes,
      startMs,
      endMs,
      isActive: true,
      timeZone: apiTimeZone || (convertedIn || convertedOut ? displayTimeZone : ""),
    };
  }, [schedulesByUserId, effectiveSelectedId, endDate]);

  const logsToday = useMemo(
    () => logsByUserId?.[String(effectiveSelectedId)] || [],
    [logsByUserId, effectiveSelectedId]
  );

  const historyLogs = useMemo(() => {
    if (!effectiveSelectedId) return [];
    const arr = historyByUserId?.[String(effectiveSelectedId)];
    return Array.isArray(arr) ? arr : [];
  }, [historyByUserId, effectiveSelectedId]);

  const hasHistory = historyLogs.length > 0;

  const monthlyAttendance = useMemo(() => {
    const monthKey = monthKeyFromMsInZone(nowMs, businessTimeZone);
    if (!monthKey) return 0;

    const src = hasHistory ? historyLogs : logsToday;
    const days = new Set();

    for (const log of Array.isArray(src) ? src : []) {
      const ts = pickTs(log);
      const t = tsMs(ts);
      if (!Number.isFinite(t)) continue;

      const dk = dayKeyFromTsInZone(ts, businessTimeZone);
      if (!dk) continue;

      if (dk.slice(0, 7) === monthKey) days.add(dk);
    }

    return days.size;
  }, [nowMs, hasHistory, historyLogs, logsToday, businessTimeZone]);

  const isOnBreak = !!activeBreaksByUserId?.[String(effectiveSelectedId)];
  const activeBreak = activeBreaksByUserId?.[String(effectiveSelectedId)] || null;
  const breakUsage = breakUsageByUserId?.[String(effectiveSelectedId)] || {
    totalMinutes: 0,
    activeBreakMinutes: 0,
    remainingMinutes: DAILY_BREAK_LIMIT_MINUTES,
  };

  useEffect(() => {
    if (!Number.isFinite(nowMs)) return;
    setLiveNowMs(nowMs);
  }, [nowMs]);

  useEffect(() => {
    const id = setInterval(() => setLiveNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const updatePanelHeight = () => {
      const panelEl = panelRef.current;
      if (!panelEl) return;

      const rectTop = panelEl.getBoundingClientRect().top;
      const viewportHeight = window.innerHeight || 0;
      const bottomGapPx = 16;
      const minPanelHeightPx = 320;
      const nextHeight = Math.max(
        minPanelHeightPx,
        Math.floor(viewportHeight - rectTop - bottomGapPx)
      );

      setPanelHeightPx((prev) => (prev === nextHeight ? prev : nextHeight));
    };

    const rafId = window.requestAnimationFrame(updatePanelHeight);
    window.addEventListener("resize", updatePanelHeight);
    window.addEventListener("orientationchange", updatePanelHeight);

    const panelEl = panelRef.current;
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            updatePanelHeight();
          })
        : null;

    if (resizeObserver && panelEl) {
      resizeObserver.observe(panelEl);
      if (panelEl.parentElement) resizeObserver.observe(panelEl.parentElement);
      const dashEl = panelEl.closest(".empDash");
      if (dashEl) resizeObserver.observe(dashEl);
    }

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", updatePanelHeight);
      window.removeEventListener("orientationchange", updatePanelHeight);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [employee]);

  const breakLimitMinutes = DAILY_BREAK_LIMIT_MINUTES;
  const savedTotalMinutes = Math.max(0, Number(breakUsage.totalMinutes || 0));
  const savedActiveMinutes = Math.max(0, Number(breakUsage.activeBreakMinutes || 0));
  const activeBreakStartMs = toMillis(activeBreak?.startedAt);
  const baseUsedMinutes = Math.max(0, savedTotalMinutes - savedActiveMinutes);

  const liveActiveMinutes =
    isOnBreak && Number.isFinite(activeBreakStartMs)
      ? Math.max(0, (liveNowMs - activeBreakStartMs) / 60000)
      : savedActiveMinutes;

  const effectiveUsedMinutes = Math.min(
    breakLimitMinutes,
    isOnBreak ? baseUsedMinutes + liveActiveMinutes : savedTotalMinutes
  );
  const breakMinutesActive = isOnBreak ? liveActiveMinutes : 0;
  const breakMinutesLeft = Math.max(0, breakLimitMinutes - effectiveUsedMinutes);
  const breakRemainingPct = Math.min(
    100,
    Math.max(0, (breakMinutesLeft / Math.max(1, breakLimitMinutes)) * 100)
  );
  const breakProgressPercent = Math.round(breakRemainingPct);
  const breakSparkleLeftPct = Math.min(99.5, Math.max(0.5, breakProgressPercent));
  const showBreakWarningMarker = breakMinutesLeft > 0 && breakMinutesLeft <= 5;
  const breakRemainingRatio = Math.min(1, Math.max(0, breakMinutesLeft / Math.max(1, breakLimitMinutes)));
  const breakProgressHue = Math.round(120 * breakRemainingRatio);
  const breakProgressColor = `hsl(${breakProgressHue} 78% 42%)`;
  const breakThirtyMinuteMarkerPct = Math.min(
    100,
    Math.max(0, (30 / Math.max(1, breakLimitMinutes)) * 100)
  );
  let breakProgressVariant = "good";
  if (breakMinutesLeft <= 10) breakProgressVariant = "danger";
  else if (breakMinutesLeft <= 20) breakProgressVariant = "warning";
  else if (breakMinutesLeft <= 35) breakProgressVariant = "caution";
  const breakUsedLabel = isOnBreak
    ? effectiveUsedMinutes.toFixed(1)
    : String(Math.round(effectiveUsedMinutes));
  const breakConfirmClockLabel = new Date(
    Number.isFinite(liveNowMs) ? liveNowMs : Date.now()
  ).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const canStartBreak = !isOnBreak && breakMinutesLeft > 0;

  async function handleBreakToggle() {
    if (!employee) return;

    setBreakLoading(true);
    setBreakError("");

    try {
      const userId = String(getUserId(employee) ?? "");
      const name = employee?.name || employee?.fullName || employee?.displayName || "";
      const email = employee?.email || "";

      if (!userId) {
        throw new Error("Employee ID not found");
      }

      if (isOnBreak) {
        await endBreak(userId);
      } else {
        if (breakMinutesLeft <= 0) {
          throw new Error("You already used the full 60-minute break allowance for today");
        }
        await startBreak({ userId, name, email });
      }

      if (typeof onBreakStatusChanged === "function") {
        await onBreakStatusChanged();
      }
    } catch (err) {
      setBreakError(err?.message || "Failed to update break");
    } finally {
      setBreakLoading(false);
    }
  }


  const requestBreakToggle = () => {
    if (!employee) return;
    if (breakLoading) return;
    if (!isOnBreak && !canStartBreak) return;
    setBreakError("");
    setBreakConfirmAction(isOnBreak ? "end" : "start");
  };

  const cancelBreakConfirm = () => {
    if (breakLoading) return;
    setBreakConfirmAction("");
  };

  const confirmBreakToggle = async () => {
    await handleBreakToggle();
    setBreakConfirmAction("");
  };

  const visitorAnnouncements = useMemo(() => {
    const rows = Array.isArray(announcementRows) ? announcementRows : [];
    const nowForWindowMs = Number.isFinite(nowMs) ? nowMs : 0;
    const notes = rows
      .map((item) => {
        const text = toText(
          pick(item, ["note", "announcement", "announcementNote", "message", "text"], "")
        );
        if (!text) return null;
        const headline = toText(pick(item, ["headline", "title", "subject"], "")) || buildFallbackHeadline(text);

        const createdAtMs = toMillis(item?.createdAt);
        const publishAtMs = toMillis(item?.publishAt);
        const expiresAtMs = toMillis(item?.expiresAt);
        const deletedAtMs = toMillis(item?.deletedAt);

        if (Number.isFinite(deletedAtMs)) return null;
        if (Number.isFinite(publishAtMs) && nowForWindowMs < publishAtMs) return null;
        if (Number.isFinite(expiresAtMs) && nowForWindowMs > expiresAtMs) return null;

        return {
          id: toText(item?.id) || `${text}-${toText(item?.createdByUserId)}-${createdAtMs}`,
          headline,
          text,
          createdBy: toText(item?.createdByName) || "Announcement",
          createdAtMs,
        };
      })
      .filter(Boolean);

    notes.sort((a, b) => {
      const aMs = Number.isFinite(a.createdAtMs) ? a.createdAtMs : 0;
      const bMs = Number.isFinite(b.createdAtMs) ? b.createdAtMs : 0;
      return bMs - aMs;
    });

    return notes.slice(0, 6);
  }, [announcementRows, nowMs]);

  const formatAnnouncementDate = (ms) => {
    if (!Number.isFinite(ms)) return "Recent";
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
    });
  };

  const stats = useMemo(() => {
    let early = 0;
    let ontime = 0;
    let late = 0;

    for (const l of Array.isArray(logsToday) ? logsToday : []) {
      const t = String(l.type || "").toLowerCase();
      const status = String(l.status || "").toLowerCase();

      if (t.includes("in")) {
        if (status.includes("early")) early++;
        else if (status.includes("late")) late++;
        else ontime++;
      }
    }

    return {
      monthlyAttendance,
      earlyCheckins: early,
      onTimeCheckins: ontime,
      lateCheckins: late,
    };
  }, [logsToday, monthlyAttendance]);

  const now = new Date(Number.isFinite(liveNowMs) ? liveNowMs : nowMs);
  const clockReferenceTimeZone = String(businessTimeZone || "").trim() || "America/Chicago";
  const clockReferenceLabel = useMemo(() => {
    try {
      const zonePart = new Intl.DateTimeFormat(undefined, {
        timeZone: clockReferenceTimeZone,
        timeZoneName: "short",
      })
        .formatToParts(now)
        .find((part) => part.type === "timeZoneName")?.value;

      return zonePart
        ? `${clockReferenceTimeZone} (${zonePart})`
        : clockReferenceTimeZone;
    } catch {
      return clockReferenceTimeZone;
    }
  }, [clockReferenceTimeZone, now]);

  const greetingText = useMemo(() => {
    const parts = getPartsInTimeZone(
      Number.isFinite(liveNowMs) ? liveNowMs : nowMs,
      businessTimeZone
    );
    const hour = Number(parts?.hour);

    if (!Number.isFinite(hour)) return "Hello";
    if (hour < 12) return "Good Morning";
    if (hour < 18) return "Good Afternoon";
    return "Good Evening";
  }, [liveNowMs, nowMs, businessTimeZone]);
  const historyLoading = !!loadingHistoryByUserId?.[String(effectiveSelectedId)];
  const historyError = historyErrorByUserId?.[String(effectiveSelectedId)] || "";
  const closeAnnouncementModal = () => setSelectedAnnouncement(null);

  return (
    <div className="empDash">
          {!employee ? (
        <div>No employee selected</div>
      ) : (
        <>
          <div className="empDashTop">
            <div>
              <select
                className="employee-select"
                value={String(effectiveSelectedId)}
                onChange={(e) => setSelected(e.target.value)}
                disabled={!canSwitchEmployee || !!lockedEmployeeId}
              >
                {(Array.isArray(employees) ? employees : []).map((emp) => {
                  const id = String(getUserId(emp) ?? emp?.userId ?? emp?.id ?? "");
                  if (!id) return null;

                  return (
                    <option key={id} value={id}>
                      {getDisplayName(emp)}
                    </option>
                  );
                })}
              </select>

              {historyLoading ? (
                <div className="empHistoryGhost">Loading full history...</div>
              ) : historyError ? (
                <div>{historyError}</div>
              ) : null}
            </div>
          </div>

          <div
            ref={panelRef}
            className="empPanel"
            style={panelHeightPx ? { height: `${panelHeightPx}px` } : undefined}
          >
            <div className="empPanelHead">
              <div className="empPanelHeadLeft">
                <span>Today's Schedule</span>
                <div className="scheduleBoxes">
                    <div className="miniBox">
                      <div className="miniLabel">Start: </div>
                      <div className="miniValue">{todaySchedule?.startTimeLabel || "-"}</div>
                    </div>

                    <div className="miniBox">
                      <div className="miniLabel">Duration: </div>
                      <div className="miniValue">{todaySchedule?.durationLabel || "-"}</div>
                    </div>

                    <div className="miniBox">
                      <div className="miniLabel">End: </div>
                      <div className="miniValue">{todaySchedule?.endTimeLabel || "-"}</div>
                    </div>

                    <div className="miniBox">
                      <div className="miniLabel">Time Zone: </div>
                      <div className="miniValue">{todaySchedule?.timeZone || "-"}</div>
                    </div>
                  </div>
              </div>
              <div className="empDatePill">
                {now.toLocaleDateString(undefined, {
                  timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
                })}
              </div>
            </div>

            <div className="empPanelBody">
              <div className="empGrid2">
                <div className="scheduleCard">
                  <div className="scheduleTopRow">
                    <div className="scheduleDay">{todaySchedule?.dayLabel || "Today"}</div>
                    <div className={`statusPill ${todaySchedule ? "active" : ""}`}>
                      {todaySchedule ? "Active" : "No Schedule"}
                    </div>
                  </div>

                  <div className="progressCard">
                    <div className="progressHead">
                      <span>Break Time Left</span>
                      <span>{Math.round(breakRemainingPct)}%</span>
                    </div>

                    <div
                      className="progressBarWrap"
                      style={{
                        "--breakMarkerLeft": `${breakThirtyMinuteMarkerPct}%`,
                        "--progressValue": `${breakSparkleLeftPct}%`,
                        "--progressFill": breakProgressColor,
                      }}
                    >
                      <progress
                        className="progressBar progressBar-good"
                        max={100}
                        value={breakProgressPercent}
                      />
                      {showBreakWarningMarker ? (
                        <span className="progressWarnIcon" aria-hidden="true">!</span>
                      ) : (
                        <span className="progressSparkle" aria-hidden="true" />
                      )}
                      <span className="progressMarker" aria-hidden="true" />
                    </div>

                    <div className="progressMetaRow">
                      <span>Used</span>
                      <span>
                        {breakUsedLabel} / {breakLimitMinutes} min
                      </span>
                    </div>

                    {breakMinutesLeft <= 0 ? (
                      <div className="breakNotice breakNotice-danger">
                        No Breaks Remaining.
                      </div>
                    ) : breakMinutesLeft <= 15 ? (
                      <div className={`breakNotice breakNotice-${breakProgressVariant}`}>
                        Break time is running low.
                      </div>
                    ) : null}
                  </div>

                  <div className="scheduleBreakActions">
                    {breakError ? (
                      <div className="breakError">
                        {breakError}
                      </div>
                    ) : null}

                    {!isOnBreak && breakMinutesLeft <= 0 ? (
                      <div className="breakLimitWarning">
                        Daily break limit reached ({DAILY_BREAK_LIMIT_MINUTES} minutes).
                      </div>
                    ) : null}

                    <button
                      className={`breakBtn ${isOnBreak ? "back" : "break"}`}
                      onClick={requestBreakToggle}
                      disabled={breakLoading || (!isOnBreak && !canStartBreak)}
                    >
                      {breakLoading ? "Please wait..." : isOnBreak ? "BACK" : "BREAK"}
                    </button>
                  </div>

                  <div className="greetingPanel">
                    <div className="greetingTitle">{greetingText}, {employee.name || employee.email}</div>

                    <div className="greetingSub">
                      {now.toLocaleDateString(undefined, {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
                      })}{" "}
                      at{" "}
                      {now.toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
                      })}
                    </div>

                    <div className="statsRow">
                      <StatCard value={stats.monthlyAttendance} label="Monthly Attendance" />
                      <StatCard value={stats.earlyCheckins} label="Early Check-ins" />
                      <StatCard value={stats.onTimeCheckins} label="On-Time Check-ins" />
                      <StatCard value={stats.lateCheckins} label="Late Check-ins" />
                    </div>
                  </div>
                </div>

                <div className="empSideColumn">
                  <div className="clockedCard">
                    <div className="clockedInner">
                      <div className="clockedTitle">
                        {isOnBreak ? "Currently On Break" : "Current Time"}
                      </div>
                      <div className="clockedTimeValue">
                        {now.toLocaleTimeString(undefined, {
                          timeZone: clockReferenceTimeZone,
                        })}
                      </div>
                      <div className="clockedTimeZoneRef">Time Zone: {clockReferenceLabel}</div>
                    </div>

                    {isOnBreak ? (
                      <div className="infoPillRow">
                        <div className="infoPill">
                          <span>Current Break</span>
                          <span>{breakMinutesActive.toFixed(1)} min</span>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="taskListCard">
                    <div className="taskListHead">
                      <span>Tasks</span>
                      <div className="taskListHeadRight">
                        <div className="taskFilterDrawer" ref={taskFilterDrawerRef}>
                          <button
                            type="button"
                            className={`taskFilterTrigger ${isTaskFilterOpen ? "open" : ""}`}
                            aria-haspopup="listbox"
                            aria-expanded={isTaskFilterOpen}
                            onClick={() => setIsTaskFilterOpen((prev) => !prev)}
                          >
                            <span>{activeTaskFilterLabel}</span>
                          </button>
                          <span className="taskFilterDrawerCount">
                            {taskFilterCounts[taskStatusFilter] ?? 0}
                          </span>
                        </div>
                      </div>
                    </div>

                    {isTaskFilterOpen ? (
                      <div className="taskFilterMenu" role="listbox" aria-label="Task status filters">
                        {TASK_FILTER_OPTIONS.map((option) => {
                          const isActive = taskStatusFilter === option.key;
                          return (
                            <button
                              key={option.key}
                              type="button"
                              role="option"
                              aria-selected={isActive}
                              className={`taskFilterMenuItem ${isActive ? "active" : ""}`}
                              onClick={() => handleTaskFilterSelect(option.key)}
                            >
                              <span>{option.label}</span>
                              <span className="taskFilterMenuItemCount">
                                {taskFilterCounts[option.key] ?? 0}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    <div className="taskListBody">
                      {tasksLoading ? (
                        <div className="taskListEmpty">Loading tasks...</div>
                      ) : tasksError ? (
                        <div className="taskListEmpty">{tasksError}</div>
                      ) : filteredEmployeeTasks.length === 0 ? (
                        <div className="taskListEmpty">
                          {employeeTasks.length === 0
                            ? "No tasks available."
                            : "No tasks match this filter."}
                        </div>
                      ) : (
                        filteredEmployeeTasks.map((task, index) => {
                          const meta = getTaskStatusMeta(task);
                          const taskForLabel = getTaskAssigneeLabel(task);
                          const taskAssignees = getTaskAssignees(task);
                          const taskId = toText(task?.id);
                          const canOpenTaskDetails =
                            !!taskId && typeof onOpenTaskDetails === "function";

                          return (
                            <button
                              type="button"
                              key={String(task?.id || `${effectiveSelectedId}-task-${index}`)}
                              className={`taskListItem taskListItemButton ${
                                canOpenTaskDetails ? "clickable" : ""
                              }`}
                              onClick={() => {
                                if (!canOpenTaskDetails) return;
                                onOpenTaskDetails(taskId);
                              }}
                              disabled={!canOpenTaskDetails}
                            >
                              <div className="taskListItemTop">
                                <div className="taskListTitle">{toText(task?.title) || "Untitled task"}</div>
                                <span className={`taskListStatus ${meta.tone}`}>{meta.label}</span>
                              </div>

                              <div className="taskListFor">
                                <span className="taskListForLabel">For:</span>
                                <div className="taskAssigneeGroup" aria-label={`Task assignees: ${taskForLabel}`}>
                                  {taskAssignees.map((assignee, assigneeIndex) => (
                                    <div
                                      key={`${toText(task?.id) || index}-${assignee.userId || assignee.name}-${assigneeIndex}`}
                                      className="taskAssigneeAvatar"
                                      title={assignee.name}
                                      aria-label={assignee.name}
                                    >
                                      {assignee.profileImg ? (
                                        <img
                                          src={assignee.profileImg}
                                          alt={`${assignee.name} profile`}
                                          className="taskAssigneeAvatarImg"
                                          loading="lazy"
                                        />
                                      ) : (
                                        initialsFromName(assignee.name)
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>

                              <div className="taskListMeta">
                                <span>Due: {formatTaskDeadlineLabel(task, businessTimeZone)}</span>
                                <span>
                                  Priority:{" "}
                                  {toText(task?.priority)
                                    ? toText(task.priority).charAt(0).toUpperCase() +
                                      toText(task.priority).slice(1)
                                    : "Medium"}
                                </span>
                              </div>

                              {toText(task?.instructions) ? (
                                <div className="taskListNotes">
                                  {truncateText(task.instructions, 120)}
                                </div>
                              ) : null}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="announcementCard">
                    <div className="announcementHead">
                      <span>Announcements</span>
                      <span className="announcementCount">{visitorAnnouncements.length}</span>
                    </div>

                    <div className="announcementBody">
                      {visitorAnnouncements.length ? (
                        visitorAnnouncements.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            className="announcementItem"
                            onClick={() => setSelectedAnnouncement(item)}
                          >
                            <div className="announcementMeta">
                              <span className="announcementAuthor">{item.createdBy}</span>
                              <span>{formatAnnouncementDate(item.createdAtMs)}</span>
                            </div>
                            <div className="announcementHeadline">{item.headline}</div>
                          </button>
                        ))
                      ) : (
                        <div className="announcementEmpty">
                          No announcements yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {selectedAnnouncement ? (
            <div className="announcementModalOverlay" onClick={closeAnnouncementModal}>
              <div
                className="announcementModalCard"
                role="dialog"
                aria-modal="true"
                aria-label="Announcement details"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="announcementModalHead">
                  <div>
                    <div className="announcementModalTitle">
                      {selectedAnnouncement.headline || "Announcement"}
                    </div>
                    <div className="announcementModalMeta">
                      <span>{selectedAnnouncement.createdBy}</span>
                      <span>{formatAnnouncementDate(selectedAnnouncement.createdAtMs)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="announcementModalClose"
                    onClick={closeAnnouncementModal}
                    aria-label="Close announcement"
                  >
                    x
                  </button>
                </div>

                <div className="announcementModalBody">
                  {selectedAnnouncement.text || "No announcement content."}
                </div>
              </div>
            </div>
          ) : null}

          <ConfirmModal
            open={!!breakConfirmAction}
            title={breakConfirmAction === "end" ? "End Break?" : "Start Break?"}
            message={
              breakConfirmAction === "end"
                ? "This will record your break end time. Continue?"
                : "This will record your break start time. Continue?"
            }
            meta={`Current device time: ${breakConfirmClockLabel}`}
            confirmText={breakConfirmAction === "end" ? "End Break" : "Start Break"}
            tone="primary"
            busy={breakLoading}
            onCancel={cancelBreakConfirm}
            onConfirm={confirmBreakToggle}
          />
        </>
      )}
    </div>
  );
}

function StatCard({ value, label }) {
  return (
    <div className="statCard">
      <div className="statValue">{value}</div>
      <div className="statLabel">{label}</div>
    </div>
  );
}
