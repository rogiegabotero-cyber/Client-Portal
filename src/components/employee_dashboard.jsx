import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./employee_dashboard.css";
import {
  startBreak,
  endBreak,
  DAILY_BREAK_LIMIT_MINUTES,
  calculateBreakUsageMinutes,
  getBreakLogsByUserIdsInRange,
} from "../services/breakService";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  Eraser,
  FileText,
  Italic,
  List,
  ListOrdered,
  RotateCcw,
  Trash2,
  Underline,
  Users,
} from "lucide-react";
import ConfirmModal from "./ConfirmModal";
import { db } from "../firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
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
  early: 1.2,
  onTime: 1.0,
  late: 0.35,
  pto: 0.75,
  absent: 0.05,
  ncns: 0,
});

const ATTENDANCE_SCORE_BEST_DAY_POINTS = 1.2;
const AGENT_ATTENDANCE_MONTH_ALL = "ALL";
const AGENT_DONUTS_PREVIEW = 24;
const EMPLOYEE_NOTEPAD_COLLECTION = "employee_notepad_notes";
const NOTIFICATIONS_COLLECTION = "break_notifications";
const EMPTY_NOTEPAD_HTML = '<p><br></p>';
const NOTEPAD_VIEW_MY = "my";
const NOTEPAD_VIEW_GROUP = "group";
const NOTEPAD_VIEW_BIN = "bin";
const NOTEPAD_DOCS_CACHE_BY_EMPLOYEE = new Map();
const NOTEPAD_NOTIFICATION_EVENT_CACHE = new Set();

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

const mapNotepadDocToRow = (noteDoc, fallbackEmployeeUserId = "") => {
  const data = noteDoc?.data?.() || {};
  const createdAtMs = toMillis(data.createdAt);
  const updatedAtMs = toMillis(data.updatedAt);
  const deadlineAtMs = toMillis(data.deadlineAt);
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
    deadlineAt: data.deadlineAt || null,
    deadlineAtMs: Number.isFinite(deadlineAtMs) ? deadlineAtMs : NaN,
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

  return wrapper.innerHTML;
};

const serializeNotepadEditorHtml = (editorEl, fallbackHtml = "") => {
  const rawHtml = String(editorEl?.innerHTML || fallbackHtml || "");
  const checkedStates = Array.from(editorEl?.querySelectorAll?.('input[type="checkbox"]') || []).map(
    (checkbox) => !!checkbox?.checked
  );
  return persistChecklistStateInHtml(rawHtml, checkedStates);
};

const stripHtmlForPreview = (html = "") =>
  String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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
    return '<p class="notepad-check-item"><input type="checkbox" contenteditable="false" /> Checklist item</p>';
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
  const [isBreakLogsDrawerOpen, setIsBreakLogsDrawerOpen] = useState(false);
  const [breakLogFilter, setBreakLogFilter] = useState("thisWeek");
  const [breakLogRows, setBreakLogRows] = useState([]);
  const [breakLogLoading, setBreakLogLoading] = useState(false);
  const [breakLogError, setBreakLogError] = useState("");
  const [breakLogRefreshToken, setBreakLogRefreshToken] = useState(0);
  const [selectedAgentAttendanceMonth, setSelectedAgentAttendanceMonth] = useState(
    AGENT_ATTENDANCE_MONTH_ALL
  );
  const [showAllAgentRates, setShowAllAgentRates] = useState(false);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const [selectedAnnouncement, setSelectedAnnouncement] = useState(null);
  const [isNotepadDrawerOpen, setIsNotepadDrawerOpen] = useState(false);
  const [notepadViewMode, setNotepadViewMode] = useState(NOTEPAD_VIEW_MY);
  const [notepadNotes, setNotepadNotes] = useState([]);
  const [notepadTrashedNotes, setNotepadTrashedNotes] = useState([]);
  const [notepadIconCount, setNotepadIconCount] = useState(0);
  const [notepadIconNoteMetaList, setNotepadIconNoteMetaList] = useState([]);
  const [notepadLoading, setNotepadLoading] = useState(false);
  const [notepadError, setNotepadError] = useState("");
  const [selectedNotepadNoteId, setSelectedNotepadNoteId] = useState("");
  const [notepadCompletingNoteId, setNotepadCompletingNoteId] = useState("");
  const [notepadTitleDraft, setNotepadTitleDraft] = useState("");
  const [notepadDeadlineDraft, setNotepadDeadlineDraft] = useState("");
  const [notepadContentDraft, setNotepadContentDraft] = useState(EMPTY_NOTEPAD_HTML);
  const [notepadDirty, setNotepadDirty] = useState(false);
  const [savingNotepadNote, setSavingNotepadNote] = useState(false);
  const [notepadStatusText, setNotepadStatusText] = useState("");
  const [notepadTrashingNoteId, setNotepadTrashingNoteId] = useState("");
  const [notepadBinActionNoteId, setNotepadBinActionNoteId] = useState("");
  const [isNotepadGroupCreatorOpen, setIsNotepadGroupCreatorOpen] = useState(false);
  const [creatingGroupNotepadNote, setCreatingGroupNotepadNote] = useState(false);
  const [notepadGroupMemberDraft, setNotepadGroupMemberDraft] = useState([]);
  const [notepadConfirmState, setNotepadConfirmState] = useState({
    open: false,
    mode: "",
    note: null,
  });
  const [notepadConfirmBusy, setNotepadConfirmBusy] = useState(false);
  const taskFilterDrawerRef = useRef(null);
  const taskFilterMenuRef = useRef(null);
  const notepadEditorRef = useRef(null);
  const notepadDueSoonNotifyInFlightRef = useRef(new Set());
  const notepadNotificationEventCacheRef = useRef(NOTEPAD_NOTIFICATION_EVENT_CACHE);

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
      const userId = String(getUserId(employee) ?? effectiveSelectedId ?? "").trim();
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

      setBreakLogRefreshToken((prev) => prev + 1);
    } catch (err) {
      const rawMessage = String(err?.message || "").trim();
      const normalizedMessage = rawMessage.toLowerCase();
      const hasBreakStateMismatch =
        normalizedMessage.includes("already has an active break") ||
        normalizedMessage.includes("no active break found");

      if (hasBreakStateMismatch && typeof onBreakStatusChanged === "function") {
        try {
          await onBreakStatusChanged();
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

  const syncNotepadDraftFromEditor = useCallback(() => {
    if (!notepadEditorRef.current) return;
    setNotepadStatusText("");
    setNotepadDirty(true);
    setNotepadContentDraft(notepadEditorRef.current.innerHTML || EMPTY_NOTEPAD_HTML);
  }, []);

  const runNotepadCommand = useCallback(
    (command, value = null) => {
      if (!notepadEditorRef.current || typeof document === "undefined") return;
      notepadEditorRef.current.focus();

      if (command === "insertChecklistItem") {
        const converted = convertSelectionLinesToChecklist(notepadEditorRef.current);
        if (!converted) {
          document.execCommand(
            "insertHTML",
            false,
            '<p class="notepad-check-item"><input type="checkbox" contenteditable="false" /> Checklist item</p>'
          );
        }
      } else if (command === "justifyLeft" || command === "justifyCenter" || command === "justifyRight") {
        document.execCommand("styleWithCSS", false, true);
        document.execCommand(command, false, null);
        document.execCommand("styleWithCSS", false, false);
      } else {
        document.execCommand(command, false, value);
      }

      syncNotepadDraftFromEditor();
    },
    [syncNotepadDraftFromEditor]
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
      const mergedDocs = Array.from(docsById.values());
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
        setNotepadTitleDraft("");
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
          const requested = String(preferredNoteId || current || "");
          const selectableRows =
            String(notepadViewMode || "") === NOTEPAD_VIEW_GROUP
              ? activeRows.filter((row) => normalizeNotepadScope(row?.noteScope) === "group")
              : activeRows.filter((row) => normalizeNotepadScope(row?.noteScope) !== "group");
          if (requested && selectableRows.some((row) => row.id === requested)) return requested;
          return selectableRows[0]?.id || "";
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
    setNotepadViewMode(NOTEPAD_VIEW_MY);
    setIsNotepadGroupCreatorOpen(false);
    setNotepadGroupMemberDraft([]);
    setSelectedNotepadNoteId("");
    setNotepadTitleDraft("");
    setNotepadDeadlineDraft("");
    setNotepadContentDraft(EMPTY_NOTEPAD_HTML);
    setNotepadDirty(false);
    setNotepadStatusText("New note ready.");
    setNotepadError("");
    if (notepadEditorRef.current) {
      notepadEditorRef.current.innerHTML = EMPTY_NOTEPAD_HTML;
      notepadEditorRef.current.focus();
    }
  }, []);

  const openCreateGroupNotepad = useCallback(() => {
    const selectedEmployeeUserId = String(effectiveSelectedId || "").trim();
    if (!selectedEmployeeUserId) {
      setNotepadError("Please select an employee before creating a group note.");
      return;
    }

    const defaultMemberIds = sanitizeNotepadMemberUserIds([selectedEmployeeUserId]);
    setNotepadViewMode(NOTEPAD_VIEW_GROUP);
    setSelectedNotepadNoteId("");
    setNotepadTitleDraft("");
    setNotepadDeadlineDraft("");
    setNotepadContentDraft(EMPTY_NOTEPAD_HTML);
    setNotepadDirty(false);
    setNotepadStatusText("");
    setNotepadError("");
    setNotepadGroupMemberDraft(defaultMemberIds);
    setIsNotepadGroupCreatorOpen(true);
  }, [effectiveSelectedId]);

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
        contentHtml: EMPTY_NOTEPAD_HTML,
        deadlineAt: null,
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
    if (savingNotepadNote) return;

    const employeeUserId = String(effectiveSelectedId || "").trim();
    if (!employeeUserId) return;
    if (!selectedNotepadNoteId && String(notepadViewMode || "") === NOTEPAD_VIEW_GROUP) {
      setNotepadError("Use + Create Group Note to start a shared note.");
      return;
    }

    const editorHtml = notepadEditorRef.current?.innerHTML || notepadContentDraft || EMPTY_NOTEPAD_HTML;
    const persistedHtml = serializeNotepadEditorHtml(notepadEditorRef.current, editorHtml);
    const finalContentHtml = String(persistedHtml || "").trim() || EMPTY_NOTEPAD_HTML;
    const finalTitle = toText(notepadTitleDraft) || "Untitled note";
    const deadlineMs = parseLocalDateTimeInputMs(notepadDeadlineDraft);
    const deadlineAtValue = Number.isFinite(deadlineMs) ? new Date(deadlineMs) : null;
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
          contentHtml: finalContentHtml,
          deadlineAt: deadlineAtValue,
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
          contentHtml: finalContentHtml,
          deadlineAt: deadlineAtValue,
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

      setNotepadDirty(false);
      setNotepadTitleDraft(finalTitle);
      setNotepadDeadlineDraft(toLocalDateTimeInputValue(deadlineAtValue));
      setNotepadContentDraft(finalContentHtml);
      if (notepadEditorRef.current) {
        notepadEditorRef.current.innerHTML = finalContentHtml;
      }
      setNotepadStatusText("Saved.");
      await refreshNotepadIconMeta({ force: true });
      await loadNotepadNotes(keepSelectedId, { force: true });
    } catch (err) {
      setNotepadError(err?.message || "Failed to save note.");
    } finally {
      setSavingNotepadNote(false);
    }
  }, [
    savingNotepadNote,
    effectiveSelectedId,
    notepadContentDraft,
    notepadDeadlineDraft,
    notepadTitleDraft,
    viewerUserId,
    selectedNotepadNoteId,
    notepadViewMode,
    selectedNotepadNote,
    employee,
    resolveNotepadMemberProfiles,
    refreshNotepadIconMeta,
    loadNotepadNotes,
  ]);

  useEffect(() => {
    if (!isNotepadDrawerOpen) return;
    loadNotepadNotes();
  }, [isNotepadDrawerOpen, loadNotepadNotes]);

  useEffect(() => {
    if (notepadMetaLoadedRef.current) return;
    notepadMetaLoadedRef.current = true;
    refreshNotepadIconMeta();
  }, [refreshNotepadIconMeta]);

  useEffect(() => {
    if (!isNotepadDrawerOpen) return;

    if (!selectedNotepadNote) {
      setNotepadTitleDraft("");
      setNotepadDeadlineDraft("");
      setNotepadContentDraft(EMPTY_NOTEPAD_HTML);
      setNotepadDirty(false);
      if (notepadEditorRef.current) notepadEditorRef.current.innerHTML = EMPTY_NOTEPAD_HTML;
      return;
    }

    setNotepadTitleDraft(toText(selectedNotepadNote.title) || "Untitled note");
    setNotepadDeadlineDraft(toLocalDateTimeInputValue(selectedNotepadNote.deadlineAt));
    setNotepadContentDraft(String(selectedNotepadNote.contentHtml || EMPTY_NOTEPAD_HTML));
    setNotepadDirty(false);
  }, [isNotepadDrawerOpen, selectedNotepadNote]);

  useEffect(() => {
    if (!isNotepadDrawerOpen || !notepadEditorRef.current) return;
    const nextContent = String(notepadContentDraft || EMPTY_NOTEPAD_HTML);
    if (notepadEditorRef.current.innerHTML !== nextContent) {
      notepadEditorRef.current.innerHTML = nextContent;
    }
  }, [isNotepadDrawerOpen, notepadContentDraft]);

  useEffect(() => {
    if (!isNotepadDrawerOpen) return;
    if (String(notepadViewMode || "") === NOTEPAD_VIEW_BIN) return;
    if (!notepadDirty) return;
    if (savingNotepadNote) return;

    const autosaveTimerId = window.setTimeout(() => {
      saveNotepadNote();
    }, 30000);

    return () => {
      window.clearTimeout(autosaveTimerId);
    };
  }, [
    isNotepadDrawerOpen,
    notepadViewMode,
    notepadDirty,
    savingNotepadNote,
    notepadTitleDraft,
    notepadDeadlineDraft,
    notepadContentDraft,
    saveNotepadNote,
  ]);

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

    for (const emp of Array.isArray(employees) ? employees : []) {
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
  }, [employees, historyByUserId, logsByUserId, businessTimeZone]);

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

    const rows = (Array.isArray(employees) ? employees : []).map((emp, index) => {
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
      const rate =
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
        tooltipSummary: `${tooltipSummary} | Score model: Early/On Time up, Late/Absent/NCNS down`,
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
    employees,
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
  const closeBreakLogsDrawer = () => setIsBreakLogsDrawerOpen(false);
  const closeNotepadDrawer = () => {
    setNotepadConfirmState({
      open: false,
      mode: "",
      note: null,
    });
    setNotepadConfirmBusy(false);
    setNotepadViewMode(NOTEPAD_VIEW_MY);
    setIsNotepadGroupCreatorOpen(false);
    setNotepadGroupMemberDraft([]);
    setIsNotepadDrawerOpen(false);
  };
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
  const notepadNoteCount = notepadPersonalNotes.length;
  const notepadGroupNoteCount = notepadGroupNotes.length;
  const notepadTrashedNoteCount = Array.isArray(notepadTrashedNotes) ? notepadTrashedNotes.length : 0;
  const notepadIconBadgeLabel = notepadIconCount > 99 ? "99+" : String(Math.max(0, notepadIconCount));
  const notepadGroupMemberSelectionCount = sanitizeNotepadMemberUserIds(notepadGroupMemberDraft).length;
  const isNotepadPersonalNewMode =
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

  const handleNotepadToolMouseDown = (event) => {
    event.preventDefault();
  };
  const handleNotepadEditorInput = () => {
    syncNotepadDraftFromEditor();
  };
  const handleNotepadEditorClick = (event) => {
    if (event?.target?.tagName !== "INPUT") return;
    const input = event.target;
    if (String(input?.type || "").toLowerCase() !== "checkbox") return;
    window.requestAnimationFrame(() => {
      syncNotepadDraftFromEditor();
    });
  };

  useEffect(() => {
    if (!isBreakLogsDrawerOpen && !isNotepadDrawerOpen) return;

    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (isNotepadDrawerOpen) {
        setIsNotepadGroupCreatorOpen(false);
        setNotepadGroupMemberDraft([]);
        setNotepadViewMode(NOTEPAD_VIEW_MY);
        setIsNotepadDrawerOpen(false);
      }
      if (isBreakLogsDrawerOpen) setIsBreakLogsDrawerOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isBreakLogsDrawerOpen, isNotepadDrawerOpen]);

  return (
    <div className="empDash">
      <div className={`empDashShell ${breakLoading ? "isBreakSaving" : ""}`} aria-busy={breakLoading}>
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
                  onClick={() => {
                    setIsNotepadDrawerOpen(false);
                    setBreakLogFilter("thisWeek");
                    setIsBreakLogsDrawerOpen(true);
                  }}
                >
                  Break Logs
                </button>
                <button
                  type="button"
                  className={`empNotepadBtn ${notepadHasDueSoonNote ? "isDueSoon" : ""}`}
                  onClick={() => {
                    setIsBreakLogsDrawerOpen(false);
                    setNotepadViewMode(NOTEPAD_VIEW_MY);
                    setIsNotepadDrawerOpen(true);
                  }}
                  title={
                    notepadHasDueSoonNote
                      ? "Open notepad (urgent deadline note detected)"
                      : "Open notepad"
                  }
                  aria-label={`Open notepad (${notepadIconCount} notes)`}
                >
                  <FileText size={14} aria-hidden="true" />
                  {notepadIconCount > 0 ? (
                    <span className="empNotepadBtnCount" aria-hidden="true">
                      {notepadIconBadgeLabel}
                    </span>
                  ) : null}
                </button>
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
                      className={`breakBtn ${isOnBreak ? "back" : "break"} ${
                        isOnBreak && breakMinutesLeft <= 0 && !breakLoading ? "limit-pulse" : ""
                      }`}
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
                              <span>{formatAnnouncementDate(item.createdAtMs)}</span>
                              <span className="announcementAuthor">{item.createdBy}</span>
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

          <div className="agentAttendancePanel">
            <div className="agentAttendancePanelTop">
              <div className="agentAttendancePanelHead">
                Best Attendance Per Employee (Early/On Time weighted, Late/Absent lower score)
              </div>
              <div className="agentAttendanceMonthFilter">
                <label htmlFor="employee-agent-attendance-month-filter">Month</label>
                <select
                  id="employee-agent-attendance-month-filter"
                  className="agentAttendanceMonthSelect"
                  value={effectiveSelectedAgentAttendanceMonth}
                  onChange={(e) => setSelectedAgentAttendanceMonth(e.target.value)}
                >
                  <option value={AGENT_ATTENDANCE_MONTH_ALL}>All months</option>
                  {availableAgentAttendanceMonths.map((monthKey) => (
                    <option key={`emp-agent-att-month-${monthKey}`} value={monthKey}>
                      {prettyMonthLabel(monthKey)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="agentAttendanceLegend">
              {ATTENDANCE_BUCKETS.map((item) => (
                <span key={`emp-agent-legend-${item.key}`} className="agentAttendanceLegendItem">
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
                  {visibleAgentAttendanceRates.map((agent, index) => (
                    <div
                      key={`emp-agent-att-${agent.userId || `${agent.name}-${index}`}`}
                      className="agentAttendanceItem"
                      title={`Score: ${agent.rate}% | ${agent.tooltipSummary}`}
                    >
                      <div className="agentAttendanceDonut" style={{ background: agent.pieBackground }}>
                        <div className="agentAttendanceCenter">{agent.rate}%</div>
                      </div>
                      <div className="agentAttendanceName">{agent.shortName}</div>
                    </div>
                  ))}
                </div>

                {hiddenAgentAttendanceRates > 0 ? (
                  <div className="agentAttendanceFoot">
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
                          setNotepadViewMode(NOTEPAD_VIEW_GROUP);
                          setIsNotepadGroupCreatorOpen(false);
                          setSelectedNotepadNoteId("");
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
                          setNotepadViewMode(NOTEPAD_VIEW_MY);
                          setIsNotepadGroupCreatorOpen(false);
                          setSelectedNotepadNoteId("");
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
                          setNotepadViewMode(NOTEPAD_VIEW_BIN);
                          setIsNotepadGroupCreatorOpen(false);
                          setSelectedNotepadNoteId("");
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

                <div className="empNotepadList">
                  {!notepadLoading &&
                  (isNotepadRecycleBinView ? notepadTrashedNotes.length === 0 : visibleNotepadActiveNotes.length === 0) ? (
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
                    visibleNotepadActiveNotes.map((note) => {
                      const noteId = String(note?.id || "");
                      const noteTitle = toText(note?.title) || "Untitled note";
                      const preview =
                        stripHtmlForPreview(note?.contentHtml) || "No content yet.";
                      const isActive = noteId === String(selectedNotepadNoteId || "");
                      const isCompleted = !!note?.isCompleted;
                      const deadlineTone = isCompleted
                        ? "completed"
                        : getNotepadDeadlineTone(note?.deadlineAtMs, nowMsForNotepad);
                      const deadlineLabel = isCompleted
                        ? `Completed: ${formatNotepadDateLabel(
                            note?.completedAt || note?.updatedAt || note?.createdAt
                          )}`
                        : formatNotepadDeadlineLabel(note?.deadlineAtMs, deadlineTone);
                      const updatedAtValue = note?.updatedAt || note?.createdAt || null;
                      const isTogglingComplete = noteId === String(notepadCompletingNoteId || "");
                      const isTrashing = noteId === String(notepadTrashingNoteId || "");
                      const groupMembers = getNotepadGroupMembers(note);

                      return (
                        <div
                          key={noteId}
                          className={`empNotepadListItem deadline-${deadlineTone} ${isCompleted ? "completed" : ""} ${isActive ? "active" : ""}`}
                        >
                          <button
                            type="button"
                            className="empNotepadListItemMain"
                            onClick={() => setSelectedNotepadNoteId(noteId)}
                            disabled={savingNotepadNote}
                          >
                            <div className="empNotepadListItemTitle">{noteTitle}</div>
                            <div className="empNotepadListItemPreview">{preview}</div>
                            <div className={`empNotepadListItemDeadline deadline-${deadlineTone}`}>
                              {deadlineLabel}
                            </div>
                            <div className="empNotepadListItemDate">
                              Updated: {formatNotepadDateLabel(updatedAtValue)}
                            </div>
                          </button>
                          <div className="empNotepadCardActions">
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
                              className="empNotepadTrashBtn"
                              onClick={() => openNotepadConfirm("trash", note)}
                              disabled={
                                savingNotepadNote ||
                                isTogglingComplete ||
                                isTrashing ||
                                !!notepadBinActionNoteId
                              }
                              title="Move to recycle bin"
                              aria-label="Move note to recycle bin"
                            >
                              {isTrashing ? "..." : <Trash2 size={13} aria-hidden="true" />}
                            </button>
                            <button
                              type="button"
                              className={`empNotepadCompleteBtn ${isCompleted ? "done" : ""}`}
                              onClick={() => toggleNotepadNoteCompleted(note)}
                              disabled={
                                savingNotepadNote ||
                                isTogglingComplete ||
                                isTrashing ||
                                !!notepadBinActionNoteId
                              }
                              title={isCompleted ? "Mark as active" : "Mark as complete"}
                              aria-label={isCompleted ? "Mark note as active" : "Mark note as complete"}
                            >
                              {isTogglingComplete ? (
                                "..."
                              ) : isCompleted ? (
                                <RotateCcw size={13} aria-hidden="true" />
                              ) : (
                                <CheckSquare size={13} aria-hidden="true" />
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })
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
                    >
                      Clear
                    </button>
                  </div>
                  <div className="empNotepadEditorActions">
                    <span className={`empNotepadSaveState ${notepadDirty ? "dirty" : ""}`}>
                      {savingNotepadNote
                        ? "Saving..."
                        : notepadStatusText || (notepadDirty ? "Unsaved changes" : "Saved")}
                    </span>
                    <button
                      type="button"
                      className="empNotepadSaveBtn"
                      onClick={saveNotepadNote}
                      disabled={savingNotepadNote}
                    >
                      Save
                    </button>
                  </div>
                </div>

                <div className="empNotepadToolbar" role="toolbar" aria-label="Notepad formatting toolbar">
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("bold")}
                    aria-label="Bold"
                    title="Bold text"
                  >
                    <Bold size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("italic")}
                    aria-label="Italic"
                    title="Italic text"
                  >
                    <Italic size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("underline")}
                    aria-label="Underline"
                    title="Underline text"
                  >
                    <Underline size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("justifyLeft")}
                    aria-label="Align left"
                    title="Align left"
                  >
                    <AlignLeft size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("justifyCenter")}
                    aria-label="Align center"
                    title="Align center"
                  >
                    <AlignCenter size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("justifyRight")}
                    aria-label="Align right"
                    title="Align right"
                  >
                    <AlignRight size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("insertUnorderedList")}
                    aria-label="Bulleted list"
                    title="Bulleted list"
                  >
                    <List size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("insertOrderedList")}
                    aria-label="Numbered list"
                    title="Numbered list"
                  >
                    <ListOrdered size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="empNotepadToolBtn"
                    onMouseDown={handleNotepadToolMouseDown}
                    onClick={() => runNotepadCommand("insertChecklistItem")}
                    aria-label="Checklist item"
                    title="Checklist (convert selected lines or insert one item)"
                  >
                    <CheckSquare size={14} aria-hidden="true" />
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
                </div>

                <div
                  ref={notepadEditorRef}
                  className="empNotepadEditor"
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck
                  onInput={handleNotepadEditorInput}
                  onClick={handleNotepadEditorClick}
                  aria-label="Notepad editor"
                />
              </section>
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

