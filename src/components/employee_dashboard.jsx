import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./employee_dashboard.css";
import {
  startBreak,
  endBreak,
  DAILY_BREAK_LIMIT_MINUTES,
  calculateBreakUsageMinutes,
  getBreakLogsByUserIdsInRange,
} from "../services/breakService";
import { isClockedOutLog, isIn } from "../utils/attendanceLog";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronLeft,
  ChevronRight,
  Coffee,
  CheckSquare,
  ClipboardList,
  Columns3,
  CircleHelp,
  Eraser,
  FileText,
  Italic,
  List,
  ListOrdered,
  Megaphone,
  Minus,
  MoreVertical,
  Palette,
  Pencil,
  Pause,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Table2,
  TableColumnsSplit,
  TableRowsSplit,
  Trash2,
  Underline,
  UserPlus,
  Users,
  DownloadCloud,
  PhoneCall,
} from "lucide-react";
import ConfirmModal from "./ConfirmModal";
import SaveAsModal from "./SaveAsModal";
import { db } from "../firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import {
  getScheduleTimeZone,
  resolveScheduledDurationMinutes,
  resolveScheduledEndUtcMsForDayKey,
  resolveScheduledStartUtcMsForDayKey,
} from "../utils/scheduleTime";
import { getDisplayName, getProfileImageUrl, getUserId, pick, toMillis, toText } from "../utils/common";
import {
  CALL_ACTIVITY_TYPES,
  calculateDurationMinutes,
  createCallActivityLog,
  formatDuration,
  getDateKey,
  subscribeCallActivityLogs,
} from "../services/callActivityService";
import {
  advanceEmployeeProcessAssignment,
  getDefaultEmployeeProcessSettings,
  getNextEmployeeProcessUserId,
  setEmployeeProcessAssignments,
  setEmployeeProcessReadyOverrides as setEmployeeProcessReadyOverridesInDb,
  subscribeEmployeeProcessSettings,
} from "../services/employeeProcessService";
import {
  createEmployeeProcessActionLog,
  subscribeEmployeeProcessActionLogs,
} from "../services/employeeProcessLogService";

/* ----------------------------- helpers ----------------------------- */
const buildFallbackHeadline = (text) => {
  const raw = toText(text);
  if (!raw) return "Announcement";
  return raw.length > 64 ? `${raw.slice(0, 64)}...` : raw;
};

const normalize = (value = "") => String(value || "").trim().toLowerCase();
const EMPLOYEE_PROCESS_LOCAL_STORAGE_KEY = "hyacinth_employee_process_assignment_v1";
const EMPLOYEE_PROCESS_READY_STORAGE_KEY = "hyacinth_employee_process_ready_overrides_v1";
const EMPLOYEE_PROCESS_GUIDE_TEXT =
  "IB and NL start on the first available employee, move separately when finished, and skip break, day off, completed, or unavailable rows. Purple IB is one optional secondary IB for the next available employee and clears if they become unavailable.";

const normalizeEmployeeProcessLocalSettings = (settings = {}) => ({
  ...getDefaultEmployeeProcessSettings(),
  ...(settings && typeof settings === "object" ? settings : {}),
  rotationUserIds: Array.from(
    new Set(
      (Array.isArray(settings?.rotationUserIds) ? settings.rotationUserIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ),
  ibUserId: String(settings?.ibUserId || settings?.ibCurrentUserId || "").trim(),
  nlUserId: String(settings?.nlUserId || settings?.nlCurrentUserId || "").trim(),
  purpleIbUserId: String(settings?.purpleIbUserId || settings?.secondaryIbUserId || "").trim(),
  readyOverrides: normalizeEmployeeProcessReadyOverrides(
    settings?.readyOverrides || settings?.readyStateOverrides || {}
  ),
});

const readEmployeeProcessLocalSettings = () => {
  if (typeof window === "undefined" || !window.localStorage) {
    return getDefaultEmployeeProcessSettings();
  }

  try {
    const raw = window.localStorage.getItem(EMPLOYEE_PROCESS_LOCAL_STORAGE_KEY);
    if (!raw) return getDefaultEmployeeProcessSettings();
    return normalizeEmployeeProcessLocalSettings(JSON.parse(raw));
  } catch {
    return getDefaultEmployeeProcessSettings();
  }
};

const writeEmployeeProcessLocalSettings = (settings = {}) => {
  if (typeof window === "undefined" || !window.localStorage) return false;

  try {
    window.localStorage.setItem(
      EMPLOYEE_PROCESS_LOCAL_STORAGE_KEY,
      JSON.stringify({
        ...normalizeEmployeeProcessLocalSettings(settings),
        localUpdatedAtMs: Date.now(),
      })
    );
    return true;
  } catch {
    return false;
  }
};

const normalizeEmployeeProcessReadyOverrides = (value = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .map(([userId, signature]) => [
        String(userId || "").trim(),
        String(signature || "").trim(),
      ])
      .filter(([userId, signature]) => userId && signature)
  );
};

const readEmployeeProcessReadyOverrides = () => {
  if (typeof window === "undefined" || !window.localStorage) return {};

  try {
    const raw = window.localStorage.getItem(EMPLOYEE_PROCESS_READY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return normalizeEmployeeProcessReadyOverrides(parsed);
  } catch {
    return {};
  }
};

const writeEmployeeProcessReadyOverrides = (overrides = {}) => {
  if (typeof window === "undefined" || !window.localStorage) return false;

  try {
    const cleanOverrides = normalizeEmployeeProcessReadyOverrides(overrides);
    window.localStorage.setItem(EMPLOYEE_PROCESS_READY_STORAGE_KEY, JSON.stringify(cleanOverrides));
    return true;
  } catch {
    return false;
  }
};

const buildEmployeeProcessReadySignature = (userId, scheduledItem, logs = [], endDate = "") => {
  const uid = String(userId || "").trim();
  const startMs = resolveScheduledStartUtcMsForDayKey(scheduledItem, endDate);
  const logSignature = (Array.isArray(logs) ? logs : [])
    .map((log) => {
      const inMs = toMillis(
        pick(log || {}, ["timeIn", "clockIn", "startedAt", "createdAt", "inAt"], null)
      );
      const outMs = toMillis(
        pick(log || {}, ["timeOut", "clockOut", "endedAt", "completedAt", "updatedAt", "outAt"], null)
      );
      return [
        normalize(getAttendanceStatusText(log)),
        isIn(log) ? "in" : "",
        isClockedOutLog(log) ? "out" : "",
        Number.isFinite(inMs) ? inMs : "",
        Number.isFinite(outMs) ? outMs : "",
      ].join(":");
    })
    .join("|");

  return `${uid}|${endDate}|${Number.isFinite(startMs) ? startMs : "no-start"}|${logSignature}`;
};

const formatLabelList = (labels = []) => {
  const cleanLabels = labels.map((label) => String(label || "").trim()).filter(Boolean);
  if (!cleanLabels.length) return "";
  if (cleanLabels.length === 1) return cleanLabels[0];
  if (cleanLabels.length === 2) return `${cleanLabels[0]} and ${cleanLabels[1]}`;
  return `${cleanLabels.slice(0, -1).join(", ")}, and ${cleanLabels[cleanLabels.length - 1]}`;
};

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
const TIME_PICKER_HOURS = Array.from({ length: 24 }, (_, hour) => pad2(hour));
const TIME_PICKER_MINUTES = Array.from({ length: 60 }, (_, minute) => pad2(minute));
const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const EMPLOYEE_ACTIVITY_RECENT_PAGE_SIZE = 10;
const compareActivityDateDesc = (a, b) =>
  String(b.entryDate || "").localeCompare(String(a.entryDate || "")) ||
  String(b.startTime || "").localeCompare(String(a.startTime || ""));

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

const dayKeyFromMsInZone = (ms, timeZone) => {
  const parts = getPartsInTimeZone(ms, timeZone);
  if (!parts) return "";
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const dayKeyToUtcMs = (dayKey) => {
  const [y, m, d] = String(dayKey || "").split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  return Date.UTC(y, m - 1, d);
};

const dayKeyFromUtcMs = (ms) => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

const getWeekRangeDayKeysInZone = (baseMs, timeZone) => {
  const currentDayKey = dayKeyFromMsInZone(baseMs, timeZone);
  const currentDayUtcMs = dayKeyToUtcMs(currentDayKey);
  if (!Number.isFinite(currentDayUtcMs)) return { startDayKey: "", endDayKey: "" };

  const dayOfWeek = new Date(currentDayUtcMs).getUTCDay();
  const startDayUtcMs = currentDayUtcMs - dayOfWeek * 86400000;
  const endDayUtcMs = startDayUtcMs + 6 * 86400000;

  return {
    startDayKey: dayKeyFromUtcMs(startDayUtcMs),
    endDayKey: dayKeyFromUtcMs(endDayUtcMs),
  };
};

const formatBreakLogLabel = (value = "", fallback = "Break") => {
  const raw = toText(value);
  if (!raw) return fallback;
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
};

const formatBreakLogDateTime = (value, timeZone = "America/Chicago") => {
  const ms = toMillis(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: String(timeZone || "").trim() || "America/Chicago",
  });
};

const formatBreakLogDuration = (startValue, endValue, fallbackNowMs = Date.now()) => {
  const startMs = toMillis(startValue);
  const endMs = toMillis(endValue);
  const effectiveEndMs = Number.isFinite(endMs) ? endMs : fallbackNowMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(effectiveEndMs) || effectiveEndMs < startMs) {
    return "-";
  }
  const mins = Math.max(0, Math.round((effectiveEndMs - startMs) / 60000));
  return `${mins} min`;
};

const ATTENDANCE_BUCKETS = [
  { key: "early", label: "Early", color: "#4b9fea" },
  { key: "onTime", label: "On Time", color: "#66bb6a" },
  { key: "late", label: "Late", color: "#f39c12" },
  { key: "pto", label: "PTO", color: "#8e44ad" },
  { key: "absent", label: "Absent", color: "#e74c3c" },
  { key: "ncns", label: "NCNS", color: "#4b5563" },
];

const ATTENDANCE_SCORE_WEIGHTS = Object.freeze({
  early: 1.0,
  onTime: 1.0,
  late: 0.7,
  pto: 1.0,
  absent: 0,
  ncns: 0,
});

const ATTENDANCE_SCORE_BEST_DAY_POINTS = 1.0;
const AGENT_ATTENDANCE_MONTH_ALL = "ALL";
const AGENT_DONUTS_PREVIEW = 24;
const EMPLOYEE_NOTEPAD_COLLECTION = "employee_notepad_notes";
const NOTIFICATIONS_COLLECTION = "break_notifications";
const EMPTY_NOTEPAD_HTML = '<p><br></p>';
const NOTEPAD_VIEW_MY = "my";
const NOTEPAD_VIEW_GROUP = "group";
const NOTEPAD_VIEW_BIN = "bin";
const DEFAULT_NOTEPAD_COLOR_KEY = "gold";
const NOTEPAD_COLOR_THEMES = Object.freeze({
  gold: {
    label: "Golden",
    vars: {
      "--dash-note-page-base": "#f4d15d",
      "--dash-note-page-back": "#e7bf45",
      "--dash-note-page-mid": "#edc84f",
      "--dash-note-front-0": "#f8d76b",
      "--dash-note-front-1": "#f1ca55",
      "--dash-note-front-2": "#e6bd49",
      "--dash-note-corner-0": "rgba(255,246,197,.96)",
      "--dash-note-corner-1": "#d9ae39",
    },
  },
  blue: {
    label: "Sky",
    vars: {
      "--dash-note-page-base": "#9ed3fb",
      "--dash-note-page-back": "#7dbef3",
      "--dash-note-page-mid": "#8ac8f7",
      "--dash-note-front-0": "#b6e0ff",
      "--dash-note-front-1": "#92cff7",
      "--dash-note-front-2": "#73bde9",
      "--dash-note-corner-0": "rgba(235,247,255,.98)",
      "--dash-note-corner-1": "#66b0de",
    },
  },
  mint: {
    label: "Mint",
    vars: {
      "--dash-note-page-base": "#b8e9c2",
      "--dash-note-page-back": "#9fd9ab",
      "--dash-note-page-mid": "#ace2b7",
      "--dash-note-front-0": "#cef2d4",
      "--dash-note-front-1": "#b2e6bd",
      "--dash-note-front-2": "#95d6a4",
      "--dash-note-corner-0": "rgba(236,253,241,.98)",
      "--dash-note-corner-1": "#86c995",
    },
  },
  rose: {
    label: "Rose",
    vars: {
      "--dash-note-page-base": "#f4bfd0",
      "--dash-note-page-back": "#eaaac0",
      "--dash-note-page-mid": "#efb5c8",
      "--dash-note-front-0": "#f8d1dd",
      "--dash-note-front-1": "#f2bdcf",
      "--dash-note-front-2": "#e9a9be",
      "--dash-note-corner-0": "rgba(255,238,244,.98)",
      "--dash-note-corner-1": "#dd96ad",
    },
  },
  violet: {
    label: "Violet",
    vars: {
      "--dash-note-page-base": "#d7c7f7",
      "--dash-note-page-back": "#c4b0ec",
      "--dash-note-page-mid": "#cfbdf2",
      "--dash-note-front-0": "#e4d9fb",
      "--dash-note-front-1": "#d3c4f4",
      "--dash-note-front-2": "#bea9e9",
      "--dash-note-corner-0": "rgba(245,241,255,.98)",
      "--dash-note-corner-1": "#ae96dd",
    },
  },
});
const NOTEPAD_COLOR_OPTIONS = Object.freeze(
  Object.entries(NOTEPAD_COLOR_THEMES).map(([key, theme]) => ({ key, label: theme?.label || key }))
);
const NOTEPAD_TOOLBAR_DEFAULT = Object.freeze({
  bold: false,
  italic: false,
  underline: false,
  alignLeft: false,
  alignCenter: false,
  alignRight: false,
  unorderedList: false,
  orderedList: false,
  checklist: false,
  fontSizePx: 14,
  fontColor: "#0f172a",
});
const NOTEPAD_FONT_SIZE_OPTIONS = Object.freeze([10, 12, 14, 16, 18, 20, 24, 28, 32]);
const NOTEPAD_TAB_SPACE_COUNT = 4;
const NOTEPAD_TAB_NBSP = "\u00A0".repeat(NOTEPAD_TAB_SPACE_COUNT);
const isNotepadToolbarStateDefault = (state = {}) =>
  Object.entries(NOTEPAD_TOOLBAR_DEFAULT).every(([key, defaultValue]) => state?.[key] === defaultValue);
const NOTEPAD_TABLE_PICKER_MAX_ROWS = 8;
const NOTEPAD_TABLE_PICKER_MAX_COLS = 8;
const NOTEPAD_DOCS_CACHE_BY_EMPLOYEE = new Map();
const NOTEPAD_NOTIFICATION_EVENT_CACHE = new Set();
const NOTEPAD_REFRESH_SIGNAL_COLLECTION = "employee_notepad_refresh_signals";
const NOTEPAD_LOCAL_DRAFT_STORAGE_PREFIX = "emp_notepad_local_draft";
const NOTEPAD_LOCAL_DRAFT_VERSION = 1;
const NOTEPAD_LOCAL_DRAFT_MAX_ENTRIES = 12;
const NOTEPAD_LOCAL_DRAFT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;
const EMP_SIDE_COLUMN_MIN_WIDTH_PX = 220;
const EMP_SIDE_COLUMN_MAX_WIDTH_RATIO = 0.6;
const EMP_SIDE_COLUMN_WIDTH_STORAGE_PREFIX = "emp_dash_side_col_width";

const sanitizeNotepadMemberUserIds = (value = []) =>
  Array.from(
    new Set((Array.isArray(value) ? value : []).map((item) => toText(item)).filter(Boolean))
  );

const sanitizeNotepadMemberProfiles = (value = []) =>
  (Array.isArray(value) ? value : [])
    .map((item) => ({
      userId: toText(item?.userId || item?.employeeUserId || item?.uid || item?.id),
      name: toText(item?.name || item?.displayName || item?.employeeName || item?.email),
      profileImg: toText(item?.profileImg || item?.profileImage || item?.profileImageUrl),
    }))
    .filter((item) => item.userId || item.name);

const normalizeNotepadScope = (scopeValue = "", hasGroupMembers = false) => {
  const normalized = toText(scopeValue).toLowerCase();
  if (normalized === "group") return "group";
  if (normalized === "personal") return "personal";
  return hasGroupMembers ? "group" : "personal";
};

const normalizeNotepadColorKey = (value = "") => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw && NOTEPAD_COLOR_THEMES[raw]) return raw;
  return DEFAULT_NOTEPAD_COLOR_KEY;
};

const getNotepadLocalDraftStorageKey = (employeeUserId = "", noteId = "") => {
  const employeeKey = toText(employeeUserId) || "unknown";
  const noteKey = toText(noteId) || "new-personal";
  return `${NOTEPAD_LOCAL_DRAFT_STORAGE_PREFIX}:${employeeKey}:${noteKey}`;
};

const readNotepadLocalDraft = (storageKey = "") => {
  if (!storageKey || typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || Number(parsed?.version) !== NOTEPAD_LOCAL_DRAFT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
};

const pruneNotepadLocalDrafts = ({
  preserveKey = "",
  maxEntries = NOTEPAD_LOCAL_DRAFT_MAX_ENTRIES,
  maxAgeMs = NOTEPAD_LOCAL_DRAFT_MAX_AGE_MS,
} = {}) => {
  if (typeof window === "undefined" || !window.localStorage) return 0;

  const nowMs = Date.now();
  const keepKey = String(preserveKey || "").trim();
  const candidateRows = [];
  const removals = new Set();

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !key.startsWith(`${NOTEPAD_LOCAL_DRAFT_STORAGE_PREFIX}:`)) continue;
    if (keepKey && key === keepKey) continue;

    const raw = window.localStorage.getItem(key);
    if (!raw) {
      removals.add(key);
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || Number(parsed?.version) !== NOTEPAD_LOCAL_DRAFT_VERSION) {
        removals.add(key);
        continue;
      }

      const updatedAtMs = Number(parsed?.updatedAtMs) || 0;
      if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0 || nowMs - updatedAtMs > maxAgeMs) {
        removals.add(key);
        continue;
      }

      candidateRows.push({ key, updatedAtMs });
    } catch {
      removals.add(key);
    }
  }

  candidateRows.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (Number.isFinite(maxEntries) && maxEntries > 0 && candidateRows.length > maxEntries) {
    for (const row of candidateRows.slice(maxEntries)) {
      removals.add(row.key);
    }
  }

  let removedCount = 0;
  for (const key of removals) {
    try {
      window.localStorage.removeItem(key);
      removedCount += 1;
    } catch {
      // Best-effort cleanup only.
    }
  }

  return removedCount;
};

const writeNotepadLocalDraft = (storageKey = "", payload = {}) => {
  if (!storageKey || typeof window === "undefined" || !window.localStorage) return false;
  try {
    const serialized = JSON.stringify({
      version: NOTEPAD_LOCAL_DRAFT_VERSION,
      updatedAtMs: Date.now(),
      ...payload,
    });
    window.localStorage.setItem(storageKey, serialized);
    pruneNotepadLocalDrafts({ preserveKey: storageKey });
    return true;
  } catch {
    try {
      pruneNotepadLocalDrafts({
        preserveKey: storageKey,
        maxEntries: Math.max(4, Math.floor(NOTEPAD_LOCAL_DRAFT_MAX_ENTRIES / 2)),
        maxAgeMs: 1000 * 60 * 60 * 24 * 7,
      });
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
        version: NOTEPAD_LOCAL_DRAFT_VERSION,
        updatedAtMs: Date.now(),
        ...payload,
        })
      );
      pruneNotepadLocalDrafts({ preserveKey: storageKey });
      return true;
    } catch {
      // If the browser is still out of space, we leave the draft unsaved locally.
    }
    return false;
  }
};

const removeNotepadLocalDraft = (storageKey = "") => {
  if (!storageKey || typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Local draft cleanup should never block a successful note save.
  }
};

const resolveNotepadDeadlineValue = (data = {}) => {
  const directCandidates = [
    data?.deadlineAt,
    data?.deadline,
    data?.dueAt,
    data?.dueDateTime,
    data?.dueOn,
  ];
  for (const candidate of directCandidates) {
    const ms = toMillis(candidate);
    if (Number.isFinite(ms)) return candidate;
  }

  const deadlineDate = toText(data?.deadlineDate || data?.dueDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(deadlineDate)) {
    const rawTime = toText(data?.deadlineTime || data?.dueTime);
    const timePart = /^\d{1,2}:\d{2}$/.test(rawTime) ? rawTime.padStart(5, "0") : "23:59";
    const combinedMs = new Date(`${deadlineDate}T${timePart}:00`).getTime();
    if (Number.isFinite(combinedMs)) return new Date(combinedMs);
  }

  return null;
};

const mapNotepadDocToRow = (noteDoc, fallbackEmployeeUserId = "") => {
  const data = noteDoc?.data?.() || {};
  const createdAtMs = toMillis(data.createdAt);
  const updatedAtMs = toMillis(data.updatedAt);
  const resolvedDeadlineValue = resolveNotepadDeadlineValue(data);
  const deadlineAtMs = toMillis(resolvedDeadlineValue);
  const completedAtMs = toMillis(data.completedAt);
  const ownerUserId = toText(data.employeeUserId || fallbackEmployeeUserId);
  const hasGroupMembers = Array.isArray(data.memberUserIds) && data.memberUserIds.length > 0;
  const noteScope = normalizeNotepadScope(data.noteScope, hasGroupMembers);
  const memberUserIdsRaw = sanitizeNotepadMemberUserIds(data.memberUserIds);
  const memberUserIds =
    noteScope === "group"
      ? Array.from(new Set([ownerUserId, ...memberUserIdsRaw].filter(Boolean)))
      : ownerUserId
        ? [ownerUserId]
        : [];

  return {
    id: noteDoc.id,
    noteScope,
    employeeUserId: ownerUserId || toText(fallbackEmployeeUserId),
    employeeName: toText(data.employeeName),
    memberUserIds,
    memberProfiles: sanitizeNotepadMemberProfiles(data.memberProfiles),
    title: toText(data.title),
    contentHtml: String(data.contentHtml || EMPTY_NOTEPAD_HTML),
    noteColorKey: normalizeNotepadColorKey(data?.noteColorKey || data?.noteColor),
    deadlineAt: resolvedDeadlineValue,
    deadlineAtMs: Number.isFinite(deadlineAtMs) ? deadlineAtMs : NaN,
    isPinned: !!data?.isPinned,
    isCompleted: !!data?.isCompleted,
    isTrashed: !!data?.isTrashed,
    trashedAt: data.trashedAt || null,
    completedAt: data.completedAt || null,
    completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : 0,
    dueSoonNotificationKey: String(data?.dueSoonNotificationKey || "").trim(),
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    updatedAtMs: Number.isFinite(updatedAtMs)
      ? updatedAtMs
      : Number.isFinite(createdAtMs)
        ? createdAtMs
        : 0,
  };
};

const shortAgentLabel = (name = "") => {
  const raw = toText(name).trim();
  if (!raw) return "-";
  const first = raw.split(/\s+/)[0] || raw;
  return first.length > 12 ? `${first.slice(0, 11)}.` : first;
};

const prettyMonthLabel = (monthKey = "") => {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey))) return String(monthKey || "-");
  const d = new Date(`${monthKey}-01T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return monthKey;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

const parseYmdToUtcNoon = (ymd = "") => {
  const d = new Date(`${ymd}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const ymdFromUtcDate = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};

const enumerateYmdRange = (startYmd = "", endYmd = "") => {
  const start = parseYmdToUtcNoon(startYmd);
  const end = parseYmdToUtcNoon(endYmd);
  if (!start || !end || start > end) return [];

  const days = [];
  const cur = new Date(start.getTime());
  while (cur <= end) {
    days.push(ymdFromUtcDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
};

const startOfWeekYmd = (ymd = "") => {
  const d = parseYmdToUtcNoon(ymd);
  if (!d) return ymd;
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return ymdFromUtcDate(d);
};

const prettyDayLabel = (ymd = "") => {
  const d = parseYmdToUtcNoon(ymd);
  if (!d) return String(ymd || "-");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
};

const buildPieConicGradient = (slices = [], total = 0) => {
  const safeTotal = Math.max(1, Number(total) || 0);
  let cur = 0;

  const parts = (Array.isArray(slices) ? slices : []).map((slice) => {
    const val = Math.max(0, Number(slice?.value) || 0);
    const deg = (val / safeTotal) * 360;
    const a0 = cur;
    const a1 = cur + deg;
    cur = a1;
    return `${slice?.color || "#cbd5e1"} ${a0}deg ${a1}deg`;
  });

  if (cur < 360) parts.push(`rgba(255,255,255,0.08) ${cur}deg 360deg`);
  return `conic-gradient(${parts.join(", ")})`;
};

const persistChecklistStateInHtml = (html = "", checkedStates = []) => {
  if (typeof document === "undefined") return String(html || "");

  const wrapper = document.createElement("div");
  wrapper.innerHTML = String(html || "");

  const normalizedStates = Array.isArray(checkedStates) ? checkedStates : [];
  wrapper.querySelectorAll('input[type="checkbox"]').forEach((checkbox, index) => {
    const stateFromEditor = normalizedStates[index];
    const isChecked = typeof stateFromEditor === "boolean" ? stateFromEditor : checkbox.checked;
    if (isChecked) checkbox.setAttribute("checked", "");
    else checkbox.removeAttribute("checked");
    checkbox.setAttribute("contenteditable", "false");
  });

  wrapper.querySelectorAll("td.notepadTableCellActive, th.notepadTableCellActive").forEach((cell) => {
    cell.classList.remove("notepadTableCellActive");
  });
  wrapper.querySelectorAll("td.notepadTableCellSelected, th.notepadTableCellSelected").forEach((cell) => {
    cell.classList.remove("notepadTableCellSelected");
  });

  return wrapper.innerHTML;
};

const serializeNotepadEditorHtml = (editorEl, fallbackHtml = "") => {
  const rawHtml = String(editorEl?.innerHTML || fallbackHtml || "");
  const checkedStates = Array.from(editorEl?.querySelectorAll?.('input[type="checkbox"]') || []).map(
    (checkbox) => !!checkbox?.checked
  );
  return persistChecklistStateInHtml(rawHtml, checkedStates);
};

const extractChecklistItemTextFromCheckbox = (checkboxEl) => {
  if (!checkboxEl || typeof checkboxEl.closest !== "function") return "";
  const checklistItemEl = checkboxEl.closest(".notepad-check-item");
  if (!checklistItemEl) return "";

  const cloneEl = checklistItemEl.cloneNode(true);
  cloneEl.querySelectorAll('input[type="checkbox"]').forEach((inputEl) => inputEl.remove());
  return String(cloneEl.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
};

const isLikelyPlaceholderPersonLabel = (value = "") => {
  const normalized = toText(value).toLowerCase();
  if (!normalized) return true;
  if (normalized === "user" || normalized === "employee" || normalized === "a teammate") return true;
  if (/^user(?:\s+.+)?$/.test(normalized) && !normalized.includes("@")) return true;
  return false;
};

const stripHtmlForPreview = (html = "") =>
  String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const hasMeaningfulNotepadContent = (html = "") => {
  const textContent = stripHtmlForPreview(html);
  if (textContent) return true;
  return /<(img|video|audio|iframe|svg|canvas|table|pre|code|blockquote|hr)\b/i.test(String(html || ""));
};

const escapeHtml = (value = "") =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildChecklistHtmlFromText = (value = "") => {
  const lines = String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  if (!lines.length) {
    return '<p class="notepad-check-item"><input type="checkbox" contenteditable="false" /> &nbsp;</p>';
  }

  return lines
    .map(
      (line) =>
        `<p class="notepad-check-item"><input type="checkbox" contenteditable="false" /> ${escapeHtml(line)}</p>`
    )
    .join("");
};

const convertSelectionLinesToChecklist = (editorEl) => {
  if (!editorEl || typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const hostNode = node?.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  if (hostNode && !editorEl.contains(hostNode)) return false;

  const selectedText = String(selection.toString() || "").trim();
  if (!selectedText) return false;

  const html = buildChecklistHtmlFromText(selectedText);
  document.execCommand("insertHTML", false, html);
  return true;
};

const getNotepadTableContext = (editorEl) => {
  if (!editorEl || typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const anchorEl = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
  const focusEl = focusNode?.nodeType === Node.TEXT_NODE ? focusNode.parentElement : focusNode;
  const scopedEl = (focusEl && editorEl.contains(focusEl) ? focusEl : null) || anchorEl;
  if (!scopedEl || !editorEl.contains(scopedEl)) return null;

  const cell = scopedEl.closest?.("td,th") || null;
  const row = cell?.parentElement || scopedEl.closest?.("tr") || null;
  const table = scopedEl.closest?.("table") || null;
  if (!table || !editorEl.contains(table)) return null;

  return { table, row, cell };
};

const createEmptyTableCell = (tagName = "td") => {
  const cell = document.createElement(String(tagName || "td").toLowerCase() === "th" ? "th" : "td");
  cell.innerHTML = "&nbsp;";
  return cell;
};

const createEmptyTableRow = (columnCount = 2, tagName = "td") => {
  const row = document.createElement("tr");
  const safeCols = Math.max(1, Number(columnCount) || 1);
  for (let index = 0; index < safeCols; index += 1) {
    row.appendChild(createEmptyTableCell(tagName));
  }
  return row;
};

const getNotepadTableRowCells = (rowEl) =>
  Array.from(rowEl?.children || []).filter((cellEl) => {
    const tag = String(cellEl?.tagName || "").toLowerCase();
    return tag === "td" || tag === "th";
  });

const getNotepadTableCellPosition = (cellEl) => {
  if (!cellEl) return null;
  const tableEl = cellEl.closest?.("table");
  const rowEl = cellEl.closest?.("tr");
  if (!tableEl || !rowEl) return null;

  const rows = Array.from(tableEl.querySelectorAll("tr"));
  const rowIndex = rows.indexOf(rowEl);
  if (rowIndex < 0) return null;

  const rowCells = getNotepadTableRowCells(rowEl);
  const colIndex = rowCells.indexOf(cellEl);
  if (colIndex < 0) return null;

  return {
    tableEl,
    rowEl,
    rowIndex,
    colIndex,
    rows,
  };
};

const getNotepadTableRectCells = (startCell, endCell) => {
  const startPos = getNotepadTableCellPosition(startCell);
  const endPos = getNotepadTableCellPosition(endCell);
  if (!startPos || !endPos) return [];
  if (startPos.tableEl !== endPos.tableEl) return [];

  const minRow = Math.min(startPos.rowIndex, endPos.rowIndex);
  const maxRow = Math.max(startPos.rowIndex, endPos.rowIndex);
  const minCol = Math.min(startPos.colIndex, endPos.colIndex);
  const maxCol = Math.max(startPos.colIndex, endPos.colIndex);
  const rectCells = [];

  for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
    const rowEl = startPos.rows[rowIndex];
    if (!rowEl) return [];
    const rowCells = getNotepadTableRowCells(rowEl);
    for (let colIndex = minCol; colIndex <= maxCol; colIndex += 1) {
      const cellEl = rowCells[colIndex];
      if (!cellEl) return [];
      rectCells.push(cellEl);
    }
  }

  return rectCells;
};

const buildNotepadTableMergePlan = (selectedCells = []) => {
  const uniqueCells = Array.from(new Set(Array.isArray(selectedCells) ? selectedCells : [])).filter(Boolean);
  if (uniqueCells.length < 2) return null;

  const firstCellPos = getNotepadTableCellPosition(uniqueCells[0]);
  if (!firstCellPos) return null;
  if (uniqueCells.some((cellEl) => cellEl.closest?.("table") !== firstCellPos.tableEl)) return null;
  if (
    uniqueCells.some(
      (cellEl) => (Number(cellEl?.rowSpan) || 1) !== 1 || (Number(cellEl?.colSpan) || 1) !== 1
    )
  ) {
    return null;
  }

  const coords = uniqueCells.map((cellEl) => getNotepadTableCellPosition(cellEl)).filter(Boolean);
  if (coords.length !== uniqueCells.length) return null;

  const minRow = Math.min(...coords.map((item) => item.rowIndex));
  const maxRow = Math.max(...coords.map((item) => item.rowIndex));
  const minCol = Math.min(...coords.map((item) => item.colIndex));
  const maxCol = Math.max(...coords.map((item) => item.colIndex));

  const rectCells = [];
  for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
    const rowEl = firstCellPos.rows[rowIndex];
    if (!rowEl) return null;
    const rowCells = getNotepadTableRowCells(rowEl);
    for (let colIndex = minCol; colIndex <= maxCol; colIndex += 1) {
      const cellEl = rowCells[colIndex];
      if (!cellEl) return null;
      if ((Number(cellEl?.rowSpan) || 1) !== 1 || (Number(cellEl?.colSpan) || 1) !== 1) return null;
      rectCells.push(cellEl);
    }
  }

  const selectedSet = new Set(uniqueCells);
  if (rectCells.some((cellEl) => !selectedSet.has(cellEl))) return null;

  const topRowCells = getNotepadTableRowCells(firstCellPos.rows[minRow]);
  const topLeftCell = topRowCells[minCol] || null;
  if (!topLeftCell) return null;

  const mergedParts = rectCells
    .map((cellEl) => String(cellEl.innerHTML || "").trim())
    .filter((html) => html && html !== "<br>" && html !== "&nbsp;");

  return {
    topLeftCell,
    cellsToRemove: rectCells.filter((cellEl) => cellEl !== topLeftCell),
    rowSpan: maxRow - minRow + 1,
    colSpan: maxCol - minCol + 1,
    mergedHtml: mergedParts.length ? mergedParts.join("<br>") : "&nbsp;",
  };
};

const applyNotepadFontSizeInEditor = (editorEl, fontSizePx) => {
  if (!editorEl || typeof document === "undefined" || typeof window === "undefined") return;
  const px = Math.max(8, Math.min(96, Number(fontSizePx) || NOTEPAD_TOOLBAR_DEFAULT.fontSizePx));
  const selection = window.getSelection();
  const selectedRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  const candidatesBefore = new Set(
    Array.from(editorEl.querySelectorAll("font[size], span[style*='font-size']"))
  );

  document.execCommand("styleWithCSS", false, true);
  document.execCommand("fontSize", false, "7");

  const shouldNormalizeNode = (nodeEl) => {
    if (!nodeEl || !editorEl.contains(nodeEl)) return false;
    if (!candidatesBefore.has(nodeEl)) return true;
    if (!selectedRange) return false;
    try {
      return selectedRange.intersectsNode(nodeEl);
    } catch {
      return false;
    }
  };

  const needsFontSizeNormalization = (nodeEl) => {
    if (!nodeEl) return false;
    const tagName = String(nodeEl.tagName || "").toLowerCase();
    if (tagName === "font" && String(nodeEl.getAttribute("size") || "").trim()) return true;
    const inlineFontSize = String(nodeEl.style?.fontSize || "").trim().toLowerCase();
    if (!inlineFontSize) return false;
    return !/^\d+(\.\d+)?px$/.test(inlineFontSize);
  };

  editorEl.querySelectorAll("font[size], span[style*='font-size']").forEach((nodeEl) => {
    if (!shouldNormalizeNode(nodeEl)) return;
    if (!needsFontSizeNormalization(nodeEl)) return;
    if (String(nodeEl.tagName || "").toLowerCase() === "font") {
      nodeEl.removeAttribute("size");
    }
    nodeEl.style.fontSize = `${px}px`;
  });
};

const toTwoDigitHex = (value) => {
  const clamped = Math.max(0, Math.min(255, Number(value) || 0));
  return clamped.toString(16).padStart(2, "0");
};

const normalizeCssColorToHex = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return NOTEPAD_TOOLBAR_DEFAULT.fontColor;

  const hexMatch = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    if (hexMatch[1].length === 6) return `#${hexMatch[1].toLowerCase()}`;
    const [r, g, b] = hexMatch[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  if (typeof document === "undefined" || typeof window === "undefined") {
    return NOTEPAD_TOOLBAR_DEFAULT.fontColor;
  }

  const probeEl = document.createElement("span");
  probeEl.style.color = raw;
  probeEl.style.position = "absolute";
  probeEl.style.left = "-9999px";
  probeEl.style.top = "-9999px";
  probeEl.style.pointerEvents = "none";
  document.body.appendChild(probeEl);
  const computedColor = String(window.getComputedStyle(probeEl).color || "");
  probeEl.remove();

  const rgbMatch = computedColor.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgbMatch) return NOTEPAD_TOOLBAR_DEFAULT.fontColor;
  const [, r, g, b] = rgbMatch;
  return `#${toTwoDigitHex(r)}${toTwoDigitHex(g)}${toTwoDigitHex(b)}`;
};

const clampNotepadMenuCoordinate = (value, minValue, maxValue) => {
  const safeValue = Number(value) || 0;
  const safeMin = Number(minValue) || 0;
  const safeMax = Number(maxValue);
  if (!Number.isFinite(safeMax) || safeMax < safeMin) return safeMin;
  return Math.min(Math.max(safeValue, safeMin), safeMax);
};

const insertNotepadTabIndentAtCaret = (editorEl) => {
  if (!editorEl || typeof window === "undefined" || typeof document === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startElement = startNode?.nodeType === Node.ELEMENT_NODE ? startNode : startNode?.parentElement;
  const listItemEl = startElement?.closest?.("li");

  if (listItemEl && editorEl.contains(listItemEl)) {
    document.execCommand("indent", false, null);
    return true;
  }

  document.execCommand("insertHTML", false, NOTEPAD_TAB_NBSP);
  return true;
};

const outdentNotepadTabIndentAtCaret = (editorEl) => {
  if (!editorEl || typeof window === "undefined" || typeof document === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startElement = startNode?.nodeType === Node.ELEMENT_NODE ? startNode : startNode?.parentElement;
  const listItemEl = startElement?.closest?.("li");

  if (listItemEl && editorEl.contains(listItemEl)) {
    document.execCommand("outdent", false, null);
    return true;
  }

  if (!range.collapsed || startNode?.nodeType !== Node.TEXT_NODE) return false;

  const rawText = String(startNode.nodeValue || "");
  const startOffset = Math.max(0, Math.min(rawText.length, Number(range.startOffset) || 0));
  const beforeCaret = rawText.slice(0, startOffset);
  const indentMatch = beforeCaret.match(/(?:\u00A0| ){1,4}$/);
  if (!indentMatch || !indentMatch[0]) return false;

  const removeCount = indentMatch[0].length;
  startNode.nodeValue = `${rawText.slice(0, startOffset - removeCount)}${rawText.slice(startOffset)}`;

  const nextRange = document.createRange();
  nextRange.setStart(startNode, Math.max(0, startOffset - removeCount));
  nextRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(nextRange);
  return true;
};

const NOTEPAD_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;
const NOTEPAD_OVERDUE_NOTIFY_DELAY_MS = 30 * 60 * 1000;

const toLocalDateTimeInputValue = (value) => {
  const ms = toMillis(value);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

const parseLocalDateTimeInputMs = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

const getNotepadDeadlineTone = (deadlineValue, nowMs = Date.now()) => {
  const deadlineMs = toMillis(deadlineValue);
  if (!Number.isFinite(deadlineMs)) return "upcoming";
  if (nowMs > deadlineMs) return "overdue";
  if (deadlineMs - nowMs <= NOTEPAD_DUE_SOON_WINDOW_MS) return "due";
  return "upcoming";
};

const getAttendanceStatusText = (log = {}) =>
  toText(pick(log || {}, ["status", "attendanceStatus", "dailyStatus", "remark"], ""));

const normalizeAttendanceScoreBucket = (status = "") => {
  const s = normalize(status).replace(/\s+/g, " ");
  if (!s) return "";
  if (s.includes("early")) return "early";
  if (s.includes("on-time") || s.includes("on time") || s.includes("ontime") || s.includes("present")) {
    return "onTime";
  }
  if (s.includes("late")) return "late";
  if (s.includes("pto") || s.includes("leave") || s.includes("vacation")) return "pto";
  if (s.includes("absent")) return "absent";
  if (s.includes("ncns") || s.includes("no call") || s.includes("no-show") || s.includes("no show")) {
    return "ncns";
  }
  return "";
};

const getAttendanceScoreDayKey = (log = {}, timeZone = "America/Chicago") => {
  const explicitDayKey = toText(
    pick(
      log || {},
      ["dayKey", "businessDay", "businessDate", "attendanceDate", "logDate", "date", "workDate"],
      ""
    )
  );
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicitDayKey)) return explicitDayKey;
  const ts = pickTs(log);
  if (!ts) return "";
  return dayKeyFromTsInZone(ts, timeZone) || "";
};

const getAttendanceScoreLogDedupeKey = (log = {}) => {
  const explicitId = toText(pick(log || {}, ["id", "_id", "logId", "attendanceLogId"], ""));
  if (explicitId) return `id:${explicitId}`;

  const inTs = toText(pickTs(log));
  const outTs = toText(pick(log || {}, ["timeOut", "timestampOut", "outTimestamp", "endedAt"], ""));
  const type = normalize(pick(log || {}, ["type", "logType", "eventType"], ""));
  const status = normalize(getAttendanceStatusText(log));
  const userId = toText(pick(log || {}, ["userId", "employeeUserId", "uid", "employeeId"], ""));
  const fallback = `${userId}|${inTs}|${outTs}|${type}|${status}`;
  if (fallback.replace(/\|/g, "").trim()) return fallback;

  return `json:${JSON.stringify(log || {})}`;
};

const mergeAttendanceScoreLogs = (...logLists) => {
  const merged = [];
  const seen = new Set();

  for (const list of logLists) {
    if (!Array.isArray(list)) continue;
    for (const log of list) {
      if (!log || typeof log !== "object") continue;
      const dedupeKey = getAttendanceScoreLogDedupeKey(log);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push(log);
    }
  }

  return merged;
};

const pickPrimaryAttendanceLogForScore = (dayLogs = []) => {
  const logs = Array.isArray(dayLogs) ? dayLogs : [];
  if (!logs.length) return null;
  const inLog = logs.find((log) => normalize(log?.type).includes("in"));
  if (inLog) return inLog;
  const statusLog = logs.find((log) => !!getAttendanceStatusText(log));
  return statusLog || logs[0];
};

export default function EmployeeDashboard({
  viewMode = "dashboard",
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
  onRefreshBreakForUser,
  onOpenTaskDetails,
  pageData = null,
}) {
  const requestedHistoryRef = useRef(new Set());
  const breakLogsCacheRef = useRef({});
  const notepadMetaLoadedRef = useRef(false);

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
  const [isTaskListDrawerOpen, setIsTaskListDrawerOpen] = useState(false);
  const [isAnnouncementDrawerOpen, setIsAnnouncementDrawerOpen] = useState(false);
  const [isBreakLogsDrawerOpen, setIsBreakLogsDrawerOpen] = useState(false);
  const [breakLogFilter, setBreakLogFilter] = useState("thisWeek");
  const [breakLogRows, setBreakLogRows] = useState([]);
  const [breakLogLoading, setBreakLogLoading] = useState(false);
  const [breakLogError, setBreakLogError] = useState("");
  const [breakLogRefreshToken, setBreakLogRefreshToken] = useState(0);
  const [selectedAgentAttendanceMonth, setSelectedAgentAttendanceMonth] = useState(
    AGENT_ATTENDANCE_MONTH_ALL
  );
  const [selectedCallActivityLeaderboardMonth, setSelectedCallActivityLeaderboardMonth] = useState(getDateKey(new Date()).slice(0, 7));
  const [callActivityLeaderboardRows, setCallActivityLeaderboardRows] = useState([]);
  const [callActivityLeaderboardLoading, setCallActivityLeaderboardLoading] = useState(false);
  const [callActivityLeaderboardError, setCallActivityLeaderboardError] = useState("");
  const [showAllAgentRates, setShowAllAgentRates] = useState(false);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const [selectedAnnouncement, setSelectedAnnouncement] = useState(null);
  const [isNotepadDrawerOpen, setIsNotepadDrawerOpen] = useState(false);
  const [notepadViewMode, setNotepadViewMode] = useState(NOTEPAD_VIEW_MY);
  const [isNotepadCompletedOpen, setIsNotepadCompletedOpen] = useState(false);
  const [notepadNotes, setNotepadNotes] = useState([]);
  const [notepadTrashedNotes, setNotepadTrashedNotes] = useState([]);
  const [notepadIconCount, setNotepadIconCount] = useState(0);
  const [notepadIconNoteMetaList, setNotepadIconNoteMetaList] = useState([]);
  const [notepadLoading, setNotepadLoading] = useState(false);
  const [notepadError, setNotepadError] = useState("");
  const [selectedNotepadNoteId, setSelectedNotepadNoteId] = useState("");
  const [isNotepadNewDraftOpen, setIsNotepadNewDraftOpen] = useState(false);
  const [notepadCompletingNoteId, setNotepadCompletingNoteId] = useState("");
  const [callActivityForm, setCallActivityForm] = useState(() => ({
    entryDate: getDateKey(new Date()),
    startTime: "",
    endTime: "",
    activityType: "Outbound Call",
    count: "0",
    notes: "",
  }));
  const [callActivitySaving, setCallActivitySaving] = useState(false);
  const [callActivityStatus, setCallActivityStatus] = useState({ type: "", message: "" });
  const [activeCallActivityTimeField, setActiveCallActivityTimeField] = useState("");
  const [callActivityMissingFields, setCallActivityMissingFields] = useState([]);
  const [callActivityRecentPage, setCallActivityRecentPage] = useState(0);
  const [employeeProcessSettings, setEmployeeProcessSettings] = useState(() =>
    readEmployeeProcessLocalSettings()
  );
  const [employeeProcessLoading, setEmployeeProcessLoading] = useState(false);
  const [employeeProcessError, setEmployeeProcessError] = useState("");
  const [employeeProcessBusy, setEmployeeProcessBusy] = useState("");
  const [employeeProcessConfirmAction, setEmployeeProcessConfirmAction] = useState(null);
  const [employeeProcessReadyOverrides, setEmployeeProcessReadyOverrides] = useState(() =>
    readEmployeeProcessReadyOverrides()
  );
  const [employeeProcessActionLogs, setEmployeeProcessActionLogs] = useState([]);
  const [employeeProcessActionLogsLoading, setEmployeeProcessActionLogsLoading] = useState(false);
  const [employeeProcessActionLogsError, setEmployeeProcessActionLogsError] = useState("");
  const [notepadPinningNoteId, setNotepadPinningNoteId] = useState("");
  const [notepadTitleDraft, setNotepadTitleDraft] = useState("");
  const [notepadColorDraft, setNotepadColorDraft] = useState(DEFAULT_NOTEPAD_COLOR_KEY);
  const [notepadDeadlineDraft, setNotepadDeadlineDraft] = useState("");
  const [notepadContentDraft, setNotepadContentDraft] = useState(EMPTY_NOTEPAD_HTML);
  const [notepadDirty, setNotepadDirty] = useState(false);
  const [notepadColorDraftSaving, setNotepadColorDraftSaving] = useState(false);
  const [notepadChecklistChangeVersion, setNotepadChecklistChangeVersion] = useState(0);
  const [notepadLastChecklistChange, setNotepadLastChecklistChange] = useState(null);
  const [savingNotepadNote, setSavingNotepadNote] = useState(false);
  const [notepadStatusText, setNotepadStatusText] = useState("");
  const [isNotepadTyping, setIsNotepadTyping] = useState(false);
  const [notepadToolbarState, setNotepadToolbarState] = useState(() => ({ ...NOTEPAD_TOOLBAR_DEFAULT }));
  const [notepadTrashingNoteId, setNotepadTrashingNoteId] = useState("");
  const [notepadBinActionNoteId, setNotepadBinActionNoteId] = useState("");
  const [isNotepadGroupCreatorOpen, setIsNotepadGroupCreatorOpen] = useState(false);
  const [creatingGroupNotepadNote, setCreatingGroupNotepadNote] = useState(false);
  const [notepadGroupMemberDraft, setNotepadGroupMemberDraft] = useState([]);
  const [notepadAddMemberNoteId, setNotepadAddMemberNoteId] = useState("");
  const [notepadAddMemberDraft, setNotepadAddMemberDraft] = useState([]);
  const [notepadAddMemberSavingNoteId, setNotepadAddMemberSavingNoteId] = useState("");
  const [notepadSideRefreshLoading, setNotepadSideRefreshLoading] = useState(false);
  const [notepadConfirmState, setNotepadConfirmState] = useState({
    open: false,
    mode: "",
    note: null,
  });
  const [notepadConfirmBusy, setNotepadConfirmBusy] = useState(false);
  const [notepadExitGuardState, setNotepadExitGuardState] = useState({
    open: false,
    reason: "",
  });
  const [notepadExitGuardBusy, setNotepadExitGuardBusy] = useState(false);
  const [dashboardDisplayHtml, setDashboardDisplayHtml] = useState("");
  const [dashboardDisplayDirty, setDashboardDisplayDirty] = useState(false);
  const [dashboardDisplaySaving, setDashboardDisplaySaving] = useState(false);
  const [dashboardDisplayStatus, setDashboardDisplayStatus] = useState("");
  const [dashboardDisplayChangeVersion, setDashboardDisplayChangeVersion] = useState(0);
  const [dashboardLastChecklistChange, setDashboardLastChecklistChange] = useState(null);
  const [dashboardDisplayNoteIndex, setDashboardDisplayNoteIndex] = useState(0);
  const [isDashboardNoteMenuOpen, setIsDashboardNoteMenuOpen] = useState(false);
  const [isDashboardUnpinConfirmOpen, setIsDashboardUnpinConfirmOpen] = useState(false);
  const [dashboardNoteColorUpdatingId, setDashboardNoteColorUpdatingId] = useState("");
  const [dashboardColorSavePendingId, setDashboardColorSavePendingId] = useState("");
  const [notepadTableMenuState, setNotepadTableMenuState] = useState({
    open: false,
    x: 0,
    y: 0,
  });
  const [notepadTableMoveHandleState, setNotepadTableMoveHandleState] = useState({
    visible: false,
    x: 0,
    y: 0,
  });
  const [notepadTableSelectedCount, setNotepadTableSelectedCount] = useState(0);
  const [isNotepadTablePickerOpen, setIsNotepadTablePickerOpen] = useState(false);
  const [notepadTablePickerRows, setNotepadTablePickerRows] = useState(2);
  const [notepadTablePickerCols, setNotepadTablePickerCols] = useState(2);
  const [dashboardNotepadPreviewColorKey, setDashboardNotepadPreviewColorKey] = useState(
    DEFAULT_NOTEPAD_COLOR_KEY
  );
  const [empSideColumnWidthPx, setEmpSideColumnWidthPx] = useState(null);
  const empSideColumnWidthPxRef = useRef(null);
  const empGridRef = useRef(null);
  const empSideColumnRef = useRef(null);
  const empSideColumnResizeStateRef = useRef(null);
  const callActivityFieldRefs = useRef({});
  const taskFilterDrawerRef = useRef(null);
  const taskFilterMenuRef = useRef(null);
  const notepadListRef = useRef(null);
  const notepadEditorRef = useRef(null);
  const dashboardDisplayRef = useRef(null);
  const dashboardNoteActionsRef = useRef(null);
  const notepadTableMenuRef = useRef(null);
  const notepadTablePickerRef = useRef(null);
  const notepadTableMoveHandleTableRef = useRef(null);
  const notepadTableMoveHandleHideTimerRef = useRef(null);
  const notepadSelectedTableCellRef = useRef(null);
  const notepadSelectedTableCellsRef = useRef([]);
  const notepadTableSelectionAnchorRef = useRef(null);
  const notepadTableResizeStateRef = useRef(null);
  const notepadSelectionRangeRef = useRef(null);
  const notepadPendingExitActionRef = useRef(null);
  const saveDashboardDisplayNoteRef = useRef(null);
  const dashboardColorSaveTimerRef = useRef(null);
  const dashboardColorPendingPayloadRef = useRef(null);
  const notepadDueSoonNotifyInFlightRef = useRef(new Set());
  const notepadNotificationEventCacheRef = useRef(NOTEPAD_NOTIFICATION_EVENT_CACHE);
  const notepadRefreshSignalSeenRef = useRef("");
  const notepadRefreshSignalCheckBusyRef = useRef(false);
  const employeeProcessAutoSyncRef = useRef("");
  const portalRoot = typeof document !== "undefined" ? document.body : null;
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsHtml, setSaveAsHtml] = useState("");
  

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
  const viewerEmail = String(
    pageData?.viewer?.email ||
      pageData?.currentUser?.email ||
      pageData?.user?.email ||
      ""
  )
    .trim()
    .toLowerCase();

  const viewerLinkedEmployeeId = useMemo(() => {
    const rows = Array.isArray(employees) ? employees : [];
    const idCandidates = [
      getUserId(pageData?.viewer?.employee),
      getUserId(pageData?.currentUser?.employee),
      getUserId(pageData?.user?.employee),
      pageData?.viewer?.employeeId,
      pageData?.currentUser?.employeeId,
      pageData?.user?.employeeId,
      viewerUserId,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    for (const candidate of idCandidates) {
      if (employeeIds.includes(candidate)) return candidate;
    }

    if (viewerEmail) {
      const match = rows.find(
        (row) => String(row?.email || "").trim().toLowerCase() === viewerEmail
      );
      const matchedId = String(getUserId(match) || "").trim();
      if (matchedId) return matchedId;
    }

    return "";
  }, [employees, employeeIds, pageData, viewerUserId, viewerEmail]);

  const lockedEmployeeId = useMemo(() => {
    if (viewerRole !== "employee") return "";
    if (viewerLinkedEmployeeId) return viewerLinkedEmployeeId;
    return "";
  }, [viewerRole, viewerLinkedEmployeeId]);

  const canSwitchEmployee = viewerRole !== "employee" && employeeIds.length > 1;

  const attendanceScoreEmployees = useMemo(() => {
    return Array.isArray(employees) ? employees : [];
  }, [employees]);

  const effectiveSelectedId = useMemo(() => {
    if (lockedEmployeeId) return lockedEmployeeId;

    const fromParent = String(selectedEmployeeId || "");
    if (fromParent) return fromParent;

    if (localSelectedId) return localSelectedId;

    return employeeIds[0] || "";
  }, [lockedEmployeeId, selectedEmployeeId, localSelectedId, employeeIds]);
  const normalizedSelectedUserId = useMemo(
    () => String(effectiveSelectedId || "").trim(),
    [effectiveSelectedId]
  );

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

  useEffect(() => {
    if ((!isNotepadDrawerOpen && !isTaskListDrawerOpen && !isAnnouncementDrawerOpen) || !portalRoot) return undefined;

    const previousOverflow = portalRoot.style.overflow;
    const previousOverscrollBehavior = portalRoot.style.overscrollBehavior;
    portalRoot.style.overflow = "hidden";
    portalRoot.style.overscrollBehavior = "contain";

    return () => {
      portalRoot.style.overflow = previousOverflow;
      portalRoot.style.overscrollBehavior = previousOverscrollBehavior;
    };
  }, [isNotepadDrawerOpen, isTaskListDrawerOpen, isAnnouncementDrawerOpen, portalRoot]);

  useEffect(() => {
    if (viewMode !== "call_activity") return undefined;

    setCallActivityLeaderboardLoading(true);
    setCallActivityLeaderboardError("");
    const unsubscribe = subscribeCallActivityLogs(
      { maxRows: 5000 },
      (nextRows) => {
        setCallActivityLeaderboardRows(Array.isArray(nextRows) ? nextRows : []);
        setCallActivityLeaderboardLoading(false);
      },
      (err) => {
        setCallActivityLeaderboardError(err?.message || "Unable to load call activity leaderboard.");
        setCallActivityLeaderboardLoading(false);
      }
    );

    return () => unsubscribe?.();
  }, [viewMode]);

  useEffect(() => {
    let active = true;
    setEmployeeProcessLoading(true);
    setEmployeeProcessError("");

    const unsubscribe = subscribeEmployeeProcessSettings(
      (settings) => {
        if (!active) return;
        const nextSettings = normalizeEmployeeProcessLocalSettings(
          settings || getDefaultEmployeeProcessSettings()
        );
        setEmployeeProcessSettings(nextSettings);
        writeEmployeeProcessLocalSettings(nextSettings);
        setEmployeeProcessReadyOverrides(
          normalizeEmployeeProcessReadyOverrides(nextSettings?.readyOverrides || {})
        );
        setEmployeeProcessError("");
        setEmployeeProcessLoading(false);
      },
      (err) => {
        if (!active) return;
        setEmployeeProcessError(err?.message || "Unable to load IB/NL process settings.");
        setEmployeeProcessLoading(false);
      }
    );

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const employee = useMemo(
    () =>
      (Array.isArray(employees) ? employees : []).find(
        (e) => String(getUserId(e) ?? "") === String(effectiveSelectedId)
      ) || null,
    [employees, effectiveSelectedId]
  );

  useEffect(() => {
    let active = true;

    setEmployeeProcessActionLogsLoading(true);
    setEmployeeProcessActionLogsError("");

    const unsubscribe = subscribeEmployeeProcessActionLogs(
      { maxRows: 0 },
      (rows) => {
        if (!active) return;
        setEmployeeProcessActionLogs(Array.isArray(rows) ? rows : []);
        setEmployeeProcessActionLogsError("");
        setEmployeeProcessActionLogsLoading(false);
      },
      (err) => {
        if (!active) return;
        setEmployeeProcessActionLogs([]);
        setEmployeeProcessActionLogsError(err?.message || "Unable to load inbound and new lead log.");
        setEmployeeProcessActionLogsLoading(false);
      }
    );

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const getScheduledDayItemForUser = useCallback(
    (userId) => {
      const sched = schedulesByUserId?.[String(userId || "").trim()];
      if (!Array.isArray(sched) || sched.length === 0) return null;

      const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const d = new Date(`${endDate}T12:00:00Z`);
      if (Number.isNaN(d.getTime())) return null;
      const targetWeekday = weekdays[d.getUTCDay()];

      return (
        sched.find(
          (item) => String(pick(item, ["dayOfWeek", "day", "weekday"], "")).toLowerCase() === targetWeekday
        ) || null
      );
    },
    [schedulesByUserId, endDate]
  );

  const resolveEmployeeProcessStatus = useCallback(
    (userId) => {
      const uid = String(userId || "").trim();
      if (!uid) return { available: false, label: "Unavailable", tone: "unavailable" };
      if (activeBreaksByUserId?.[uid]) return { available: false, label: "On break", tone: "break" };

      const logs = Array.isArray(logsByUserId?.[uid]) ? logsByUserId[uid] : [];
      const statusTexts = logs.map((log) => normalize(getAttendanceStatusText(log))).filter(Boolean);
      const hasDayOffStatus = statusTexts.some(
        (status) =>
          status.includes("day off") ||
          status.includes("rest day") ||
          status.includes("holiday") ||
          status.includes("pto") ||
          status.includes("leave") ||
          status.includes("vacation") ||
          status.includes("no schedule")
      );
      if (hasDayOffStatus) return { available: false, label: "Day Off", tone: "dayoff" };

      const hasCompletedStatus = statusTexts.some(
        (status) => status.includes("completed") || status.includes("complete")
      );
      if (hasCompletedStatus || logs.some((log) => isClockedOutLog(log))) {
        return { available: false, label: "Completed", tone: "completed" };
      }

      const scheduledItem = getScheduledDayItemForUser(uid);
      if (!scheduledItem) return { available: false, label: "Day Off", tone: "dayoff" };

      const hasClockIn = logs.some((log) => isIn(log));
      if (!hasClockIn) return { available: false, label: "Scheduled", tone: "scheduled" };

      const readySignature = buildEmployeeProcessReadySignature(uid, scheduledItem, logs, endDate);
      if (employeeProcessReadyOverrides?.[uid] === readySignature) {
        return {
          available: true,
          label: "Available",
          tone: "available",
          readySignature,
          isReadyOverride: true,
        };
      }

      const scheduledStartMs = resolveScheduledStartUtcMsForDayKey(scheduledItem, endDate);
      const currentMs = Number.isFinite(liveNowMs) ? liveNowMs : Date.now();
      const hasEarlyInStatus = statusTexts.some((status) => status.includes("early in"));
      if (hasEarlyInStatus || (Number.isFinite(scheduledStartMs) && currentMs < scheduledStartMs)) {
        return {
          available: false,
          label: "Logged in",
          tone: "loggedin",
          canReady: true,
          readySignature,
        };
      }

      return { available: true, label: "Available", tone: "available" };
    },
    [
      activeBreaksByUserId,
      buildEmployeeProcessReadySignature,
      employeeProcessReadyOverrides,
      endDate,
      getScheduledDayItemForUser,
      liveNowMs,
      logsByUserId,
    ]
  );

  const employeeProcessRows = useMemo(() => {
    const rowsById = new Map();
    for (const row of Array.isArray(employees) ? employees : []) {
      const userId = String(getUserId(row) || "").trim();
      if (!userId || rowsById.has(userId)) continue;
      rowsById.set(userId, {
        userId,
        name: getDisplayName(row) || row?.email || userId,
        email: row?.email || "",
        profileImg: getProfileImageUrl(row),
        initials: initialsFromName(getDisplayName(row) || row?.email || userId),
      });
    }

    const savedIds = Array.isArray(employeeProcessSettings?.rotationUserIds)
      ? employeeProcessSettings.rotationUserIds.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const orderedIds = savedIds.length ? savedIds : Array.from(rowsById.keys());

    return orderedIds
      .map((userId) => rowsById.get(userId))
      .filter(Boolean)
      .map((row) => {
        const status = resolveEmployeeProcessStatus(row.userId);
        return {
          ...row,
          statusLabel: status.label,
          statusTone: status.tone,
          isAvailable: !!status.available,
          canReady: !!status.canReady,
          readySignature: status.readySignature || "",
          isReadyOverride: !!status.isReadyOverride,
        };
      });
  }, [employeeProcessSettings?.rotationUserIds, employees, resolveEmployeeProcessStatus]);

  useEffect(() => {
    setEmployeeProcessReadyOverrides((prev) => {
      const current = prev && typeof prev === "object" ? prev : {};
      const validSignaturesByUserId = new Map(
        employeeProcessRows
          .map((row) => [
            String(row.userId || "").trim(),
            String(row.readySignature || "").trim(),
          ])
          .filter(([userId, signature]) => userId && signature)
      );

      const next = {};
      for (const [userId, signature] of Object.entries(current)) {
        if (validSignaturesByUserId.get(userId) === signature) {
          next[userId] = signature;
        }
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      const unchanged =
        currentKeys.length === nextKeys.length &&
        nextKeys.every((key) => current[key] === next[key]);

      if (unchanged) return prev;
      writeEmployeeProcessReadyOverrides(next);
      return next;
    });
  }, [employeeProcessRows]);

  const employeeProcessRotationUserIds = useMemo(
    () => employeeProcessRows.map((row) => row.userId).filter(Boolean),
    [employeeProcessRows]
  );

  const employeeProcessUnavailableUserIds = useMemo(
    () => employeeProcessRows.filter((row) => !row.isAvailable).map((row) => row.userId),
    [employeeProcessRows]
  );

  const firstAvailableProcessUserId =
    employeeProcessRows.find((row) => row.isAvailable)?.userId || "";

  const savedIbUserId = String(employeeProcessSettings?.ibUserId || "").trim();
  const savedNlUserId = String(employeeProcessSettings?.nlUserId || "").trim();
  const savedPurpleIbUserId = String(employeeProcessSettings?.purpleIbUserId || "").trim();
  const hasSavedIbUser = employeeProcessRows.some((row) => row.userId === savedIbUserId);
  const hasSavedNlUser = employeeProcessRows.some((row) => row.userId === savedNlUserId);
  const hasSavedPurpleIbUser = employeeProcessRows.some((row) => row.userId === savedPurpleIbUserId);
  const isSavedIbUserAvailable = employeeProcessRows.some(
    (row) => row.userId === savedIbUserId && row.isAvailable
  );
  const isSavedNlUserAvailable = employeeProcessRows.some(
    (row) => row.userId === savedNlUserId && row.isAvailable
  );
  const isSavedPurpleIbUserAvailable = employeeProcessRows.some(
    (row) => row.userId === savedPurpleIbUserId && row.isAvailable
  );
  const effectiveIbUserId = hasSavedIbUser
    ? savedIbUserId
    : firstAvailableProcessUserId;
  const effectiveNlUserId = hasSavedNlUser
    ? savedNlUserId
    : firstAvailableProcessUserId;
  const employeeProcessSecondaryIbUnavailableUserIds = useMemo(
    () =>
      Array.from(
        new Set(
          [...employeeProcessUnavailableUserIds, effectiveIbUserId]
            .map((userId) => String(userId || "").trim())
            .filter(Boolean)
        )
      ),
    [effectiveIbUserId, employeeProcessUnavailableUserIds]
  );
  const employeeProcessNextPurpleIbUserId = useMemo(() => {
    if (!effectiveIbUserId || savedPurpleIbUserId) return "";
    return getNextEmployeeProcessUserId({
      rotationUserIds: employeeProcessRotationUserIds,
      currentUserId: effectiveIbUserId,
      unavailableUserIds: employeeProcessSecondaryIbUnavailableUserIds,
    });
  }, [
    effectiveIbUserId,
    employeeProcessRotationUserIds,
    employeeProcessSecondaryIbUnavailableUserIds,
    savedPurpleIbUserId,
  ]);

  useEffect(() => {
    if (employeeProcessLoading || employeeProcessError) return;
    if (!employeeProcessRotationUserIds.length) return;

    const nextAssignments = {};
    if ((!hasSavedIbUser || !isSavedIbUserAvailable) && firstAvailableProcessUserId) {
      nextAssignments.ibUserId = getNextEmployeeProcessUserId({
        rotationUserIds: employeeProcessRotationUserIds,
        currentUserId: savedIbUserId,
        unavailableUserIds: employeeProcessUnavailableUserIds,
      });
    }
    if ((!hasSavedNlUser || !isSavedNlUserAvailable) && firstAvailableProcessUserId) {
      nextAssignments.nlUserId = getNextEmployeeProcessUserId({
        rotationUserIds: employeeProcessRotationUserIds,
        currentUserId: savedNlUserId,
        unavailableUserIds: employeeProcessUnavailableUserIds,
      });
    }
    if (
      savedPurpleIbUserId &&
      (
        !hasSavedPurpleIbUser ||
        !isSavedPurpleIbUserAvailable ||
        savedPurpleIbUserId === effectiveIbUserId
      )
    ) {
      nextAssignments.purpleIbUserId = "";
    }
    if (nextAssignments.ibUserId === savedIbUserId) delete nextAssignments.ibUserId;
    if (nextAssignments.nlUserId === savedNlUserId) delete nextAssignments.nlUserId;
    if (nextAssignments.purpleIbUserId === savedPurpleIbUserId) {
      delete nextAssignments.purpleIbUserId;
    }
    if (!Object.keys(nextAssignments).length) return;

    const signature = [
      savedIbUserId,
      savedNlUserId,
      savedPurpleIbUserId,
      nextAssignments.ibUserId || "",
      nextAssignments.nlUserId || "",
      typeof nextAssignments.purpleIbUserId === "undefined" ? "" : nextAssignments.purpleIbUserId,
    ].join("|");
    if (employeeProcessAutoSyncRef.current === signature) return;
    employeeProcessAutoSyncRef.current = signature;

    setEmployeeProcessAssignments({
      ...nextAssignments,
      updatedByUserId: viewerUserId,
      updatedByName: pageData?.viewer?.name || pageData?.currentUser?.name || pageData?.user?.name || "Portal User",
    })
      .then(() => {
        setEmployeeProcessSettings((prev) => {
          const nextSettings = normalizeEmployeeProcessLocalSettings({
            ...prev,
            ...nextAssignments,
          });
          writeEmployeeProcessLocalSettings(nextSettings);
          return nextSettings;
        });
      })
      .catch((err) => {
        employeeProcessAutoSyncRef.current = "";
        setEmployeeProcessError(err?.message || "Unable to sync IB/NL assignment.");
      });
  }, [
    employeeProcessError,
    employeeProcessLoading,
    employeeProcessRotationUserIds,
    employeeProcessUnavailableUserIds,
    employeeProcessRotationUserIds.length,
    effectiveIbUserId,
    firstAvailableProcessUserId,
    hasSavedIbUser,
    hasSavedNlUser,
    hasSavedPurpleIbUser,
    isSavedIbUserAvailable,
    isSavedNlUserAvailable,
    isSavedPurpleIbUserAvailable,
    pageData,
    savedIbUserId,
    savedNlUserId,
    savedPurpleIbUserId,
    viewerUserId,
  ]);

  const canAdvanceEmployeeProcessForRow = useCallback(
    (userId) => {
      const uid = String(userId || "").trim();
      if (!uid) return false;
      if (viewerRole === "admin" || viewerRole === "super_admin") {
        return uid === String(normalizedSelectedUserId || "").trim();
      }
      if (viewerRole !== "employee") return false;
      return !viewerLinkedEmployeeId || viewerLinkedEmployeeId === uid;
    },
    [normalizedSelectedUserId, viewerLinkedEmployeeId, viewerRole]
  );

  const requestEmployeeProcessReady = useCallback(
    async (userId) => {
      const uid = String(userId || "").trim();
      if (!uid || !canAdvanceEmployeeProcessForRow(uid)) return false;

      const row = employeeProcessRows.find((item) => item.userId === uid);
      if (!row?.canReady || !row?.readySignature) return false;

      const previousOverrides =
        employeeProcessReadyOverrides && typeof employeeProcessReadyOverrides === "object"
          ? employeeProcessReadyOverrides
          : {};
      const nextOverrides = {
        ...previousOverrides,
        [uid]: row.readySignature,
      };

      setEmployeeProcessReadyOverrides(nextOverrides);
      writeEmployeeProcessReadyOverrides(nextOverrides);
      setEmployeeProcessError("");

      try {
        await setEmployeeProcessReadyOverridesInDb({
          readyOverrides: nextOverrides,
          updatedByUserId: viewerUserId,
          updatedByName:
            pageData?.viewer?.name || pageData?.currentUser?.name || pageData?.user?.name || "Portal User",
        });
        try {
          await createEmployeeProcessActionLog({
            employeeUserId: uid,
            employeeName: row.name,
            employeeProfileImageUrl: row.profileImg,
            actionType: "ready",
            actionLabel: "Marked Ready",
            actionScope: "ready",
            createdByUserId: viewerUserId,
            createdByName:
              pageData?.viewer?.name || pageData?.currentUser?.name || pageData?.user?.name || "Portal User",
          });
        } catch (logErr) {
          console.error("Unable to save employee process ready log.", logErr);
        }
        return true;
      } catch (err) {
        setEmployeeProcessReadyOverrides(previousOverrides);
        writeEmployeeProcessReadyOverrides(previousOverrides);
        setEmployeeProcessError(err?.message || "Unable to save ready status.");
        return false;
      }
    },
    [
      canAdvanceEmployeeProcessForRow,
      employeeProcessReadyOverrides,
      employeeProcessRows,
      pageData?.currentUser?.name,
      pageData?.user?.name,
      pageData?.viewer?.name,
      viewerUserId,
    ]
  );

  const handleAdvanceEmployeeProcess = useCallback(
    async (type, currentUserId) => {
      const uid = String(currentUserId || "").trim();
      if (!uid || !canAdvanceEmployeeProcessForRow(uid)) return false;
      const row = employeeProcessRows.find((item) => item.userId === uid);

      setEmployeeProcessBusy(type);
      setEmployeeProcessError("");
      try {
        const nextUserId = await advanceEmployeeProcessAssignment({
          type,
          unavailableUserIds: employeeProcessUnavailableUserIds,
          fallbackRotationUserIds: employeeProcessRotationUserIds,
          updatedByUserId: viewerUserId,
          updatedByName: pageData?.viewer?.name || pageData?.currentUser?.name || pageData?.user?.name || "Portal User",
        });
        const settingKey = String(type || "").toLowerCase() === "nl" ? "nlUserId" : "ibUserId";
        setEmployeeProcessSettings((prev) => {
          const nextSettings = normalizeEmployeeProcessLocalSettings({
            ...prev,
            [settingKey]: nextUserId,
          });
          writeEmployeeProcessLocalSettings(nextSettings);
          return nextSettings;
        });
        try {
          await createEmployeeProcessActionLog({
            employeeUserId: uid,
            employeeName: row?.name || "",
            employeeProfileImageUrl: row?.profileImg || "",
            actionType: String(type || "").toLowerCase() === "nl" ? "finish_nl" : "finish_ib",
            actionLabel: String(type || "").toLowerCase() === "nl" ? "Finished New Lead" : "Finished Inbound",
            actionScope: String(type || "").toLowerCase() === "nl" ? "new_lead" : "inbound",
            relatedUserId: nextUserId,
            relatedUserName:
              employeeProcessRows.find((item) => item.userId === nextUserId)?.name || "",
            createdByUserId: viewerUserId,
            createdByName:
              pageData?.viewer?.name || pageData?.currentUser?.name || pageData?.user?.name || "Portal User",
          });
        } catch (logErr) {
          console.error("Unable to save employee process action log.", logErr);
        }
        return true;
      } catch (err) {
        setEmployeeProcessError(err?.message || `Unable to advance ${String(type).toUpperCase()}.`);
        return false;
      } finally {
        setEmployeeProcessBusy("");
      }
    },
    [
      canAdvanceEmployeeProcessForRow,
      employeeProcessRotationUserIds,
      employeeProcessUnavailableUserIds,
      pageData,
      viewerUserId,
    ]
  );

  const requestEmployeeProcessFinish = useCallback(
    (type, currentUserId) => {
      const uid = String(currentUserId || "").trim();
      if (!uid || !canAdvanceEmployeeProcessForRow(uid)) return;
      setEmployeeProcessConfirmAction({
        type: String(type || "").toLowerCase() === "nl" ? "nl" : "ib",
        userId: uid,
      });
    },
    [canAdvanceEmployeeProcessForRow]
  );

  const handleSetEmployeeProcessPurpleIb = useCallback(
    async (nextPurpleIbUserId, actionUserId) => {
      const targetUserId = String(nextPurpleIbUserId || "").trim();
      const uid = String(actionUserId || targetUserId || savedPurpleIbUserId || "").trim();
      if (!uid || !canAdvanceEmployeeProcessForRow(uid)) return false;
      if (targetUserId && targetUserId !== employeeProcessNextPurpleIbUserId) return false;
      if (!targetUserId && uid !== savedPurpleIbUserId) return false;
      const row = employeeProcessRows.find((item) => item.userId === uid);

      setEmployeeProcessBusy(targetUserId ? "purple_ib_mark" : "purple_ib_remove");
      setEmployeeProcessError("");
      try {
        await setEmployeeProcessAssignments({
          purpleIbUserId: targetUserId,
          updatedByUserId: viewerUserId,
          updatedByName: pageData?.viewer?.name || pageData?.currentUser?.name || pageData?.user?.name || "Portal User",
        });
        setEmployeeProcessSettings((prev) => {
          const nextSettings = normalizeEmployeeProcessLocalSettings({
            ...prev,
            purpleIbUserId: targetUserId,
          });
          writeEmployeeProcessLocalSettings(nextSettings);
          return nextSettings;
        });
        try {
          await createEmployeeProcessActionLog({
            employeeUserId: uid,
            employeeName: row?.name || "",
            employeeProfileImageUrl: row?.profileImg || "",
            actionType: targetUserId ? "purple_ib_mark" : "purple_ib_remove",
            actionLabel: targetUserId ? "Marked Secondary IB" : "Removed Secondary IB",
            actionScope: "secondary_ib",
            relatedUserId: targetUserId,
            relatedUserName:
              targetUserId ? employeeProcessRows.find((item) => item.userId === targetUserId)?.name || "" : "",
            createdByUserId: viewerUserId,
            createdByName:
              pageData?.viewer?.name || pageData?.currentUser?.name || pageData?.user?.name || "Portal User",
          });
        } catch (logErr) {
          console.error("Unable to save employee process action log.", logErr);
        }
        return true;
      } catch (err) {
        setEmployeeProcessError(
          err?.message || (targetUserId ? "Unable to mark secondary IB." : "Unable to remove secondary IB.")
        );
        return false;
      } finally {
        setEmployeeProcessBusy("");
      }
    },
    [
      canAdvanceEmployeeProcessForRow,
      employeeProcessNextPurpleIbUserId,
      pageData,
      savedPurpleIbUserId,
      viewerUserId,
    ]
  );

  const requestEmployeeProcessPurpleIb = useCallback(
    (mode, userId) => {
      const uid = String(userId || "").trim();
      const actionMode = String(mode || "").toLowerCase() === "remove" ? "remove" : "mark";
      if (!uid || !canAdvanceEmployeeProcessForRow(uid)) return;
      if (actionMode === "mark" && uid !== employeeProcessNextPurpleIbUserId) return;
      if (actionMode === "remove" && uid !== savedPurpleIbUserId) return;
      setEmployeeProcessConfirmAction({
        type: "purple_ib",
        mode: actionMode,
        userId: uid,
      });
    },
    [
      canAdvanceEmployeeProcessForRow,
      employeeProcessNextPurpleIbUserId,
      savedPurpleIbUserId,
    ]
  );

  const cancelEmployeeProcessFinish = useCallback(() => {
    if (employeeProcessBusy) return;
    setEmployeeProcessConfirmAction(null);
  }, [employeeProcessBusy]);

  const confirmEmployeeProcessFinish = useCallback(async () => {
    const action = employeeProcessConfirmAction;
    if (!action?.type || !action?.userId) return;
    if (action.type === "purple_ib") {
      const didUpdate = await handleSetEmployeeProcessPurpleIb(
        action.mode === "remove" ? "" : action.userId,
        action.userId
      );
      if (didUpdate) setEmployeeProcessConfirmAction(null);
      return;
    }
    const didFinish = await handleAdvanceEmployeeProcess(action.type, action.userId);
    if (didFinish) setEmployeeProcessConfirmAction(null);
  }, [employeeProcessConfirmAction, handleAdvanceEmployeeProcess, handleSetEmployeeProcessPurpleIb]);

  const employeeProcessConfirmEmployee = useMemo(
    () =>
      employeeProcessRows.find(
        (row) => row.userId === String(employeeProcessConfirmAction?.userId || "").trim()
      ) || null,
    [employeeProcessConfirmAction?.userId, employeeProcessRows]
  );
  const employeeProcessConfirmIsPurpleIb = employeeProcessConfirmAction?.type === "purple_ib";
  const employeeProcessConfirmIsPurpleRemove =
    employeeProcessConfirmIsPurpleIb && employeeProcessConfirmAction?.mode === "remove";
  const employeeProcessConfirmIsNl = employeeProcessConfirmAction?.type === "nl";
  const employeeProcessConfirmLabel = employeeProcessConfirmIsNl ? "new lead" : "inbound";
  const employeeProcessConfirmTitle = employeeProcessConfirmIsPurpleIb
    ? employeeProcessConfirmIsPurpleRemove
      ? "Remove Secondary IB?"
      : "Mark Secondary IB?"
    : employeeProcessConfirmIsNl
      ? "Finish New Lead?"
      : "Finish Inbound?";
  const employeeProcessConfirmMessage = employeeProcessConfirmIsPurpleIb
    ? employeeProcessConfirmIsPurpleRemove
      ? `Remove the secondary IB mark from ${employeeProcessConfirmEmployee?.name || "this employee"}?`
      : `Mark ${employeeProcessConfirmEmployee?.name || "this employee"} as the secondary IB?`
    : `Finish ${employeeProcessConfirmLabel} for ${
        employeeProcessConfirmEmployee?.name || "this employee"
      } and move the mark to the next available employee?`;
  const employeeProcessConfirmButtonText = employeeProcessConfirmIsPurpleIb
    ? employeeProcessConfirmIsPurpleRemove
      ? "Remove IB Mark"
      : "Mark IB"
    : employeeProcessConfirmIsNl
      ? "Finish new lead"
      : "Finish Inbound";

  const employeeProcessActionUserId =
    viewerRole === "employee"
      ? String(viewerLinkedEmployeeId || normalizedSelectedUserId || "").trim()
      : viewerRole === "admin" || viewerRole === "super_admin"
        ? String(normalizedSelectedUserId || "").trim()
      : "";
  const showEmployeeProcessActionModal =
    !!employeeProcessActionUserId &&
    (
      employeeProcessActionUserId === effectiveIbUserId ||
      employeeProcessActionUserId === effectiveNlUserId
    );
  const employeeProcessActionEmployee = useMemo(
    () =>
      employeeProcessRows.find((row) => row.userId === employeeProcessActionUserId) ||
      null,
    [employeeProcessActionUserId, employeeProcessRows]
  );

  const callActivityDurationMinutes = useMemo(
    () => calculateDurationMinutes(
      callActivityForm.entryDate,
      callActivityForm.startTime,
      callActivityForm.endTime
    ),
    [callActivityForm.entryDate, callActivityForm.startTime, callActivityForm.endTime]
  );

  const updateCallActivityForm = useCallback((field, value) => {
    setCallActivityForm((prev) => ({ ...prev, [field]: value }));
    setCallActivityStatus({ type: "", message: "" });
    setCallActivityMissingFields([]);
  }, []);

  const validateCallActivityForm = useCallback(() => {
    const requiredFields = [
      { field: "entryDate", label: "Date" },
      { field: "startTime", label: "Start time" },
      { field: "endTime", label: "End time" },
      { field: "activityType", label: "Activity type" },
      { field: "count", label: "Count" },
    ];
    const missingFields = requiredFields.filter(({ field }) => !String(callActivityForm[field] || "").trim());

    if (missingFields.length) {
      const missingFieldLabels = missingFields.map(({ label }) => label);
      setCallActivityMissingFields(missingFields.map(({ field }) => field));
      setCallActivityStatus({
        type: "error",
        message: `Please fill in ${formatLabelList(missingFieldLabels)} before saving.`,
      });
      const firstMissingField = missingFields[0]?.field;
      callActivityFieldRefs.current[firstMissingField]?.focus?.();
      return false;
    }

    setCallActivityMissingFields([]);
    return true;
  }, [callActivityForm]);

  const getCallActivityTimeParts = useCallback((field) => {
    const rawValue = String(callActivityForm[field] || "");
    const match = rawValue.match(/^(\d{2}):(\d{2})$/);
    if (match) return { hour: match[1], minute: match[2] };
    const now = new Date();
    return { hour: pad2(now.getHours()), minute: pad2(now.getMinutes()) };
  }, [callActivityForm]);

  const updateCallActivityTimePart = useCallback((field, part, value) => {
    const current = getCallActivityTimeParts(field);
    const next = {
      ...current,
      [part]: value,
    };
    updateCallActivityForm(field, `${next.hour}:${next.minute}`);
  }, [getCallActivityTimeParts, updateCallActivityForm]);

  const renderCallActivityTimeField = (field, label) => {
    const timeParts = getCallActivityTimeParts(field);
    const isOpen = activeCallActivityTimeField === field;

    return (
      <label className="callActivityTimeField">
        <span>{label}</span>
        <div
          className="callActivityTimeInputWrap"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setActiveCallActivityTimeField("");
            }
          }}
        >
          <input
            ref={(node) => {
              callActivityFieldRefs.current[field] = node;
            }}
            type="text"
            inputMode="numeric"
            placeholder="HH:MM"
            value={callActivityForm[field]}
            onClick={() => setActiveCallActivityTimeField(field)}
            onFocus={() => setActiveCallActivityTimeField(field)}
            onChange={(event) => updateCallActivityForm(field, event.target.value)}
            required
          />
          {isOpen ? (
            <div className="callActivityTimePopover">
              <select
                aria-label={`${label} hour`}
                value={timeParts.hour}
                onChange={(event) => updateCallActivityTimePart(field, "hour", event.target.value)}
              >
                {TIME_PICKER_HOURS.map((hour) => (
                  <option key={hour} value={hour}>{hour}</option>
                ))}
              </select>
              <span>:</span>
              <select
                aria-label={`${label} minute`}
                value={timeParts.minute}
                onChange={(event) => updateCallActivityTimePart(field, "minute", event.target.value)}
              >
                {TIME_PICKER_MINUTES.map((minute) => (
                  <option key={minute} value={minute}>{minute}</option>
                ))}
              </select>
              <button type="button" onClick={() => setActiveCallActivityTimeField("")}>Done</button>
            </div>
          ) : null}
        </div>
      </label>
    );
  };

  const handleSubmitCallActivity = useCallback(async (event) => {
    event.preventDefault();
    if (!employee) {
      setCallActivityStatus({ type: "error", message: "No employee selected." });
      return;
    }

    if (!validateCallActivityForm()) return;

    setCallActivitySaving(true);
    setCallActivityStatus({ type: "", message: "" });
    try {
      const employeeUserId = String(getUserId(employee) || effectiveSelectedId || "").trim();
      await createCallActivityLog({
        ...callActivityForm,
        employeeUserId,
        employeeName: getDisplayName(employee),
        employeeEmail: employee?.email || "",
        createdByUserId: viewerUserId || employeeUserId,
        createdByName: pageData?.viewer?.name || pageData?.currentUser?.name || pageData?.user?.name || getDisplayName(employee),
        createdByEmail: viewerEmail || employee?.email || "",
      });
      setCallActivityStatus({ type: "success", message: "Activity saved to Firebase." });
      setCallActivityMissingFields([]);
      setCallActivityForm((prev) => ({
        ...prev,
        startTime: "",
        endTime: "",
        count: "0",
        notes: "",
      }));
    } catch (err) {
      setCallActivityStatus({ type: "error", message: err?.message || "Unable to save activity." });
    } finally {
      setCallActivitySaving(false);
    }
  }, [callActivityForm, effectiveSelectedId, employee, pageData, validateCallActivityForm, viewerEmail, viewerUserId]);

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

  const notepadGroupMemberOptions = useMemo(() => {
    const rows = [];
    const seen = new Set();
    for (const employeeRow of Array.isArray(employees) ? employees : []) {
      const userId = toText(getUserId(employeeRow));
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      rows.push({
        userId,
        name: toText(getDisplayName(employeeRow)) || userId,
        profileImg: toText(profileImagesByUserId?.[userId]) || getProfileImageUrl(employeeRow) || "",
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [employees, profileImagesByUserId]);

  const resolveNotepadMemberProfiles = useCallback(
    (memberIds = [], rawMemberProfiles = []) => {
      const memberIdList = sanitizeNotepadMemberUserIds(memberIds);
      const profileByUserId = new Map(
        sanitizeNotepadMemberProfiles(rawMemberProfiles)
          .filter((item) => item.userId)
          .map((item) => [item.userId, item])
      );
      return memberIdList.map((userId) => {
        const fromDoc = profileByUserId.get(userId) || null;
        const employeeRow = employeesByUserId.get(userId) || null;
        const name =
          toText(fromDoc?.name) || (employeeRow ? toText(getDisplayName(employeeRow)) : "") || userId;
        const profileImg =
          toText(fromDoc?.profileImg) ||
          toText(profileImagesByUserId?.[userId]) ||
          (employeeRow ? getProfileImageUrl(employeeRow) : "") ||
          "";
        return {
          userId,
          name,
          profileImg,
        };
      });
    },
    [employeesByUserId, profileImagesByUserId]
  );

  const getNotepadGroupMembers = useCallback(
    (note = {}) => {
      if (normalizeNotepadScope(note?.noteScope) !== "group") return [];
      return resolveNotepadMemberProfiles(note?.memberUserIds, note?.memberProfiles);
    },
    [resolveNotepadMemberProfiles]
  );

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
  const BREAK_LOG_FILTER_OPTIONS = [
    { key: "today", label: "Today" },
    { key: "thisWeek", label: "This Week" },
    { key: "thisMonth", label: "This Month" },
    { key: "all", label: "All" },
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
      if (taskFilterMenuRef.current?.contains(event.target)) return;
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
    if (isTaskListDrawerOpen) return;
    setIsTaskFilterOpen(false);
  }, [isTaskListDrawerOpen]);

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

  useEffect(() => {
    if (!onFetchFullHistory) return;

    const rows = Array.isArray(employees) ? employees : [];
    for (const emp of rows) {
      const uid = String(getUserId(emp) ?? emp?.userId ?? emp?.id ?? "").trim();
      if (!uid) continue;

      const existing = Array.isArray(historyByUserId?.[uid]) && historyByUserId[uid].length > 0;
      const loading = !!loadingHistoryByUserId?.[uid];
      if (existing || loading || requestedHistoryRef.current.has(uid)) continue;

      requestedHistoryRef.current.add(uid);
      Promise.resolve(onFetchFullHistory(uid)).catch(() => {
        requestedHistoryRef.current.delete(uid);
      });
    }
  }, [employees, onFetchFullHistory, historyByUserId, loadingHistoryByUserId]);

  // Cost control: do not prefetch full history for every employee.
  // Full history is loaded only for the selected employee, then cached by App.jsx.

  useEffect(() => {
    if (!isBreakLogsDrawerOpen) return;

    const uid = String(effectiveSelectedId || "").trim();
    if (!uid) {
      setBreakLogRows([]);
      setBreakLogError("");
      setBreakLogLoading(false);
      return;
    }

    const cacheKey = `${uid}|${breakLogFilter}`;
    const cachedRows = breakLogsCacheRef.current[cacheKey];
    if (Array.isArray(cachedRows) && breakLogRefreshToken === 0) {
      setBreakLogRows(cachedRows);
      setBreakLogError("");
      setBreakLogLoading(false);
      return;
    }

    let active = true;
    setBreakLogLoading(true);
    setBreakLogError("");

    Promise.resolve(getBreakLogsByUserIdsInRange([uid]))
      .then((rowsByUserId) => {
        if (!active) return;
        const rows = Array.isArray(rowsByUserId?.[uid]) ? rowsByUserId[uid] : [];
        breakLogsCacheRef.current[cacheKey] = rows;
        setBreakLogRows(rows);
      })
      .catch((err) => {
        if (!active) return;
        setBreakLogRows([]);
        setBreakLogError(err?.message || "Failed to load break logs.");
      })
      .finally(() => {
        if (active) setBreakLogLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isBreakLogsDrawerOpen, effectiveSelectedId, breakLogRefreshToken]);

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

  const selectedEmployeeDotMonth = useMemo(() => {
    const endDateMonth = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ""))
      ? String(endDate).slice(0, 7)
      : "";
    if (endDateMonth) return endDateMonth;
    return monthKeyFromMsInZone(nowMs || Date.now(), businessTimeZone);
  }, [endDate, nowMs, businessTimeZone]);

  const selectedEmployeeDotDayKeys = useMemo(() => {
    if (!/^\d{4}-\d{2}$/.test(selectedEmployeeDotMonth)) return [];
    const start = `${selectedEmployeeDotMonth}-01`;
    const startDate = parseYmdToUtcNoon(start);
    if (!startDate) return [];
    const endDateObj = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 0, 12, 0, 0));
    return enumerateYmdRange(start, ymdFromUtcDate(endDateObj));
  }, [selectedEmployeeDotMonth]);

  const selectedEmployeeDotWeekGroups = useMemo(() => {
    if (!selectedEmployeeDotDayKeys.length) return [];
    const groups = [];
    let activeWeekKey = "";
    let activeGroup = [];

    for (const dayKey of selectedEmployeeDotDayKeys) {
      const weekKey = startOfWeekYmd(dayKey);
      if (weekKey !== activeWeekKey) {
        if (activeGroup.length) groups.push(activeGroup);
        activeWeekKey = weekKey;
        activeGroup = [];
      }
      activeGroup.push(dayKey);
    }

    if (activeGroup.length) groups.push(activeGroup);
    return groups;
  }, [selectedEmployeeDotDayKeys]);

  const selectedEmployeeDotWeekLabels = useMemo(
    () =>
      selectedEmployeeDotWeekGroups.map((weekDays) => {
        const firstDay = (weekDays[0] || "").slice(-2).replace(/^0/, "") || "-";
        const lastDay = (weekDays[weekDays.length - 1] || weekDays[0] || "").slice(-2).replace(/^0/, "") || firstDay;
        return `${firstDay} - ${lastDay}`;
      }),
    [selectedEmployeeDotWeekGroups]
  );

  const selectedEmployeeDotWeekTrackStyle = useMemo(
    () => ({
      "--break-employee-dot-week-count": Math.max(1, selectedEmployeeDotWeekLabels.length),
    }),
    [selectedEmployeeDotWeekLabels.length]
  );

  const selectedEmployeeDotRangeLabel = useMemo(() => {
    if (!selectedEmployeeDotDayKeys.length || !selectedEmployeeDotMonth) return "No month selected";
    const lastDay = selectedEmployeeDotDayKeys[selectedEmployeeDotDayKeys.length - 1]?.slice(-2).replace(/^0/, "");
    return `From 1 - ${lastDay} ${prettyMonthLabel(selectedEmployeeDotMonth)}`;
  }, [selectedEmployeeDotDayKeys, selectedEmployeeDotMonth]);

  const selectedEmployeeDotRow = useMemo(() => {
    if (!effectiveSelectedId || !selectedEmployeeDotWeekGroups.length) return null;
    const zone = String(businessTimeZone || "").trim() || "America/Chicago";
    const sourceLogs = mergeAttendanceScoreLogs(logsToday, historyLogs);
    const byDay = new Map();
    const bucketLabelByKey = ATTENDANCE_BUCKETS.reduce((acc, item) => {
      acc[item.key] = item.label;
      return acc;
    }, {});

    for (const log of sourceLogs) {
      const dayKey = getAttendanceScoreDayKey(log, zone);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !dayKey.startsWith(`${selectedEmployeeDotMonth}-`)) continue;
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey).push(log);
    }

    const loggedDayKeys = Array.from(byDay.keys()).sort();
    const firstDayKey = loggedDayKeys[0] || "";
    const currentMonth = monthKeyFromMsInZone(nowMs || Date.now(), zone);
    const effectiveEndDate =
      /^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ""))
        ? String(endDate)
        : dayKeyFromMsInZone(nowMs || Date.now(), zone) || "";
    const selectedMonthIsCurrent = selectedEmployeeDotMonth === currentMonth;

    let loggedDays = 0;
    let eligibleDays = 0;
    const weeks = selectedEmployeeDotWeekGroups.map((weekDays) =>
      weekDays.map((dayKey) => {
        if (!firstDayKey || dayKey >= firstDayKey) eligibleDays += 1;

        const dayLogs = byDay.get(dayKey) || [];
        if (dayLogs.length) {
          const primaryLog = pickPrimaryAttendanceLogForScore(dayLogs);
          const statusText = getAttendanceStatusText(primaryLog || {});
          let bucket = normalizeAttendanceScoreBucket(statusText);
          const typeText = normalize(pick(primaryLog || {}, ["type", "logType", "eventType"], ""));
          if (!bucket && typeText.includes("in")) bucket = "onTime";

          loggedDays += 1;
          return {
            key: `${effectiveSelectedId}-${dayKey}`,
            className: bucket ? `dash-tone-${bucket}` : "isUnknown",
            label: bucketLabelByKey[bucket] || "Logged",
            dayKey,
          };
        }

        if (firstDayKey && dayKey < firstDayKey) {
          return {
            key: `${effectiveSelectedId}-${dayKey}`,
            className: "isInactive",
            label: "Not started yet",
            dayKey,
          };
        }

        if (selectedMonthIsCurrent && effectiveEndDate && dayKey > effectiveEndDate) {
          return {
            key: `${effectiveSelectedId}-${dayKey}`,
            className: "isFuture",
            label: "Upcoming day",
            dayKey,
          };
        }

        return {
          key: `${effectiveSelectedId}-${dayKey}`,
          className: "isMissing",
          label: "No log",
          dayKey,
        };
      })
    );

    const selectedName = toText(getDisplayName(employee)) || "Selected Employee";
    return {
      userId: String(effectiveSelectedId),
      name: selectedName,
      initials: initialsFromName(selectedName),
      meta: `${loggedDays}/${eligibleDays} logged days`,
      weeks,
    };
  }, [
    effectiveSelectedId,
    employee,
    selectedEmployeeDotWeekGroups,
    selectedEmployeeDotMonth,
    nowMs,
    endDate,
    logsToday,
    historyLogs,
    businessTimeZone,
  ]);

  const selectedBreakLogs = useMemo(() => {
    const uid = normalizedSelectedUserId;
    if (!uid) return [];
    const rows =
      pageData?.breakLogsByUserId?.[uid] ||
      pageData?.breakLogsByUserId?.[String(effectiveSelectedId || "")];
    return Array.isArray(rows) ? rows : [];
  }, [normalizedSelectedUserId, effectiveSelectedId, pageData]);

  const derivedBreakUsage = useMemo(() => {
    if (!selectedBreakLogs.length) return null;
    const usage = calculateBreakUsageMinutes(
      selectedBreakLogs,
      Number.isFinite(liveNowMs) ? liveNowMs : Date.now()
    );
    if (!usage || typeof usage !== "object") return null;
    return usage;
  }, [selectedBreakLogs, liveNowMs]);

  const selectedBreakUsageRaw =
    breakUsageByUserId?.[normalizedSelectedUserId] ||
    breakUsageByUserId?.[String(effectiveSelectedId || "")] ||
    {};
  const selectedBreakUsage =
    selectedBreakUsageRaw && typeof selectedBreakUsageRaw === "object" ? selectedBreakUsageRaw : {};

  const breakUsage = useMemo(() => {
    const storedTotalMinutes = Math.max(0, Number(selectedBreakUsage.totalMinutes || 0));
    const storedActiveMinutes = Math.max(0, Number(selectedBreakUsage.activeBreakMinutes || 0));
    const derivedTotalMinutes = Math.max(0, Number(derivedBreakUsage?.totalMinutes || 0));
    const derivedActiveMinutes = Math.max(0, Number(derivedBreakUsage?.activeBreakMinutes || 0));
    const totalMinutes = Math.max(storedTotalMinutes, derivedTotalMinutes);
    const activeBreakMinutes = Math.max(storedActiveMinutes, derivedActiveMinutes);

    return {
      totalMinutes,
      activeBreakMinutes,
      remainingMinutes: Math.max(0, DAILY_BREAK_LIMIT_MINUTES - totalMinutes),
    };
  }, [selectedBreakUsage, derivedBreakUsage]);

  const activeBreak =
    activeBreaksByUserId?.[normalizedSelectedUserId] ||
    activeBreaksByUserId?.[String(effectiveSelectedId || "")] ||
    null;
  const isOnBreak = !!activeBreak;

  useEffect(() => {
    if (typeof onRefreshBreakForUser !== "function") return;
    if (!normalizedSelectedUserId) return;

    Promise.resolve(onRefreshBreakForUser(normalizedSelectedUserId)).catch(() => {});
  }, [normalizedSelectedUserId, onRefreshBreakForUser]);

  useEffect(() => {
    if (!Number.isFinite(nowMs)) return;
    setLiveNowMs(nowMs);
  }, [nowMs]);

  useEffect(() => {
    const id = setInterval(() => setLiveNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    if (!breakLoading) return undefined;

    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;

    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, [breakLoading]);

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
  const breakMinutesLeft = Math.max(0, breakLimitMinutes - effectiveUsedMinutes);
  const breakRemainingPct = Math.min(
    100,
    Math.max(0, (breakMinutesLeft / Math.max(1, breakLimitMinutes)) * 100)
  );
  const breakProgressPercent = Math.round(breakRemainingPct);
  const showBreakWarningMarker = breakMinutesLeft > 0 && breakMinutesLeft <= 5;
  const breakRemainingRatio = Math.min(1, Math.max(0, breakMinutesLeft / Math.max(1, breakLimitMinutes)));
  const breakProgressHue = Math.round(120 * breakRemainingRatio);
  const breakProgressColor = `hsl(${breakProgressHue} 78% 42%)`;
  const breakDonutOffset = 100 - breakProgressPercent;
  const breakDonutAngle = breakProgressPercent * 3.6;
  const breakThirtyMinuteMarkerAngle =
    -Math.min(100, Math.max(0, (30 / Math.max(1, breakLimitMinutes)) * 100)) * 3.6;
  const breakSecondsLeftTotal = Math.max(0, Math.ceil(breakMinutesLeft * 60));
  const breakMinutesCounter = Math.floor(breakSecondsLeftTotal / 60);
  const breakSecondsCounter = breakSecondsLeftTotal % 60;
  const breakSecondsLabel = String(breakSecondsCounter).padStart(2, "0");
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
  const breakToggleLabel = isOnBreak ? "Back to work" : "Take a break";

  async function handleBreakToggle() {
    if (!employee) return;

    setBreakLoading(true);
    setBreakError("");

    try {
      const userId = String(getUserId(employee) ?? effectiveSelectedId ?? "").trim();
      const name = employee?.name || employee?.fullName || employee?.displayName || "";
      const email = employee?.email || "";

      if (!userId) {
        throw new Error("Employee ID not found");
      }

      const breakAction = isOnBreak ? "end" : "start";

      if (isOnBreak) {
        await endBreak(userId);
      } else {
        if (breakMinutesLeft <= 0) {
          throw new Error("You already used the full 60-minute break allowance for today");
        }
        await startBreak({ userId, name, email });
      }

      if (typeof onBreakStatusChanged === "function") {
        await onBreakStatusChanged({ userId, action: breakAction });
      }

      setBreakLogRefreshToken((prev) => prev + 1);
    } catch (err) {
      const rawMessage = String(err?.message || "").trim();
      const normalizedMessage = rawMessage.toLowerCase();
      const hasBreakStateMismatch =
        normalizedMessage.includes("already has an active break") ||
        normalizedMessage.includes("no active break found");

      if (hasBreakStateMismatch && typeof onBreakStatusChanged === "function") {
        try {
          await onBreakStatusChanged({ userId: String(getUserId(employee) ?? effectiveSelectedId ?? "").trim(), action: "sync" });
          setBreakLogRefreshToken((prev) => prev + 1);
          setBreakError(
            normalizedMessage.includes("already has an active break")
              ? "User is already on break. Synced latest status."
              : "User is not on an active break. Synced latest status."
          );
          return;
        } catch (syncErr) {
          const syncMessage = String(syncErr?.message || "").trim();
          setBreakError(syncMessage || rawMessage || "Failed to update break");
          return;
        }
      }

      setBreakError(rawMessage || "Failed to update break");
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

  const filteredBreakLogRows = useMemo(() => {
    const logs = Array.isArray(breakLogRows) ? breakLogRows : [];
    if (!logs.length) return [];

    if (breakLogFilter === "all") {
      return logs
        .slice()
        .sort(
          (a, b) =>
            toMillis(b?.startedAt ?? b?.createdAt) - toMillis(a?.startedAt ?? a?.createdAt)
        );
    }

    const referenceMs = Number.isFinite(liveNowMs) ? liveNowMs : Date.now();
    const zone = String(businessTimeZone || "").trim() || "America/Chicago";
    const todayDayKey = dayKeyFromMsInZone(referenceMs, zone);
    const { startDayKey, endDayKey } = getWeekRangeDayKeysInZone(referenceMs, zone);
    const monthKey = monthKeyFromMsInZone(referenceMs, zone);

    const filtered = logs.filter((row) => {
      const startedMs = toMillis(row?.startedAt ?? row?.createdAt);
      if (!Number.isFinite(startedMs)) return false;

      const dayKey = dayKeyFromMsInZone(startedMs, zone);
      if (!dayKey) return false;

      if (breakLogFilter === "thisMonth") {
        return !!monthKey && dayKey.slice(0, 7) === monthKey;
      }

      if (breakLogFilter === "today") {
        return !!todayDayKey && dayKey === todayDayKey;
      }

      if (breakLogFilter === "thisWeek") {
        return !!startDayKey && !!endDayKey && dayKey >= startDayKey && dayKey <= endDayKey;
      }

      return true;
    });

    return filtered.sort(
      (a, b) => toMillis(b?.startedAt ?? b?.createdAt) - toMillis(a?.startedAt ?? a?.createdAt)
    );
  }, [breakLogRows, breakLogFilter, liveNowMs, businessTimeZone]);

  const breakLogEmptyText = useMemo(() => {
    if (breakLogFilter === "today") return "No break logs today.";
    if (breakLogFilter === "thisMonth") return "No break logs this month.";
    if (breakLogFilter === "all") return "No break logs found.";
    return "No break logs this week.";
  }, [breakLogFilter]);

  const selectedNotepadNote = useMemo(
    () =>
      (Array.isArray(notepadNotes) ? notepadNotes : []).find(
        (note) => String(note?.id || "") === String(selectedNotepadNoteId || "")
      ) || null,
    [notepadNotes, selectedNotepadNoteId]
  );

  useEffect(() => {
    if (String(selectedNotepadNoteId || "").trim()) {
      setIsNotepadNewDraftOpen(false);
    }
  }, [selectedNotepadNoteId]);

  const notepadNewDraftCanEdit =
    isNotepadNewDraftOpen &&
    String(notepadViewMode || "") === NOTEPAD_VIEW_MY &&
    !isNotepadGroupCreatorOpen;
  const notepadDisabled = !String(selectedNotepadNoteId || "").trim() && !notepadNewDraftCanEdit;

  
  const notepadLocalDraftStorageKey = useMemo(
    () => getNotepadLocalDraftStorageKey(effectiveSelectedId, selectedNotepadNoteId),
    [effectiveSelectedId, selectedNotepadNoteId]
  );

  const formatNotepadDateLabel = useCallback(
    (value) => {
      const ms = toMillis(value);
      if (!Number.isFinite(ms)) return "No date";
      return new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
      });
    },
    [businessTimeZone]
  );

  const formatNotepadDeadlineLabel = useCallback(
    (deadlineValue, tone = "upcoming") => {
      const ms = toMillis(deadlineValue);
      if (!Number.isFinite(ms)) return "No deadline";
      const stamp = new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
      });
      if (tone === "overdue") return `Overdue: ${stamp}`;
      if (tone === "due") return `Due soon: ${stamp}`;
      return `Due: ${stamp}`;
    },
    [businessTimeZone]
  );

  const formatNotepadDueLabel = useCallback(
    (deadlineAtValue) => {
      const deadlineMs = toMillis(deadlineAtValue);
      if (!Number.isFinite(deadlineMs)) return "No due date set";
      return formatNotepadDateLabel(deadlineMs);
    },
    [formatNotepadDateLabel]
  );

  const createNotepadNotificationIfMissing = useCallback(
    async ({
      eventKey = "",
      userId = "",
      type = "",
      title = "",
      message = "",
      noteId = "",
      noteScope = "personal",
      noteTitle = "",
      deadlineAt = null,
      actorUserId = "",
      actorName = "",
    }) => {
      const normalizedEventKey = String(eventKey || "").trim();
      const normalizedUserId = String(userId || "").trim();
      if (!normalizedEventKey || !normalizedUserId) return false;

      if (notepadNotificationEventCacheRef.current.has(normalizedEventKey)) {
        return false;
      }

      try {
        const existingSnap = await getDocs(
          query(collection(db, NOTIFICATIONS_COLLECTION), where("eventKey", "==", normalizedEventKey))
        );
        if (!existingSnap.empty) {
          notepadNotificationEventCacheRef.current.add(normalizedEventKey);
          return false;
        }

        const recipient = employeesByUserId.get(normalizedUserId);
        await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
          eventKey: normalizedEventKey,
          audience: "employee",
          userId: normalizedUserId,
          role: "employee",
          name: toText(getDisplayName(recipient)),
          email: toText(recipient?.email || ""),
          type: String(type || "").trim(),
          title: String(title || "").trim(),
          message: String(message || "").trim(),
          targetPage: "employee_dashboard",
          noteId: String(noteId || "").trim(),
          noteScope: normalizeNotepadScope(noteScope),
          noteTitle: toText(noteTitle),
          deadlineAt: deadlineAt || null,
          createdByUserId: String(actorUserId || "").trim(),
          createdByName: toText(actorName),
          read: false,
          archived: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        notepadNotificationEventCacheRef.current.add(normalizedEventKey);
        return true;
      } catch (err) {
        console.error("Failed to create notepad notification:", err);
        return false;
      }
    },
    [employeesByUserId]
  );

  const notifyGroupChecklistUpdated = useCallback(
    async ({
      noteId = "",
      noteTitle = "",
      noteScope = "group",
      deadlineAt = null,
      memberUserIds = [],
      actorUserId = "",
      actorName = "",
      checklistItemText = "",
      checklistItemChecked = null,
    } = {}) => {
      const normalizedNoteId = String(noteId || "").trim();
      if (!normalizedNoteId) return;
      if (normalizeNotepadScope(noteScope) !== "group") return;

      const normalizedActorUserId = String(actorUserId || "").trim();
      const recipients = sanitizeNotepadMemberUserIds(memberUserIds).filter(
        (userId) => !normalizedActorUserId || userId !== normalizedActorUserId
      );
      if (!recipients.length) return;

      const actorEmployee = normalizedActorUserId
        ? employeesByUserId.get(normalizedActorUserId)
        : null;
      const viewerNameFallback = toText(
        pageData?.viewer?.name ||
          pageData?.viewer?.displayName ||
          pageData?.currentUser?.name ||
          pageData?.currentUser?.displayName ||
          pageData?.user?.name ||
          pageData?.user?.displayName
      );
      const providedActorName = toText(actorName);
      const actorDisplayName = toText(getDisplayName(actorEmployee));
      const normalizedViewerEmail = toText(viewerEmail);
      const actorNameCandidates = [
        providedActorName,
        actorDisplayName,
        viewerNameFallback,
        normalizedViewerEmail,
        normalizedActorUserId,
      ];
      const resolvedActorName =
        actorNameCandidates.find((candidate) => !isLikelyPlaceholderPersonLabel(candidate)) || "A teammate";
      const safeTitle = toText(noteTitle) || "Untitled group note";
      const safeChecklistText = toText(checklistItemText).replace(/\s+/g, " ").trim();
      const checklistAction =
        checklistItemChecked === true ? "checked" : checklistItemChecked === false ? "unchecked" : "updated";
      const checklistDetail = safeChecklistText
        ? `${checklistAction} checklist item "${safeChecklistText}"`
        : `${checklistAction} a checklist item`;
      const dueLabel = formatNotepadDueLabel(deadlineAt);
      const checklistKey = String(Math.floor(Date.now() / 60000));

      await Promise.all(
        recipients.map((recipientUserId) =>
          createNotepadNotificationIfMissing({
            eventKey: `notepad:notepad_group_checklist_updated:${normalizedNoteId}:${recipientUserId}:${checklistKey}`,
            userId: recipientUserId,
            type: "notepad_group_checklist_updated",
            title: "Group Note Checklist Updated",
            message: `${checklistDetail} by ${resolvedActorName} in group note "${safeTitle}". Due: ${dueLabel}.`,
            noteId: normalizedNoteId,
            noteScope: "group",
            noteTitle: safeTitle,
            deadlineAt: deadlineAt || null,
            actorUserId: normalizedActorUserId,
            actorName: resolvedActorName,
          })
        )
      );
    },
    [
      createNotepadNotificationIfMissing,
      employeesByUserId,
      formatNotepadDueLabel,
      pageData,
      viewerUserId,
      viewerEmail,
    ]
  );

  const emitNotepadRefreshSignal = useCallback(
    async ({ recipientUserIds = [], noteId = "", reason = "" } = {}) => {
      const normalizedRecipients = sanitizeNotepadMemberUserIds(recipientUserIds);
      if (!normalizedRecipients.length) return;
      const actorUserId = String(viewerUserId || effectiveSelectedId || "").trim();
      const safeReason = String(reason || "").trim();
      const safeNoteId = String(noteId || "").trim();
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      await Promise.all(
        normalizedRecipients.map((recipientUserId) =>
          setDoc(
            doc(db, NOTEPAD_REFRESH_SIGNAL_COLLECTION, recipientUserId),
            {
              userId: recipientUserId,
              actorUserId,
              noteId: safeNoteId,
              reason: safeReason,
              nonce,
              changedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          )
        )
      );
    },
    [viewerUserId, effectiveSelectedId]
  );

  const syncNotepadDraftFromEditor = useCallback(() => {
    if (!notepadEditorRef.current) return;
    setIsNotepadTyping(true);
    setNotepadStatusText("");
    setNotepadDirty(true);
    setNotepadContentDraft(notepadEditorRef.current.innerHTML || EMPTY_NOTEPAD_HTML);
  }, []);

  const getCurrentNotepadDraftSnapshot = useCallback(() => {
    const editorHtml = notepadEditorRef.current?.innerHTML || notepadContentDraft || EMPTY_NOTEPAD_HTML;
    const contentHtml =
      String(serializeNotepadEditorHtml(notepadEditorRef.current, editorHtml) || "").trim() ||
      EMPTY_NOTEPAD_HTML;

    return {
      employeeUserId: String(effectiveSelectedId || "").trim(),
      noteId: String(selectedNotepadNoteId || "").trim(),
      noteScope:
        normalizeNotepadScope(selectedNotepadNote?.noteScope) ||
        (String(notepadViewMode || "") === NOTEPAD_VIEW_GROUP ? "group" : "personal"),
      title: String(notepadTitleDraft || ""),
      noteColorKey: normalizeNotepadColorKey(notepadColorDraft || selectedNotepadNote?.noteColorKey),
      deadlineDraft: String(notepadDeadlineDraft || ""),
      contentHtml,
      checklistChangeVersion: Number(notepadChecklistChangeVersion) || 0,
      lastChecklistChange: notepadLastChecklistChange || null,
    };
  }, [
    effectiveSelectedId,
    selectedNotepadNoteId,
    selectedNotepadNote,
    notepadViewMode,
    notepadTitleDraft,
    notepadColorDraft,
    notepadDeadlineDraft,
    notepadContentDraft,
    notepadChecklistChangeVersion,
    notepadLastChecklistChange,
  ]);

  const persistCurrentNotepadLocalDraft = useCallback(() => {
    if (!notepadLocalDraftStorageKey) return false;
    return writeNotepadLocalDraft(notepadLocalDraftStorageKey, getCurrentNotepadDraftSnapshot());
  }, [notepadLocalDraftStorageKey, getCurrentNotepadDraftSnapshot]);

  const hasPendingNotepadLocalDraft = useCallback(() => {
    if (!isNotepadDrawerOpen) return false;
    if (String(notepadViewMode || "") === NOTEPAD_VIEW_BIN) return false;
    if (savingNotepadNote) return false;
    return !!notepadDirty;
  }, [isNotepadDrawerOpen, notepadViewMode, savingNotepadNote, notepadDirty]);

  const requestNotepadDraftTransition = useCallback(
    (pendingAction, reason = "") => {
      if (!hasPendingNotepadLocalDraft()) {
        pendingAction?.();
        return true;
      }

      persistCurrentNotepadLocalDraft();
      notepadPendingExitActionRef.current = typeof pendingAction === "function" ? pendingAction : null;
      setNotepadExitGuardState({
        open: true,
        reason: String(reason || "").trim(),
      });
      return false;
    },
    [hasPendingNotepadLocalDraft, persistCurrentNotepadLocalDraft]
  );

  const refreshNotepadToolbarState = useCallback(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const editorEl = notepadEditorRef.current;
    if (!editorEl) {
      setNotepadToolbarState((prev) => {
        if (isNotepadToolbarStateDefault(prev)) return prev;
        return { ...NOTEPAD_TOOLBAR_DEFAULT };
      });
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      setNotepadToolbarState((prev) => {
        if (isNotepadToolbarStateDefault(prev)) return prev;
        return { ...NOTEPAD_TOOLBAR_DEFAULT };
      });
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const anchorEl = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentNode : anchorNode;
    const focusEl = focusNode?.nodeType === Node.TEXT_NODE ? focusNode.parentNode : focusNode;
    const isInEditor = (!!anchorEl && editorEl.contains(anchorEl)) || (!!focusEl && editorEl.contains(focusEl));
    if (!isInEditor) {
      setNotepadToolbarState((prev) => {
        if (isNotepadToolbarStateDefault(prev)) return prev;
        return { ...NOTEPAD_TOOLBAR_DEFAULT };
      });
      return;
    }
    try {
      notepadSelectionRangeRef.current = selection.getRangeAt(0).cloneRange();
    } catch {
      notepadSelectionRangeRef.current = null;
    }

    const safeQueryState = (commandName) => {
      try {
        return !!document.queryCommandState(commandName);
      } catch {
        return false;
      }
    };

    const focusElement = focusNode?.nodeType === Node.TEXT_NODE ? focusNode.parentElement : focusNode;
    const scopedElement = focusElement && editorEl.contains(focusElement) ? focusElement : editorEl;
    const closestChecklistRow = scopedElement?.closest?.(".notepad-check-item");
    const blockElement =
      scopedElement?.closest?.("p,div,li,ol,ul,h1,h2,h3,h4,h5,h6,blockquote") || scopedElement || editorEl;
    const computedInlineStyle = window.getComputedStyle(scopedElement || editorEl);
    const parsedFontSize = Number.parseFloat(String(computedInlineStyle?.fontSize || "").replace("px", ""));
    const resolvedFontSize = Number.isFinite(parsedFontSize)
      ? Math.max(8, Math.min(96, Math.round(parsedFontSize)))
      : NOTEPAD_TOOLBAR_DEFAULT.fontSizePx;
    const nearestFontSize = NOTEPAD_FONT_SIZE_OPTIONS.reduce((closest, sizeValue) => {
      if (!Number.isFinite(closest)) return sizeValue;
      const prevDelta = Math.abs(closest - resolvedFontSize);
      const nextDelta = Math.abs(sizeValue - resolvedFontSize);
      return nextDelta < prevDelta ? sizeValue : closest;
    }, NaN);
    const resolvedFontSizePx = Number.isFinite(nearestFontSize)
      ? nearestFontSize
      : NOTEPAD_TOOLBAR_DEFAULT.fontSizePx;
    const resolvedFontColor = normalizeCssColorToHex(String(computedInlineStyle?.color || ""));

    let alignment = "left";
    const inlineAlign = String(blockElement?.style?.textAlign || "").trim().toLowerCase();
    if (inlineAlign === "left" || inlineAlign === "center" || inlineAlign === "right") {
      alignment = inlineAlign;
    } else {
      const computedAlign = String(window.getComputedStyle(blockElement).textAlign || "")
        .trim()
        .toLowerCase();
      if (computedAlign.includes("center")) alignment = "center";
      else if (computedAlign.includes("right") || computedAlign.includes("end")) alignment = "right";
    }

    const nextState = {
      bold: safeQueryState("bold"),
      italic: safeQueryState("italic"),
      underline: safeQueryState("underline"),
      alignLeft: alignment === "left",
      alignCenter: alignment === "center",
      alignRight: alignment === "right",
      unorderedList: safeQueryState("insertUnorderedList"),
      orderedList: safeQueryState("insertOrderedList"),
      checklist: !!closestChecklistRow,
      fontSizePx: resolvedFontSizePx,
      fontColor: resolvedFontColor,
    };

    setNotepadToolbarState((prev) => {
      if (
        prev.bold === nextState.bold &&
        prev.italic === nextState.italic &&
        prev.underline === nextState.underline &&
        prev.alignLeft === nextState.alignLeft &&
        prev.alignCenter === nextState.alignCenter &&
        prev.alignRight === nextState.alignRight &&
        prev.unorderedList === nextState.unorderedList &&
        prev.orderedList === nextState.orderedList &&
        prev.checklist === nextState.checklist &&
        prev.fontSizePx === nextState.fontSizePx &&
        prev.fontColor === nextState.fontColor
      ) {
        return prev;
      }
      return nextState;
    });
  }, []);

  const runNotepadCommand = useCallback(
    (command, value = null, options = {}) => {
      if (!notepadEditorRef.current || typeof document === "undefined" || typeof window === "undefined") return;
      const forceRestoreSelection = !!options?.forceRestoreSelection;
      const editorEl = notepadEditorRef.current;
      editorEl.focus();
      const selection = window.getSelection();
      const hasSelectionInEditor =
        selection &&
        selection.rangeCount > 0 &&
        (() => {
          const anchorNode = selection.anchorNode;
          const focusNode = selection.focusNode;
          const anchorEl = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentNode : anchorNode;
          const focusEl = focusNode?.nodeType === Node.TEXT_NODE ? focusNode.parentNode : focusNode;
          return (!!anchorEl && editorEl.contains(anchorEl)) || (!!focusEl && editorEl.contains(focusEl));
        })();
      const hasCachedSelection = !!notepadSelectionRangeRef.current;
      const shouldRestoreCachedSelection =
        !!selection &&
        hasCachedSelection &&
        (forceRestoreSelection ||
          !hasSelectionInEditor ||
          (hasSelectionInEditor &&
            !!selection.isCollapsed &&
            !notepadSelectionRangeRef.current?.collapsed));
      if (shouldRestoreCachedSelection && selection && notepadSelectionRangeRef.current) {
        try {
          selection.removeAllRanges();
          selection.addRange(notepadSelectionRangeRef.current.cloneRange());
        } catch {
          // Selection can become stale when editor DOM changes; ignore and continue with caret at focus.
        }
      }

      if (command === "insertChecklistItem") {
        const converted = convertSelectionLinesToChecklist(notepadEditorRef.current);
        if (!converted) {
          document.execCommand(
            "insertHTML",
            false,
            '<p class="notepad-check-item"><input type="checkbox" contenteditable="false" /> &nbsp;</p>'
          );
        }
      } else if (command === "justifyLeft" || command === "justifyCenter" || command === "justifyRight") {
        document.execCommand("styleWithCSS", false, true);
        document.execCommand(command, false, null);
        document.execCommand("styleWithCSS", false, false);
      } else if (command === "foreColor") {
        const nextColor = normalizeCssColorToHex(value);
        document.execCommand("styleWithCSS", false, true);
        document.execCommand("foreColor", false, nextColor);
        document.execCommand("styleWithCSS", false, false);
      } else if (command === "fontSizePx") {
        applyNotepadFontSizeInEditor(notepadEditorRef.current, value);
      } else if (command === "insertTable") {
        const requestedRows = Math.max(1, Math.min(20, Number(value?.rows) || 2));
        const requestedCols = Math.max(1, Math.min(20, Number(value?.cols) || 2));
        let tableHtml = "<table><tbody>";
        for (let rowIndex = 0; rowIndex < requestedRows; rowIndex += 1) {
          tableHtml += "<tr>";
          for (let colIndex = 0; colIndex < requestedCols; colIndex += 1) {
            tableHtml += "<td>&nbsp;</td>";
          }
          tableHtml += "</tr>";
        }
        tableHtml += "</tbody></table><p><br></p>";
        document.execCommand("insertHTML", false, tableHtml);
      } else if (command === "tableAddRow" || command === "tableDeleteRow") {
        const context = getNotepadTableContext(notepadEditorRef.current);
        if (context?.table) {
          const activeRow = context.row || context.table.querySelector("tr");
          if (activeRow) {
            if (command === "tableAddRow") {
              const columnCount = activeRow.cells?.length || 1;
              const tagName = String(activeRow.cells?.[0]?.tagName || "td");
              const nextRow = createEmptyTableRow(columnCount, tagName);
              activeRow.insertAdjacentElement("afterend", nextRow);
            } else {
              activeRow.remove();
              const remainingRows = context.table.querySelectorAll("tr");
              if (!remainingRows.length) {
                context.table.remove();
              }
            }
          }
        }
      } else if (command === "tableAddColumn" || command === "tableDeleteColumn") {
        const context = getNotepadTableContext(notepadEditorRef.current);
        if (context?.table) {
          const activeRow = context.row || context.table.querySelector("tr");
          const activeCell = context.cell || activeRow?.cells?.[0] || null;
          if (activeRow && activeCell) {
            const rawIndex = Array.from(activeRow.cells || []).indexOf(activeCell);
            const targetIndex = rawIndex >= 0 ? rawIndex : 0;
            const rows = Array.from(context.table.querySelectorAll("tr"));
            if (command === "tableAddColumn") {
              rows.forEach((rowEl) => {
                const cellTag = String(rowEl.cells?.[targetIndex]?.tagName || activeCell.tagName || "td");
                const nextCell = createEmptyTableCell(cellTag);
                const referenceCell = rowEl.cells?.[targetIndex + 1] || null;
                if (referenceCell) rowEl.insertBefore(nextCell, referenceCell);
                else rowEl.appendChild(nextCell);
              });
            } else {
              rows.forEach((rowEl) => {
                const cellToRemove = rowEl.cells?.[targetIndex];
                if (cellToRemove) cellToRemove.remove();
              });
              const hasAnyCells = rows.some((rowEl) => (rowEl.cells?.length || 0) > 0);
              if (!hasAnyCells) {
                context.table.remove();
              }
            }
          }
        }
      } else if (command === "tableDelete") {
        const context = getNotepadTableContext(notepadEditorRef.current);
        if (context?.table) {
          context.table.remove();
        }
      } else if (command === "tableMergeSelected") {
        const editorEl = notepadEditorRef.current;
        const selectedCells = Array.from(new Set(notepadSelectedTableCellsRef.current || [])).filter(
          (cellEl) => editorEl?.contains(cellEl)
        );
        const mergePlan = buildNotepadTableMergePlan(selectedCells);
        if (mergePlan?.topLeftCell) {
          mergePlan.topLeftCell.setAttribute("rowspan", String(Math.max(1, mergePlan.rowSpan || 1)));
          mergePlan.topLeftCell.setAttribute("colspan", String(Math.max(1, mergePlan.colSpan || 1)));
          mergePlan.topLeftCell.innerHTML = mergePlan.mergedHtml;
          mergePlan.cellsToRemove.forEach((cellEl) => cellEl.remove());
        }
      } else if (command === "tableSetCellColor" || command === "tableClearCellColor") {
        const context = getNotepadTableContext(notepadEditorRef.current);
        const highlightedCell = notepadSelectedTableCellRef.current;
        const selectedCells = Array.from(new Set(notepadSelectedTableCellsRef.current || [])).filter((cellEl) =>
          notepadEditorRef.current?.contains(cellEl)
        );
        const targetCell =
          context?.cell && notepadEditorRef.current.contains(context.cell)
            ? context.cell
            : highlightedCell && notepadEditorRef.current.contains(highlightedCell)
              ? highlightedCell
              : null;
        const targetCells = selectedCells.length > 0 ? selectedCells : targetCell ? [targetCell] : [];
        if (targetCells.length > 0) {
          if (command === "tableSetCellColor") {
            const colorValue = String(value || "").trim();
            if (colorValue) {
              targetCells.forEach((cellEl) => {
                cellEl.style.backgroundColor = colorValue;
              });
            }
          } else {
            targetCells.forEach((cellEl) => {
              cellEl.style.removeProperty("background-color");
            });
          }
        }
      } else {
        document.execCommand(command, false, value);
      }

      syncNotepadDraftFromEditor();
      window.requestAnimationFrame(() => {
        refreshNotepadToolbarState();
      });
    },
    [refreshNotepadToolbarState, syncNotepadDraftFromEditor]
  );

  const getNotepadDocsForEmployee = useCallback(
    async (employeeUserIdValue = "", options = {}) => {
      const force = !!options?.force;
      const employeeUserId = String(employeeUserIdValue || "").trim();
      if (!employeeUserId) return [];

      if (!force) {
        const cachedDocs = NOTEPAD_DOCS_CACHE_BY_EMPLOYEE.get(employeeUserId);
        if (Array.isArray(cachedDocs)) {
          return cachedDocs;
        }
      }

      const notesCollection = collection(db, EMPLOYEE_NOTEPAD_COLLECTION);
      const [personalSnapshot, groupSnapshot] = await Promise.all([
        getDocs(query(notesCollection, where("employeeUserId", "==", employeeUserId))),
        getDocs(query(notesCollection, where("memberUserIds", "array-contains", employeeUserId))),
      ]);

      const docsById = new Map();
      for (const noteDoc of personalSnapshot.docs) docsById.set(noteDoc.id, noteDoc);
      for (const noteDoc of groupSnapshot.docs) docsById.set(noteDoc.id, noteDoc);
      const mergedDocs = Array.from(docsById.values()).filter((noteDoc) => {
        const data = noteDoc?.data?.() || {};
        return String(data?.docType || "").trim() !== "dashboardPref";
      });
      NOTEPAD_DOCS_CACHE_BY_EMPLOYEE.set(employeeUserId, mergedDocs);
      return mergedDocs;
    },
    []
  );

  const refreshNotepadIconMeta = useCallback(async (options = {}) => {
    const force = !!options?.force;
    const employeeUserId = String(effectiveSelectedId || "").trim();
    if (!employeeUserId) {
      setNotepadIconCount(0);
      setNotepadIconNoteMetaList([]);
      return;
    }

    try {
      const noteDocs = await getNotepadDocsForEmployee(employeeUserId, { force });
      const rows = noteDocs.map((noteDoc) => {
        const mapped = mapNotepadDocToRow(noteDoc, employeeUserId);
        return {
          id: mapped.id,
          noteScope: mapped.noteScope,
          employeeUserId: mapped.employeeUserId,
          employeeName: mapped.employeeName,
          memberUserIds: sanitizeNotepadMemberUserIds(mapped.memberUserIds),
          memberProfiles: sanitizeNotepadMemberProfiles(mapped.memberProfiles),
          title: toText(mapped.title) || "Untitled note",
          deadlineAt: mapped.deadlineAt || null,
          deadlineAtMs: Number(mapped.deadlineAtMs),
          isCompleted: !!mapped.isCompleted,
          isTrashed: !!mapped.isTrashed,
        };
      });
      const activeRows = rows.filter((row) => !row?.isTrashed);

      const nowMsLocal = Number.isFinite(liveNowMs) ? liveNowMs : Date.now();
      for (const row of activeRows) {
        if (!row?.id || !Number.isFinite(row?.deadlineAtMs) || row?.isCompleted) continue;

        const deadlineKey = String(Math.floor(row.deadlineAtMs / 60000));
        const dueLabel = formatNotepadDueLabel(row.deadlineAt || row.deadlineAtMs);
        const isGroupNote = normalizeNotepadScope(row.noteScope) === "group";
        const recipientUserIds = isGroupNote
          ? sanitizeNotepadMemberUserIds(row.memberUserIds)
          : sanitizeNotepadMemberUserIds([row.employeeUserId || employeeUserId]);
        if (!recipientUserIds.length) continue;

        const ownerUserId = toText(row.employeeUserId || employeeUserId);
        const ownerEmployee = ownerUserId ? employeesByUserId.get(ownerUserId) : null;
        const ownerName =
          toText(row.employeeName) ||
          (ownerEmployee ? toText(getDisplayName(ownerEmployee)) : "") ||
          ownerUserId ||
          "Employee";

        const shouldNotifyDueSoon =
          row.deadlineAtMs > nowMsLocal && row.deadlineAtMs - nowMsLocal <= NOTEPAD_DUE_SOON_WINDOW_MS;
        const shouldNotifyDueReached = nowMsLocal >= row.deadlineAtMs;
        const shouldNotifyOverdue30 = nowMsLocal >= row.deadlineAtMs + NOTEPAD_OVERDUE_NOTIFY_DELAY_MS;

        await Promise.all(
          recipientUserIds.map(async (recipientUserId) => {
            const recipientId = String(recipientUserId || "").trim();
            if (!recipientId) return;

            const sendIfNeeded = async ({ condition = false, eventType = "", title = "", message = "" }) => {
              if (!condition) return;
              const eventKey = [
                "notepad",
                String(eventType || "").trim(),
                String(row.id || "").trim(),
                recipientId,
                deadlineKey,
              ].join(":");
              const inFlightKey = `note_event:${eventKey}`;
              if (notepadDueSoonNotifyInFlightRef.current.has(inFlightKey)) return;
              notepadDueSoonNotifyInFlightRef.current.add(inFlightKey);
              try {
                await createNotepadNotificationIfMissing({
                  eventKey,
                  userId: recipientId,
                  type: eventType,
                  title,
                  message,
                  noteId: row.id,
                  noteScope: row.noteScope,
                  noteTitle: row.title,
                  deadlineAt: row.deadlineAt || new Date(row.deadlineAtMs),
                  actorUserId: ownerUserId,
                  actorName: ownerName,
                });
              } finally {
                notepadDueSoonNotifyInFlightRef.current.delete(inFlightKey);
              }
            };

            if (isGroupNote) {
              await sendIfNeeded({
                condition: shouldNotifyDueSoon,
                eventType: "notepad_group_due_soon",
                title: "Group Note Due Soon",
                message: `Group note "${row.title}" is due soon (${dueLabel}).`,
              });
              await sendIfNeeded({
                condition: shouldNotifyDueReached,
                eventType: "notepad_group_due_reached",
                title: "Group Note Is Due",
                message: `Group note "${row.title}" is now due (${dueLabel}).`,
              });
              await sendIfNeeded({
                condition: shouldNotifyOverdue30,
                eventType: "notepad_group_overdue_30m",
                title: "Group Note Overdue",
                message: `Group note "${row.title}" is overdue by 30 minutes. Due was ${dueLabel}.`,
              });
            } else {
              await sendIfNeeded({
                condition: shouldNotifyDueSoon,
                eventType: "notepad_due_soon",
                title: "Note Due Soon",
                message: `"${row.title}" is due soon (${dueLabel}).`,
              });
              await sendIfNeeded({
                condition: shouldNotifyDueReached,
                eventType: "notepad_due_reached",
                title: "Note Is Due",
                message: `"${row.title}" is now due (${dueLabel}).`,
              });
              await sendIfNeeded({
                condition: shouldNotifyOverdue30,
                eventType: "notepad_overdue_30m",
                title: "Note Overdue",
                message: `"${row.title}" is overdue by 30 minutes. Due was ${dueLabel}.`,
              });
            }
          })
        );
      }

      setNotepadIconCount(activeRows.length);
      setNotepadIconNoteMetaList(
        activeRows.map((row) => ({
          deadlineAtMs: Number(row?.deadlineAtMs),
          isCompleted: !!row?.isCompleted,
        }))
      );
    } catch {
      setNotepadIconCount(0);
      setNotepadIconNoteMetaList([]);
    }
  }, [
    effectiveSelectedId,
    liveNowMs,
    formatNotepadDueLabel,
    getNotepadDocsForEmployee,
    createNotepadNotificationIfMissing,
    employeesByUserId,
  ]);

  const loadNotepadNotes = useCallback(
    async (preferredNoteId = "", options = {}) => {
      const force = !!options?.force;
      const employeeUserId = String(effectiveSelectedId || "").trim();
      if (!employeeUserId) {
        setNotepadNotes([]);
        setNotepadTrashedNotes([]);
        setNotepadIconCount(0);
        setNotepadIconNoteMetaList([]);
        setNotepadViewMode(NOTEPAD_VIEW_MY);
        setIsNotepadGroupCreatorOpen(false);
        setNotepadGroupMemberDraft([]);
        setSelectedNotepadNoteId("");
        setIsNotepadNewDraftOpen(false);
        setNotepadTitleDraft("");
        setNotepadColorDraft(DEFAULT_NOTEPAD_COLOR_KEY);
        setNotepadDeadlineDraft("");
        setNotepadContentDraft(EMPTY_NOTEPAD_HTML);
        setNotepadError("");
        setNotepadLoading(false);
        return;
      }

      setNotepadLoading(true);
      setNotepadError("");

      try {
        const noteDocs = await getNotepadDocsForEmployee(employeeUserId, { force });
        const rows = noteDocs
          .map((noteDoc) => mapNotepadDocToRow(noteDoc, employeeUserId))
          .sort((a, b) => {
            const aPinned = !!a?.isPinned;
            const bPinned = !!b?.isPinned;
            if (aPinned !== bPinned) return aPinned ? -1 : 1;
            if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
            if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
            return String(a.title || "").localeCompare(String(b.title || ""));
          });
        const activeRows = rows.filter((row) => !row?.isTrashed);
        const trashedRows = rows.filter((row) => !!row?.isTrashed);

        setNotepadNotes(activeRows);
        setNotepadTrashedNotes(trashedRows);
        setNotepadIconCount(activeRows.length);
        setNotepadIconNoteMetaList(
          activeRows.map((row) => ({
            deadlineAtMs: Number(row?.deadlineAtMs),
            isCompleted: !!row?.isCompleted,
          }))
        );
        setSelectedNotepadNoteId((current) => {
          if (String(notepadViewMode || "") === NOTEPAD_VIEW_BIN) return "";
          const requested = String(preferredNoteId || current || "").trim();
          const selectableRows =
            String(notepadViewMode || "") === NOTEPAD_VIEW_GROUP
              ? activeRows.filter((row) => normalizeNotepadScope(row?.noteScope) === "group")
              : activeRows.filter((row) => normalizeNotepadScope(row?.noteScope) !== "group");
          if (requested && selectableRows.some((row) => row.id === requested)) return requested;
          return "";
        });
      } catch (err) {
        setNotepadError(err?.message || "Failed to load notes.");
      } finally {
        setNotepadLoading(false);
      }
    },
    [effectiveSelectedId, getNotepadDocsForEmployee, notepadViewMode]
  );

  const startNewNotepadNote = useCallback(() => {
    requestNotepadDraftTransition(() => {
      setNotepadViewMode(NOTEPAD_VIEW_MY);
      setIsNotepadGroupCreatorOpen(false);
      setIsNotepadNewDraftOpen(true);
      setNotepadGroupMemberDraft([]);
      setNotepadAddMemberNoteId("");
      setNotepadAddMemberDraft([]);
      setSelectedNotepadNoteId("");
      setNotepadTitleDraft("");
      setNotepadColorDraft(DEFAULT_NOTEPAD_COLOR_KEY);
      setNotepadDeadlineDraft("");
      setNotepadContentDraft(EMPTY_NOTEPAD_HTML);
      setNotepadDirty(false);
      setNotepadStatusText("New note ready.");
      setNotepadError("");
      if (notepadEditorRef.current) {
        notepadEditorRef.current.innerHTML = EMPTY_NOTEPAD_HTML;
        notepadEditorRef.current.focus();
      }
    }, "new_note");
  }, [requestNotepadDraftTransition]);

  const handleOverlayCreateNote = useCallback(() => {
    try {
      startNewNotepadNote();
      // ensure the notepad drawer is open and editor focused
      setIsNotepadDrawerOpen(true);
      setTimeout(() => {
        try {
          if (notepadEditorRef?.current) notepadEditorRef.current.focus();
        } catch (e) {
          // ignore
        }
      }, 50);
    } catch (err) {
      // swallow errors to avoid breaking overlay click
      // eslint-disable-next-line no-console
      console.error("Failed to create new notepad note from overlay:", err);
    }
  }, [startNewNotepadNote, setIsNotepadDrawerOpen]);

  const openCreateGroupNotepad = useCallback(() => {
    const selectedEmployeeUserId = String(effectiveSelectedId || "").trim();
    if (!selectedEmployeeUserId) {
      setNotepadError("Please select an employee before creating a group note.");
      return;
    }

    requestNotepadDraftTransition(() => {
      const defaultMemberIds = sanitizeNotepadMemberUserIds([selectedEmployeeUserId]);
      setNotepadViewMode(NOTEPAD_VIEW_GROUP);
      setIsNotepadNewDraftOpen(false);
      setSelectedNotepadNoteId("");
      setNotepadTitleDraft("");
      setNotepadColorDraft(DEFAULT_NOTEPAD_COLOR_KEY);
      setNotepadDeadlineDraft("");
      setNotepadContentDraft(EMPTY_NOTEPAD_HTML);
      setNotepadDirty(false);
      setNotepadStatusText("");
      setNotepadError("");
      setNotepadAddMemberNoteId("");
      setNotepadAddMemberDraft([]);
      setNotepadGroupMemberDraft(defaultMemberIds);
      setIsNotepadGroupCreatorOpen(true);
    }, "group_note");
  }, [effectiveSelectedId, requestNotepadDraftTransition]);

  const toggleGroupNoteMemberDraft = useCallback(
    (memberUserId) => {
      const targetUserId = String(memberUserId || "").trim();
      if (!targetUserId) return;
      const pinnedOwnerUserId = String(effectiveSelectedId || "").trim();
      setNotepadGroupMemberDraft((current) => {
        const normalized = sanitizeNotepadMemberUserIds(current);
        const hasUser = normalized.includes(targetUserId);
        if (hasUser) {
          if (targetUserId === pinnedOwnerUserId) return normalized;
          return normalized.filter((id) => id !== targetUserId);
        }
        return sanitizeNotepadMemberUserIds([...normalized, targetUserId]);
      });
    },
    [effectiveSelectedId]
  );

  const getNotepadNoteMemberUserIds = useCallback(
    (note) => {
      const ownerUserId =
        toText(note?.employeeUserId) || String(effectiveSelectedId || "").trim() || toText(viewerUserId);
      const scopeMembers =
        normalizeNotepadScope(note?.noteScope) === "group"
          ? sanitizeNotepadMemberUserIds(note?.memberUserIds)
          : [];
      return sanitizeNotepadMemberUserIds([ownerUserId, ...scopeMembers]);
    },
    [effectiveSelectedId, viewerUserId]
  );

  const openAddUsersToNotepad = useCallback(
    (note) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;
      if (savingNotepadNote || notepadTrashingNoteId || notepadBinActionNoteId) return;
      const nextMembers = getNotepadNoteMemberUserIds(note);
      setIsNotepadGroupCreatorOpen(false);
      setNotepadGroupMemberDraft([]);
      setNotepadAddMemberNoteId(noteId);
      setNotepadAddMemberDraft(nextMembers);
      setNotepadError("");
      setNotepadStatusText("");
    },
    [
      savingNotepadNote,
      notepadTrashingNoteId,
      notepadBinActionNoteId,
      getNotepadNoteMemberUserIds,
    ]
  );

  const closeAddUsersToNotepad = useCallback(() => {
    if (notepadAddMemberSavingNoteId) return;
    setNotepadAddMemberNoteId("");
    setNotepadAddMemberDraft([]);
  }, [notepadAddMemberSavingNoteId]);

  const toggleNotepadAddMemberDraftUser = useCallback(
    (note, memberUserId) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId || noteId !== String(notepadAddMemberNoteId || "")) return;
      const targetUserId = String(memberUserId || "").trim();
      if (!targetUserId) return;

      const lockedMemberIds = getNotepadNoteMemberUserIds(note);
      if (lockedMemberIds.includes(targetUserId)) return;

      setNotepadAddMemberDraft((current) => {
        const normalized = sanitizeNotepadMemberUserIds(current);
        if (normalized.includes(targetUserId)) {
          return normalized.filter((id) => id !== targetUserId);
        }
        return sanitizeNotepadMemberUserIds([...normalized, targetUserId]);
      });
    },
    [notepadAddMemberNoteId, getNotepadNoteMemberUserIds]
  );

  const saveNotepadAddedMembers = useCallback(
    async (note) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;
      if (savingNotepadNote || notepadTrashingNoteId || notepadBinActionNoteId || notepadAddMemberSavingNoteId) return;
      if (String(notepadAddMemberNoteId || "") !== noteId) return;

      const existingMemberUserIds = getNotepadNoteMemberUserIds(note);
      const nextMemberUserIds = sanitizeNotepadMemberUserIds([
        ...existingMemberUserIds,
        ...notepadAddMemberDraft,
      ]);
      const addedUserIds = nextMemberUserIds.filter((userId) => !existingMemberUserIds.includes(userId));
      if (addedUserIds.length === 0) {
        setNotepadStatusText("No new users selected.");
        setNotepadError("");
        return;
      }

      const actorUserId =
        viewerUserId || String(effectiveSelectedId || "").trim() || String(note?.employeeUserId || "").trim();
      const ownerUserId = toText(note?.employeeUserId);
      const ownerEmployee = ownerUserId ? employeesByUserId.get(ownerUserId) : null;
      const actorEmployee = actorUserId ? employeesByUserId.get(actorUserId) : null;
      const actorName =
        toText(getDisplayName(actorEmployee)) ||
        toText(note?.updatedByName) ||
        toText(getDisplayName(ownerEmployee)) ||
        toText(note?.employeeName) ||
        actorUserId ||
        "A teammate";
      const noteTitle = toText(note?.title) || "Untitled group note";
      const dueLabel = formatNotepadDueLabel(note?.deadlineAt || note?.deadlineAtMs);
      const memberProfiles = resolveNotepadMemberProfiles(nextMemberUserIds, note?.memberProfiles);

      setNotepadAddMemberSavingNoteId(noteId);
      setNotepadError("");
      setNotepadStatusText("");
      try {
        await updateDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, noteId), {
          noteScope: "group",
          memberUserIds: nextMemberUserIds,
          memberProfiles,
          updatedAt: serverTimestamp(),
          updatedByUserId: actorUserId || "",
        });

        await Promise.all(
          addedUserIds.map((recipientUserId) =>
            createNotepadNotificationIfMissing({
              eventKey: `notepad:notepad_group_added:${noteId}:${recipientUserId}`,
              userId: recipientUserId,
              type: "notepad_group_added",
              title: "Added To Group Note",
              message: `${actorName} added you to group note "${noteTitle}". Due: ${dueLabel}.`,
              noteId,
              noteScope: "group",
              noteTitle,
              deadlineAt: note?.deadlineAt || null,
              actorUserId,
              actorName,
            })
          )
        );

        setNotepadStatusText(
          addedUserIds.length === 1
            ? "1 user added to group note."
            : `${addedUserIds.length} users added to group note.`
        );
        setNotepadAddMemberNoteId("");
        setNotepadAddMemberDraft([]);
        await refreshNotepadIconMeta({ force: true });
        await loadNotepadNotes(noteId, { force: true });
      } catch (err) {
        setNotepadError(err?.message || "Failed to add users to note.");
      } finally {
        setNotepadAddMemberSavingNoteId("");
      }
    },
    [
      savingNotepadNote,
      notepadTrashingNoteId,
      notepadBinActionNoteId,
      notepadAddMemberSavingNoteId,
      notepadAddMemberNoteId,
      notepadAddMemberDraft,
      getNotepadNoteMemberUserIds,
      viewerUserId,
      effectiveSelectedId,
      employeesByUserId,
      formatNotepadDueLabel,
      resolveNotepadMemberProfiles,
      createNotepadNotificationIfMissing,
      refreshNotepadIconMeta,
      loadNotepadNotes,
    ]
  );

  const cancelCreateGroupNotepad = useCallback(() => {
    if (creatingGroupNotepadNote) return;
    setIsNotepadGroupCreatorOpen(false);
    setNotepadGroupMemberDraft([]);
    setNotepadStatusText("Group note setup canceled.");
    setNotepadError("");
  }, [creatingGroupNotepadNote]);

  const createGroupNotepadNote = useCallback(async () => {
    if (creatingGroupNotepadNote || savingNotepadNote) return;
    const ownerUserId = String(effectiveSelectedId || "").trim();
    if (!ownerUserId) return;

    const memberUserIds = sanitizeNotepadMemberUserIds([ownerUserId, ...notepadGroupMemberDraft]);
    if (memberUserIds.length < 2) {
      setNotepadError("Please add at least one other employee for this group note.");
      return;
    }

    const actorUserId = viewerUserId || ownerUserId;
    const ownerEmployee = employeesByUserId.get(ownerUserId) || null;
    const ownerName = toText(employee?.name || employee?.email || getDisplayName(ownerEmployee) || ownerUserId);
    const memberProfiles = resolveNotepadMemberProfiles(memberUserIds, []);

    setCreatingGroupNotepadNote(true);
    setNotepadError("");
    setNotepadStatusText("");
    try {
      const docRef = await addDoc(collection(db, EMPLOYEE_NOTEPAD_COLLECTION), {
        noteScope: "group",
        employeeUserId: ownerUserId,
        employeeName: ownerName,
        memberUserIds,
        memberProfiles,
        title: "Untitled group note",
        noteColorKey: DEFAULT_NOTEPAD_COLOR_KEY,
        contentHtml: EMPTY_NOTEPAD_HTML,
        deadlineAt: null,
        isPinned: false,
        isCompleted: false,
        completedAt: null,
        isTrashed: false,
        trashedAt: null,
        dueSoonNotificationKey: "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      });

      const groupCreateDueLabel = formatNotepadDueLabel(null);
      await Promise.all(
        memberProfiles.map(async (member) => {
          const recipientId = String(member?.userId || "").trim();
          if (!recipientId) return;
          await createNotepadNotificationIfMissing({
            eventKey: `notepad:notepad_group_added:${docRef.id}:${recipientId}`,
            userId: recipientId,
            type: "notepad_group_added",
            title: "Added To Group Note",
            message: `${ownerName} added you to a group note. Due: ${groupCreateDueLabel}.`,
            noteId: docRef.id,
            noteScope: "group",
            noteTitle: "Untitled group note",
            deadlineAt: null,
            actorUserId,
            actorName: ownerName,
          });
        })
      );

      setIsNotepadGroupCreatorOpen(false);
      setNotepadGroupMemberDraft([]);
      setNotepadViewMode(NOTEPAD_VIEW_GROUP);
      setSelectedNotepadNoteId(docRef.id);
      setNotepadTitleDraft("Untitled group note");
      setNotepadDeadlineDraft("");
      setNotepadContentDraft(EMPTY_NOTEPAD_HTML);
      setNotepadDirty(false);
      if (notepadEditorRef.current) {
        notepadEditorRef.current.innerHTML = EMPTY_NOTEPAD_HTML;
        notepadEditorRef.current.focus();
      }
      setNotepadStatusText("Group note created.");
      await refreshNotepadIconMeta({ force: true });
      await loadNotepadNotes(docRef.id, { force: true });
    } catch (err) {
      setNotepadError(err?.message || "Failed to create group note.");
    } finally {
      setCreatingGroupNotepadNote(false);
    }
  }, [
    creatingGroupNotepadNote,
    savingNotepadNote,
    effectiveSelectedId,
    notepadGroupMemberDraft,
    viewerUserId,
    employeesByUserId,
    employee,
    resolveNotepadMemberProfiles,
    formatNotepadDueLabel,
    createNotepadNotificationIfMissing,
    refreshNotepadIconMeta,
    loadNotepadNotes,
  ]);

  const toggleNotepadNoteCompleted = useCallback(
    async (note) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;
      if (savingNotepadNote) return;
      if (notepadCompletingNoteId) return;

      const nextCompleted = !note?.isCompleted;
      const actorUserId =
        viewerUserId || String(effectiveSelectedId || "").trim() || String(note?.employeeUserId || "").trim();

      setNotepadCompletingNoteId(noteId);
      setNotepadError("");

      try {
        await updateDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, noteId), {
          isCompleted: nextCompleted,
          completedAt: nextCompleted ? serverTimestamp() : null,
          updatedAt: serverTimestamp(),
          updatedByUserId: actorUserId,
        });

        if (nextCompleted && normalizeNotepadScope(note?.noteScope) === "group") {
          const noteTitle = toText(note?.title) || "Untitled group note";
          const dueLabel = formatNotepadDueLabel(note?.deadlineAt || note?.deadlineAtMs);
          const ownerUserId = toText(note?.employeeUserId);
          const ownerEmployee = ownerUserId ? employeesByUserId.get(ownerUserId) : null;
          const actorEmployee = actorUserId ? employeesByUserId.get(actorUserId) : null;
          const actorName =
            toText(getDisplayName(actorEmployee)) ||
            toText(note?.updatedByName) ||
            toText(getDisplayName(ownerEmployee)) ||
            toText(note?.employeeName) ||
            actorUserId ||
            "A teammate";
          const recipientUserIds = sanitizeNotepadMemberUserIds(
            Array.isArray(note?.memberUserIds) && note.memberUserIds.length
              ? note.memberUserIds
              : [ownerUserId]
          );
          const completionKey = String(Math.floor(Date.now() / 60000));

          await Promise.all(
            recipientUserIds.map((recipientUserId) =>
              createNotepadNotificationIfMissing({
                eventKey: `notepad:notepad_group_completed:${noteId}:${recipientUserId}:${completionKey}`,
                userId: recipientUserId,
                type: "notepad_group_completed",
                title: "Group Note Completed",
                message: `${actorName} marked group note "${noteTitle}" as complete. Due: ${dueLabel}.`,
                noteId,
                noteScope: "group",
                noteTitle,
                deadlineAt: note?.deadlineAt || null,
                actorUserId,
                actorName,
              })
            )
          );
        }

        setNotepadStatusText(nextCompleted ? "Marked as complete." : "Marked as active.");
        await refreshNotepadIconMeta({ force: true });
        await loadNotepadNotes(noteId, { force: true });
      } catch (err) {
        setNotepadError(err?.message || "Failed to update note status.");
      } finally {
        setNotepadCompletingNoteId("");
      }
    },
    [
      savingNotepadNote,
      notepadCompletingNoteId,
      viewerUserId,
      effectiveSelectedId,
      employeesByUserId,
      formatNotepadDueLabel,
      createNotepadNotificationIfMissing,
      refreshNotepadIconMeta,
      loadNotepadNotes,
    ]
  );

  const toggleNotepadNotePinned = useCallback(
    async (note) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;
      if (savingNotepadNote || notepadTrashingNoteId || notepadBinActionNoteId) return;
      if (notepadPinningNoteId) return;

      const actorUserId =
        viewerUserId || String(effectiveSelectedId || "").trim() || String(note?.employeeUserId || "").trim();
      const nextPinned = !note?.isPinned;

      setNotepadPinningNoteId(noteId);
      setNotepadError("");

      try {
        await updateDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, noteId), {
          isPinned: nextPinned,
          updatedAt: serverTimestamp(),
          updatedByUserId: actorUserId || "",
        });
        setNotepadStatusText(nextPinned ? "Note pinned." : "Note unpinned.");
        await refreshNotepadIconMeta({ force: true });
        await loadNotepadNotes(noteId, { force: true });
      } catch (err) {
        setNotepadError(err?.message || "Failed to update pin state.");
      } finally {
        setNotepadPinningNoteId("");
      }
    },
    [
      savingNotepadNote,
      notepadTrashingNoteId,
      notepadBinActionNoteId,
      notepadPinningNoteId,
      viewerUserId,
      effectiveSelectedId,
      refreshNotepadIconMeta,
      loadNotepadNotes,
    ]
  );

  const notifyGroupNoteDeleted = useCallback(
    async ({ note = {}, actorUserId = "", permanent = false, movedToBin = false } = {}) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;

      const normalizedActorUserId = String(actorUserId || "").trim();
      const noteDocRef = doc(db, EMPLOYEE_NOTEPAD_COLLECTION, noteId);
      let latestData = {};
      try {
        const snap = await getDoc(noteDocRef);
        if (snap.exists()) latestData = snap.data() || {};
      } catch {
        latestData = {};
      }

      const ownerUserId = toText(latestData?.employeeUserId || note?.employeeUserId);
      const memberIdsFromProfiles = sanitizeNotepadMemberUserIds(
        [
          ...(Array.isArray(latestData?.memberProfiles) ? latestData.memberProfiles : []),
          ...(Array.isArray(note?.memberProfiles) ? note.memberProfiles : []),
        ].map((item) => item?.userId || item?.employeeUserId || item?.uid || item?.id)
      );
      const recipientUserIds = sanitizeNotepadMemberUserIds(
        Array.isArray(latestData?.memberUserIds) && latestData.memberUserIds.length
          ? [...latestData.memberUserIds, ...memberIdsFromProfiles, ownerUserId]
          : Array.isArray(note?.memberUserIds) && note.memberUserIds.length
            ? [...note.memberUserIds, ...memberIdsFromProfiles, ownerUserId]
          : [...memberIdsFromProfiles, ownerUserId]
      ).filter((recipientId) => !normalizedActorUserId || recipientId !== normalizedActorUserId);
      if (!recipientUserIds.length) return;

      const ownerEmployee = ownerUserId ? employeesByUserId.get(ownerUserId) : null;
      const actorEmployee = normalizedActorUserId ? employeesByUserId.get(normalizedActorUserId) : null;
      const actorName =
        toText(getDisplayName(actorEmployee)) ||
        toText(note?.updatedByName) ||
        toText(getDisplayName(ownerEmployee)) ||
        toText(note?.employeeName) ||
        normalizedActorUserId ||
        "A teammate";
      const noteTitle = toText(note?.title) || "Untitled group note";
      const dueLabel = formatNotepadDueLabel(note?.deadlineAt || note?.deadlineAtMs);
      const eventMinuteKey = String(Math.floor(Date.now() / 60000));
      const eventType = movedToBin
        ? "notepad_group_moved_to_bin"
        : permanent
          ? "notepad_group_permanently_deleted"
          : "notepad_group_deleted";
      const eventTitle = movedToBin
        ? "Group Note Moved To Recycle Bin"
        : permanent
          ? "Group Note Permanently Deleted"
          : "Group Note Deleted";
      const eventMessage = movedToBin
        ? `${actorName} moved group note "${noteTitle}" to recycle bin. Due: ${dueLabel}.`
        : permanent
          ? `${actorName} permanently deleted group note "${noteTitle}". Due: ${dueLabel}.`
          : `${actorName} deleted group note "${noteTitle}". Due: ${dueLabel}.`;

      await Promise.all(
        recipientUserIds.map((recipientUserId) =>
          createNotepadNotificationIfMissing({
            eventKey: `notepad:${eventType}:${noteId}:${recipientUserId}:${eventMinuteKey}`,
            userId: recipientUserId,
            type: eventType,
            title: eventTitle,
            message: eventMessage,
            noteId,
            noteScope: "group",
            noteTitle,
            deadlineAt: note?.deadlineAt || null,
            actorUserId: normalizedActorUserId,
            actorName,
          })
        )
      );
    },
    [createNotepadNotificationIfMissing, employeesByUserId, formatNotepadDueLabel]
  );

  const moveNotepadNoteToTrash = useCallback(
    async (note) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;
      if (savingNotepadNote || notepadTrashingNoteId || notepadBinActionNoteId) return;

      const actorUserId =
        viewerUserId || String(effectiveSelectedId || "").trim() || String(note?.employeeUserId || "").trim();

      setNotepadTrashingNoteId(noteId);
      setNotepadError("");

      try {
        await updateDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, noteId), {
          isTrashed: true,
          trashedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedByUserId: actorUserId,
        });
        const groupRecipientIds = sanitizeNotepadMemberUserIds([
          note?.employeeUserId,
          ...(Array.isArray(note?.memberUserIds) ? note.memberUserIds : []),
          ...(Array.isArray(note?.memberProfiles)
            ? note.memberProfiles.map((item) => item?.userId || item?.employeeUserId || item?.uid || item?.id)
            : []),
        ]);
        const ownerUserId = toText(note?.employeeUserId);
        const ownerEmployee = ownerUserId ? employeesByUserId.get(ownerUserId) : null;
        const actorEmployee = actorUserId ? employeesByUserId.get(actorUserId) : null;
        const actorName =
          toText(getDisplayName(actorEmployee)) ||
          toText(note?.updatedByName) ||
          toText(getDisplayName(ownerEmployee)) ||
          toText(note?.employeeName) ||
          actorUserId ||
          "A teammate";
        const noteTitle = toText(note?.title) || "Untitled group note";
        const dueLabel = formatNotepadDueLabel(note?.deadlineAt || note?.deadlineAtMs);
        const eventKeySeed = String(Date.now());
        const recipients = groupRecipientIds.filter((recipientId) => recipientId && recipientId !== actorUserId);

        await Promise.all(
          recipients.map(async (recipientUserId) => {
            const recipient = employeesByUserId.get(recipientUserId);
            await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
              eventKey: `notepad:notepad_group_moved_to_bin:${noteId}:${recipientUserId}:${eventKeySeed}`,
              audience: "employee",
              userId: recipientUserId,
              role: "employee",
              name: toText(getDisplayName(recipient)),
              email: toText(recipient?.email || ""),
              type: "notepad_group_moved_to_bin",
              title: "Group Note Moved To Recycle Bin",
              message: `${actorName} moved group note "${noteTitle}" to recycle bin. Due: ${dueLabel}.`,
              targetPage: "employee_dashboard",
              noteId,
              noteScope: "group",
              noteTitle,
              deadlineAt: note?.deadlineAt || null,
              createdByUserId: String(actorUserId || "").trim(),
              createdByName: toText(actorName),
              read: false,
              archived: false,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          })
        );
        await emitNotepadRefreshSignal({
          recipientUserIds: groupRecipientIds,
          noteId,
          reason: "note_moved_to_bin",
        });

        if (String(selectedNotepadNoteId || "") === noteId) {
          setSelectedNotepadNoteId("");
        }
        setNotepadStatusText("Moved to recycle bin.");
        await refreshNotepadIconMeta({ force: true });
        await loadNotepadNotes("", { force: true });
      } catch (err) {
        setNotepadError(err?.message || "Failed to move note to recycle bin.");
      } finally {
        setNotepadTrashingNoteId("");
      }
    },
    [
      savingNotepadNote,
      notepadTrashingNoteId,
      notepadBinActionNoteId,
      viewerUserId,
      effectiveSelectedId,
      selectedNotepadNoteId,
      employeesByUserId,
      formatNotepadDueLabel,
      emitNotepadRefreshSignal,
      refreshNotepadIconMeta,
      loadNotepadNotes,
    ]
  );

  const restoreNotepadNoteFromTrash = useCallback(
    async (note) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;
      if (savingNotepadNote || notepadTrashingNoteId || notepadBinActionNoteId) return;

      const actorUserId =
        viewerUserId || String(effectiveSelectedId || "").trim() || String(note?.employeeUserId || "").trim();

      setNotepadBinActionNoteId(noteId);
      setNotepadError("");

      try {
        await updateDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, noteId), {
          isTrashed: false,
          trashedAt: null,
          updatedAt: serverTimestamp(),
          updatedByUserId: actorUserId,
        });
        const groupRecipientIds = sanitizeNotepadMemberUserIds([
          note?.employeeUserId,
          ...(Array.isArray(note?.memberUserIds) ? note.memberUserIds : []),
          ...(Array.isArray(note?.memberProfiles)
            ? note.memberProfiles.map((item) => item?.userId || item?.employeeUserId || item?.uid || item?.id)
            : []),
        ]);
        const ownerUserId = toText(note?.employeeUserId);
        const ownerEmployee = ownerUserId ? employeesByUserId.get(ownerUserId) : null;
        const actorEmployee = actorUserId ? employeesByUserId.get(actorUserId) : null;
        const actorName =
          toText(getDisplayName(actorEmployee)) ||
          toText(note?.updatedByName) ||
          toText(getDisplayName(ownerEmployee)) ||
          toText(note?.employeeName) ||
          actorUserId ||
          "A teammate";
        const noteTitle = toText(note?.title) || "Untitled group note";
        const dueLabel = formatNotepadDueLabel(note?.deadlineAt || note?.deadlineAtMs);
        const eventKeySeed = String(Date.now());
        const recipients = groupRecipientIds.filter((recipientId) => recipientId && recipientId !== actorUserId);

        await Promise.all(
          recipients.map(async (recipientUserId) => {
            const recipient = employeesByUserId.get(recipientUserId);
            await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
              eventKey: `notepad:notepad_group_restored:${noteId}:${recipientUserId}:${eventKeySeed}`,
              audience: "employee",
              userId: recipientUserId,
              role: "employee",
              name: toText(getDisplayName(recipient)),
              email: toText(recipient?.email || ""),
              type: "notepad_group_restored",
              title: "Group Note Restored",
              message: `${actorName} restored group note "${noteTitle}" from recycle bin. Due: ${dueLabel}.`,
              targetPage: "employee_dashboard",
              noteId,
              noteScope: "group",
              noteTitle,
              deadlineAt: note?.deadlineAt || null,
              createdByUserId: String(actorUserId || "").trim(),
              createdByName: toText(actorName),
              read: false,
              archived: false,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          })
        );
        await emitNotepadRefreshSignal({
          recipientUserIds: groupRecipientIds,
          noteId,
          reason: "note_restored",
        });

        setNotepadStatusText("Note restored.");
        await refreshNotepadIconMeta({ force: true });
        await loadNotepadNotes(noteId, { force: true });
      } catch (err) {
        setNotepadError(err?.message || "Failed to restore note.");
      } finally {
        setNotepadBinActionNoteId("");
      }
    },
    [
      savingNotepadNote,
      notepadTrashingNoteId,
      notepadBinActionNoteId,
      viewerUserId,
      effectiveSelectedId,
      employeesByUserId,
      formatNotepadDueLabel,
      emitNotepadRefreshSignal,
      refreshNotepadIconMeta,
      loadNotepadNotes,
    ]
  );

  const deleteNotepadNotePermanently = useCallback(
    async (note) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;
      if (savingNotepadNote || notepadTrashingNoteId || notepadBinActionNoteId) return;

      setNotepadBinActionNoteId(noteId);
      setNotepadError("");

      try {
        const actorUserId =
          viewerUserId || String(effectiveSelectedId || "").trim() || String(note?.employeeUserId || "").trim();
        const groupRecipientIds = sanitizeNotepadMemberUserIds([
          note?.employeeUserId,
          ...(Array.isArray(note?.memberUserIds) ? note.memberUserIds : []),
          ...(Array.isArray(note?.memberProfiles)
            ? note.memberProfiles.map((item) => item?.userId || item?.employeeUserId || item?.uid || item?.id)
            : []),
        ]);
        await notifyGroupNoteDeleted({
          note,
          actorUserId,
          permanent: true,
        });
        await emitNotepadRefreshSignal({
          recipientUserIds: groupRecipientIds,
          noteId,
          reason: "note_permanently_deleted",
        });
        await deleteDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, noteId));
        setNotepadStatusText("Note permanently deleted.");
        await refreshNotepadIconMeta({ force: true });
        await loadNotepadNotes("", { force: true });
      } catch (err) {
        setNotepadError(err?.message || "Failed to delete note.");
      } finally {
        setNotepadBinActionNoteId("");
      }
    },
    [
      savingNotepadNote,
      notepadTrashingNoteId,
      notepadBinActionNoteId,
      viewerUserId,
      effectiveSelectedId,
      notifyGroupNoteDeleted,
      emitNotepadRefreshSignal,
      refreshNotepadIconMeta,
      loadNotepadNotes,
    ]
  );

  const openNotepadConfirm = useCallback((mode, note) => {
    if (!note || typeof note !== "object") return;
    setNotepadConfirmState({
      open: true,
      mode: String(mode || "").trim(),
      note,
    });
  }, []);

  const closeNotepadConfirm = useCallback(() => {
    if (notepadConfirmBusy) return;
    setNotepadConfirmState({
      open: false,
      mode: "",
      note: null,
    });
  }, [notepadConfirmBusy]);

  const notepadConfirmConfig = useMemo(() => {
    const mode = String(notepadConfirmState.mode || "").trim();
    const titleText = toText(notepadConfirmState?.note?.title) || "Untitled note";

    if (mode === "trash") {
      return {
        title: "Move Note To Recycle Bin?",
        message: `Move "${titleText}" to recycle bin?`,
        confirmText: "Move to Bin",
        tone: "danger",
      };
    }
    if (mode === "restore") {
      return {
        title: "Restore Note?",
        message: `Restore "${titleText}" from recycle bin?`,
        confirmText: "Restore",
        tone: "primary",
      };
    }
    if (mode === "delete") {
      return {
        title: "Delete Note Permanently?",
        message: `Permanently delete "${titleText}"? This cannot be undone.`,
        confirmText: "Delete Permanently",
        tone: "danger",
      };
    }

    return {
      title: "Confirm Action",
      message: "Proceed with this note action?",
      confirmText: "Confirm",
      tone: "primary",
    };
  }, [notepadConfirmState]);

  const confirmNotepadAction = useCallback(async () => {
    if (notepadConfirmBusy) return;

    const mode = String(notepadConfirmState.mode || "").trim();
    const note = notepadConfirmState.note;
    if (!mode || !note) {
      setNotepadConfirmState({
        open: false,
        mode: "",
        note: null,
      });
      return;
    }

    setNotepadConfirmBusy(true);
    try {
      if (mode === "trash") await moveNotepadNoteToTrash(note);
      else if (mode === "restore") await restoreNotepadNoteFromTrash(note);
      else if (mode === "delete") await deleteNotepadNotePermanently(note);

      setNotepadConfirmState({
        open: false,
        mode: "",
        note: null,
      });
    } finally {
      setNotepadConfirmBusy(false);
    }
  }, [
    notepadConfirmBusy,
    notepadConfirmState,
    moveNotepadNoteToTrash,
    restoreNotepadNoteFromTrash,
    deleteNotepadNotePermanently,
  ]);

  const saveNotepadNote = useCallback(async () => {
    if (savingNotepadNote) return false;

    const employeeUserId = String(effectiveSelectedId || "").trim();
    if (!employeeUserId) return false;
    if (!selectedNotepadNoteId && String(notepadViewMode || "") === NOTEPAD_VIEW_GROUP) {
      setNotepadError("Use + Create Group Note to start a shared note.");
      return false;
    }

    const draftStorageKey = notepadLocalDraftStorageKey;
    const editorHtml = notepadEditorRef.current?.innerHTML || notepadContentDraft || EMPTY_NOTEPAD_HTML;
    const persistedHtml = serializeNotepadEditorHtml(notepadEditorRef.current, editorHtml);
    const finalContentHtml = String(persistedHtml || "").trim() || EMPTY_NOTEPAD_HTML;
    const finalTitle = toText(notepadTitleDraft) || "Untitled note";
    const finalColorKey = normalizeNotepadColorKey(notepadColorDraft || selectedNotepadNote?.noteColorKey);
    const deadlineMs = parseLocalDateTimeInputMs(notepadDeadlineDraft);
    const deadlineAtValue = Number.isFinite(deadlineMs) ? new Date(deadlineMs) : null;
    const hasMeaningfulTitle = !!toText(notepadTitleDraft);
    const hasMeaningfulContent = hasMeaningfulNotepadContent(finalContentHtml);
    const hasDeadline = Number.isFinite(deadlineMs);
    const isCreatingNewNote = !String(selectedNotepadNoteId || "").trim();
    if (isCreatingNewNote && !hasMeaningfulTitle && !hasMeaningfulContent && !hasDeadline) {
      removeNotepadLocalDraft(draftStorageKey);
      setNotepadDirty(false);
      setNotepadChecklistChangeVersion(0);
      setNotepadLastChecklistChange(null);
      setNotepadStatusText("Nothing to save.");
      setNotepadError("");
      return true;
    }

    const deadlineNotificationKey = Number.isFinite(deadlineMs) ? String(Math.floor(deadlineMs / 60000)) : "";
    const previousNotificationKey = String(selectedNotepadNote?.dueSoonNotificationKey || "").trim();
    const nextDueSoonNotificationKey =
      deadlineNotificationKey && previousNotificationKey === deadlineNotificationKey
        ? deadlineNotificationKey
        : "";
    const nowBy = viewerUserId || employeeUserId;

    setSavingNotepadNote(true);
    setNotepadError("");
    setNotepadStatusText("");

    try {
      let keepSelectedId = String(selectedNotepadNoteId || "");
      if (keepSelectedId) {
        await updateDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, keepSelectedId), {
          title: finalTitle,
          noteColorKey: finalColorKey,
          contentHtml: finalContentHtml,
          deadlineAt: deadlineAtValue,
          isPinned: !!selectedNotepadNote?.isPinned,
          dueSoonNotificationKey: nextDueSoonNotificationKey,
          employeeName: toText(employee?.name || employee?.email || ""),
          updatedAt: serverTimestamp(),
          updatedByUserId: nowBy,
        });
      } else {
        const docRef = await addDoc(collection(db, EMPLOYEE_NOTEPAD_COLLECTION), {
          noteScope: "personal",
          employeeUserId,
          employeeName: toText(employee?.name || employee?.email || ""),
          memberUserIds: [employeeUserId],
          memberProfiles: resolveNotepadMemberProfiles([employeeUserId], []),
          title: finalTitle,
          noteColorKey: finalColorKey,
          contentHtml: finalContentHtml,
          deadlineAt: deadlineAtValue,
          isPinned: false,
          isCompleted: false,
          completedAt: null,
          isTrashed: false,
          trashedAt: null,
          dueSoonNotificationKey: "",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdByUserId: nowBy,
          updatedByUserId: nowBy,
        });
        keepSelectedId = docRef.id;
      }

      const shouldBroadcastChecklistRefresh =
        notepadChecklistChangeVersion > 0 &&
        normalizeNotepadScope(selectedNotepadNote?.noteScope) === "group" &&
        Array.isArray(selectedNotepadNote?.memberUserIds);
      const isGroupNoteSave =
        normalizeNotepadScope(selectedNotepadNote?.noteScope) === "group" &&
        Array.isArray(selectedNotepadNote?.memberUserIds);
      const didGroupNoteColorChange =
        isGroupNoteSave &&
        normalizeNotepadColorKey(selectedNotepadNote?.noteColorKey) !== finalColorKey;
      if (shouldBroadcastChecklistRefresh) {
        await notifyGroupChecklistUpdated({
          noteId: keepSelectedId,
          noteTitle: finalTitle,
          noteScope: selectedNotepadNote?.noteScope,
          deadlineAt: deadlineAtValue || selectedNotepadNote?.deadlineAt || null,
          memberUserIds: selectedNotepadNote?.memberUserIds,
          actorUserId: nowBy,
          checklistItemText: notepadLastChecklistChange?.itemText || "",
          checklistItemChecked: notepadLastChecklistChange?.checked,
        });
        await emitNotepadRefreshSignal({
          recipientUserIds: sanitizeNotepadMemberUserIds(selectedNotepadNote?.memberUserIds),
          noteId: keepSelectedId,
          reason: "checklist_saved",
        });
      }
      if (didGroupNoteColorChange) {
        await emitNotepadRefreshSignal({
          recipientUserIds: sanitizeNotepadMemberUserIds(selectedNotepadNote?.memberUserIds),
          noteId: keepSelectedId,
          reason: "color_changed",
        });
      }

      setNotepadDirty(false);
      setNotepadTitleDraft(finalTitle);
      setNotepadColorDraft(finalColorKey);
      setNotepadDeadlineDraft(toLocalDateTimeInputValue(deadlineAtValue));
      setNotepadContentDraft(finalContentHtml);
      setNotepadChecklistChangeVersion(0);
      setNotepadLastChecklistChange(null);
      removeNotepadLocalDraft(draftStorageKey);
      if (notepadEditorRef.current) {
        notepadEditorRef.current.innerHTML = finalContentHtml;
      }
      setNotepadStatusText("Saved.");
      await refreshNotepadIconMeta({ force: true });
      await loadNotepadNotes(keepSelectedId, { force: true });
      return true;
    } catch (err) {
      setNotepadError(err?.message || "Failed to save note.");
      return false;
    } finally {
      setSavingNotepadNote(false);
    }
  }, [
    savingNotepadNote,
    effectiveSelectedId,
    notepadContentDraft,
    notepadChecklistChangeVersion,
    notepadLastChecklistChange,
    notepadDeadlineDraft,
    notepadTitleDraft,
    notepadColorDraft,
    notepadLocalDraftStorageKey,
    viewerUserId,
    selectedNotepadNoteId,
    notepadViewMode,
    selectedNotepadNote,
    employee,
    resolveNotepadMemberProfiles,
    notifyGroupChecklistUpdated,
    emitNotepadRefreshSignal,
    refreshNotepadIconMeta,
    loadNotepadNotes,
  ]);

  const continueEditingNotepadDraft = useCallback(() => {
    if (notepadExitGuardBusy) return;
    notepadPendingExitActionRef.current = null;
    setNotepadExitGuardState({
      open: false,
      reason: "",
    });
    window.requestAnimationFrame(() => {
      notepadEditorRef.current?.focus?.();
    });
  }, [notepadExitGuardBusy]);

  const saveAndContinueNotepadDraftTransition = useCallback(async () => {
    if (notepadExitGuardBusy) return;

    setNotepadExitGuardBusy(true);
    try {
      const didSave = await saveNotepadNote();
      if (!didSave) return;

      const pendingAction = notepadPendingExitActionRef.current;
      notepadPendingExitActionRef.current = null;
      setNotepadExitGuardState({
        open: false,
        reason: "",
      });
      pendingAction?.();
    } finally {
      setNotepadExitGuardBusy(false);
    }
  }, [notepadExitGuardBusy, saveNotepadNote]);

  useEffect(() => {
    if (!isNotepadDrawerOpen) return;
    loadNotepadNotes();
  }, [isNotepadDrawerOpen, loadNotepadNotes]);

  useEffect(() => {
    if (notepadMetaLoadedRef.current) return;
    notepadMetaLoadedRef.current = true;
    refreshNotepadIconMeta();
  }, [refreshNotepadIconMeta]);

  const processNotepadChecklistRefreshSignal = useCallback(async (options = {}) => {
    const showBusy = options?.showBusy !== false;
    const employeeUserId = String(effectiveSelectedId || "").trim();
    if (!employeeUserId) return false;
    const signalDocRef = doc(db, NOTEPAD_REFRESH_SIGNAL_COLLECTION, employeeUserId);
    if (notepadRefreshSignalCheckBusyRef.current) return false;
    notepadRefreshSignalCheckBusyRef.current = true;
    if (showBusy) setNotepadSideRefreshLoading(true);
    try {
      const snapshot = await getDoc(signalDocRef);
      if (!snapshot.exists()) return false;
      const data = snapshot.data() || {};
      const actorUserId = String(data?.actorUserId || "").trim();
      const nonce = String(data?.nonce || "").trim();
      const reason = String(data?.reason || "").trim();
      const changedAtMs = toMillis(data?.changedAt);
      const signalKey = `${actorUserId}|${nonce}|${Number.isFinite(changedAtMs) ? changedAtMs : "na"}`;
      if (!signalKey || signalKey === notepadRefreshSignalSeenRef.current) return false;
      if (
        reason !== "checklist_saved" &&
        reason !== "color_changed" &&
        reason !== "note_moved_to_bin" &&
        reason !== "note_restored" &&
        reason !== "note_deleted" &&
        reason !== "note_permanently_deleted"
      ) {
        return false;
      }
      notepadRefreshSignalSeenRef.current = signalKey;

      if (isNotepadDrawerOpen && (notepadDirty || savingNotepadNote)) {
        await refreshNotepadIconMeta({ force: true });
        setNotepadStatusText("New note update available.");
        return true;
      }
      await loadNotepadNotes("", { force: true });
      return true;
    } catch {
      return false;
    } finally {
      notepadRefreshSignalCheckBusyRef.current = false;
      if (showBusy) setNotepadSideRefreshLoading(false);
    }
  }, [
    effectiveSelectedId,
    isNotepadDrawerOpen,
    loadNotepadNotes,
    notepadDirty,
    refreshNotepadIconMeta,
    savingNotepadNote,
  ]);

  useEffect(() => {
    const handleChecklistNotificationRefresh = () => {
      const refreshButton = document.querySelector(".empSideColumnRefreshBtn");
      if (refreshButton instanceof HTMLButtonElement && !refreshButton.disabled) {
        refreshButton.click();
      }
      processNotepadChecklistRefreshSignal({ showBusy: false });
    };
    window.addEventListener("notepadChecklistNotificationReceived", handleChecklistNotificationRefresh);
    return () => {
      window.removeEventListener("notepadChecklistNotificationReceived", handleChecklistNotificationRefresh);
    };
  }, [processNotepadChecklistRefreshSignal]);

  useEffect(() => {
    if (!isNotepadDrawerOpen) return;

    const localDraft = readNotepadLocalDraft(notepadLocalDraftStorageKey);
    if (!selectedNotepadNote) {
      const localContentHtml = String(localDraft?.contentHtml || EMPTY_NOTEPAD_HTML);
      setNotepadTitleDraft(localDraft ? String(localDraft?.title || "") : "");
      setNotepadColorDraft(normalizeNotepadColorKey(localDraft?.noteColorKey || DEFAULT_NOTEPAD_COLOR_KEY));
      setNotepadDeadlineDraft(localDraft ? String(localDraft?.deadlineDraft || "") : "");
      setNotepadContentDraft(localContentHtml);
      setNotepadDirty(!!localDraft);
      setNotepadChecklistChangeVersion(Number(localDraft?.checklistChangeVersion) || 0);
      setNotepadLastChecklistChange(localDraft?.lastChecklistChange || null);
      setNotepadStatusText(localDraft ? "Recovered local draft." : "");
      if (notepadEditorRef.current) notepadEditorRef.current.innerHTML = localContentHtml;
      return;
    }

    const localContentHtml = String(
      localDraft?.contentHtml || selectedNotepadNote.contentHtml || EMPTY_NOTEPAD_HTML
    );
    setNotepadTitleDraft(
      localDraft ? String(localDraft?.title || "") : toText(selectedNotepadNote.title) || "Untitled note"
    );
    setNotepadColorDraft(
      normalizeNotepadColorKey(localDraft?.noteColorKey || selectedNotepadNote?.noteColorKey)
    );
    setNotepadDeadlineDraft(
      localDraft ? String(localDraft?.deadlineDraft || "") : toLocalDateTimeInputValue(selectedNotepadNote.deadlineAt)
    );
    setNotepadContentDraft(localContentHtml);
    setNotepadDirty(!!localDraft);
    setNotepadChecklistChangeVersion(Number(localDraft?.checklistChangeVersion) || 0);
    setNotepadLastChecklistChange(localDraft?.lastChecklistChange || null);
    setNotepadStatusText(localDraft ? "Recovered local draft." : "");
  }, [isNotepadDrawerOpen, selectedNotepadNote, notepadLocalDraftStorageKey]);

  useEffect(() => {
    if (!isNotepadDrawerOpen || !notepadEditorRef.current) return;
    const nextContent = String(notepadContentDraft || EMPTY_NOTEPAD_HTML);
    if (notepadEditorRef.current.innerHTML !== nextContent) {
      notepadEditorRef.current.innerHTML = nextContent;
    }
  }, [isNotepadDrawerOpen, notepadContentDraft]);

  useEffect(() => {
    if (!isNotepadDrawerOpen) return undefined;
    if (String(notepadViewMode || "") === NOTEPAD_VIEW_BIN) return undefined;
    if (!notepadDirty) return undefined;
    if (savingNotepadNote) return undefined;

    const localDraftTimerId = window.setTimeout(() => {
      const didWrite = persistCurrentNotepadLocalDraft();
      if (didWrite) setNotepadStatusText("Saved locally");
    }, 250);

    return () => {
      window.clearTimeout(localDraftTimerId);
    };
  }, [
    isNotepadDrawerOpen,
    notepadViewMode,
    notepadDirty,
    savingNotepadNote,
    notepadTitleDraft,
    notepadColorDraft,
    notepadDeadlineDraft,
    notepadContentDraft,
    notepadChecklistChangeVersion,
    persistCurrentNotepadLocalDraft,
  ]);

  useEffect(() => {
    if (!isNotepadDrawerOpen) return undefined;
    if (String(notepadViewMode || "") === NOTEPAD_VIEW_BIN) return undefined;
    if (!notepadDirty) return undefined;

    const persistDraftBeforeUnload = () => {
      persistCurrentNotepadLocalDraft();
    };

    window.addEventListener("beforeunload", persistDraftBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", persistDraftBeforeUnload);
    };
  }, [isNotepadDrawerOpen, notepadViewMode, notepadDirty, persistCurrentNotepadLocalDraft]);

  useEffect(() => {
    if (!notepadColorDraftSaving) return undefined;
    const colorSavingTimerId = window.setTimeout(() => {
      setNotepadColorDraftSaving(false);
    }, 900);
    return () => {
      window.clearTimeout(colorSavingTimerId);
    };
  }, [notepadColorDraftSaving]);

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

  const availableAgentAttendanceMonths = useMemo(() => {
    const zone = String(businessTimeZone || "").trim() || "America/Chicago";
    const monthSet = new Set();

    for (const emp of attendanceScoreEmployees) {
      const userId = String(getUserId(emp) ?? emp?.userId ?? emp?.id ?? "").trim();
      if (!userId) continue;
      const historyLogs = Array.isArray(historyByUserId?.[userId]) ? historyByUserId[userId] : [];
      const todayLogs = Array.isArray(logsByUserId?.[userId]) ? logsByUserId[userId] : [];
      const sourceLogs = mergeAttendanceScoreLogs(todayLogs, historyLogs);

      for (const log of sourceLogs) {
        const dayKey = getAttendanceScoreDayKey(log, zone);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
        monthSet.add(dayKey.slice(0, 7));
      }
    }

    return Array.from(monthSet.values()).sort((a, b) => b.localeCompare(a));
  }, [attendanceScoreEmployees, historyByUserId, logsByUserId, businessTimeZone]);

  const effectiveSelectedAgentAttendanceMonth = useMemo(() => {
    if (selectedAgentAttendanceMonth === AGENT_ATTENDANCE_MONTH_ALL) {
      return AGENT_ATTENDANCE_MONTH_ALL;
    }
    return availableAgentAttendanceMonths.includes(selectedAgentAttendanceMonth)
      ? selectedAgentAttendanceMonth
      : AGENT_ATTENDANCE_MONTH_ALL;
  }, [selectedAgentAttendanceMonth, availableAgentAttendanceMonths]);

  useEffect(() => {
    setShowAllAgentRates(false);
  }, [effectiveSelectedAgentAttendanceMonth]);

  const agentAttendanceRates = useMemo(() => {
    const zone = String(businessTimeZone || "").trim() || "America/Chicago";

    const rows = attendanceScoreEmployees.map((emp, index) => {
      const userId = String(getUserId(emp) ?? emp?.userId ?? emp?.id ?? "").trim();
      const name = toText(getDisplayName(emp)) || userId || `Employee ${index + 1}`;
      const historyLogs = Array.isArray(historyByUserId?.[userId]) ? historyByUserId[userId] : [];
      const todayLogs = Array.isArray(logsByUserId?.[userId]) ? logsByUserId[userId] : [];
      const sourceLogs = mergeAttendanceScoreLogs(todayLogs, historyLogs);

      const byDay = new Map();
      for (const log of sourceLogs) {
        const dayKey = getAttendanceScoreDayKey(log, zone);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey).push(log);
      }

      const counts = ATTENDANCE_BUCKETS.reduce((acc, item) => {
        acc[item.key] = 0;
        return acc;
      }, {});

      for (const [dayKey, dayLogs] of byDay.entries()) {
        if (
          effectiveSelectedAgentAttendanceMonth !== AGENT_ATTENDANCE_MONTH_ALL &&
          !String(dayKey).startsWith(`${effectiveSelectedAgentAttendanceMonth}-`)
        ) {
          continue;
        }

        const primaryLog = pickPrimaryAttendanceLogForScore(dayLogs);
        const bucket = normalizeAttendanceScoreBucket(getAttendanceStatusText(primaryLog || {}));
        if (bucket && counts[bucket] !== undefined) counts[bucket] += 1;
      }

      const totalCounted = ATTENDANCE_BUCKETS.reduce(
        (sum, item) => sum + Number(counts[item.key] || 0),
        0
      );
      const weightedScorePoints =
        Number(counts.early || 0) * ATTENDANCE_SCORE_WEIGHTS.early +
        Number(counts.onTime || 0) * ATTENDANCE_SCORE_WEIGHTS.onTime +
        Number(counts.late || 0) * ATTENDANCE_SCORE_WEIGHTS.late +
        Number(counts.pto || 0) * ATTENDANCE_SCORE_WEIGHTS.pto +
        Number(counts.absent || 0) * ATTENDANCE_SCORE_WEIGHTS.absent +
        Number(counts.ncns || 0) * ATTENDANCE_SCORE_WEIGHTS.ncns;
      const hasPenaltyStatus =
        Number(counts.late || 0) > 0 ||
        Number(counts.absent || 0) > 0 ||
        Number(counts.ncns || 0) > 0;
      const rawRate =
        totalCounted > 0
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round(
                  (weightedScorePoints / (totalCounted * ATTENDANCE_SCORE_BEST_DAY_POINTS)) * 100
                )
              )
            )
          : 0;
      const rate = hasPenaltyStatus ? Math.min(rawRate, 99) : rawRate;

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

      return {
        userId,
        name,
        shortName: shortAgentLabel(name),
        rate,
        counts,
        totalCounted,
        pieBackground,
        tooltipSummary: `${tooltipSummary} | Score model: Early/On Time/PTO = full credit, Late/Absent reduce score, NCNS has the biggest deduction`,
      };
    });

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
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }, [
    attendanceScoreEmployees,
    historyByUserId,
    logsByUserId,
    businessTimeZone,
    effectiveSelectedAgentAttendanceMonth,
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

  const availableCallActivityLeaderboardMonths = useMemo(() => {
    const monthSet = new Set();
    for (const row of callActivityLeaderboardRows) {
      const entryDate = String(row?.entryDate || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
        monthSet.add(entryDate.slice(0, 7));
      }
    }
    return Array.from(monthSet.values()).sort((a, b) => b.localeCompare(a));
  }, [callActivityLeaderboardRows]);

  const effectiveSelectedCallActivityLeaderboardMonth = useMemo(() => {
    if (availableCallActivityLeaderboardMonths.includes(selectedCallActivityLeaderboardMonth)) {
      return selectedCallActivityLeaderboardMonth;
    }
    return availableCallActivityLeaderboardMonths[0] || selectedCallActivityLeaderboardMonth;
  }, [availableCallActivityLeaderboardMonths, selectedCallActivityLeaderboardMonth]);

  useEffect(() => {
    if (
      availableCallActivityLeaderboardMonths.length &&
      !availableCallActivityLeaderboardMonths.includes(selectedCallActivityLeaderboardMonth)
    ) {
      setSelectedCallActivityLeaderboardMonth(availableCallActivityLeaderboardMonths[0]);
    }
  }, [availableCallActivityLeaderboardMonths, selectedCallActivityLeaderboardMonth]);

  const callActivityLeaderboard = useMemo(() => {
    const employeeLookup = new Map();
    const selectedUserId = String(getUserId(employee) || effectiveSelectedId || "").trim();
    const selectedEmail = String(employee?.email || "").trim().toLowerCase();
    const selectedName = String(getDisplayName(employee) || "").trim().toLowerCase();

    for (const emp of Array.isArray(employees) ? employees : []) {
      const userId = String(getUserId(emp) || "").trim();
      const email = String(emp?.email || "").trim().toLowerCase();
      if (userId) employeeLookup.set(`id:${userId}`, emp);
      if (email) employeeLookup.set(`email:${email}`, emp);
    }

    const rowsByEmployee = new Map();
    for (const row of callActivityLeaderboardRows) {
      const entryDate = String(row?.entryDate || "").trim();
      if (
        effectiveSelectedCallActivityLeaderboardMonth &&
        !entryDate.startsWith(`${effectiveSelectedCallActivityLeaderboardMonth}-`)
      ) {
        continue;
      }

      const employeeUserId = String(row?.employeeUserId || "").trim();
      const employeeEmail = String(row?.employeeEmail || "").trim().toLowerCase();
      const key = employeeUserId || employeeEmail || String(row?.employeeName || "Unknown").trim() || "Unknown";
      const matchedEmployee =
        employeeLookup.get(`id:${employeeUserId}`) ||
        employeeLookup.get(`email:${employeeEmail}`) ||
        null;
      const current = rowsByEmployee.get(key) || {
        key,
        name: matchedEmployee ? getDisplayName(matchedEmployee) : toText(row?.employeeName) || employeeEmail || "Unknown",
        profileImageUrl: matchedEmployee ? getProfileImageUrl(matchedEmployee) : "",
        userId: matchedEmployee ? String(getUserId(matchedEmployee) || employeeUserId) : employeeUserId,
        email: matchedEmployee ? String(matchedEmployee?.email || employeeEmail || "").trim().toLowerCase() : employeeEmail,
        count: 0,
        entries: 0,
        minutes: 0,
      };
      current.count += Number(row?.count) || 0;
      current.entries += 1;
      current.minutes += Number(row?.durationMinutes) || 0;
      if (!current.profileImageUrl && matchedEmployee) {
        current.profileImageUrl = getProfileImageUrl(matchedEmployee);
      }
      rowsByEmployee.set(key, current);
    }

    const rows = Array.from(rowsByEmployee.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.entries !== a.entries) return b.entries - a.entries;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    const leaderCount = Math.max(1, Number(rows[0]?.count) || 0);
    const leaderMinutes = Math.max(1, ...rows.map((row) => Number(row.minutes) || 0));
    const leaderEntries = Math.max(1, ...rows.map((row) => Number(row.entries) || 0));

    return rows.slice(0, 8).map((row, index) => {
      const countPercent = Math.max(4, Math.round((Number(row.count) / leaderCount) * 100));
      const hoursPercent = Math.max(4, Math.round((Number(row.minutes) / leaderMinutes) * 100));
      const entriesPercent = Math.max(4, Math.round((Number(row.entries) / leaderEntries) * 100));
      const initials = String(row.name || "U")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase())
        .join("") || "U";
      return {
        ...row,
        rank: index + 1,
        countPercent,
        hoursPercent,
        entriesPercent,
        initials,
        hours: Number((Number(row.minutes || 0) / 60).toFixed(1)),
        isSelected:
          (!!selectedUserId && String(row.userId || "").trim() === selectedUserId) ||
          (!!selectedEmail && String(row.email || "").trim().toLowerCase() === selectedEmail) ||
          (!!selectedName && String(row.name || "").trim().toLowerCase() === selectedName),
      };
    });
  }, [
    employee,
    callActivityLeaderboardRows,
    effectiveSelectedCallActivityLeaderboardMonth,
    effectiveSelectedId,
    employees,
  ]);

  const selectedEmployeeActivityRows = useMemo(() => {
    const selectedUserId = String(getUserId(employee) || effectiveSelectedId || "").trim();
    const selectedEmail = String(employee?.email || "").trim().toLowerCase();
    const selectedName = String(getDisplayName(employee) || "").trim().toLowerCase();

    return callActivityLeaderboardRows
      .filter((row) => {
        const rowUserId = String(row?.employeeUserId || "").trim();
        const rowEmail = String(row?.employeeEmail || "").trim().toLowerCase();
        const rowName = String(row?.employeeName || "").trim().toLowerCase();
        if (selectedUserId && rowUserId === selectedUserId) return true;
        if (selectedEmail && rowEmail === selectedEmail) return true;
        return !!selectedName && rowName === selectedName;
      })
      .sort(compareActivityDateDesc);
  }, [callActivityLeaderboardRows, effectiveSelectedId, employee]);

  const callActivityRecentPageCount = Math.max(
    1,
    Math.ceil(selectedEmployeeActivityRows.length / EMPLOYEE_ACTIVITY_RECENT_PAGE_SIZE)
  );
  const safeCallActivityRecentPage = Math.min(callActivityRecentPage, callActivityRecentPageCount - 1);
  const callActivityRecentRows = useMemo(() => {
    const start = safeCallActivityRecentPage * EMPLOYEE_ACTIVITY_RECENT_PAGE_SIZE;
    return selectedEmployeeActivityRows.slice(start, start + EMPLOYEE_ACTIVITY_RECENT_PAGE_SIZE);
  }, [safeCallActivityRecentPage, selectedEmployeeActivityRows]);
  const callActivityRecentRangeStart = selectedEmployeeActivityRows.length
    ? safeCallActivityRecentPage * EMPLOYEE_ACTIVITY_RECENT_PAGE_SIZE + 1
    : 0;
  const callActivityRecentRangeEnd = selectedEmployeeActivityRows.length
    ? Math.min(selectedEmployeeActivityRows.length, callActivityRecentRangeStart + callActivityRecentRows.length - 1)
    : 0;

  useEffect(() => {
    setCallActivityRecentPage(0);
  }, [effectiveSelectedId, selectedEmployeeActivityRows.length]);

  const now = new Date(Number.isFinite(liveNowMs) ? liveNowMs : nowMs);

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
  const closeBreakLogsDrawer = () => setIsBreakLogsDrawerOpen(false);
  const closeTaskListDrawer = () => {
    setIsTaskFilterOpen(false);
    setIsTaskListDrawerOpen(false);
  };
  const closeAnnouncementDrawer = () => {
    setIsAnnouncementDrawerOpen(false);
  };
  const forceCloseNotepadDrawer = useCallback(() => {
    setNotepadConfirmState({
      open: false,
      mode: "",
      note: null,
    });
    setNotepadConfirmBusy(false);
    setNotepadViewMode(NOTEPAD_VIEW_MY);
    setIsNotepadGroupCreatorOpen(false);
    setNotepadGroupMemberDraft([]);
    setNotepadAddMemberNoteId("");
    setNotepadAddMemberDraft([]);
    setNotepadAddMemberSavingNoteId("");
    setIsNotepadDrawerOpen(false);
  }, []);
  const closeNotepadDrawer = useCallback(() => {
    requestNotepadDraftTransition(() => {
      forceCloseNotepadDrawer();
    }, "close_drawer");
  }, [forceCloseNotepadDrawer, requestNotepadDraftTransition]);
  const openBreakLogsPanel = useCallback(() => {
    requestNotepadDraftTransition(() => {
      setIsTaskListDrawerOpen(false);
      setIsAnnouncementDrawerOpen(false);
      forceCloseNotepadDrawer();
      setBreakLogFilter("thisWeek");
      setIsBreakLogsDrawerOpen(true);
    }, "switch_panel");
  }, [forceCloseNotepadDrawer, requestNotepadDraftTransition]);
  const toggleTaskListPanel = useCallback(() => {
    requestNotepadDraftTransition(() => {
      setIsBreakLogsDrawerOpen(false);
      setIsAnnouncementDrawerOpen(false);
      forceCloseNotepadDrawer();
      setIsTaskListDrawerOpen((prev) => !prev);
    }, "switch_panel");
  }, [forceCloseNotepadDrawer, requestNotepadDraftTransition]);
  const toggleAnnouncementPanel = useCallback(() => {
    requestNotepadDraftTransition(() => {
      setIsBreakLogsDrawerOpen(false);
      setIsTaskListDrawerOpen(false);
      forceCloseNotepadDrawer();
      setIsAnnouncementDrawerOpen((prev) => !prev);
    }, "switch_panel");
  }, [forceCloseNotepadDrawer, requestNotepadDraftTransition]);
  const openMyNotepadPanel = useCallback(() => {
    requestNotepadDraftTransition(() => {
      setIsTaskListDrawerOpen(false);
      setIsBreakLogsDrawerOpen(false);
      setIsAnnouncementDrawerOpen(false);
      setNotepadViewMode(NOTEPAD_VIEW_MY);
      setIsNotepadDrawerOpen(true);
    }, "switch_view");
  }, [requestNotepadDraftTransition]);
  const closeAnnouncementModal = () => setSelectedAnnouncement(null);
  const notepadPersonalNotes = (Array.isArray(notepadNotes) ? notepadNotes : []).filter(
    (note) => normalizeNotepadScope(note?.noteScope) !== "group"
  );
  const notepadGroupNotes = (Array.isArray(notepadNotes) ? notepadNotes : []).filter(
    (note) => normalizeNotepadScope(note?.noteScope) === "group"
  );
  const isNotepadRecycleBinView = String(notepadViewMode || "") === NOTEPAD_VIEW_BIN;
  const isNotepadGroupView = String(notepadViewMode || "") === NOTEPAD_VIEW_GROUP;
  const visibleNotepadActiveNotes = isNotepadGroupView ? notepadGroupNotes : notepadPersonalNotes;
  const visibleNotepadCompletedNotes = visibleNotepadActiveNotes.filter((note) => !!note?.isCompleted);
  const visibleNotepadOpenNotes = visibleNotepadActiveNotes.filter((note) => !note?.isCompleted);
  const visibleNotepadCompletedCount = visibleNotepadCompletedNotes.length;
  const notepadNoteCount = notepadPersonalNotes.length;
  const notepadGroupNoteCount = notepadGroupNotes.length;
  const notepadTrashedNoteCount = Array.isArray(notepadTrashedNotes) ? notepadTrashedNotes.length : 0;
  const notepadIconBadgeLabel = notepadIconCount > 99 ? "99+" : String(Math.max(0, notepadIconCount));
  const taskIconCountLabel =
    employeeTasks.length > 99 ? "99+" : String(Math.max(0, employeeTasks.length));
  const notepadGroupMemberSelectionCount = sanitizeNotepadMemberUserIds(notepadGroupMemberDraft).length;
  const isNotepadPersonalNewMode =
    isNotepadNewDraftOpen &&
    String(notepadViewMode || "") === NOTEPAD_VIEW_MY &&
    !isNotepadGroupCreatorOpen &&
    !String(selectedNotepadNoteId || "").trim();
  const notepadModeHint = isNotepadGroupCreatorOpen
    ? "Mode: Create Group Note"
    : isNotepadPersonalNewMode
      ? "Mode: New Note"
      : String(selectedNotepadNoteId || "").trim()
        ? "Mode: Editing Selected Note"
        : "Mode: Browse Notes";
  const nowMsForNotepad = Number.isFinite(liveNowMs) ? liveNowMs : Date.now();
  const notepadHasDueSoonNote = (Array.isArray(notepadIconNoteMetaList) ? notepadIconNoteMetaList : []).some(
    (row) => {
      if (row?.isCompleted) return false;
      const tone = getNotepadDeadlineTone(row?.deadlineAtMs, nowMsForNotepad);
      return tone === "due" || tone === "overdue";
    }
  );
  const notepadDraftDeadlineMs = parseLocalDateTimeInputMs(notepadDeadlineDraft);
  const notepadDraftDeadlineTone = getNotepadDeadlineTone(notepadDraftDeadlineMs, nowMsForNotepad);
  const currentNotepadEditorHtml = String(
    notepadEditorRef.current?.innerHTML || notepadContentDraft || EMPTY_NOTEPAD_HTML
  );
  const notepadEditorIsEmpty = !hasMeaningfulNotepadContent(currentNotepadEditorHtml);
  const notepadDraftCanSave =
    !!String(selectedNotepadNoteId || "").trim() ||
    !!toText(notepadTitleDraft) ||
    !notepadEditorIsEmpty ||
    Number.isFinite(notepadDraftDeadlineMs);
  const dashboardImportantNotes = useMemo(() => {
    const rows = (Array.isArray(notepadNotes) ? notepadNotes : []).filter((note) => !note?.isCompleted);
    const nowForPriorityMs = Number.isFinite(nowMsForNotepad) ? nowMsForNotepad : Date.now();
    const getPriorityBucket = (note) => {
      const deadlineMs = Number(note?.deadlineAtMs);
      if (!Number.isFinite(deadlineMs)) return 3; // no due date
      if (deadlineMs < nowForPriorityMs) return 0; // overdue first
      if (deadlineMs - nowForPriorityMs <= NOTEPAD_DUE_SOON_WINDOW_MS) return 1; // due soon
      return 2; // upcoming but not due soon
    };

    return rows
      .slice()
      .sort((a, b) => {
        const aPinned = !!a?.isPinned;
        const bPinned = !!b?.isPinned;
        if (aPinned !== bPinned) return aPinned ? -1 : 1;

        const aBucket = getPriorityBucket(a);
        const bBucket = getPriorityBucket(b);
        if (aBucket !== bBucket) return aBucket - bBucket;

        const aDeadlineMs = Number(a?.deadlineAtMs);
        const bDeadlineMs = Number(b?.deadlineAtMs);
        const aHasDeadline = Number.isFinite(aDeadlineMs);
        const bHasDeadline = Number.isFinite(bDeadlineMs);
        if ((aBucket === 1 || aBucket === 2) && aHasDeadline && bHasDeadline) {
          const aDeltaMs = aDeadlineMs - nowForPriorityMs;
          const bDeltaMs = bDeadlineMs - nowForPriorityMs;
          if (aDeltaMs !== bDeltaMs) return aDeltaMs - bDeltaMs;
        }

        if (aBucket === 0 && aHasDeadline && bHasDeadline && aDeadlineMs !== bDeadlineMs) {
          // Overdue notes: the most recently overdue appears first.
          return bDeadlineMs - aDeadlineMs;
        }

        const aCreatedMs = Number(a?.createdAtMs) || 0;
        const bCreatedMs = Number(b?.createdAtMs) || 0;
        if (aCreatedMs !== bCreatedMs) {
          return bCreatedMs - aCreatedMs;
        }

        const aUpdatedMs = Number(a?.updatedAtMs) || 0;
        const bUpdatedMs = Number(b?.updatedAtMs) || 0;
        if (aUpdatedMs !== bUpdatedMs) return bUpdatedMs - aUpdatedMs;

        return String(a?.title || "").localeCompare(String(b?.title || ""));
      });
  }, [notepadNotes, nowMsForNotepad]);
  useEffect(() => {
    if (!dashboardImportantNotes.length) {
      setDashboardDisplayNoteIndex(0);
      return;
    }
    setDashboardDisplayNoteIndex((prev) =>
      prev >= 0 && prev < dashboardImportantNotes.length ? prev : 0
    );
  }, [dashboardImportantNotes.length]);

  const topDashboardImportantNote =
    dashboardImportantNotes[dashboardDisplayNoteIndex] || dashboardImportantNotes[0] || null;
  const dashboardImportantNoteCount = dashboardImportantNotes.length;
  const dashboardVisiblePageCount = Math.min(3, Math.max(0, dashboardImportantNoteCount));
  const dashboardHasFrontPage = dashboardVisiblePageCount >= 1;
  const dashboardHasMidPage = dashboardVisiblePageCount >= 2;
  const dashboardHasBackPage = dashboardVisiblePageCount >= 3;
  const dashboardHasNoPages = dashboardVisiblePageCount === 0;
  const dashboardStackMidNote =
    dashboardImportantNoteCount > 1
      ? dashboardImportantNotes[(dashboardDisplayNoteIndex + 1) % dashboardImportantNoteCount]
      : null;
  const dashboardStackBackNote =
    dashboardImportantNoteCount > 2
      ? dashboardImportantNotes[(dashboardDisplayNoteIndex + 2) % dashboardImportantNoteCount]
      : dashboardStackMidNote;
  const dashboardNotepadColorKey = normalizeNotepadColorKey(dashboardNotepadPreviewColorKey);
  const dashboardDefaultThemeVars = NOTEPAD_COLOR_THEMES[DEFAULT_NOTEPAD_COLOR_KEY]?.vars || {};
  const dashboardFrontThemeVars = NOTEPAD_COLOR_THEMES[dashboardNotepadColorKey]?.vars || dashboardDefaultThemeVars;
  const dashboardMidColorKey = normalizeNotepadColorKey(
    dashboardStackMidNote?.noteColorKey || dashboardNotepadColorKey
  );
  const dashboardMidThemeVars = NOTEPAD_COLOR_THEMES[dashboardMidColorKey]?.vars || dashboardDefaultThemeVars;
  const dashboardBackColorKey = normalizeNotepadColorKey(
    dashboardStackBackNote?.noteColorKey || dashboardMidColorKey
  );
  const dashboardBackThemeVars = NOTEPAD_COLOR_THEMES[dashboardBackColorKey]?.vars || dashboardDefaultThemeVars;
  const dashboardNotepadTitle = toText(topDashboardImportantNote?.title) || "Notes";
  const dashboardNotepadDeadlineMs = Number(topDashboardImportantNote?.deadlineAtMs);
  const dashboardNotepadHasDeadline = Number.isFinite(dashboardNotepadDeadlineMs);
  const dashboardNotepadDeadlineTone = dashboardNotepadHasDeadline
    ? getNotepadDeadlineTone(dashboardNotepadDeadlineMs, nowMsForNotepad)
    : "";
  const dashboardNotepadDeadlineLabel = dashboardNotepadHasDeadline
    ? formatNotepadDeadlineLabel(dashboardNotepadDeadlineMs, dashboardNotepadDeadlineTone)
    : "";
  const dashboardNotepadIsPinned = !!topDashboardImportantNote?.isPinned;
  const hasDashboardImportantNote = !!String(topDashboardImportantNote?.id || "").trim();
  const dashboardDisplayNoteId = String(topDashboardImportantNote?.id || "").trim();
  const dashboardDisplaySourceHtml = String(topDashboardImportantNote?.contentHtml || EMPTY_NOTEPAD_HTML);
  const dashboardPreviewHasTable = /<table\b/i.test(String(dashboardDisplayHtml || ""));
  const dashboardDisplayNoteCount = dashboardImportantNotes.length;
  const dashboardUnpinBusy =
    String(notepadPinningNoteId || "").trim() === String(topDashboardImportantNote?.id || "").trim();
  const dashboardColorUpdateBusy = !!String(dashboardNoteColorUpdatingId || "").trim();
  const dashboardColorSaveVisible =
    !!dashboardDisplayNoteId &&
    (String(dashboardNoteColorUpdatingId || "").trim() === dashboardDisplayNoteId ||
      String(dashboardColorSavePendingId || "").trim() === dashboardDisplayNoteId);

  useEffect(() => {
    if (dashboardColorSaveTimerRef.current) return;
    if (topDashboardImportantNote?.id) {
      setDashboardNotepadPreviewColorKey(
        normalizeNotepadColorKey(topDashboardImportantNote?.noteColorKey || DEFAULT_NOTEPAD_COLOR_KEY)
      );
      return;
    }
    setDashboardNotepadPreviewColorKey(DEFAULT_NOTEPAD_COLOR_KEY);
  }, [topDashboardImportantNote?.id, topDashboardImportantNote?.noteColorKey]);

  useEffect(() => {
    return () => {
      if (dashboardColorSaveTimerRef.current) {
        window.clearTimeout(dashboardColorSaveTimerRef.current);
      }
      dashboardColorSaveTimerRef.current = null;
      dashboardColorPendingPayloadRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!dashboardColorSaveTimerRef.current) return;
    window.clearTimeout(dashboardColorSaveTimerRef.current);
    dashboardColorSaveTimerRef.current = null;
    dashboardColorPendingPayloadRef.current = null;
    setDashboardColorSavePendingId("");
  }, [effectiveSelectedId]);

  useEffect(() => {
    setIsDashboardNoteMenuOpen(false);
  }, [dashboardDisplayNoteId]);

  useEffect(() => {
    if (!isDashboardNoteMenuOpen) return;
    const handlePointerDown = (event) => {
      const hostEl = dashboardNoteActionsRef.current;
      if (!hostEl) return;
      if (hostEl.contains(event.target)) return;
      setIsDashboardNoteMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isDashboardNoteMenuOpen]);

  const showPreviousDashboardNote = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (dashboardDisplayNoteCount < 2) return;
      setDashboardDisplayNoteIndex(
        (prev) => (prev - 1 + dashboardDisplayNoteCount) % dashboardDisplayNoteCount
      );
    },
    [dashboardDisplayNoteCount]
  );

  const showNextDashboardNote = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (dashboardDisplayNoteCount < 2) return;
      setDashboardDisplayNoteIndex((prev) => (prev + 1) % dashboardDisplayNoteCount);
    },
    [dashboardDisplayNoteCount]
  );

  const handleDashboardPinIconClick = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!topDashboardImportantNote?.id) return;
      if (dashboardNotepadIsPinned) {
        setIsDashboardUnpinConfirmOpen(true);
        return;
      }
      toggleNotepadNotePinned(topDashboardImportantNote);
    },
    [topDashboardImportantNote, dashboardNotepadIsPinned, toggleNotepadNotePinned]
  );

  const toggleDashboardNoteMenu = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDashboardNoteMenuOpen((prev) => !prev);
  }, []);

  const stopDashboardMenuPropagation = useCallback((event) => {
    event.stopPropagation();
  }, []);

  const closeDashboardNoteMenuOnMouseLeave = useCallback(() => {
    setIsDashboardNoteMenuOpen(false);
  }, []);

  const runDashboardNoteAction = useCallback(
    (actionKey, event) => {
      event.preventDefault();
      event.stopPropagation();

      const note = topDashboardImportantNote;
      if (!note?.id) {
        setIsDashboardNoteMenuOpen(false);
        return;
      }

      setIsDashboardNoteMenuOpen(false);
      if (actionKey === "pin") {
        if (note?.isPinned) setIsDashboardUnpinConfirmOpen(true);
        else toggleNotepadNotePinned(note);
        return;
      }
      if (actionKey === "edit") {
        const noteId = String(note?.id || "").trim();
        if (!noteId) return;
        requestNotepadDraftTransition(() => {
          setIsBreakLogsDrawerOpen(false);
          setIsTaskListDrawerOpen(false);
          setIsAnnouncementDrawerOpen(false);
          setIsNotepadGroupCreatorOpen(false);
          setNotepadViewMode(
            normalizeNotepadScope(note?.noteScope) === "group" ? NOTEPAD_VIEW_GROUP : NOTEPAD_VIEW_MY
          );
          setSelectedNotepadNoteId(noteId);
          setIsNotepadDrawerOpen(true);
        }, "switch_note");
        return;
      }
      if (actionKey === "complete") {
        if (!note?.isCompleted) {
          toggleNotepadNoteCompleted(note);
        }
        return;
      }
      if (actionKey === "delete") {
        openNotepadConfirm("trash", note);
      }
    },
    [
      topDashboardImportantNote,
      requestNotepadDraftTransition,
      toggleNotepadNotePinned,
      toggleNotepadNoteCompleted,
      openNotepadConfirm,
    ]
  );

  const persistDashboardNoteColor = useCallback(
    async (payload = {}) => {
      const nextColorKey = normalizeNotepadColorKey(payload?.nextColorKey);
      const actorUserId = String(payload?.actorUserId || "").trim();
      const preferredNoteId = String(payload?.preferredNoteId || "").trim();
      const targetNoteId = String(payload?.targetNoteId || "").trim();
      const noteScope = String(payload?.noteScope || "").trim();
      const memberUserIds = sanitizeNotepadMemberUserIds(payload?.memberUserIds);
      if (!targetNoteId) return;

      setDashboardNoteColorUpdatingId(targetNoteId);
      setNotepadError("");
      try {
        await updateDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, targetNoteId), {
          noteColorKey: nextColorKey,
          updatedAt: serverTimestamp(),
          updatedByUserId: actorUserId || "",
        });
        if (normalizeNotepadScope(noteScope) === "group" && memberUserIds.length > 0) {
          await emitNotepadRefreshSignal({
            recipientUserIds: memberUserIds,
            noteId: targetNoteId,
            reason: "color_changed",
          });
        }

        await refreshNotepadIconMeta({ force: true });
        await loadNotepadNotes(preferredNoteId || dashboardDisplayNoteId || targetNoteId, { force: true });
      } catch (err) {
        setNotepadError(err?.message || "Failed to update notepad color.");
        await loadNotepadNotes(dashboardDisplayNoteId, { force: true });
      } finally {
        setDashboardNoteColorUpdatingId("");
        setDashboardColorSavePendingId("");
      }
    },
    [
      emitNotepadRefreshSignal,
      refreshNotepadIconMeta,
      loadNotepadNotes,
      dashboardDisplayNoteId,
    ]
  );

  const setDashboardNoteColor = useCallback(
    (colorKey, event) => {
      event.preventDefault();
      event.stopPropagation();

      const nextColorKey = normalizeNotepadColorKey(colorKey);
      const currentPreviewColorKey = normalizeNotepadColorKey(dashboardNotepadPreviewColorKey);
      if (nextColorKey === currentPreviewColorKey && !dashboardColorSaveTimerRef.current) return;

      setDashboardNotepadPreviewColorKey(nextColorKey);

      const actorUserId =
        viewerUserId ||
        String(effectiveSelectedId || "").trim() ||
        String(topDashboardImportantNote?.employeeUserId || "").trim();
      const targetNoteId = String(topDashboardImportantNote?.id || "").trim();
      if (!targetNoteId) return;

      setDashboardColorSavePendingId(targetNoteId);
      dashboardColorPendingPayloadRef.current = {
        nextColorKey,
        actorUserId,
        targetNoteId,
        preferredNoteId: dashboardDisplayNoteId,
        noteScope: topDashboardImportantNote?.noteScope || "",
        memberUserIds: topDashboardImportantNote?.memberUserIds || [],
      };
      setNotepadError("");

      if (dashboardColorSaveTimerRef.current) {
        window.clearTimeout(dashboardColorSaveTimerRef.current);
      }
      dashboardColorSaveTimerRef.current = window.setTimeout(() => {
        const payload = dashboardColorPendingPayloadRef.current;
        dashboardColorPendingPayloadRef.current = null;
        dashboardColorSaveTimerRef.current = null;
        if (!payload) return;
        persistDashboardNoteColor(payload);
      }, 3000);
    },
    [
      dashboardNotepadPreviewColorKey,
      viewerUserId,
      effectiveSelectedId,
      topDashboardImportantNote,
      dashboardDisplayNoteId,
      persistDashboardNoteColor,
    ]
  );

  const confirmDashboardUnpin = useCallback(async () => {
    if (!topDashboardImportantNote?.id) {
      setIsDashboardUnpinConfirmOpen(false);
      return;
    }
    await toggleNotepadNotePinned(topDashboardImportantNote);
    setIsDashboardUnpinConfirmOpen(false);
  }, [topDashboardImportantNote, toggleNotepadNotePinned]);

  useEffect(() => {
    setDashboardDisplayHtml(dashboardDisplaySourceHtml);
    setDashboardDisplayDirty(false);
    setDashboardDisplayStatus("");
    setDashboardLastChecklistChange(null);
  }, [dashboardDisplayNoteId, dashboardDisplaySourceHtml]);

  const handleDashboardDisplayCheckboxChange = useCallback(
    (event) => {
      const checkboxEl = event?.target;
      if (String(checkboxEl?.tagName || "").toLowerCase() !== "input") return;
      if (String(checkboxEl?.type || "").toLowerCase() !== "checkbox") return;

      event.stopPropagation();
      const hostEl = dashboardDisplayRef.current;
      if (!hostEl) return;

      const rawHtml = String(hostEl.innerHTML || "");
      const checkedStates = Array.from(hostEl.querySelectorAll('input[type="checkbox"]')).map(
        (checkbox) => !!checkbox?.checked
      );
      const nextHtml = persistChecklistStateInHtml(rawHtml, checkedStates);
      setDashboardDisplayHtml(nextHtml);
      setDashboardDisplayDirty(true);
      setDashboardDisplayStatus("Unsaved checklist changes");
      setDashboardLastChecklistChange({
        itemText: extractChecklistItemTextFromCheckbox(checkboxEl),
        checked: !!checkboxEl?.checked,
      });
      setDashboardDisplayChangeVersion((prev) => prev + 1);
    },
    []
  );

  const saveDashboardDisplayNote = useCallback(async () => {
    if (dashboardDisplaySaving) return;
    if (!dashboardDisplayDirty) return;
    if (!dashboardDisplayNoteId) return;

    const actorUserId =
      viewerUserId || String(effectiveSelectedId || "").trim() || String(topDashboardImportantNote?.employeeUserId || "").trim();

    setDashboardDisplaySaving(true);
    setDashboardDisplayStatus("Saving...");
    setNotepadError("");
    try {
      await updateDoc(doc(db, EMPLOYEE_NOTEPAD_COLLECTION, dashboardDisplayNoteId), {
        contentHtml: String(dashboardDisplayHtml || EMPTY_NOTEPAD_HTML),
        updatedAt: serverTimestamp(),
        updatedByUserId: actorUserId || "",
      });
      const isGroupDashboardNote =
        normalizeNotepadScope(topDashboardImportantNote?.noteScope) === "group";
      const refreshRecipients = isGroupDashboardNote
        ? sanitizeNotepadMemberUserIds(topDashboardImportantNote?.memberUserIds)
        : sanitizeNotepadMemberUserIds([
            topDashboardImportantNote?.employeeUserId || effectiveSelectedId || actorUserId,
          ]);
      if (isGroupDashboardNote) {
        await notifyGroupChecklistUpdated({
          noteId: dashboardDisplayNoteId,
          noteTitle: toText(topDashboardImportantNote?.title) || "Untitled group note",
          noteScope: topDashboardImportantNote?.noteScope,
          deadlineAt: topDashboardImportantNote?.deadlineAt || topDashboardImportantNote?.deadlineAtMs || null,
          memberUserIds: topDashboardImportantNote?.memberUserIds,
          actorUserId,
          checklistItemText: dashboardLastChecklistChange?.itemText || "",
          checklistItemChecked: dashboardLastChecklistChange?.checked,
        });
      }
      await emitNotepadRefreshSignal({
        recipientUserIds: refreshRecipients,
        noteId: dashboardDisplayNoteId,
        reason: "checklist_saved",
      });
      setDashboardDisplayDirty(false);
      setDashboardLastChecklistChange(null);
      setDashboardDisplayStatus("Saved");
      await refreshNotepadIconMeta({ force: true });
      await loadNotepadNotes(dashboardDisplayNoteId, { force: true });
    } catch (err) {
      setDashboardDisplayStatus("Could not save");
      setNotepadError(err?.message || "Failed to save dashboard note checklist changes.");
    } finally {
      setDashboardDisplaySaving(false);
    }
  }, [
    dashboardDisplaySaving,
    dashboardDisplayDirty,
    dashboardDisplayNoteId,
    dashboardDisplayHtml,
    dashboardLastChecklistChange,
    viewerUserId,
    effectiveSelectedId,
    topDashboardImportantNote,
    notifyGroupChecklistUpdated,
    emitNotepadRefreshSignal,
    refreshNotepadIconMeta,
    loadNotepadNotes,
  ]);

  useEffect(() => {
    saveDashboardDisplayNoteRef.current = saveDashboardDisplayNote;
  }, [saveDashboardDisplayNote]);

  useEffect(() => {
    if (!dashboardDisplayDirty) return;
    if (dashboardDisplaySaving) return;
    if (!dashboardDisplayNoteId) return;

    const autosaveTimerId = window.setTimeout(() => {
      saveDashboardDisplayNoteRef.current?.();
    }, 10000);

    return () => window.clearTimeout(autosaveTimerId);
  }, [
    dashboardDisplayDirty,
    dashboardDisplaySaving,
    dashboardDisplayNoteId,
    dashboardDisplayChangeVersion,
  ]);

  const openDashboardImportantNote = useCallback(
    (note) => {
      const noteId = String(note?.id || "").trim();
      if (!noteId) return;

      requestNotepadDraftTransition(() => {
        setIsBreakLogsDrawerOpen(false);
        setIsTaskListDrawerOpen(false);
        setIsAnnouncementDrawerOpen(false);
        setIsNotepadGroupCreatorOpen(false);
        setNotepadViewMode(
          normalizeNotepadScope(note?.noteScope) === "group" ? NOTEPAD_VIEW_GROUP : NOTEPAD_VIEW_MY
        );
        setSelectedNotepadNoteId(noteId);
        setIsNotepadDrawerOpen(true);
      }, "switch_note");
    },
    [requestNotepadDraftTransition]
  );

  useEffect(() => {
    if (!isNotepadRecycleBinView) return;
    setIsNotepadCompletedOpen(false);
  }, [isNotepadRecycleBinView]);

  useEffect(() => {
    if (!isNotepadDrawerOpen) return undefined;
    const noteId = String(selectedNotepadNoteId || "").trim();
    if (!noteId) return undefined;

    const selectedNote = notepadNotes.find((note) => String(note?.id || "").trim() === noteId) || null;
    if (selectedNote?.isCompleted && !isNotepadCompletedOpen && !isNotepadRecycleBinView) {
      setIsNotepadCompletedOpen(true);
    }

    let rafIdA = 0;
    let rafIdB = 0;
    const scrollToSelectedNote = () => {
      const listEl = notepadListRef.current;
      if (!listEl) return;
      const noteItemEls = Array.from(listEl.querySelectorAll(".empNotepadListItem[data-note-id]"));
      const targetEl = noteItemEls.find((itemEl) => String(itemEl?.dataset?.noteId || "").trim() === noteId);
      if (!targetEl) return;
      targetEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    };

    rafIdA = window.requestAnimationFrame(() => {
      rafIdB = window.requestAnimationFrame(scrollToSelectedNote);
    });

    return () => {
      if (rafIdA) window.cancelAnimationFrame(rafIdA);
      if (rafIdB) window.cancelAnimationFrame(rafIdB);
    };
  }, [
    isNotepadDrawerOpen,
    selectedNotepadNoteId,
    notepadNotes,
    isNotepadCompletedOpen,
    isNotepadRecycleBinView,
  ]);

  useEffect(() => {
    const selectedEmployeeUserId = String(effectiveSelectedId || "").trim();
    if (!selectedEmployeeUserId) return;
    loadNotepadNotes();
  }, [effectiveSelectedId, loadNotepadNotes]);

  const clearNotepadSelectedTableCell = useCallback(() => {
    const prevCell = notepadSelectedTableCellRef.current;
    if (prevCell?.classList) {
      prevCell.classList.remove("notepadTableCellActive");
    }
    notepadSelectedTableCellRef.current = null;
  }, []);

  const clearNotepadTableSelection = useCallback(() => {
    const selectedCells = Array.isArray(notepadSelectedTableCellsRef.current)
      ? notepadSelectedTableCellsRef.current
      : [];
    selectedCells.forEach((cellEl) => {
      if (cellEl?.classList) {
        cellEl.classList.remove("notepadTableCellSelected");
      }
    });
    notepadSelectedTableCellsRef.current = [];
    notepadTableSelectionAnchorRef.current = null;
    setNotepadTableSelectedCount(0);
  }, []);

  const setNotepadTableSelection = useCallback((cells = []) => {
    const editorEl = notepadEditorRef.current;
    const normalizedCells = Array.from(new Set(Array.isArray(cells) ? cells : []))
      .filter(Boolean)
      .filter(
        (cellEl) =>
          editorEl?.contains(cellEl) && ["td", "th"].includes(String(cellEl?.tagName || "").toLowerCase())
      );

    const previousCells = Array.isArray(notepadSelectedTableCellsRef.current)
      ? notepadSelectedTableCellsRef.current
      : [];
    previousCells.forEach((cellEl) => {
      if (cellEl?.classList) {
        cellEl.classList.remove("notepadTableCellSelected");
      }
    });
    normalizedCells.forEach((cellEl) => {
      if (cellEl?.classList) {
        cellEl.classList.add("notepadTableCellSelected");
      }
    });

    notepadSelectedTableCellsRef.current = normalizedCells;
    setNotepadTableSelectedCount(normalizedCells.length);
  }, []);

  const highlightNotepadTableCell = useCallback(
    (cellEl) => {
      const nextCell =
        cellEl &&
        ["td", "th"].includes(String(cellEl.tagName || "").toLowerCase()) &&
        notepadEditorRef.current?.contains(cellEl)
          ? cellEl
          : null;

      const prevCell = notepadSelectedTableCellRef.current;
      if (prevCell === nextCell) return;
      if (prevCell?.classList) {
        prevCell.classList.remove("notepadTableCellActive");
      }
      if (nextCell?.classList) {
        nextCell.classList.add("notepadTableCellActive");
      }
      notepadSelectedTableCellRef.current = nextCell;
    },
    []
  );

  const runNotepadTableContextAction = useCallback(
    (commandKey, commandValue = null) => {
      if (commandKey === "tableMergeSelected" && notepadTableSelectedCount < 2) return;
      runNotepadCommand(commandKey, commandValue);
      setNotepadTableMenuState((prev) => ({ ...prev, open: false }));
      if (commandKey === "tableDelete") {
        clearNotepadSelectedTableCell();
        clearNotepadTableSelection();
        return;
      }
      if (commandKey === "tableMergeSelected") {
        const activeCell = notepadSelectedTableCellRef.current;
        clearNotepadTableSelection();
        if (activeCell && notepadEditorRef.current?.contains(activeCell)) {
          setNotepadTableSelection([activeCell]);
        }
      }
    },
    [
      runNotepadCommand,
      clearNotepadSelectedTableCell,
      clearNotepadTableSelection,
      setNotepadTableSelection,
      notepadTableSelectedCount,
    ]
  );

  const handleNotepadEditorContextMenu = useCallback(
    (event) => {
      setIsNotepadTablePickerOpen(false);
      const editorEl = notepadEditorRef.current;
      const eventTarget = event?.target;
      if (!editorEl || !eventTarget) return;

      const cellEl = eventTarget.closest?.("td,th");
      if (!cellEl || !editorEl.contains(cellEl)) {
        setNotepadTableMenuState((prev) => (prev.open ? { ...prev, open: false } : prev));
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const currentlySelected = Array.isArray(notepadSelectedTableCellsRef.current)
        ? notepadSelectedTableCellsRef.current
        : [];
      if (!currentlySelected.includes(cellEl)) {
        setNotepadTableSelection([cellEl]);
      }
      highlightNotepadTableCell(cellEl);
      notepadTableSelectionAnchorRef.current = cellEl;
      setNotepadTableMenuState({
        open: true,
        x: Number(event.clientX) || 0,
        y: Number(event.clientY) || 0,
      });
    },
    [highlightNotepadTableCell, setNotepadTableSelection]
  );

  const clearNotepadTableMoveHandleHideTimer = useCallback(() => {
    if (!notepadTableMoveHandleHideTimerRef.current) return;
    window.clearTimeout(notepadTableMoveHandleHideTimerRef.current);
    notepadTableMoveHandleHideTimerRef.current = null;
  }, []);

  const scheduleNotepadTableMoveHandleHide = useCallback(() => {
    clearNotepadTableMoveHandleHideTimer();
    notepadTableMoveHandleHideTimerRef.current = window.setTimeout(() => {
      setNotepadTableMoveHandleState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      notepadTableMoveHandleTableRef.current = null;
      notepadTableMoveHandleHideTimerRef.current = null;
    }, 320);
  }, [clearNotepadTableMoveHandleHideTimer]);

  const getNotepadTableMenuBounds = useCallback(() => {
    const margin = 8;
    const viewportBounds = {
      left: margin,
      top: margin,
      right: Math.max(margin, Number(window?.innerWidth) - margin),
      bottom: Math.max(margin, Number(window?.innerHeight) - margin),
    };

    const drawerEl = notepadEditorRef.current?.closest?.(".empNotepadDrawer");
    if (!drawerEl) return viewportBounds;

    const drawerRect = drawerEl.getBoundingClientRect();
    return {
      left: clampNotepadMenuCoordinate(drawerRect.left + margin, margin, viewportBounds.right),
      top: clampNotepadMenuCoordinate(drawerRect.top + margin, margin, viewportBounds.bottom),
      right: clampNotepadMenuCoordinate(drawerRect.right - margin, margin, viewportBounds.right),
      bottom: clampNotepadMenuCoordinate(drawerRect.bottom - margin, margin, viewportBounds.bottom),
    };
  }, []);

  useEffect(() => {
    if (!notepadTableMenuState.open) return;

    const closeMenu = () => {
      setNotepadTableMenuState((prev) => ({ ...prev, open: false }));
    };
    const handlePointerDown = (event) => {
      const menuEl = notepadTableMenuRef.current;
      if (menuEl && menuEl.contains(event.target)) return;
      closeMenu();
    };
    const handleKeyDown = (event) => {
      if (event?.key === "Escape") closeMenu();
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [notepadTableMenuState.open]);

  useEffect(() => {
    if (!notepadTableMenuState.open) return;
    const menuEl = notepadTableMenuRef.current;
    if (!menuEl) return;

    const menuRect = menuEl.getBoundingClientRect();
    const bounds = getNotepadTableMenuBounds();
    const maxX = bounds.right - menuRect.width;
    const maxY = bounds.bottom - menuRect.height;
    const nextX = Math.round(clampNotepadMenuCoordinate(notepadTableMenuState.x, bounds.left, maxX));
    const nextY = Math.round(clampNotepadMenuCoordinate(notepadTableMenuState.y, bounds.top, maxY));

    if (nextX === notepadTableMenuState.x && nextY === notepadTableMenuState.y) return;
    setNotepadTableMenuState((prev) => (prev.open ? { ...prev, x: nextX, y: nextY } : prev));
  }, [
    getNotepadTableMenuBounds,
    notepadTableMenuState.open,
    notepadTableMenuState.x,
    notepadTableMenuState.y,
  ]);

  useEffect(() => {
    if (isNotepadDrawerOpen) return;
    clearNotepadTableMoveHandleHideTimer();
    setNotepadTableMenuState((prev) => ({ ...prev, open: false }));
    setNotepadTableMoveHandleState((prev) => ({ ...prev, visible: false }));
    notepadTableMoveHandleTableRef.current = null;
    clearNotepadSelectedTableCell();
    clearNotepadTableSelection();
    setIsNotepadTablePickerOpen(false);
    notepadTableResizeStateRef.current = null;
    if (notepadEditorRef.current) notepadEditorRef.current.style.cursor = "";
  }, [isNotepadDrawerOpen, clearNotepadSelectedTableCell, clearNotepadTableSelection, clearNotepadTableMoveHandleHideTimer]);

  useEffect(() => {
    clearNotepadTableMoveHandleHideTimer();
    clearNotepadSelectedTableCell();
    clearNotepadTableSelection();
    setNotepadTableMenuState((prev) => ({ ...prev, open: false }));
    setNotepadTableMoveHandleState((prev) => ({ ...prev, visible: false }));
    notepadTableMoveHandleTableRef.current = null;
    setIsNotepadTablePickerOpen(false);
    notepadTableResizeStateRef.current = null;
    if (notepadEditorRef.current) notepadEditorRef.current.style.cursor = "";
  }, [
    selectedNotepadNoteId,
    clearNotepadSelectedTableCell,
    clearNotepadTableSelection,
    clearNotepadTableMoveHandleHideTimer,
  ]);

  const getNotepadTableMoveOffsets = useCallback((tableEl) => {
    if (!tableEl) return { x: 0, y: 0 };
    const x = Number(tableEl.dataset?.notepadMoveX);
    const y = Number(tableEl.dataset?.notepadMoveY);
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    };
  }, []);

  const applyNotepadTableMoveOffsets = useCallback((tableEl, x, y) => {
    if (!tableEl) return;
    const safeX = Math.round(Number(x) || 0);
    const safeY = Math.round(Number(y) || 0);
    tableEl.dataset.notepadMoveX = String(safeX);
    tableEl.dataset.notepadMoveY = String(safeY);
    tableEl.style.transform = safeX === 0 && safeY === 0 ? "" : `translate(${safeX}px, ${safeY}px)`;
  }, []);

  const getNotepadTableCornerHoverHit = useCallback((event) => {
    const editorEl = notepadEditorRef.current;
    const targetEl = event?.target;
    if (!editorEl || !targetEl || !editorEl.contains(targetEl)) return null;
    const tableEl = targetEl.closest?.("table");
    if (!tableEl || !editorEl.contains(tableEl)) return null;

    const rect = tableEl.getBoundingClientRect();
    const px = Number(event.clientX) || 0;
    const py = Number(event.clientY) || 0;
    const threshold = 10;
    const nearLeft = Math.abs(px - rect.left) <= threshold;
    const nearRight = Math.abs(px - rect.right) <= threshold;
    const nearTop = Math.abs(py - rect.top) <= threshold;
    const nearBottom = Math.abs(py - rect.bottom) <= threshold;

    let corner = "";
    if (nearLeft && nearTop) corner = "topLeft";
    else if (nearRight && nearTop) corner = "topRight";
    else if (nearLeft && nearBottom) corner = "bottomLeft";
    else if (nearRight && nearBottom) corner = "bottomRight";
    if (!corner) return null;

    const moveHandleOffset = 10;
    let x = rect.left - moveHandleOffset;
    let y = rect.top - moveHandleOffset;
    if (corner === "topRight") {
      x = rect.right - moveHandleOffset;
      y = rect.top - moveHandleOffset;
    } else if (corner === "bottomLeft") {
      x = rect.left - moveHandleOffset;
      y = rect.bottom - moveHandleOffset;
    } else if (corner === "bottomRight") {
      x = rect.right - moveHandleOffset;
      y = rect.bottom - moveHandleOffset;
    }

    return {
      tableEl,
      x,
      y,
    };
  }, []);

  const getNotepadTableResizeHit = useCallback((event) => {
    const editorEl = notepadEditorRef.current;
    const targetEl = event?.target;
    if (!editorEl || !targetEl || !editorEl.contains(targetEl)) return null;

    const borderThreshold = 6;
    const tableEl = targetEl.closest?.("table");
    if (tableEl && editorEl.contains(tableEl)) {
      const tableOffsets = getNotepadTableMoveOffsets(tableEl);
      const rect = tableEl.getBoundingClientRect();
      const nearLeft = Math.abs((event.clientX || 0) - rect.left) <= borderThreshold;
      const nearRight = Math.abs((event.clientX || 0) - rect.right) <= borderThreshold;
      const nearTop = Math.abs((event.clientY || 0) - rect.top) <= borderThreshold;
      const nearBottom = Math.abs((event.clientY || 0) - rect.bottom) <= borderThreshold;
      if (nearLeft || nearRight || nearTop || nearBottom) {
        let cursor = "default";
        if ((nearLeft && nearTop) || (nearRight && nearBottom)) cursor = "nwse-resize";
        else if ((nearRight && nearTop) || (nearLeft && nearBottom)) cursor = "nesw-resize";
        else if (nearLeft || nearRight) cursor = "col-resize";
        else if (nearTop || nearBottom) cursor = "row-resize";

        return {
          mode: "table",
          cursor,
          tableEl,
          resizeLeft: !!nearLeft,
          resizeRight: !!nearRight,
          resizeTop: !!nearTop,
          resizeBottom: !!nearBottom,
          initialWidth: Math.max(120, Math.round(rect.width)),
          initialHeight: Math.max(80, Math.round(rect.height)),
          initialOffsetX: Number(tableOffsets.x) || 0,
          initialOffsetY: Number(tableOffsets.y) || 0,
          startX: Number(event.clientX) || 0,
          startY: Number(event.clientY) || 0,
        };
      }
    }

    const cellEl = targetEl.closest?.("td,th");
    if (cellEl && editorEl.contains(cellEl)) {
      const rect = cellEl.getBoundingClientRect();
      const nearRight = Math.abs((event.clientX || 0) - rect.right) <= borderThreshold;
      const nearBottom = Math.abs((event.clientY || 0) - rect.bottom) <= borderThreshold;
      if (nearRight) {
        const position = getNotepadTableCellPosition(cellEl);
        if (position) {
          const nextColIndex = position.colIndex + 1;
          const rowCells = getNotepadTableRowCells(position.rowEl);
          const nextCell = rowCells[nextColIndex] || null;
          return {
            mode: "column",
            cursor: "col-resize",
            tableEl: position.tableEl,
            colIndex: position.colIndex,
            nextColIndex: nextCell ? nextColIndex : -1,
            initialSize: Math.max(30, Math.round(rect.width)),
            initialNextSize: nextCell
              ? Math.max(30, Math.round(nextCell.getBoundingClientRect().width || 30))
              : 0,
            startX: Number(event.clientX) || 0,
          };
        }
      }
      if (nearBottom) {
        const rowEl = cellEl.closest?.("tr") || null;
        if (rowEl) {
          const nextRowEl = rowEl.nextElementSibling?.tagName?.toLowerCase() === "tr" ? rowEl.nextElementSibling : null;
          return {
            mode: "row",
            cursor: "row-resize",
            rowEl,
            nextRowEl,
            initialSize: Math.max(22, Math.round(rowEl.getBoundingClientRect().height || rect.height || 22)),
            initialNextSize: nextRowEl
              ? Math.max(22, Math.round(nextRowEl.getBoundingClientRect().height || 22))
              : 0,
            startY: Number(event.clientY) || 0,
          };
        }
      }
    }

    return null;
  }, [getNotepadTableMoveOffsets]);

  const handleNotepadEditorMouseMove = useCallback(
    (event) => {
      const editorEl = notepadEditorRef.current;
      if (!editorEl) return;

      const activeResize = notepadTableResizeStateRef.current;
      if (activeResize) {
        event.preventDefault();
        if (activeResize.mode === "column" && activeResize.tableEl) {
          const deltaX = (Number(event.clientX) || 0) - Number(activeResize.startX || 0);
          const hasNeighbor = Number(activeResize.nextColIndex) >= 0;
          const currentStart = Number(activeResize.initialSize || 40);
          const neighborStart = Number(activeResize.initialNextSize || 40);
          const minColSize = 40;
          const maxDeltaRight = hasNeighbor ? neighborStart - minColSize : Number.POSITIVE_INFINITY;
          const maxDeltaLeft = currentStart - minColSize;
          const clampedDelta = Math.max(-maxDeltaLeft, Math.min(deltaX, maxDeltaRight));
          const nextWidth = Math.max(minColSize, Math.round(currentStart + clampedDelta));
          const nextNeighborWidth = Math.max(minColSize, Math.round(neighborStart - clampedDelta));

          const rows = Array.from(activeResize.tableEl.querySelectorAll("tr"));
          rows.forEach((rowEl) => {
            const rowCells = getNotepadTableRowCells(rowEl);
            const cellEl = rowCells[activeResize.colIndex];
            if (cellEl) {
              cellEl.style.width = `${nextWidth}px`;
              cellEl.style.minWidth = `${nextWidth}px`;
            }
            if (hasNeighbor) {
              const neighborCellEl = rowCells[activeResize.nextColIndex];
              if (neighborCellEl) {
                neighborCellEl.style.width = `${nextNeighborWidth}px`;
                neighborCellEl.style.minWidth = `${nextNeighborWidth}px`;
              }
            }
          });
        } else if (activeResize.mode === "row" && activeResize.rowEl) {
          const deltaY = (Number(event.clientY) || 0) - Number(activeResize.startY || 0);
          const hasNeighbor = !!activeResize.nextRowEl;
          const currentStart = Number(activeResize.initialSize || 24);
          const neighborStart = Number(activeResize.initialNextSize || 24);
          const minRowSize = 24;
          const maxDeltaDown = hasNeighbor ? neighborStart - minRowSize : Number.POSITIVE_INFINITY;
          const maxDeltaUp = currentStart - minRowSize;
          const clampedDelta = Math.max(-maxDeltaUp, Math.min(deltaY, maxDeltaDown));
          const nextHeight = Math.max(minRowSize, Math.round(currentStart + clampedDelta));
          activeResize.rowEl.style.height = `${nextHeight}px`;
          if (hasNeighbor && activeResize.nextRowEl) {
            const nextNeighborHeight = Math.max(minRowSize, Math.round(neighborStart - clampedDelta));
            activeResize.nextRowEl.style.height = `${nextNeighborHeight}px`;
          }
        } else if (activeResize.mode === "table" && activeResize.tableEl) {
          if (activeResize.resizeLeft || activeResize.resizeRight) {
            const deltaX = (Number(event.clientX) || 0) - Number(activeResize.startX || 0);
            const widthDelta = activeResize.resizeLeft ? -deltaX : deltaX;
            const nextWidth = Math.max(140, Math.round(Number(activeResize.initialWidth || 140) + widthDelta));
            activeResize.tableEl.style.width = `${nextWidth}px`;
            if (activeResize.resizeLeft) {
              const nextOffsetX = Math.round(Number(activeResize.initialOffsetX || 0) + deltaX);
              applyNotepadTableMoveOffsets(
                activeResize.tableEl,
                nextOffsetX,
                Number(activeResize.initialOffsetY || 0)
              );
            }
          }
          if (activeResize.resizeTop || activeResize.resizeBottom) {
            const deltaY = (Number(event.clientY) || 0) - Number(activeResize.startY || 0);
            const heightDelta = activeResize.resizeTop ? -deltaY : deltaY;
            const nextHeight = Math.max(80, Math.round(Number(activeResize.initialHeight || 80) + heightDelta));
            activeResize.tableEl.style.height = `${nextHeight}px`;
            if (activeResize.resizeTop) {
              const baseOffsetX = activeResize.resizeLeft
                ? Math.round(Number(activeResize.initialOffsetX || 0) + ((Number(event.clientX) || 0) - Number(activeResize.startX || 0)))
                : Number(activeResize.initialOffsetX || 0);
              const nextOffsetY = Math.round(Number(activeResize.initialOffsetY || 0) + deltaY);
              applyNotepadTableMoveOffsets(activeResize.tableEl, baseOffsetX, nextOffsetY);
            }
          }
        }
        editorEl.style.cursor = activeResize.cursor || "default";
        return;
      }

      const resizeHit = getNotepadTableResizeHit(event);
      editorEl.style.cursor = resizeHit?.cursor || "";
      const cornerHit = getNotepadTableCornerHoverHit(event);
      if (cornerHit) {
        clearNotepadTableMoveHandleHideTimer();
        notepadTableMoveHandleTableRef.current = cornerHit.tableEl;
        setNotepadTableMoveHandleState({
          visible: true,
          x: cornerHit.x,
          y: cornerHit.y,
        });
      } else {
        scheduleNotepadTableMoveHandleHide();
      }
    },
    [
      getNotepadTableResizeHit,
      getNotepadTableCornerHoverHit,
      clearNotepadTableMoveHandleHideTimer,
      scheduleNotepadTableMoveHandleHide,
    ]
  );

  const handleNotepadEditorMouseDown = useCallback(
    (event) => {
      if (Number(event?.button) !== 0) return;
      const editorEl = notepadEditorRef.current;
      if (!editorEl) return;
      const resizeHit = getNotepadTableResizeHit(event);
      if (!resizeHit) return;

      event.preventDefault();
      event.stopPropagation();
      setNotepadTableMenuState((prev) => (prev.open ? { ...prev, open: false } : prev));
      setIsNotepadTablePickerOpen(false);
      notepadTableResizeStateRef.current = resizeHit;
      editorEl.style.cursor = resizeHit.cursor || "";
    },
    [getNotepadTableResizeHit]
  );

  const handleNotepadTableMoveHandleMouseDown = useCallback(
    (event) => {
      if (Number(event?.button) !== 0) return;
      const editorEl = notepadEditorRef.current;
      const tableEl = notepadTableMoveHandleTableRef.current;
      if (!editorEl || !tableEl || !editorEl.contains(tableEl)) return;

      event.preventDefault();
      event.stopPropagation();
      clearNotepadTableMoveHandleHideTimer();
      const offsets = getNotepadTableMoveOffsets(tableEl);
      setNotepadTableMenuState((prev) => (prev.open ? { ...prev, open: false } : prev));
      setIsNotepadTablePickerOpen(false);
      notepadTableResizeStateRef.current = {
        mode: "tableMove",
        cursor: "move",
        tableEl,
        startX: Number(event.clientX) || 0,
        startY: Number(event.clientY) || 0,
        initialOffsetX: Number(offsets.x) || 0,
        initialOffsetY: Number(offsets.y) || 0,
      };
      editorEl.style.cursor = "move";
    },
    [getNotepadTableMoveOffsets, clearNotepadTableMoveHandleHideTimer]
  );

  const handleNotepadTableMoveHandleMouseEnter = useCallback(() => {
    clearNotepadTableMoveHandleHideTimer();
  }, [clearNotepadTableMoveHandleHideTimer]);

  const handleNotepadTableMoveHandleMouseLeave = useCallback(() => {
    if (notepadTableResizeStateRef.current?.mode === "tableMove") return;
    scheduleNotepadTableMoveHandleHide();
  }, [scheduleNotepadTableMoveHandleHide]);

  const handleNotepadEditorMouseLeave = useCallback(() => {
    const editorEl = notepadEditorRef.current;
    if (!editorEl) return;
    if (notepadTableResizeStateRef.current) return;
    editorEl.style.cursor = "";
    scheduleNotepadTableMoveHandleHide();
  }, [scheduleNotepadTableMoveHandleHide]);

  useEffect(() => {
    const handlePointerUp = () => {
      const editorEl = notepadEditorRef.current;
      const activeResize = notepadTableResizeStateRef.current;
      if (!activeResize) return;

      notepadTableResizeStateRef.current = null;
      if (editorEl) {
        editorEl.style.cursor = "";
      }
      syncNotepadDraftFromEditor();
      setNotepadStatusText("Unsaved table layout changes");
    };

    window.addEventListener("mouseup", handlePointerUp);
    return () => {
      window.removeEventListener("mouseup", handlePointerUp);
    };
  }, [syncNotepadDraftFromEditor]);

  useEffect(() => {
    const handleGlobalMouseMove = (event) => {
      const activeResize = notepadTableResizeStateRef.current;
      if (!activeResize || activeResize.mode !== "tableMove" || !activeResize.tableEl) return;
      const deltaX = (Number(event.clientX) || 0) - Number(activeResize.startX || 0);
      const deltaY = (Number(event.clientY) || 0) - Number(activeResize.startY || 0);
      const nextX = Math.round(Number(activeResize.initialOffsetX || 0) + deltaX);
      const nextY = Math.round(Number(activeResize.initialOffsetY || 0) + deltaY);
      applyNotepadTableMoveOffsets(activeResize.tableEl, nextX, nextY);
      setNotepadTableMoveHandleState((prev) => ({
        ...prev,
        visible: true,
        x: (Number(event.clientX) || 0) - 10,
        y: (Number(event.clientY) || 0) - 10,
      }));
    };
    window.addEventListener("mousemove", handleGlobalMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
    };
  }, [applyNotepadTableMoveOffsets]);

  useEffect(() => {
    return () => {
      if (notepadTableMoveHandleHideTimerRef.current) {
        window.clearTimeout(notepadTableMoveHandleHideTimerRef.current);
      }
      notepadTableMoveHandleHideTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!notepadTableMoveHandleState.visible) return;
    const handlePointerDown = (event) => {
      const targetEl = event?.target;
      if (targetEl?.closest?.(".notepadTableMoveHandle")) return;
      const editorEl = notepadEditorRef.current;
      if (editorEl && targetEl && editorEl.contains(targetEl) && targetEl.closest?.("table")) return;
      setNotepadTableMoveHandleState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      notepadTableMoveHandleTableRef.current = null;
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [notepadTableMoveHandleState.visible]);

  const toggleNotepadTablePicker = useCallback(() => {
    setNotepadTableMenuState((prev) => (prev.open ? { ...prev, open: false } : prev));
    setIsNotepadTablePickerOpen((prev) => !prev);
  }, []);

  const insertNotepadTableFromPicker = useCallback(
    (rows, cols) => {
      const safeRows = Math.max(1, Math.min(20, Number(rows) || 2));
      const safeCols = Math.max(1, Math.min(20, Number(cols) || 2));
      runNotepadCommand("insertTable", { rows: safeRows, cols: safeCols });
      setNotepadTablePickerRows(safeRows);
      setNotepadTablePickerCols(safeCols);
      setIsNotepadTablePickerOpen(false);
    },
    [runNotepadCommand]
  );

  useEffect(() => {
    if (!isNotepadTablePickerOpen) return;

    const handlePointerDown = (event) => {
      const hostEl = notepadTablePickerRef.current;
      if (hostEl && hostEl.contains(event.target)) return;
      setIsNotepadTablePickerOpen(false);
    };
    const handleEscape = (event) => {
      if (event?.key === "Escape") setIsNotepadTablePickerOpen(false);
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isNotepadTablePickerOpen]);

  const handleNotepadToolMouseDown = (event) => {
    event.preventDefault();
  };
  const cacheNotepadEditorSelectionRange = useCallback(() => {
    if (typeof window === "undefined") return;
    const editorEl = notepadEditorRef.current;
    if (!editorEl) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const anchorEl = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentNode : anchorNode;
    const focusEl = focusNode?.nodeType === Node.TEXT_NODE ? focusNode.parentNode : focusNode;
    const isInEditor = (!!anchorEl && editorEl.contains(anchorEl)) || (!!focusEl && editorEl.contains(focusEl));
    if (!isInEditor) return;
    try {
      notepadSelectionRangeRef.current = selection.getRangeAt(0).cloneRange();
    } catch {
      // Ignore stale selection cloning errors.
    }
  }, []);
  const placeCaretAfterChecklistCheckbox = useCallback((checkboxEl) => {
    if (!checkboxEl || typeof window === "undefined" || typeof document === "undefined") return;
    const editorEl = notepadEditorRef.current;
    if (!editorEl) return;
    const checklistItemEl = checkboxEl.closest(".notepad-check-item");
    if (!checklistItemEl || !editorEl.contains(checklistItemEl)) return;

    editorEl.focus();
    const selection = window.getSelection();
    if (!selection) return;

    const walker = document.createTreeWalker(checklistItemEl, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) {
      const candidate = walker.currentNode;
      if (String(candidate?.nodeValue || "").length > 0) {
        textNode = candidate;
        break;
      }
    }

    if (!textNode) {
      textNode = document.createTextNode(" ");
      checklistItemEl.appendChild(textNode);
    }

    const rawText = String(textNode.nodeValue || "");
    const firstTextOffset = rawText.search(/\S/);
    const safeOffset = firstTextOffset >= 0 ? firstTextOffset : rawText.length;

    const range = document.createRange();
    range.setStart(textNode, Math.min(safeOffset, rawText.length));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);
  const handleNotepadEditorFocus = () => {
    setIsNotepadTyping(true);
    window.requestAnimationFrame(() => {
      refreshNotepadToolbarState();
    });
  };
  const handleNotepadEditorBlur = () => {
    setIsNotepadTyping(false);
    setNotepadToolbarState({ ...NOTEPAD_TOOLBAR_DEFAULT });
  };
  const handleNotepadEditorInput = () => {
    syncNotepadDraftFromEditor();
    window.requestAnimationFrame(() => {
      refreshNotepadToolbarState();
    });
  };
  const handleNotepadEditorClick = (event) => {
    setIsNotepadTablePickerOpen(false);
    const editorEl = notepadEditorRef.current;
    const tableCell = event?.target?.closest?.("td,th");
    if (editorEl && tableCell && editorEl.contains(tableCell)) {
      const isShiftPressed = !!event?.shiftKey;
      const isTogglePressed = !!event?.ctrlKey || !!event?.metaKey;
      const anchorCell = notepadTableSelectionAnchorRef.current;

      if (isShiftPressed && anchorCell && editorEl.contains(anchorCell)) {
        const rangeCells = getNotepadTableRectCells(anchorCell, tableCell);
        if (rangeCells.length > 0) {
          setNotepadTableSelection(rangeCells);
        } else {
          setNotepadTableSelection([tableCell]);
          notepadTableSelectionAnchorRef.current = tableCell;
        }
      } else if (isTogglePressed) {
        const currentCells = Array.isArray(notepadSelectedTableCellsRef.current)
          ? notepadSelectedTableCellsRef.current
          : [];
        const isAlreadySelected = currentCells.includes(tableCell);
        const nextCells = isAlreadySelected
          ? currentCells.filter((cellEl) => cellEl !== tableCell)
          : [...currentCells, tableCell];
        setNotepadTableSelection(nextCells);
        if (!isAlreadySelected || !notepadTableSelectionAnchorRef.current) {
          notepadTableSelectionAnchorRef.current = tableCell;
        }
      } else {
        setNotepadTableSelection([tableCell]);
        notepadTableSelectionAnchorRef.current = tableCell;
      }
      highlightNotepadTableCell(tableCell);
    } else if (editorEl && event?.target && !event.target.closest?.("table")) {
      clearNotepadSelectedTableCell();
      clearNotepadTableSelection();
    }
    setNotepadTableMenuState((prev) => (prev.open ? { ...prev, open: false } : prev));

    if (event?.target?.tagName === "INPUT") {
      const input = event.target;
      if (String(input?.type || "").toLowerCase() === "checkbox") {
        window.requestAnimationFrame(() => {
          setNotepadLastChecklistChange({
            itemText: extractChecklistItemTextFromCheckbox(input),
            checked: !!input.checked,
          });
          placeCaretAfterChecklistCheckbox(input);
          syncNotepadDraftFromEditor();
          setNotepadStatusText("Unsaved checklist changes");
          setNotepadChecklistChangeVersion((prev) => prev + 1);
          refreshNotepadToolbarState();
        });
        return;
      }
    }

    window.requestAnimationFrame(() => {
      refreshNotepadToolbarState();
    });
  };
  const handleNotepadEditorKeyUp = () => {
    window.requestAnimationFrame(() => {
      refreshNotepadToolbarState();
    });
  };
  const handleNotepadEditorKeyDown = (event) => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const editorEl = notepadEditorRef.current;
    if (!editorEl) return;

    if (event?.key === "Tab") {
      event.preventDefault();
      const handled = event.shiftKey
        ? outdentNotepadTabIndentAtCaret(editorEl)
        : insertNotepadTabIndentAtCaret(editorEl);
      if (handled) {
        syncNotepadDraftFromEditor();
        refreshNotepadToolbarState();
      }
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return;

    const startNode = range.startContainer;
    const startElement = startNode?.nodeType === Node.ELEMENT_NODE ? startNode : startNode?.parentElement;
    const checklistItemEl = startElement?.closest?.(".notepad-check-item");
    if (!checklistItemEl || !editorEl.contains(checklistItemEl)) return;

    if (event?.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      const nextChecklistItemEl = document.createElement("p");
      nextChecklistItemEl.className = "notepad-check-item";
      const nextCheckboxEl = document.createElement("input");
      nextCheckboxEl.type = "checkbox";
      nextCheckboxEl.setAttribute("contenteditable", "false");
      const nextTextNode = document.createTextNode("\u00A0");
      nextChecklistItemEl.appendChild(nextCheckboxEl);
      nextChecklistItemEl.appendChild(nextTextNode);

      if (checklistItemEl.parentNode) {
        checklistItemEl.parentNode.insertBefore(nextChecklistItemEl, checklistItemEl.nextSibling);
      } else {
        editorEl.appendChild(nextChecklistItemEl);
      }

      placeCaretAfterChecklistCheckbox(nextCheckboxEl);
      syncNotepadDraftFromEditor();
      refreshNotepadToolbarState();
      return;
    }

    if (event?.key !== "Backspace") return;

    const checkboxEl = checklistItemEl.querySelector('input[type="checkbox"]');
    if (!checkboxEl) return;

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(checklistItemEl);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeText = String(beforeRange.toString() || "").replace(/\u200B/g, "");
    if (beforeText.trim().length > 0) return;

    event.preventDefault();

    checkboxEl.remove();
    checklistItemEl.classList.remove("notepad-check-item");
    if (!String(checklistItemEl.textContent || "").trim()) {
      checklistItemEl.innerHTML = "<br>";
    }

    editorEl.focus();
    const nextSelection = window.getSelection();
    if (!nextSelection) {
      syncNotepadDraftFromEditor();
      return;
    }

    const walker = document.createTreeWalker(checklistItemEl, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) {
      const candidate = walker.currentNode;
      if (String(candidate?.nodeValue || "").length > 0) {
        textNode = candidate;
        break;
      }
    }

    const nextRange = document.createRange();
    if (textNode) {
      const rawText = String(textNode.nodeValue || "");
      const firstNonSpace = rawText.search(/\S/);
      const offset = firstNonSpace >= 0 ? firstNonSpace : rawText.length;
      nextRange.setStart(textNode, Math.min(offset, rawText.length));
    } else {
      nextRange.setStart(checklistItemEl, 0);
    }
    nextRange.collapse(true);
    nextSelection.removeAllRanges();
    nextSelection.addRange(nextRange);

    syncNotepadDraftFromEditor();
    refreshNotepadToolbarState();
  };

  useEffect(() => {
    if (!isNotepadDrawerOpen || typeof document === "undefined") return;
    const handleSelectionChange = () => {
      refreshNotepadToolbarState();
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [isNotepadDrawerOpen, refreshNotepadToolbarState]);

  useEffect(() => {
    if (!isBreakLogsDrawerOpen && !isNotepadDrawerOpen && !isTaskListDrawerOpen && !isAnnouncementDrawerOpen) return;

    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (notepadExitGuardState.open || notepadConfirmState.open) return;
      if (isNotepadDrawerOpen) {
        closeNotepadDrawer();
      }
      if (isBreakLogsDrawerOpen) setIsBreakLogsDrawerOpen(false);
      if (isTaskListDrawerOpen) {
        setIsTaskFilterOpen(false);
        setIsTaskListDrawerOpen(false);
      }
      if (isAnnouncementDrawerOpen) {
        setIsAnnouncementDrawerOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    isBreakLogsDrawerOpen,
    isNotepadDrawerOpen,
    isTaskListDrawerOpen,
    isAnnouncementDrawerOpen,
    closeNotepadDrawer,
    notepadExitGuardState.open,
    notepadConfirmState.open,
  ]);

  useEffect(() => {
    if (!notepadAddMemberNoteId) return;
    const targetId = String(notepadAddMemberNoteId || "").trim();
    const exists = (Array.isArray(notepadNotes) ? notepadNotes : []).some(
      (note) => String(note?.id || "").trim() === targetId
    );
    if (exists) return;
    setNotepadAddMemberNoteId("");
    setNotepadAddMemberDraft([]);
  }, [notepadAddMemberNoteId, notepadNotes]);

  const handleEmpSideColumnResizeMouseDown = useCallback((event) => {
    if (Number(event?.button) !== 0) return;
    if (typeof window === "undefined" || window.innerWidth <= 1000) return;

    const gridEl = empGridRef.current;
    const sideEl = empSideColumnRef.current;
    if (!gridEl || !sideEl) return;

    const gridRect = gridEl.getBoundingClientRect();
    const sideRect = sideEl.getBoundingClientRect();
    empSideColumnResizeStateRef.current = {
      startX: Number(event.clientX) || 0,
      startWidth: Math.round(sideRect.width),
      gridWidth: Math.max(0, Math.round(gridRect.width)),
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const getEmpSideColumnStorageKey = useCallback(() => {
    const userKey = String(normalizedSelectedUserId || "default").trim() || "default";
    return `${EMP_SIDE_COLUMN_WIDTH_STORAGE_PREFIX}:${userKey}`;
  }, [normalizedSelectedUserId]);

  const resolveEmpSideColumnClampedWidth = useCallback((value) => {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return NaN;
    const maxByViewport = Math.round(Math.max(EMP_SIDE_COLUMN_MIN_WIDTH_PX + 20, window.innerWidth * EMP_SIDE_COLUMN_MAX_WIDTH_RATIO));
    return Math.round(Math.max(EMP_SIDE_COLUMN_MIN_WIDTH_PX, Math.min(maxByViewport, raw)));
  }, []);

  const restoreEmpSideColumnWidthFromStorage = useCallback(() => {
    if (typeof window === "undefined") return;
    if (window.innerWidth <= 1000) {
      setEmpSideColumnWidthPx(null);
      return;
    }
    const storageKey = getEmpSideColumnStorageKey();
    const storedRaw = window.localStorage.getItem(storageKey);
    const restoredWidth = resolveEmpSideColumnClampedWidth(storedRaw);
    if (Number.isFinite(restoredWidth)) {
      setEmpSideColumnWidthPx(restoredWidth);
      return;
    }
    setEmpSideColumnWidthPx(null);
  }, [getEmpSideColumnStorageKey, resolveEmpSideColumnClampedWidth]);

  useEffect(() => {
    restoreEmpSideColumnWidthFromStorage();
  }, [restoreEmpSideColumnWidthFromStorage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.innerWidth <= 1000) return;
    const widthPx = Number(empSideColumnWidthPx);
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    const storageKey = getEmpSideColumnStorageKey();
    const clampedWidth = resolveEmpSideColumnClampedWidth(widthPx);
    if (!Number.isFinite(clampedWidth)) return;
    window.localStorage.setItem(storageKey, String(clampedWidth));
  }, [empSideColumnWidthPx, getEmpSideColumnStorageKey, resolveEmpSideColumnClampedWidth]);

  useEffect(() => {
    empSideColumnWidthPxRef.current = empSideColumnWidthPx;
  }, [empSideColumnWidthPx]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const clearResizeState = () => {
      if (!empSideColumnResizeStateRef.current) return;
      empSideColumnResizeStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const handlePointerMove = (event) => {
      const activeState = empSideColumnResizeStateRef.current;
      if (!activeState) return;
      const deltaX = (Number(event.clientX) || 0) - Number(activeState.startX || 0);
      const minWidthPx = EMP_SIDE_COLUMN_MIN_WIDTH_PX;
      const maxWidthPx = Math.max(
        minWidthPx + 20,
        Math.round(Number(activeState.gridWidth || 0) * EMP_SIDE_COLUMN_MAX_WIDTH_RATIO)
      );
      const nextWidthPx = Math.round(
        Math.max(minWidthPx, Math.min(maxWidthPx, Number(activeState.startWidth || minWidthPx) - deltaX))
      );
      setEmpSideColumnWidthPx(nextWidthPx);
      event.preventDefault();
    };

    const handleWindowResize = () => {
      if (window.innerWidth <= 1000) {
        setEmpSideColumnWidthPx(null);
        clearResizeState();
        return;
      }
      const currentWidthPx = Number(empSideColumnWidthPxRef.current);
      if (!Number.isFinite(currentWidthPx) || currentWidthPx <= 0) {
        restoreEmpSideColumnWidthFromStorage();
      } else {
        const clampedWidth = resolveEmpSideColumnClampedWidth(currentWidthPx);
        if (Number.isFinite(clampedWidth) && clampedWidth !== currentWidthPx) {
          setEmpSideColumnWidthPx(clampedWidth);
        }
      }
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", clearResizeState);
    window.addEventListener("mouseleave", clearResizeState);
    window.addEventListener("resize", handleWindowResize);

    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", clearResizeState);
      window.removeEventListener("mouseleave", clearResizeState);
      window.removeEventListener("resize", handleWindowResize);
      clearResizeState();
    };
  }, [resolveEmpSideColumnClampedWidth, restoreEmpSideColumnWidthFromStorage]);

  const empSideColumnInlineStyle = useMemo(() => {
    const widthPx = Number(empSideColumnWidthPx);
    if (!Number.isFinite(widthPx) || widthPx <= 0) return undefined;
    const widthDelta = widthPx - 300;
    const nextNotepadWidth = Math.round(Math.max(220, Math.min(320, 250 + widthDelta * 0.2)));
    const nextNotepadHeight = Math.round(Math.max(164, Math.min(228, 176 + widthDelta * 0.18)));
    return {
      width: `${widthPx}px`,
      flex: `0 0 ${widthPx}px`,
      maxWidth: `${widthPx}px`,
      "--dashboard-note-stack-width": `${nextNotepadWidth}px`,
      "--dashboard-note-stack-min-height": `${nextNotepadHeight}px`,
      "--dashboard-note-front-min-height": `${nextNotepadHeight}px`,
    };
  }, [empSideColumnWidthPx]);

  const renderTaskListItem = (task, index, keyPrefix = "task") => {
    const meta = getTaskStatusMeta(task);
    const taskForLabel = getTaskAssigneeLabel(task);
    const taskAssignees = getTaskAssignees(task);
    const taskId = toText(task?.id);
    const canOpenTaskDetails = !!taskId && typeof onOpenTaskDetails === "function";

    return (
      <button
        type="button"
        key={String(task?.id || `${keyPrefix}-${effectiveSelectedId}-task-${index}`)}
        className={`taskListItem taskListItemButton ${canOpenTaskDetails ? "clickable" : ""}`}
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
              ? toText(task.priority).charAt(0).toUpperCase() + toText(task.priority).slice(1)
              : "Medium"}
          </span>
        </div>

        {toText(task?.instructions) ? (
          <div className="taskListNotes">{truncateText(task.instructions, 120)}</div>
        ) : null}
      </button>
    );
  };

  const renderNotepadActiveListItem = (note, index, keyPrefix = "active") => {
    const noteId = String(note?.id || "");
    const noteTitle = toText(note?.title) || "Untitled note";
    const preview = stripHtmlForPreview(note?.contentHtml) || "No content yet.";
    const isActive = noteId === String(selectedNotepadNoteId || "");
    const isCompleted = !!note?.isCompleted;
    const deadlineTone = isCompleted ? "completed" : getNotepadDeadlineTone(note?.deadlineAtMs, nowMsForNotepad);
    const deadlineLabel = isCompleted
      ? `Completed: ${formatNotepadDateLabel(note?.completedAt || note?.updatedAt || note?.createdAt)}`
      : formatNotepadDeadlineLabel(note?.deadlineAtMs, deadlineTone);
    const updatedAtValue = note?.updatedAt || note?.createdAt || null;
    const isTogglingComplete = noteId === String(notepadCompletingNoteId || "");
    const isPinning = noteId === String(notepadPinningNoteId || "");
    const isTrashing = noteId === String(notepadTrashingNoteId || "");
    const groupMembers = getNotepadGroupMembers(note);
    const isPinned = !!note?.isPinned;
    const isAddMemberOpen = noteId === String(notepadAddMemberNoteId || "");
    const isAddingMembers = noteId === String(notepadAddMemberSavingNoteId || "");
    const noteMemberUserIds = getNotepadNoteMemberUserIds(note);
    const draftMemberUserIds = isAddMemberOpen
      ? sanitizeNotepadMemberUserIds(notepadAddMemberDraft)
      : noteMemberUserIds;
    const addableMembersCount = Math.max(
      0,
      draftMemberUserIds.filter((memberUserId) => !noteMemberUserIds.includes(memberUserId)).length
    );
    const ownerUserId = toText(note?.employeeUserId);

    return (
      <div
        key={`${keyPrefix}-${noteId || index}`}
        className={`empNotepadListItem deadline-${deadlineTone} ${isCompleted ? "completed" : ""} ${isActive ? "active" : ""}`}
        data-note-id={noteId}
      >
        <button
          type="button"
          className="empNotepadListItemMain"
          onClick={() => {
            if (isActive) return;
            requestNotepadDraftTransition(() => {
              setSelectedNotepadNoteId(noteId);
            }, "switch_note");
          }}
          disabled={savingNotepadNote}
        >
          <div className="empNotepadListItemTitle">{noteTitle}</div>
          <div className="empNotepadListItemPreview">{preview}</div>
          <div className={`empNotepadListItemDeadline deadline-${deadlineTone}`}>{deadlineLabel}</div>
          <div className="empNotepadListItemDate">Updated: {formatNotepadDateLabel(updatedAtValue)}</div>
        </button>
        <div className="empNotepadCardActions">
          <button
            type="button"
            className="empNotepadAddMemberBtn"
            onClick={() => openAddUsersToNotepad(note)}
            disabled={savingNotepadNote || isTogglingComplete || isTrashing || !!notepadBinActionNoteId || isAddingMembers}
            title="Add users to note"
            aria-label="Add users to note"
          >
            {isAddingMembers ? "..." : <UserPlus size={13} aria-hidden="true" />}
          </button>
          {groupMembers.length > 0 ? (
            <div className="empNotepadGroupMembers" aria-label="Group note members">
              {groupMembers.slice(0, 4).map((member) => (
                <span
                  key={`${noteId}-group-member-${member.userId || member.name}`}
                  className="empNotepadGroupMemberAvatar"
                  title={member.name}
                  aria-label={member.name}
                >
                  {member.profileImg ? (
                    <img src={member.profileImg} alt={`${member.name} profile`} />
                  ) : (
                    initialsFromName(member.name)
                  )}
                </span>
              ))}
              {groupMembers.length > 4 ? (
                <span className="empNotepadGroupMemberMore" aria-hidden="true">
                  +{groupMembers.length - 4}
                </span>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className={`empNotepadPinBtn ${isPinned ? "pinned" : ""}`}
            onClick={() => toggleNotepadNotePinned(note)}
            disabled={savingNotepadNote || isTogglingComplete || isPinning || isTrashing || !!notepadBinActionNoteId}
            title={isPinned ? "Unpin note" : "Pin note"}
            aria-label={isPinned ? "Unpin note" : "Pin note"}
          >
            {isPinning ? "..." : <Pin size={13} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="empNotepadTrashBtn"
            onClick={() => openNotepadConfirm("trash", note)}
            disabled={savingNotepadNote || isTogglingComplete || isTrashing || !!notepadBinActionNoteId}
            title="Move to recycle bin"
            aria-label="Move note to recycle bin"
          >
            {isTrashing ? "..." : <Trash2 size={13} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={`empNotepadCompleteBtn ${isCompleted ? "done" : ""}`}
            onClick={() => toggleNotepadNoteCompleted(note)}
            disabled={savingNotepadNote || isTogglingComplete || isTrashing || !!notepadBinActionNoteId}
            title={isCompleted ? "Mark as active" : "Mark as complete"}
            aria-label={isCompleted ? "Mark note as active" : "Mark note as complete"}
          >
            {isTogglingComplete ? "Saving..." : isCompleted ? "Reopen" : "Complete"}
          </button>
        </div>
        {isAddMemberOpen ? (
          <div className="empNotepadMemberAddPane">
            <div className="empNotepadGroupCreateTitle">Add Users To Note</div>
            <div className="empNotepadGroupCreateSub">
              Adding a user will convert this note into a group note.
            </div>
            <div className="empNotepadGroupCreateList">
              {notepadGroupMemberOptions.length === 0 ? (
                <div className="empNotepadGroupCreateEmpty">No employees available.</div>
              ) : (
                notepadGroupMemberOptions.map((member) => {
                  const userId = String(member?.userId || "");
                  const isOwner = userId === ownerUserId;
                  const isExisting = noteMemberUserIds.includes(userId);
                  const isChecked = draftMemberUserIds.includes(userId) || isExisting;
                  const isDisabled = isOwner || isExisting || isAddingMembers;
                  const suffixLabel = isOwner ? " (Owner)" : isExisting ? " (Already added)" : "";
                  return (
                    <label
                      key={`${noteId}-add-member-${userId}`}
                      className={`empNotepadGroupCreateItem ${isChecked ? "checked" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isDisabled}
                        onChange={() => toggleNotepadAddMemberDraftUser(note, userId)}
                      />
                      <span className="empNotepadGroupCreateAvatar" aria-hidden="true">
                        {member?.profileImg ? <img src={member.profileImg} alt="" /> : initialsFromName(member?.name)}
                      </span>
                      <span className="empNotepadGroupCreateName">
                        {member?.name || userId}
                        {suffixLabel}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <div className="empNotepadGroupCreateActions">
              <button
                type="button"
                className="empNotepadGroupCreateBtn cancel"
                onClick={closeAddUsersToNotepad}
                disabled={isAddingMembers}
              >
                Cancel
              </button>
              <button
                type="button"
                className="empNotepadGroupCreateBtn create"
                onClick={() => saveNotepadAddedMembers(note)}
                disabled={isAddingMembers || addableMembersCount < 1}
                title={addableMembersCount < 1 ? "Select at least one new user" : "Add selected users"}
              >
                {isAddingMembers ? "Adding..." : "Add Selected Users"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const refreshSideNotepadDisplay = useCallback(async () => {
    if (notepadSideRefreshLoading) return;
    setNotepadSideRefreshLoading(true);
    setNotepadError("");
    try {
      await loadNotepadNotes("", { force: true });
      await refreshNotepadIconMeta({ force: true });
      setNotepadStatusText("Notes refreshed.");
    } catch (err) {
      setNotepadError(err?.message || "Failed to refresh notes.");
    } finally {
      setNotepadSideRefreshLoading(false);
    }
  }, [notepadSideRefreshLoading, loadNotepadNotes, refreshNotepadIconMeta]);

  return (
    <div className="empDash">
      <div
        className={`empDashShell ${breakLoading ? "isBreakSaving" : ""} ${
          viewMode === "call_activity" ? "isCallActivityView" : "isDashboardView"
        }`}
        aria-busy={breakLoading}
      >
        {!employee ? (
        <div>No employee selected</div>
      ) : (
        <>
          <div className="empDashTop">
            <div>
              {viewerRole !== "employee" ? (
                <select
                  className="employee-select"
                  value={String(effectiveSelectedId)}
                  onChange={(e) => {
                    const nextEmployeeId = e.target.value;
                    requestNotepadDraftTransition(() => {
                      setSelected(nextEmployeeId);
                    }, "switch_employee");
                  }}
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
              ) : null}

              {historyLoading ? (
                <div className="empHistoryGhost">Loading full history...</div>
              ) : historyError ? (
                <div>{historyError}</div>
              ) : null}
            </div>
          </div>

          <div className="empPanel">
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
              <div className="empPanelHeadRight">
                <div className="empDatePill">
                  {now.toLocaleDateString(undefined, {
                    timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
                  })}
                </div>
                <button
                  type="button"
                  className="empBreakLogsBtn"
                  onClick={openBreakLogsPanel}
                >
                  <Coffee size={14} aria-hidden="true" />
                  Break Logs
                </button>
                <button
                  type="button"
                  className={`empTaskListBtn ${isTaskListDrawerOpen ? "active" : ""}`}
                  onClick={toggleTaskListPanel}
                  title="Open tasks"
                  aria-label={`Open task list (${employeeTasks.length} tasks)`}
                >
                  <ClipboardList size={14} aria-hidden="true" />
                  <span className="empTaskListBtnLabel">Tasks</span>
                  {employeeTasks.length > 0 ? (
                    <span className="empTaskListBtnCount" aria-hidden="true">
                      {taskIconCountLabel}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`empAnnouncementBtn ${isAnnouncementDrawerOpen ? "active" : ""}`}
                  onClick={toggleAnnouncementPanel}
                  title="Open announcements"
                  aria-label={`Open announcements (${visitorAnnouncements.length} items)`}
                >
                  <Megaphone size={14} aria-hidden="true" />
                  <span className="empAnnouncementBtnLabel">Announcements</span>
                  {visitorAnnouncements.length > 0 ? (
                    <span className="empAnnouncementBtnCount" aria-hidden="true">
                      {visitorAnnouncements.length > 99 ? "99+" : visitorAnnouncements.length}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`empNotepadBtn ${notepadHasDueSoonNote ? "isDueSoon" : ""}`}
                  onClick={openMyNotepadPanel}
                  title={
                    notepadHasDueSoonNote
                      ? "Open notepad (urgent deadline note detected)"
                      : "Open notepad"
                  }
                  aria-label={`Open notepad (${notepadIconCount} notes)`}
                >
                  <span className="empNotepadBtnIconStack" aria-hidden="true">
                    <FileText size={14} className="empNotepadBtnIcon" />
                    <Pencil size={11} className="empNotepadBtnPencil" />
                  </span>
                  {notepadIconCount > 0 ? (
                    <span className="empNotepadBtnCount" aria-hidden="true">
                      {notepadIconBadgeLabel}
                    </span>
                  ) : null}
                </button>
              </div>
            </div>

            <div className="empPanelBody">
              <div className="empGrid2" ref={empGridRef}>
                <div className="scheduleCard">
                  <div className="scheduleTopRow">
                    <div className="scheduleDay">{todaySchedule?.dayLabel || "Today"}</div>
                    <div className={`statusPill ${todaySchedule ? "active" : ""}`}>
                      {todaySchedule ? "Active" : "No Schedule"}
                    </div>
                  </div>

                  <div className="progressCard">

                    <div className="breakDonutRow">
                      

                      <div className="donut-container">
                        <button
                          type="button"
                          className={`breakDonutButton ${isOnBreak ? "back" : "break"} ${
                            isOnBreak && breakMinutesLeft <= 0 && !breakLoading ? "limit-pulse" : ""
                          } breakDonut-${breakProgressVariant}`}
                          style={{
                            "--progressFill": breakProgressColor,
                            "--donutAngle": `${-breakDonutAngle}deg`,
                            "--markerAngle": `${breakThirtyMinuteMarkerAngle}deg`,
                          }}
                          onClick={requestBreakToggle}
                          disabled={breakLoading || (!isOnBreak && !canStartBreak)}
                          aria-label={breakToggleLabel}
                          data-tooltip={breakToggleLabel}
                        >
                          <span className="breakDonutOuter" aria-hidden="true">
                            <svg className="breakDonutSvg" viewBox="0 0 120 120" focusable="false">
                              <circle className="breakDonutTrack" cx="60" cy="60" r="48" pathLength="100" />
                              <circle
                                className="breakDonutProgress"
                                cx="60"
                                cy="60"
                                r="48"
                                pathLength="100"
                                strokeDasharray="100"
                                strokeDashoffset={breakDonutOffset}
                              />
                            </svg>
                            {showBreakWarningMarker ? (
                              <span className="breakDonutWarning">!</span>
                            ) : (
                              <span className="breakDonutDot" />
                            )}
                            <span className="breakDonutMarker" aria-hidden="true">
                              <span className="breakDonutMarkerTick" />
                              <span className="breakDonutMarkerLabel">30m</span>
                            </span>
                          </span>
                        <span className="breakDonutCenter">
                          <span className="breakDonutTitle">Break Time Left</span>
                          <span className="breakDonutTime" aria-hidden="true">
                            <span className="breakDonutValue">{breakLoading ? "--" : breakMinutesCounter}</span>
                              <span className="breakDonutDivider">:</span>
                              <span className="breakDonutValue seconds">{breakLoading ? "--" : breakSecondsLabel}</span>
                            </span>
                            <span className="breakDonutLabel">min sec</span>
                            <span className="breakDonutIcon">
                              {isOnBreak ? (
                                <Play size={26} fill="currentColor" aria-hidden="true" />
                              ) : (
                                <Pause size={26} fill="currentColor" aria-hidden="true" />
                              )}
                            </span>
                          </span>
                        </button>

                        <div className="progressMetaRow">
                          <span>Used</span>
                          <span>
                            {breakUsedLabel} / {breakLimitMinutes} min
                          </span>
                        </div>
                      </div>

                      {effectiveSelectedId ? (
                        <div
                          className="breakEmployeeDotPanel"
                          aria-label={`${toText(getDisplayName(employee)) || "Selected employee"} attendance dots`}
                        >
                          <div className="breakEmployeeDotPanelTop">
                            <div>
                              <div className="breakEmployeeDotPanelTitle">Employee Attendance</div>
                              <div className="breakEmployeeDotPanelSub">{selectedEmployeeDotRangeLabel}</div>
                            </div>
                          </div>

                          {!selectedEmployeeDotRow ? (
                            <div className="breakEmployeeDotEmpty">No employee attendance records for this year.</div>
                          ) : (
                            <div className="breakEmployeeDotRows">
                              <div className="breakEmployeeDotTableRow">
                                <div className="breakEmployeeDotIdentity">
                                  <div className="breakEmployeeDotAvatar">{selectedEmployeeDotRow.initials}</div>
                                  <div className="breakEmployeeDotIdentityText">
                                    <div className="breakEmployeeDotName">{selectedEmployeeDotRow.name}</div>
                                    <div className="breakEmployeeDotMeta">{selectedEmployeeDotRow.meta}</div>
                                  </div>
                                </div>

                                <div className="breakEmployeeDotWeeksWrap">
                                  <div className="breakEmployeeDotWeekTrack" style={selectedEmployeeDotWeekTrackStyle}>
                                    {selectedEmployeeDotRow.weeks.map((weekDots, weekIdx) => (
                                      <div
                                        key={`break-employee-dot-week-${selectedEmployeeDotRow.userId}-${weekIdx}`}
                                        className="breakEmployeeDotWeekCell"
                                      >
                                        <span className="breakEmployeeDotWeekHeaderLabel">
                                          {selectedEmployeeDotWeekLabels[weekIdx] || `W${weekIdx + 1}`}
                                        </span>
                                        <div className="breakEmployeeDotWeek">
                                          {weekDots.map((dot) => (
                                            <span
                                              key={dot.key}
                                              className={`breakEmployeeDotItem ${dot.className}`}
                                              title={`${prettyDayLabel(dot.dayKey)} - ${dot.label}`}
                                              aria-label={`${prettyDayLabel(dot.dayKey)} ${dot.label}`}
                                            />
                                          ))}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : null}
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
                  </div>

                  <div className="agentAttendancePanel dashboardAttendancePanel employeeLeadProcessPanel">
                    <div className="agentAttendancePanelTop employeeLeadProcessTop">
                      <div>
                        <div className="employeeLeadProcessTitleRow">
                          <div className="agentAttendancePanelHead">Inbound and New Lead</div>
                          <button
                            type="button"
                            className="employeeLeadGuideBtn"
                            aria-label={`Inbound and New Lead guide: ${EMPLOYEE_PROCESS_GUIDE_TEXT}`}
                          >
                            <CircleHelp size={14} aria-hidden="true" />
                            <span className="employeeLeadGuideTooltip" role="tooltip">
                              {EMPLOYEE_PROCESS_GUIDE_TEXT}
                            </span>
                          </button>
                        </div>
                      </div>
                      <div className="employeeLeadProcessBadge">
                        {employeeProcessLoading ? "Loading" : firstAvailableProcessUserId ? "Live" : "Waiting"}
                      </div>
                    </div>

                    {employeeProcessError ? (
                      <div className="agentAttendanceEmpty">{employeeProcessError}</div>
                    ) : employeeProcessRows.length === 0 ? (
                      <div className="agentAttendanceEmpty">No employees are included in the IB/NL process.</div>
                    ) : (
                      <div className="employeeLeadProcessTableWrap">
                        <table className="employeeLeadProcessTable" aria-label="Inbound and new lead process">
                          <thead>
                            <tr>
                              <th scope="col">Employee</th>
                              <th scope="col">Inbound (IB)</th>
                              <th scope="col">New Lead (NL)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {employeeProcessRows.map((row) => {
                              const isIb = row.userId === effectiveIbUserId;
                              const isNl = row.userId === effectiveNlUserId;
                              const isPurpleIb =
                                row.userId === savedPurpleIbUserId &&
                                row.isAvailable &&
                                row.userId !== effectiveIbUserId;
                              const canFinishMark =
                                (
                                  (viewerRole === "admin" || viewerRole === "super_admin") &&
                                  String(row.userId || "").trim() === String(normalizedSelectedUserId || "").trim()
                                ) ||
                                (
                                  viewerRole === "employee" &&
                                  String(row.userId || "").trim() === String(viewerLinkedEmployeeId || "").trim()
                                );
                              const canMarkPurpleIb =
                                !savedPurpleIbUserId &&
                                row.isAvailable &&
                                row.userId === employeeProcessNextPurpleIbUserId &&
                                canFinishMark;
                              const canRemovePurpleIb = isPurpleIb && canFinishMark;

                              return (
                                <tr
                                  key={`employee-lead-process-${row.userId}`}
                                  className={[
                                    "employeeLeadProcessRow",
                                    row.isAvailable ? "isAvailable" : "isUnavailable",
                                    isIb ? "isIb" : "",
                                    isPurpleIb ? "isPurpleIb" : "",
                                    isNl ? "isNl" : "",
                                    canMarkPurpleIb ? "canMarkPurpleIb" : "",
                                  ].filter(Boolean).join(" ")}
                                >
                                {!row.isAvailable ? (
                                  <td colSpan={3} className={`employeeLeadUnavailableCell tone-${row.statusTone}`}>
                                    <div className="employeeLeadUnavailableContent">
                                      <div className="employeeLeadIdentity">
                                        <div className="employeeLeadAvatar">
                                            {row.profileImg ? (
                                              <img src={row.profileImg} alt={`${row.name} profile`} />
                                            ) : (
                                              row.initials
                                            )}
                                          </div>
                                          <div>
                                            <div className="employeeLeadName">{row.name}</div>
                                          </div>
                                        </div>
                                        {row.statusTone === "loggedin" && row.canReady ? (
                                          <button
                                            type="button"
                                            className={`employeeLeadStatus employeeLeadUnavailableStatus employeeLeadReadyStatus tone-${row.statusTone}`}
                                            onClick={() => requestEmployeeProcessReady(row.userId)}
                                            aria-label={`Mark ${row.name} as ready for IB and New Lead rotation`}
                                            title="Click to make available"
                                          >
                                            <span className="employeeLeadReadyTextDefault">{row.statusLabel}</span>
                                            <span className="employeeLeadReadyTextHover">I'm ready</span>
                                          </button>
                                        ) : (
                                          <div className={`employeeLeadStatus employeeLeadUnavailableStatus tone-${row.statusTone}`}>
                                            {row.statusLabel}
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                  ) : (
                                    <>
                                      <td>
                                        <div className="employeeLeadIdentity">
                                          <div className="employeeLeadAvatar">
                                            {row.profileImg ? (
                                              <img src={row.profileImg} alt={`${row.name} profile`} />
                                            ) : (
                                              row.initials
                                            )}
                                          </div>
                                          <div>
                                            <div className="employeeLeadName">{row.name}</div>
                                            <div className={`employeeLeadStatus tone-${row.statusTone}`}>
                                              {row.statusLabel}
                                            </div>
                                          </div>
                                        </div>
                                      </td>
                                      <td>
                                        {isIb ? (
                                          <div className="employeeLeadMarkStack">
                                            <button
                                              type="button"
                                              className={`employeeLeadMark isIb ${canFinishMark ? "canFinish" : ""}`}
                                              onClick={() => requestEmployeeProcessFinish("ib", row.userId)}
                                              disabled={!canFinishMark || employeeProcessBusy === "ib"}
                                              aria-label="Finish Inbound"
                                            >
                                              <span className="employeeLeadMarkTextDefault">IB</span>
                                              <span className="employeeLeadMarkTextHover">
                                                {employeeProcessBusy === "ib" ? "Finishing..." : "Finish Inbound"}
                                              </span>
                                            </button>
                                          </div>
                                        ) : isPurpleIb ? (
                                          <div className="employeeLeadMarkStack">
                                            <button
                                              type="button"
                                              className={`employeeLeadMark isPurpleIb ${canRemovePurpleIb ? "canFinish" : ""}`}
                                              onClick={() => requestEmployeeProcessPurpleIb("remove", row.userId)}
                                              disabled={!canRemovePurpleIb || employeeProcessBusy === "purple_ib_remove"}
                                              aria-label="Remove secondary IB mark"
                                            >
                                              <span className="employeeLeadMarkTextDefault">IB</span>
                                              <span className="employeeLeadMarkTextHover">
                                                {employeeProcessBusy === "purple_ib_remove" ? "Removing..." : "Remove IB Mark"}
                                              </span>
                                            </button>
                                          </div>
                                        ) : canMarkPurpleIb ? (
                                          <div className="employeeLeadMarkStack">
                                            <button
                                              type="button"
                                              className="employeeLeadSecondaryPrompt"
                                              onClick={() => requestEmployeeProcessPurpleIb("mark", row.userId)}
                                              disabled={employeeProcessBusy === "purple_ib_mark"}
                                              aria-label="Mark secondary IB"
                                            >
                                              {employeeProcessBusy === "purple_ib_mark" ? "Marking..." : "Mark IB"}
                                            </button>
                                          </div>
                                        ) : null}
                                      </td>
                                      <td>
                                        {isNl ? (
                                          <div className="employeeLeadMarkStack">
                                            <button
                                              type="button"
                                              className={`employeeLeadMark isNl ${canFinishMark ? "canFinish" : ""}`}
                                              onClick={() => requestEmployeeProcessFinish("nl", row.userId)}
                                              disabled={!canFinishMark || employeeProcessBusy === "nl"}
                                              aria-label="Finish new lead"
                                            >
                                              <span className="employeeLeadMarkTextDefault">NL</span>
                                              <span className="employeeLeadMarkTextHover">
                                                {employeeProcessBusy === "nl" ? "Finishing..." : "Finish new lead"}
                                              </span>
                                            </button>
                                          </div>
                                        ) : null}
                                      </td>
                                    </>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>

                <div className="empSideColumn" ref={empSideColumnRef} style={empSideColumnInlineStyle}>
                  <button
                    type="button"
                    className="empSideColumnResizeHandle"
                    onMouseDown={handleEmpSideColumnResizeMouseDown}
                    aria-label="Resize notes panel"
                    title="Drag to resize notes panel"
                  />
                  <div className="empSideColumnTopRow">
                    <h3>My Notes:</h3>
                    <button
                      type="button"
                      className={`empSideColumnRefreshBtn ${notepadSideRefreshLoading ? "loading" : ""}`}
                      onClick={refreshSideNotepadDisplay}
                      disabled={notepadSideRefreshLoading}
                      title="Refresh notes"
                      aria-label="Refresh notes"
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="dashboardNotepadCard">
                    <div
                      className={`dashboardNotepadStack${dashboardHasNoPages ? " isEmpty" : ""}`}
                      aria-label="Interactive dashboard notepad"
                    >
                      <span className="dashboardNotepadClip" aria-hidden="true" />
                      {dashboardHasBackPage ? (
                        <span
                          className="dashboardNotepadPage dashboardNotepadPageBack"
                          aria-hidden="true"
                          style={dashboardBackThemeVars}
                        />
                      ) : null}
                      {dashboardHasMidPage ? (
                        <span
                          className="dashboardNotepadPage dashboardNotepadPageMid"
                          aria-hidden="true"
                          style={dashboardMidThemeVars}
                        />
                      ) : null}
                      <div
                        className="dashboardNotepadActions"
                        ref={dashboardNoteActionsRef}
                        onClick={stopDashboardMenuPropagation}
                        onMouseDown={stopDashboardMenuPropagation}
                      >
                        {dashboardNotepadIsPinned ? (
                          <button
                            type="button"
                            className="dashboardNotepadPinnedIconBtn pinned"
                            onClick={handleDashboardPinIconClick}
                            aria-label="Unpin note"
                            title="Unpin note"
                          >
                            <Pin size={13} aria-hidden="true" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="dashboardNotepadMoreBtn"
                          onClick={toggleDashboardNoteMenu}
                          aria-haspopup="menu"
                          aria-expanded={isDashboardNoteMenuOpen}
                          aria-label="Note actions"
                          title="Note actions"
                        >
                          <MoreVertical size={14} aria-hidden="true" />
                        </button>
                        {isDashboardNoteMenuOpen ? (
                          <div
                            className="dashboardNotepadMenu"
                            role="menu"
                            aria-label="Dashboard note actions"
                            onClick={stopDashboardMenuPropagation}
                            onMouseDown={stopDashboardMenuPropagation}
                            onMouseLeave={closeDashboardNoteMenuOnMouseLeave}
                          >
                            <button
                              type="button"
                              className="dashboardNotepadMenuItem"
                              role="menuitem"
                              onClick={(event) => runDashboardNoteAction("pin", event)}
                              disabled={!hasDashboardImportantNote}
                            >
                              <Pin size={13} className="dashboardNotepadMenuItemIcon" aria-hidden="true" />
                              {dashboardNotepadIsPinned ? "Unpin this note" : "Pin this note"}
                            </button>
                            <button
                              type="button"
                              className="dashboardNotepadMenuItem"
                              role="menuitem"
                              onClick={(event) => runDashboardNoteAction("edit", event)}
                              disabled={!hasDashboardImportantNote}
                            >
                              <Pencil size={13} className="dashboardNotepadMenuItemIcon" aria-hidden="true" />
                              Edit note
                            </button>
                            <button
                              type="button"
                              className="dashboardNotepadMenuItem"
                              role="menuitem"
                              onClick={(event) => runDashboardNoteAction("complete", event)}
                              disabled={!hasDashboardImportantNote || !!topDashboardImportantNote?.isCompleted}
                            >
                              <CheckSquare size={13} className="dashboardNotepadMenuItemIcon" aria-hidden="true" />
                              Mark as complete
                            </button>
                            <button
                              type="button"
                              className="dashboardNotepadMenuItem danger"
                              role="menuitem"
                              onClick={(event) => runDashboardNoteAction("delete", event)}
                              disabled={!hasDashboardImportantNote}
                            >
                              <Trash2 size={13} className="dashboardNotepadMenuItemIcon" aria-hidden="true" />
                              Delete note
                            </button>
                            <div
                              className={`dashboardNotepadMenuColorSection${
                                dashboardColorSaveVisible ? " saving" : ""
                              }`}
                            >
                              <div className="dashboardNotepadMenuColorLabel">
                                <Palette size={13} className="dashboardNotepadMenuItemIcon" aria-hidden="true" />
                                <span>
                                  {dashboardColorSaveVisible ? "Saving color..." : "Customize color"}
                                </span>
                              </div>
                              <div className="dashboardNotepadMenuColorOptions">
                                {NOTEPAD_COLOR_OPTIONS.map((option) => {
                                  const optionKey = String(option?.key || "").trim();
                                  const isActive = optionKey === dashboardNotepadColorKey;
                                  const isSavingOption = isActive && dashboardColorSaveVisible;
                                  const swatchColor =
                                    NOTEPAD_COLOR_THEMES[optionKey]?.vars?.["--dash-note-page-base"] || "#f4d15d";
                                  return (
                                    <button
                                      key={optionKey}
                                      type="button"
                                      className={`dashboardNotepadMenuColorOption${isActive ? " active" : ""}${
                                        isSavingOption ? " saving" : ""
                                      }`}
                                      onClick={(event) => setDashboardNoteColor(optionKey, event)}
                                      disabled={dashboardColorUpdateBusy}
                                      title={option?.label || optionKey}
                                      aria-label={`Use ${option?.label || optionKey} note color`}
                                    >
                                      <span
                                        className="dashboardNotepadMenuColorSwatch"
                                        style={{ backgroundColor: swatchColor }}
                                        aria-hidden="true"
                                      />
                                      <span className="dashboardNotepadMenuColorName">
                                        {option?.label || optionKey}
                                      </span>
                                      {isActive ? (
                                        <span className="dashboardNotepadMenuColorSelected" aria-hidden="true">
                                          {isSavingOption ? "" : "✓"}
                                        </span>
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div
                        className={`dashboardNotepadPage dashboardNotepadPageFront${
                          dashboardHasNoPages ? " isEmpty" : ""
                        }`}
                        style={dashboardHasFrontPage ? dashboardFrontThemeVars : undefined}
                        onClick={() => {
                          if (topDashboardImportantNote?.id) {
                            openDashboardImportantNote(topDashboardImportantNote);
                          } else {
                            openMyNotepadPanel();
                          }
                        }}
                      >
                        <div className="dashboardNotepadTopRow">
                          <div className="dashboardNotepadTitleBlock">
                            <span className="dashboardNotepadTitle">{dashboardNotepadTitle}</span>
                            {dashboardNotepadHasDeadline ? (
                              <span className={`dashboardNotepadDueMeta tone-${dashboardNotepadDeadlineTone}`}>
                                {dashboardNotepadDeadlineLabel}
                              </span>
                            ) : null}
                          </div>
                        </div>

                        {topDashboardImportantNote ? (
                          <div
                            ref={dashboardDisplayRef}
                            className={`dashboardNotepadPreview${dashboardPreviewHasTable ? " hasTable" : ""}`}
                            onClick={handleDashboardDisplayCheckboxChange}
                            dangerouslySetInnerHTML={{
                              __html: String(dashboardDisplayHtml || EMPTY_NOTEPAD_HTML),
                            }}
                          />
                        ) : (
                          <div className="dashboardNotepadPreview dashboardNotepadPreviewEmpty">
                            {notepadLoading ? "Loading notes..." : "No notes yet. Click to open notepad."}
                          </div>
                        )}

                        <div className="dashboardNotepadHint">
                          {dashboardDisplaySaving
                            ? "Saving..."
                            : dashboardDisplayStatus || (topDashboardImportantNote ? "Click to open this note" : "Click to open notepad")}
                        </div>
                      </div>

                      {dashboardDisplayNoteCount > 1 ? (
                        <div className="dashboardNotepadFrontNav" aria-label="Dashboard note navigation">
                          <button
                            type="button"
                            className="dashboardNotepadSideNav"
                            onClick={showPreviousDashboardNote}
                            aria-label="Show previous note"
                            title="Previous note"
                          >
                            <ChevronLeft size={14} aria-hidden="true" />
                          </button>
                          <span className="dashboardNotepadNavCount" aria-live="polite">
                            {dashboardDisplayNoteIndex + 1}/{dashboardDisplayNoteCount}
                          </span>
                          <button
                            type="button"
                            className="dashboardNotepadSideNav"
                            onClick={showNextDashboardNote}
                            aria-label="Show next note"
                            title="Next note"
                          >
                            <ChevronRight size={14} aria-hidden="true" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="employeeProcessLogPane" aria-label="Inbound and new lead log">
                    <div className="employeeProcessLogHead">
                      <div>
                        <div className="employeeProcessLogKicker">Activity Log</div>
                        <h4>Inbound &amp; New Lead Log</h4>
                      </div>
                      <div className="employeeProcessLogCount">{employeeProcessActionLogs.length}</div>
                    </div>

                    {employeeProcessActionLogsError ? (
                      <div className="employeeProcessLogEmpty error">{employeeProcessActionLogsError}</div>
                    ) : employeeProcessActionLogsLoading ? (
                      <div className="employeeProcessLogEmpty">Loading process log...</div>
                    ) : employeeProcessActionLogs.length === 0 ? (
                      <div className="employeeProcessLogEmpty">No inbound or new lead actions yet.</div>
                    ) : (
                      <div className="employeeProcessLogList">
                        {employeeProcessActionLogs.map((log, index) => {
                          const logKey =
                            String(log?.id || "").trim() ||
                            `${normalizedSelectedUserId || "employee"}-process-log-${index}`;

                          return (
                            <div key={logKey} className="employeeProcessLogItem">
                              <div className="employeeProcessLogAvatar">
                                {log?.employeeProfileImageUrl ? (
                                  <img src={log.employeeProfileImageUrl} alt={`${log.employeeName || "Employee"} profile`} />
                                ) : (
                                  initialsFromName(log?.employeeName || log?.createdByName || "Employee")
                                )}
                              </div>
                              <div className="employeeProcessLogMain">
                                <div className="employeeProcessLogName">
                                  {log?.employeeName || log?.createdByName || "Employee"}
                                </div>
                                <div className="employeeProcessLogAction">{log?.actionLabel || "Action"}</div>
                              </div>
                              <div className="employeeProcessLogTime">
                                {formatBreakLogDateTime(log?.createdAtMs || log?.createdAt, businessTimeZone)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="greetingPanel">
            <div className="greetingLavaObjects" aria-hidden="true">
              <span className="greetingLavaBlob blobOne" />
              <span className="greetingLavaBlob blobTwo" />
              <span className="greetingLavaBlob blobThree" />
              <span className="greetingLavaBlob blobFour" />
              <span className="greetingLavaBlob blobFive" />
              <span className="greetingLavaBlob blobSix" />
              <span className="greetingLavaBlob blobSeven" />
              <span className="greetingLavaBlob blobEight" />
            </div>

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

          {portalRoot
            ? createPortal(
                <>
                  {isAnnouncementDrawerOpen ? (
                    <div
                      className="empAnnouncementBackdrop"
                      role="button"
                      tabIndex={0}
                      aria-label="Close announcement drawer"
                      onClick={closeAnnouncementDrawer}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") closeAnnouncementDrawer();
                      }}
                    />
                  ) : null}

                  <div
                    className={`empAnnouncementDrawer ${isAnnouncementDrawerOpen ? "open" : ""}`}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Announcements"
                  >
                    <div className="empAnnouncementDrawerHead">
                      <div className="empAnnouncementDrawerIdentity">
                        <div className="empAnnouncementDrawerTitle">Announcements</div>
                        <div className="empAnnouncementDrawerSub">
                          {employee?.name || employee?.email || effectiveSelectedId || "Employee"}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="empAnnouncementDrawerClose"
                        onClick={closeAnnouncementDrawer}
                        aria-label="Close announcements drawer"
                      >
                        x
                      </button>
                    </div>

                    <div className="empAnnouncementDrawerBody">
                      <div className="announcementCard announcementCardDrawer">
                        <div className="announcementHead">
                          <span>Announcements</span>
                          <span className="announcementCount">{visitorAnnouncements.length}</span>
                        </div>
                        <div className="announcementBody announcementBodyDrawer">
                          {visitorAnnouncements.length ? (
                            visitorAnnouncements.map((item) => (
                              <button
                                type="button"
                                key={item.id}
                                className="announcementItem"
                                onClick={() => {
                                  setSelectedAnnouncement(item);
                                  setIsAnnouncementDrawerOpen(false);
                                }}
                              >
                                <div className="announcementMeta">
                                  <span>{formatAnnouncementDate(item.createdAtMs)}</span>
                                  <span className="announcementAuthor">{item.createdBy}</span>
                                </div>
                                <div className="announcementHeadline">{item.headline}</div>
                              </button>
                            ))
                          ) : (
                            <div className="announcementEmpty">No announcements yet.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {isTaskListDrawerOpen ? (
                    <div
                      className="empTaskListBackdrop"
                      role="button"
                      tabIndex={0}
                      aria-label="Close task list drawer"
                      onClick={closeTaskListDrawer}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") closeTaskListDrawer();
                      }}
                    />
                  ) : null}

                  <div
                    className={`empTaskListDrawer ${isTaskListDrawerOpen ? "open" : ""}`}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Employee tasks"
                  >
                    <div className="empTaskListDrawerHead">
                      <div className="empTaskListDrawerIdentity">
                        <div className="empTaskListDrawerTitle">Tasks</div>
                        <div className="empTaskListDrawerSub">
                          {employee?.name || employee?.email || effectiveSelectedId || "Employee"}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="empTaskListDrawerClose"
                        onClick={closeTaskListDrawer}
                        aria-label="Close task list drawer"
                      >
                        x
                      </button>
                    </div>

                    <div className="empTaskListDrawerBody">
                      <div className="taskListCard taskListCardDrawer">
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
                          <div
                            ref={taskFilterMenuRef}
                            className="taskFilterMenu"
                            role="listbox"
                            aria-label="Task status filters"
                          >
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

                        <div className="taskListBody taskListBodyDrawer">
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
                            filteredEmployeeTasks.map((task, index) =>
                              renderTaskListItem(task, index, "filtered")
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </>,
                portalRoot
              )
            : null}

          {portalRoot
            ? createPortal(
                <>
                  {isBreakLogsDrawerOpen ? (
                    <div
                      className="empBreakLogsBackdrop"
                      role="button"
                      tabIndex={0}
                      aria-label="Close break logs drawer"
                      onClick={closeBreakLogsDrawer}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") closeBreakLogsDrawer();
                      }}
                    />
                  ) : null}

                  <div
                    className={`empBreakLogsDrawer ${isBreakLogsDrawerOpen ? "open" : ""}`}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Employee break logs"
                  >
                    <div className="empBreakLogsDrawerHead">
                      <div className="empBreakLogsDrawerIdentity">
                        <div className="empBreakLogsDrawerTitle">Break Logs</div>
                        <div className="empBreakLogsDrawerSub">
                          {employee?.name || employee?.email || effectiveSelectedId || "Employee"}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="empBreakLogsDrawerClose"
                        onClick={closeBreakLogsDrawer}
                        aria-label="Close break logs drawer"
                      >
                        x
                      </button>
                    </div>

                    <div className="empBreakLogsDrawerBody">
                      <div className="empBreakLogsToolbar">
                        <div className="empBreakLogsSummary">
                          {breakLogLoading
                            ? "Loading break logs..."
                            : `${filteredBreakLogRows.length} log${filteredBreakLogRows.length === 1 ? "" : "s"}`}
                        </div>
                        <div className="empBreakLogsFilters" role="tablist" aria-label="Break log filters">
                          {BREAK_LOG_FILTER_OPTIONS.map((option) => {
                            const isActive = breakLogFilter === option.key;
                            return (
                              <button
                                key={option.key}
                                type="button"
                                role="tab"
                                aria-selected={isActive}
                                className={`empBreakLogsFilterBtn ${isActive ? "active" : ""}`}
                                onClick={() => setBreakLogFilter(option.key)}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {breakLogError ? (
                        <div className="empBreakLogsError">{breakLogError}</div>
                      ) : breakLogLoading ? (
                        <div className="empBreakLogsEmpty">Fetching break logs...</div>
                      ) : filteredBreakLogRows.length === 0 ? (
                        <div className="empBreakLogsEmpty">{breakLogEmptyText}</div>
                      ) : (
                        <div className="empBreakLogsList">
                          {filteredBreakLogRows.map((row, index) => {
                            const startedAt = row?.startedAt ?? row?.createdAt ?? null;
                            const endedAt = row?.endedAt ?? null;
                            const isActiveBreak = !endedAt || !!row?.isActive;
                            const startedAtMs = toMillis(startedAt);
                            const key =
                              toText(row?.id) ||
                              `${effectiveSelectedId}-break-${Number.isFinite(startedAtMs) ? startedAtMs : index}`;

                            return (
                              <div key={key} className="empBreakLogsItem">
                                <div className="empBreakLogsItemTop">
                                  <div className="empBreakLogsItemType">
                                    {formatBreakLogLabel(row?.breakType, "Break")}
                                  </div>
                                  <span className={`empBreakLogsItemState ${isActiveBreak ? "active" : ""}`}>
                                    {isActiveBreak ? "Active" : "Completed"}
                                  </span>
                                </div>

                                <div className="empBreakLogsItemMeta">
                                  <span>Start</span>
                                  <strong>{formatBreakLogDateTime(startedAt, businessTimeZone)}</strong>
                                </div>
                                <div className="empBreakLogsItemMeta">
                                  <span>End</span>
                                  <strong>
                                    {isActiveBreak ? "In progress" : formatBreakLogDateTime(endedAt, businessTimeZone)}
                                  </strong>
                                </div>
                                <div className="empBreakLogsItemMeta">
                                  <span>Duration</span>
                                  <strong>
                                    {formatBreakLogDuration(
                                      startedAt,
                                      endedAt,
                                      Number.isFinite(liveNowMs) ? liveNowMs : Date.now()
                                    )}
                                  </strong>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </>,
                portalRoot
              )
            : null}

          {portalRoot
            ? createPortal(
                <>
                  {isNotepadDrawerOpen ? (
            <div
              className="empNotepadBackdrop"
              role="button"
              tabIndex={0}
              aria-label="Close notepad drawer"
              onClick={closeNotepadDrawer}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeNotepadDrawer();
              }}
            />
          ) : null}

          <div
            className={`empNotepadDrawer ${isNotepadDrawerOpen ? "open" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label="Employee notes"
          >
            <div className="empNotepadDrawerHead">
              <div className="empNotepadDrawerIdentity">
                <div className="empNotepadDrawerTitle">Employee Notepad</div>
                <div className="empNotepadDrawerSub">
                  {employee?.name || employee?.email || effectiveSelectedId || "Employee"}
                </div>
              </div>
              <button
                type="button"
                className="empNotepadDrawerClose"
                onClick={closeNotepadDrawer}
                aria-label="Close notepad drawer"
              >
                x
              </button>
            </div>

            <div className="empNotepadDrawerBody">
              <aside className="empNotepadListPane">
                <div className="empNotepadListPaneTop">
                  <div className="empNotepadListTopRow">
                    <div className="empNotepadListCount">
                      {notepadLoading
                        ? "Loading notes..."
                        : isNotepadRecycleBinView
                          ? `${notepadTrashedNoteCount} trashed note${notepadTrashedNoteCount === 1 ? "" : "s"}`
                          : isNotepadGroupView
                            ? `${notepadGroupNoteCount} group note${notepadGroupNoteCount === 1 ? "" : "s"}`
                            : `${notepadNoteCount} note${notepadNoteCount === 1 ? "" : "s"}`}
                    </div>
                    <div className="empNotepadViewControls">
                      <button
                        type="button"
                        className={`empNotepadViewBtn ${isNotepadGroupView ? "active" : ""}`}
                        onClick={() => {
                          if (isNotepadGroupView && !isNotepadGroupCreatorOpen) return;
                          requestNotepadDraftTransition(() => {
                            setNotepadViewMode(NOTEPAD_VIEW_GROUP);
                            setIsNotepadGroupCreatorOpen(false);
                            setIsNotepadNewDraftOpen(false);
                            setNotepadAddMemberNoteId("");
                            setNotepadAddMemberDraft([]);
                            setSelectedNotepadNoteId("");
                          }, "switch_view");
                        }}
                        title="Open group notes"
                        aria-label={`Open group notes (${notepadGroupNoteCount})`}
                      >
                        Group Notes
                        <span className="empNotepadViewBtnBadge" aria-hidden="true">
                          {notepadGroupNoteCount > 99 ? "99+" : notepadGroupNoteCount}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`empNotepadViewBtn ${notepadViewMode === NOTEPAD_VIEW_MY ? "active" : ""}`}
                        onClick={() => {
                          if (String(notepadViewMode || "") === NOTEPAD_VIEW_MY && !isNotepadGroupCreatorOpen) return;
                          requestNotepadDraftTransition(() => {
                            setNotepadViewMode(NOTEPAD_VIEW_MY);
                            setIsNotepadGroupCreatorOpen(false);
                            setIsNotepadNewDraftOpen(false);
                            setNotepadAddMemberNoteId("");
                            setNotepadAddMemberDraft([]);
                            setSelectedNotepadNoteId("");
                          }, "switch_view");
                        }}
                        title="Open my notes"
                        aria-label={`Open my notes (${notepadNoteCount})`}
                      >
                        My Notes
                        <span className="empNotepadViewBtnBadge" aria-hidden="true">
                          {notepadNoteCount > 99 ? "99+" : notepadNoteCount}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`empNotepadBinToggleBtn ${isNotepadRecycleBinView ? "active" : ""}`}
                        onClick={() => {
                          if (isNotepadRecycleBinView) return;
                          requestNotepadDraftTransition(() => {
                            setNotepadViewMode(NOTEPAD_VIEW_BIN);
                            setIsNotepadGroupCreatorOpen(false);
                            setIsNotepadNewDraftOpen(false);
                            setNotepadAddMemberNoteId("");
                            setNotepadAddMemberDraft([]);
                            setSelectedNotepadNoteId("");
                          }, "switch_view");
                        }}
                        title="Open recycle bin"
                        aria-label={`Open recycle bin (${notepadTrashedNoteCount})`}
                      >
                        Recycle Bin
                        <span className="empNotepadViewBtnBadge" aria-hidden="true">
                          {notepadTrashedNoteCount > 99 ? "99+" : notepadTrashedNoteCount}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
                <div className="empNotepadNewBtnRow">
                  <button
                    type="button"
                    className={`empNotepadNewBtn empNotepadNewBtnFull ${isNotepadPersonalNewMode ? "active" : ""}`}
                    onClick={startNewNotepadNote}
                    aria-pressed={isNotepadPersonalNewMode}
                    disabled={
                      savingNotepadNote ||
                      creatingGroupNotepadNote ||
                      !!notepadTrashingNoteId ||
                      !!notepadBinActionNoteId
                    }
                  >
                    + New Note
                  </button>
                  <button
                    type="button"
                    className={`empNotepadNewBtn empNotepadNewBtnGroup ${isNotepadGroupCreatorOpen ? "active" : ""}`}
                    onClick={openCreateGroupNotepad}
                    title="Create group note"
                    aria-label="Create group note"
                    aria-pressed={isNotepadGroupCreatorOpen}
                    disabled={
                      savingNotepadNote ||
                      creatingGroupNotepadNote ||
                      !!notepadTrashingNoteId ||
                      !!notepadBinActionNoteId
                    }
                  >
                    <span className="empNotepadNewBtnGroupPlusInline" aria-hidden="true">
                      +
                    </span>
                    <span className="empNotepadNewBtnGroupUsersIcon" aria-hidden="true">
                      <Users size={14} />
                    </span>
                    <span className="empNotepadNewBtnGroupNoteBadge" aria-hidden="true">
                      <FileText size={8} />
                    </span>
                  </button>
                </div>
                <div className="empNotepadModeHint">{notepadModeHint}</div>

                {isNotepadGroupCreatorOpen ? (
                  <div className="empNotepadGroupCreatePane">
                    <div className="empNotepadGroupCreateTitle">Create a Group Note</div>
                    <div className="empNotepadGroupCreateSub">
                      Select employees who can access and edit this note.
                    </div>
                    <div className="empNotepadGroupCreateList">
                      {notepadGroupMemberOptions.length === 0 ? (
                        <div className="empNotepadGroupCreateEmpty">No employees available.</div>
                      ) : (
                        notepadGroupMemberOptions.map((member) => {
                          const userId = String(member?.userId || "");
                          const isOwner = userId === String(effectiveSelectedId || "");
                          const isChecked = notepadGroupMemberDraft.includes(userId) || isOwner;
                          return (
                            <label
                              key={`group-note-member-${userId}`}
                              className={`empNotepadGroupCreateItem ${isChecked ? "checked" : ""}`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                disabled={isOwner || creatingGroupNotepadNote}
                                onChange={() => toggleGroupNoteMemberDraft(userId)}
                              />
                              <span className="empNotepadGroupCreateAvatar" aria-hidden="true">
                                {member?.profileImg ? (
                                  <img src={member.profileImg} alt="" />
                                ) : (
                                  initialsFromName(member?.name)
                                )}
                              </span>
                              <span className="empNotepadGroupCreateName">
                                {member?.name || userId}
                                {isOwner ? " (Owner)" : ""}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                    <div className="empNotepadGroupCreateActions">
                      <button
                        type="button"
                        className="empNotepadGroupCreateBtn cancel"
                        onClick={cancelCreateGroupNotepad}
                        disabled={creatingGroupNotepadNote}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="empNotepadGroupCreateBtn create"
                        onClick={createGroupNotepadNote}
                        disabled={creatingGroupNotepadNote || notepadGroupMemberSelectionCount < 2}
                        title={
                          notepadGroupMemberSelectionCount < 2
                            ? "Add at least one other employee to create a group note"
                            : "Create group note"
                        }
                      >
                        {creatingGroupNotepadNote ? "Creating..." : "Create Group Note"}
                      </button>
                    </div>
                  </div>
                ) : null}

                {notepadError ? <div className="empNotepadError">{notepadError}</div> : null}

                <div className="empNotepadList" ref={notepadListRef}>
                  {!notepadLoading && !isNotepadRecycleBinView ? (
                    <div className={`empNotepadCompletedDropdown ${isNotepadCompletedOpen ? "open" : ""}`}>
                      <button
                        type="button"
                        className={`empNotepadCompletedTrigger ${isNotepadCompletedOpen ? "open" : ""}`}
                        aria-expanded={isNotepadCompletedOpen}
                        onClick={() => setIsNotepadCompletedOpen((prev) => !prev)}
                      >
                        <span className="empNotepadCompletedLabel">
                          {visibleNotepadCompletedCount} completed task
                          {visibleNotepadCompletedCount === 1 ? "" : "s"}
                        </span>
                      </button>
                      {isNotepadCompletedOpen ? (
                        <div className="empNotepadCompletedList">
                          {visibleNotepadCompletedCount === 0 ? (
                            <div className="empNotepadEmptyList">No completed tasks yet.</div>
                          ) : (
                            visibleNotepadCompletedNotes.map((note, index) =>
                              renderNotepadActiveListItem(note, index, "completed-note")
                            )
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {!notepadLoading &&
                  (isNotepadRecycleBinView
                    ? notepadTrashedNotes.length === 0
                    : visibleNotepadOpenNotes.length === 0 && visibleNotepadCompletedCount === 0) ? (
                    <div className="empNotepadEmptyList">
                      {isNotepadRecycleBinView
                        ? "Recycle bin is empty."
                        : isNotepadGroupView
                          ? "No group notes yet."
                          : "No notes yet."}
                    </div>
                  ) : isNotepadRecycleBinView ? (
                    notepadTrashedNotes.map((note) => {
                      const noteId = String(note?.id || "");
                      const noteTitle = toText(note?.title) || "Untitled note";
                      const preview = stripHtmlForPreview(note?.contentHtml) || "No content.";
                      const trashedAtValue = note?.trashedAt || note?.updatedAt || note?.createdAt || null;
                      const isBinActionRunning = noteId === String(notepadBinActionNoteId || "");
                      const groupMembers = getNotepadGroupMembers(note);

                      return (
                        <div key={noteId} className="empNotepadListItem trashed">
                          <div className="empNotepadListItemMain empNotepadListItemMainStatic">
                            <div className="empNotepadListItemTitle">{noteTitle}</div>
                            <div className="empNotepadListItemPreview">{preview}</div>
                            <div className="empNotepadListItemDeadline deadline-trashed">
                              Trashed: {formatNotepadDateLabel(trashedAtValue)}
                            </div>
                            <div className="empNotepadListItemDate">
                              Updated: {formatNotepadDateLabel(note?.updatedAt || note?.createdAt || null)}
                            </div>
                          </div>
                          <div className="empNotepadCardActions">
                            {groupMembers.length > 0 ? (
                              <div className="empNotepadGroupMembers" aria-label="Group note members">
                                {groupMembers.slice(0, 4).map((member) => (
                                  <span
                                    key={`${noteId}-group-trash-member-${member.userId || member.name}`}
                                    className="empNotepadGroupMemberAvatar"
                                    title={member.name}
                                    aria-label={member.name}
                                  >
                                    {member.profileImg ? (
                                      <img src={member.profileImg} alt={`${member.name} profile`} />
                                    ) : (
                                      initialsFromName(member.name)
                                    )}
                                  </span>
                                ))}
                                {groupMembers.length > 4 ? (
                                  <span className="empNotepadGroupMemberMore" aria-hidden="true">
                                    +{groupMembers.length - 4}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            <button
                              type="button"
                              className="empNotepadBinActionBtn restore"
                              onClick={() => openNotepadConfirm("restore", note)}
                              disabled={isBinActionRunning || savingNotepadNote || !!notepadTrashingNoteId}
                              title="Restore note"
                              aria-label="Restore note"
                            >
                              <RotateCcw size={13} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="empNotepadBinActionBtn delete"
                              onClick={() => openNotepadConfirm("delete", note)}
                              disabled={isBinActionRunning || savingNotepadNote || !!notepadTrashingNoteId}
                              title="Delete permanently"
                              aria-label="Delete permanently"
                            >
                              <Trash2 size={13} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    visibleNotepadOpenNotes.map((note, index) =>
                      renderNotepadActiveListItem(note, index, "open-note")
                    )
                  )}
                </div>
              </aside>

              <section className="empNotepadEditorPane">
                <div className="empNotepadEditorTop">
                  <input
                    type="text"
                    className="empNotepadTitleInput"
                    placeholder="Note title"
                    value={notepadTitleDraft}
                    onChange={(event) => {
                      setNotepadTitleDraft(event.target.value);
                      setNotepadDirty(true);
                      setNotepadStatusText("");
                    }}
                  />
                  <div className="empNotepadDeadlineControl">
                    <label htmlFor="emp-notepad-deadline">Deadline</label>
                    <input
                      id="emp-notepad-deadline"
                      type="datetime-local"
                      className={`empNotepadDeadlineInput tone-${notepadDraftDeadlineTone}`}
                      disabled={notepadDisabled}
                      value={notepadDeadlineDraft}
                      onChange={(event) => {
                        setNotepadDeadlineDraft(event.target.value);
                        setNotepadDirty(true);
                        setNotepadStatusText("");
                      }}
                    />
                    <button
                      type="button"
                      className="empNotepadDeadlineClearBtn"
                      onClick={() => {
                        setNotepadDeadlineDraft("");
                        setNotepadDirty(true);
                        setNotepadStatusText("");
                      }}
                      disabled={notepadDisabled}
                    >
                      Clear
                    </button>
                  </div>
                  <div className={`empNotepadColorControl${notepadColorDraftSaving ? " saving" : ""}`}>
                    <label htmlFor="emp-notepad-color">Color</label>
                    <select
                      id="emp-notepad-color"
                      className="empNotepadColorSelect"
                      value={notepadColorDraft}
                      disabled={notepadDisabled}
                      onChange={(event) => {
                        setNotepadColorDraft(normalizeNotepadColorKey(event.target.value));
                        setNotepadColorDraftSaving(true);
                        setNotepadDirty(true);
                        setNotepadStatusText("Saving color locally...");
                      }}
                    >
                      {NOTEPAD_COLOR_OPTIONS.map((option) => (
                        <option key={`notepad-color-${option.key}`} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {notepadColorDraftSaving ? (
                      <span className="empNotepadColorSavingText" aria-live="polite">
                        Saving
                      </span>
                    ) : null}
                  </div>
                  <div className="empNotepadEditorActions">
                    <span className={`empNotepadSaveState ${notepadDirty ? "dirty" : ""}`}>
                      {savingNotepadNote
                        ? "Saving..."
                        : notepadStatusText ||
                          (isNotepadTyping ? "Typing..." : notepadDirty ? "Unsaved changes" : "Saved")}
                    </span>
                    <button
                      type="button"
                      className="empNotepadSaveBtn"
                      onClick={saveNotepadNote}
                      disabled={savingNotepadNote || !notepadDraftCanSave || notepadDisabled}
                      title={notepadDraftCanSave ? "Save note" : "Add a title, deadline, or note content to enable save"}
                    >
                      Save
                    </button>
                  </div>
                </div>

                <div className={`empNotepadToolbar ${notepadDisabled ? "disabled" : ""}`} role="toolbar" aria-label="Notepad formatting toolbar">
                  <select
                    className="empNotepadToolSelect fontSize"
                    value={String(notepadToolbarState.fontSizePx || NOTEPAD_TOOLBAR_DEFAULT.fontSizePx)}
                    onMouseDown={cacheNotepadEditorSelectionRange}
                    onChange={(event) =>
                      runNotepadCommand("fontSizePx", Number(event.target.value), { forceRestoreSelection: true })
                    }
                    aria-label="Font size"
                    title="Font size"
                  >
                    {NOTEPAD_FONT_SIZE_OPTIONS.map((sizeValue) => (
                      <option key={`notepad-font-size-${sizeValue}`} value={sizeValue}>
                        {sizeValue}px
                      </option>
                    ))}
                  </select>
                  <input
                    type="color"
                    className="empNotepadToolColorInput"
                    value={notepadToolbarState.fontColor || NOTEPAD_TOOLBAR_DEFAULT.fontColor}
                    onMouseDown={cacheNotepadEditorSelectionRange}
                    onChange={(event) =>
                      runNotepadCommand("foreColor", event.target.value, { forceRestoreSelection: true })
                    }
                    aria-label="Font color"
                    title="Font color"
                  />
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.bold ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("bold")}
                    aria-label="Bold"
                    title="Bold text"
                  >
                    <Bold size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.italic ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("italic")}
                    aria-label="Italic"
                    title="Italic text"
                  >
                    <Italic size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.underline ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("underline")}
                    aria-label="Underline"
                    title="Underline text"
                  >
                    <Underline size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.alignLeft ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("justifyLeft")}
                    aria-label="Align left"
                    title="Align left"
                  >
                    <AlignLeft size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.alignCenter ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("justifyCenter")}
                    aria-label="Align center"
                    title="Align center"
                  >
                    <AlignCenter size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.alignRight ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("justifyRight")}
                    aria-label="Align right"
                    title="Align right"
                  >
                    <AlignRight size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.unorderedList ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("insertUnorderedList")}
                    aria-label="Bulleted list"
                    title="Bulleted list"
                  >
                    <List size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.orderedList ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("insertOrderedList")}
                    aria-label="Numbered list"
                    title="Numbered list"
                  >
                    <ListOrdered size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`empNotepadToolBtn ${notepadToolbarState.checklist ? "active" : ""}`}
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("insertChecklistItem")}
                    aria-label="Checklist item"
                    title="Checklist (convert selected lines or insert one item)"
                  >
                    <CheckSquare size={14} aria-hidden="true" />
                  </button>
                  <div className="empNotepadTablePickerHost" ref={notepadTablePickerRef}>
                    <button
                      type="button"
                      className={`empNotepadToolBtn tableAction${isNotepadTablePickerOpen ? " active" : ""}`}
                      onMouseDown={handleNotepadToolMouseDown}
                      onClick={toggleNotepadTablePicker}
                      aria-label="Insert table"
                      aria-expanded={isNotepadTablePickerOpen}
                      title="Insert table"
                    >
                      <Table2 size={14} aria-hidden="true" />
                    </button>
                    {isNotepadTablePickerOpen ? (
                      <div
                        className="empNotepadTablePickerMenu"
                        role="dialog"
                        aria-label="Select table size"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="empNotepadTablePickerGrid">
                          {Array.from({ length: NOTEPAD_TABLE_PICKER_MAX_ROWS }).map((_, rowIndex) =>
                            Array.from({ length: NOTEPAD_TABLE_PICKER_MAX_COLS }).map((__, colIndex) => {
                              const rows = rowIndex + 1;
                              const cols = colIndex + 1;
                              const isActiveCell =
                                rows <= notepadTablePickerRows && cols <= notepadTablePickerCols;
                              return (
                                <button
                                  key={`notepad-table-picker-${rows}-${cols}`}
                                  type="button"
                                  className={`empNotepadTablePickerCell${isActiveCell ? " active" : ""}`}
                                  onMouseEnter={() => {
                                    setNotepadTablePickerRows(rows);
                                    setNotepadTablePickerCols(cols);
                                  }}
                                  onFocus={() => {
                                    setNotepadTablePickerRows(rows);
                                    setNotepadTablePickerCols(cols);
                                  }}
                                  onClick={() => insertNotepadTableFromPicker(rows, cols)}
                                  aria-label={`${rows} by ${cols} table`}
                                  title={`${rows} x ${cols}`}
                                />
                              );
                            })
                          )}
                        </div>
                        <div className="empNotepadTablePickerMeta">
                          {notepadTablePickerRows} x {notepadTablePickerCols}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="empNotepadToolBtn tableAction"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("tableAddRow")}
                    aria-label="Add table row"
                    title="Add row"
                  >
                    <TableRowsSplit size={14} aria-hidden="true" />
                    <Plus size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn tableAction"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("tableDeleteRow")}
                    aria-label="Delete table row"
                    title="Delete row"
                  >
                    <TableRowsSplit size={14} aria-hidden="true" />
                    <Minus size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn tableAction"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("tableAddColumn")}
                    aria-label="Add table column"
                    title="Add column"
                  >
                    <TableColumnsSplit size={14} aria-hidden="true" />
                    <Plus size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn tableAction"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("tableDeleteColumn")}
                    aria-label="Delete table column"
                    title="Delete column"
                  >
                    <TableColumnsSplit size={14} aria-hidden="true" />
                    <Minus size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn tableAction"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("tableDelete")}
                    aria-label="Delete table"
                    title="Delete table"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("removeFormat")}
                    aria-label="Clear formatting"
                    title="Clear formatting"
                  >
                    <Eraser size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => {
                      const html = notepadEditorRef.current?.innerHTML || "";
                      setSaveAsHtml(String(html || ""));
                      setSaveAsOpen(true);
                    }}
                    aria-label="Save as"
                    title="Save as"
                  >
                    <DownloadCloud size={14} aria-hidden="true" />
                  </button>
                </div>

                <div className="empNotepadEditorWrap">
                  <div
                    ref={notepadEditorRef}
                    className="empNotepadEditor"
                    contentEditable={!notepadDisabled}
                    suppressContentEditableWarning
                    spellCheck
                    onFocus={handleNotepadEditorFocus}
                    onBlur={handleNotepadEditorBlur}
                    onKeyDown={handleNotepadEditorKeyDown}
                    onKeyUp={handleNotepadEditorKeyUp}
                    onInput={handleNotepadEditorInput}
                    onClick={handleNotepadEditorClick}
                    onMouseMove={handleNotepadEditorMouseMove}
                    onMouseDown={handleNotepadEditorMouseDown}
                    onMouseLeave={handleNotepadEditorMouseLeave}
                    onContextMenu={handleNotepadEditorContextMenu}
                    aria-label="Notepad editor"
                    aria-disabled={notepadDisabled}
                  />

                  {notepadDisabled ? (
                    <div className="empNotepadEditorOverlay" role="status" aria-live="polite">
                      <div className="empNotepadEditorOverlayInner">
                        <span>Select a Note or </span>
                            <button type="button" className="empNotepadCreateNoteBtn" onClick={handleOverlayCreateNote}>
                              CREATE A NOTE
                            </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                {portalRoot && notepadTableMoveHandleState.visible ? (
                  createPortal(
                    <button
                      type="button"
                      className="notepadTableMoveHandle"
                      style={{
                        left: `${Math.max(6, Number(notepadTableMoveHandleState.x) || 0)}px`,
                        top: `${Math.max(6, Number(notepadTableMoveHandleState.y) || 0)}px`,
                      }}
                      onMouseEnter={handleNotepadTableMoveHandleMouseEnter}
                      onMouseLeave={handleNotepadTableMoveHandleMouseLeave}
                      onMouseDown={handleNotepadTableMoveHandleMouseDown}
                      onClick={(event) => event.preventDefault()}
                      title="Drag to move table"
                      aria-label="Drag to move table"
                    >
                      ✥
                    </button>,
                    portalRoot
                  )
                ) : null}
                {portalRoot && notepadTableMenuState.open
                  ? createPortal(
                      <div
                        ref={notepadTableMenuRef}
                        className="notepadTableContextMenu"
                        style={{
                          left: `${notepadTableMenuState.x}px`,
                          top: `${notepadTableMenuState.y}px`,
                        }}
                        role="menu"
                        aria-label="Table actions"
                      >
                        <button
                          type="button"
                          className="notepadTableContextMenuItem"
                          onClick={() => runNotepadTableContextAction("tableAddRow")}
                          role="menuitem"
                        >
                          Add Row
                        </button>
                        <button
                          type="button"
                          className="notepadTableContextMenuItem"
                          onClick={() => runNotepadTableContextAction("tableDeleteRow")}
                          role="menuitem"
                        >
                          Delete Row
                        </button>
                        <button
                          type="button"
                          className="notepadTableContextMenuItem"
                          onClick={() => runNotepadTableContextAction("tableAddColumn")}
                          role="menuitem"
                        >
                          Add Column
                        </button>
                        <button
                          type="button"
                          className="notepadTableContextMenuItem"
                          onClick={() => runNotepadTableContextAction("tableDeleteColumn")}
                          role="menuitem"
                        >
                          Delete Column
                        </button>
                        <button
                          type="button"
                          className="notepadTableContextMenuItem"
                          onClick={() => runNotepadTableContextAction("tableMergeSelected")}
                          disabled={notepadTableSelectedCount < 2}
                          role="menuitem"
                        >
                          Merge Selected Cells
                        </button>
                        <button
                          type="button"
                          className="notepadTableContextMenuItem danger"
                          onClick={() => runNotepadTableContextAction("tableDelete")}
                          role="menuitem"
                        >
                          Delete Table
                        </button>
                        <div className="notepadTableContextMenuDivider" aria-hidden="true" />
                        <div className="notepadTableContextMenuLabel">Cell Color</div>
                        <div className="notepadTableColorRow" role="group" aria-label="Cell colors">
                          {[
                            "#fef3c7",
                            "#dbeafe",
                            "#dcfce7",
                            "#fee2e2",
                            "#ede9fe",
                            "#f1f5f9",
                          ].map((colorValue) => (
                            <button
                              key={`table-cell-color-${colorValue}`}
                              type="button"
                              className="notepadTableColorSwatch"
                              style={{ backgroundColor: colorValue }}
                              onClick={() => runNotepadTableContextAction("tableSetCellColor", colorValue)}
                              title={`Set cell color ${colorValue}`}
                              aria-label={`Set cell color ${colorValue}`}
                            />
                          ))}
                          <button
                            type="button"
                            className="notepadTableColorResetBtn"
                            onClick={() => runNotepadTableContextAction("tableClearCellColor")}
                            title="Clear cell color"
                            aria-label="Clear cell color"
                          >
                            Clear
                          </button>
                        </div>
                      </div>,
                      portalRoot
                    )
                  : null}
              </section>
            </div>
          </div>
                </>,
                portalRoot
              )
            : null}

          <div className="agentAttendancePanel callActivityLeaderboardPanel">
            <div className="agentAttendancePanelTop">
              <div className="agentAttendancePanelHead">
                Call / Activity Leaderboard
              </div>
              <div className="agentAttendanceMonthFilter">
                <label htmlFor="employee-call-activity-leaderboard-month-filter">Month</label>
                <select
                  id="employee-call-activity-leaderboard-month-filter"
                  className="agentAttendanceMonthSelect"
                  value={effectiveSelectedCallActivityLeaderboardMonth}
                  onChange={(event) => setSelectedCallActivityLeaderboardMonth(event.target.value)}
                >
                  {availableCallActivityLeaderboardMonths.length ? (
                    availableCallActivityLeaderboardMonths.map((monthKey) => (
                      <option key={`call-activity-leaderboard-month-${monthKey}`} value={monthKey}>
                        {prettyMonthLabel(monthKey)}
                      </option>
                    ))
                  ) : (
                    <option value={effectiveSelectedCallActivityLeaderboardMonth}>
                      {prettyMonthLabel(effectiveSelectedCallActivityLeaderboardMonth)}
                    </option>
                  )}
                </select>
              </div>
            </div>

            {callActivityLeaderboardLoading ? (
              <div className="agentAttendanceEmpty">Loading call activity leaderboard...</div>
            ) : callActivityLeaderboardError ? (
              <div className="agentAttendanceEmpty">{callActivityLeaderboardError}</div>
            ) : callActivityLeaderboard.length === 0 ? (
              <div className="agentAttendanceEmpty">No call or activity logs for this month.</div>
            ) : (
              <div className="callActivityLeaderboardStrip">
                {callActivityLeaderboard.map((agent) => (
                  <div
                    className={`callActivityLeaderboardItem ${agent.isSelected ? "isSelected" : ""}`}
                    key={`call-activity-leader-${agent.key}`}
                  >
                    <div
                      className="callActivityLeaderboardBars"
                      title={`${agent.name}: ${numberFmt.format(agent.count)} count, ${agent.entries} entries`}
                    >
                      <div className="callActivityLeaderboardBarsTop">
                        <div className="callActivityLeaderboardRank">#{agent.rank}</div>
                        {agent.isSelected ? <div className="callActivityLeaderboardYou">You</div> : null}
                      </div>
                      <div className="callActivityLeaderboardBarGroup">
                        <div
                          className="callActivityLeaderboardBar isCount"
                          style={{ "--barPct": `${agent.countPercent}%` }}
                        >
                          <span>{numberFmt.format(agent.count)}</span>
                          <i aria-hidden="true" />
                          <em>Count</em>
                        </div>
                        <div
                          className="callActivityLeaderboardBar isHours"
                          style={{ "--barPct": `${agent.hoursPercent}%` }}
                        >
                          <span>{numberFmt.format(agent.hours)}hrs</span>
                          <i aria-hidden="true" />
                          <em>Hours</em>
                        </div>
                        <div
                          className="callActivityLeaderboardBar isEntries"
                          style={{ "--barPct": `${agent.entriesPercent}%` }}
                        >
                          <span>{agent.entries}</span>
                          <i aria-hidden="true" />
                          <em>Entries</em>
                        </div>
                      </div>
                    </div>
                    <div className="callActivityLeaderboardAvatar">
                      {agent.profileImageUrl ? (
                        <img src={agent.profileImageUrl} alt={`${agent.name} profile`} />
                      ) : (
                        <span>{agent.initials}</span>
                      )}
                    </div>
                    <div className="callActivityLeaderboardName">{agent.name}</div>
                    <div className="callActivityLeaderboardMeta">
                      {numberFmt.format(agent.count)} count • {agent.entries} entries • {numberFmt.format(agent.hours)}hrs
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <section className="callActivityPanel" aria-label="Call activity input">
            <div className="callActivityPanelHead">
              <div>
                <div className="callActivityKickerRow">
                  <div className="callActivityKicker">Client portal activity tracker</div>
                  <button
                    type="button"
                    className="callActivityHelpTip"
                    aria-label="Call activity tracker help"
                  >
                    ?
                    <span role="tooltip">
                      Enter start and end time only. Total hours are calculated automatically.
                      Count is the number of calls, bookings, virtuals, or outputs completed in that time block.
                    </span>
                  </button>
                </div>
                <h3><PhoneCall size={18} aria-hidden="true" /> Call / Activity Log</h3>
              </div>
              <div className="callActivityDurationPreview">
                <span>Auto duration</span>
                <strong>{formatDuration(callActivityDurationMinutes)}</strong>
              </div>
            </div>

            <form className="callActivityForm" onSubmit={handleSubmitCallActivity} noValidate>
              <label>
                <span>Date</span>
                <input
                  ref={(node) => {
                    callActivityFieldRefs.current.entryDate = node;
                  }}
                  type="date"
                  value={callActivityForm.entryDate}
                  onChange={(e) => updateCallActivityForm("entryDate", e.target.value)}
                  required
                />
              </label>
              {renderCallActivityTimeField("startTime", "Start time")}
              {renderCallActivityTimeField("endTime", "End time")}
              <label>
                <span>Activity type</span>
                <select
                  ref={(node) => {
                    callActivityFieldRefs.current.activityType = node;
                  }}
                  value={callActivityForm.activityType}
                  onChange={(e) => updateCallActivityForm("activityType", e.target.value)}
                  required
                >
                  {CALL_ACTIVITY_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Count</span>
                <input
                  ref={(node) => {
                    callActivityFieldRefs.current.count = node;
                  }}
                  type="number"
                  min="0"
                  step="1"
                  value={callActivityForm.count}
                  onChange={(e) => updateCallActivityForm("count", e.target.value)}
                  required
                />
              </label>
              <label className="callActivityNotesField">
                <span>Notes / what the call was about</span>
                <textarea
                  value={callActivityForm.notes}
                  onChange={(e) => updateCallActivityForm("notes", e.target.value)}
                  placeholder="Example: outbound follow-ups, inbound support calls, booked appointment, training, admin work..."
                  rows={3}
                />
              </label>
              <div className="callActivityActions">
                {callActivityStatus.message ? (
                  <div className={`callActivityStatus ${callActivityStatus.type}`}>
                    {callActivityStatus.message}
                  </div>
                ) : (
                  <div className="callActivityHelp">Saved rows go to Firestore collection: callActivityLogs.</div>
                )}
                <button type="submit" disabled={callActivitySaving || !employee}>
                  {callActivitySaving ? "Saving..." : "Save Activity"}
                </button>
              </div>
            </form>
          </section>

          <section className="callActivityRecentPanel" aria-label="Recent call activity logs">
            <div className="callActivityRecentHead">
              <div>
                <h3>Recent activity logs</h3>
                <span>Only showing logs for {getDisplayName(employee) || "this employee"}</span>
              </div>
              <div className="callActivityRecentPager">
                <button
                  type="button"
                  onClick={() => setCallActivityRecentPage((page) => Math.max(0, page - 1))}
                  disabled={safeCallActivityRecentPage <= 0}
                  aria-label="Previous activity logs page"
                >
                  ‹
                </button>
                <span>
                  Showing {callActivityRecentRangeStart}-{callActivityRecentRangeEnd} of{" "}
                  {selectedEmployeeActivityRows.length} row(s)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setCallActivityRecentPage((page) => Math.min(callActivityRecentPageCount - 1, page + 1))
                  }
                  disabled={safeCallActivityRecentPage >= callActivityRecentPageCount - 1}
                  aria-label="Next activity logs page"
                >
                  ›
                </button>
              </div>
            </div>

            {callActivityLeaderboardLoading ? (
              <div className="callActivityRecentEmpty">Loading recent activity logs...</div>
            ) : callActivityLeaderboardError ? (
              <div className="callActivityRecentEmpty error">{callActivityLeaderboardError}</div>
            ) : callActivityRecentRows.length === 0 ? (
              <div className="callActivityRecentEmpty">No activity logs saved for this employee yet.</div>
            ) : (
              <div className="callActivityRecentTableWrap">
                <table className="callActivityRecentTable">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Duration</th>
                      <th>Type</th>
                      <th>Count</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {callActivityRecentRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.entryDate || "-"}</td>
                        <td>{row.startTime || "-"}</td>
                        <td>{row.endTime || "-"}</td>
                        <td>{formatDuration(row.durationMinutes)}</td>
                        <td>{row.activityType || "-"}</td>
                        <td>{numberFmt.format(Number(row.count) || 0)}</td>
                        <td>{row.notes || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {selectedAnnouncement && portalRoot
            ? createPortal(
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
                </div>,
                portalRoot
              )
            : null}

          <ConfirmModal
            open={isDashboardUnpinConfirmOpen}
            title="Unpin Note?"
            message={`Unpin "${toText(topDashboardImportantNote?.title) || "this note"}"?`}
            confirmText="Unpin"
            tone="danger"
            busy={dashboardUnpinBusy}
            onCancel={() => {
              if (dashboardUnpinBusy) return;
              setIsDashboardUnpinConfirmOpen(false);
            }}
            onConfirm={confirmDashboardUnpin}
          />

          <ConfirmModal
            open={!!notepadExitGuardState.open}
            title="Save Notepad Changes?"
            message="Your notepad changes are saved locally in this browser. Save them to the database before leaving, or continue editing."
            confirmText="Save Changes"
            cancelText="Continue Editing"
            tone="primary"
            busy={notepadExitGuardBusy || savingNotepadNote}
            onCancel={continueEditingNotepadDraft}
            onConfirm={saveAndContinueNotepadDraftTransition}
          />

          <ConfirmModal
            open={!!notepadConfirmState.open}
            title={notepadConfirmConfig.title}
            message={notepadConfirmConfig.message}
            confirmText={notepadConfirmConfig.confirmText}
            tone={notepadConfirmConfig.tone}
            busy={notepadConfirmBusy}
            onCancel={closeNotepadConfirm}
            onConfirm={confirmNotepadAction}
          />

          <ConfirmModal
            open={!!employeeProcessConfirmAction}
            title={employeeProcessConfirmTitle}
            message={employeeProcessConfirmMessage}
            confirmText={employeeProcessConfirmButtonText}
            cancelText="Cancel"
            tone="primary"
            busy={!!employeeProcessBusy}
            onCancel={cancelEmployeeProcessFinish}
            onConfirm={confirmEmployeeProcessFinish}
          />

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
          <SaveAsModal open={saveAsOpen} html={saveAsHtml} onClose={() => setSaveAsOpen(false)} />
        </>
      )}
      </div>

      {showEmployeeProcessActionModal && portalRoot
        ? createPortal(
            <div className="employeeLeadFloatingModal" role="region" aria-label="IB and NL advance actions">
              <div className="employeeLeadFloatingHead">
                <span>Current turn</span>
                <strong>{employeeProcessActionEmployee?.name || "Your row"}</strong>
              </div>
              <div className="employeeLeadFloatingMarks">
                {employeeProcessActionUserId === effectiveIbUserId ? (
                  <button
                    type="button"
                    className="employeeLeadFloatingBtn isIb"
                    onClick={() => requestEmployeeProcessFinish("ib", employeeProcessActionUserId)}
                    disabled={employeeProcessBusy === "ib"}
                  >
                    <span>IB</span>
                    {employeeProcessBusy === "ib" ? "Finishing..." : "Finish Inbound"}
                  </button>
                ) : null}
                {employeeProcessActionUserId === effectiveNlUserId ? (
                  <button
                    type="button"
                    className="employeeLeadFloatingBtn isNl"
                    onClick={() => requestEmployeeProcessFinish("nl", employeeProcessActionUserId)}
                    disabled={employeeProcessBusy === "nl"}
                  >
                    <span>NL</span>
                    {employeeProcessBusy === "nl" ? "Finishing..." : "Finish new lead"}
                  </button>
                ) : null}
              </div>
            </div>,
            portalRoot
          )
        : null}

      {breakLoading ? (
        <div className="breakSavingOverlay" role="status" aria-live="polite" aria-label="Saving break status">
          <div className="breakSavingSpinner" aria-hidden="true" />
          <div className="breakSavingText">
            {isOnBreak ? "Saving break..." : "Saving break..."}
          </div>
        </div>
      ) : null}
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
