import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";

import Header from "./header/header";
import Sidebar from "./header/Sidebar";

import SchedulePage from "./components/SchedulePage";
import AttendancePage from "./components/AttendancePage";
import Dashboard from "./components/dashboard";
import EmployeeDashboard from "./components/employee_dashboard";
import NotificationsPage from "./components/NotificationsPage";
import LoginPage from "./components/LoginPage";
import RegisterPortalUser from "./components/RegisterPortalUser";
import ControlPanelPage from "./components/ControlPanelPage";

import "./App.css";
import HyacinthAttendanceAPI from "./api/hyacinthAttendanceApi";
import { useAuth } from "./auth/useAuth";
import {
  canAccessPage,
  DEFAULT_ROLE_PAGES,
  PAGE_KEYS,
  ROLES,
  getAllowedPages,
  normalizeRole,
} from "./auth/roleUtils";
import {
  approvePortalUserRequest,
  adminUpdateEmployeePortalPassword,
  createPortalUserRequest,
  deleteAdminPortalUser,
  getEmployeePermission,
  getPortalUserRequests,
  getSpecialPortalUsers,
  rejectPortalUserRequest,
  sendPortalUserPasswordResetEmail,
  updateEmployeeAllowedPages,
  updateEmployeePortalPassword,
  updatePortalUserEmail,
  updatePortalUserPassword,
  updatePortalUserProfileDetails,
  transferEmployeeToPortalRole,
  transferPortalUserToEmployeeRole,
  updatePortalUserAllowedPages,
} from "./auth/firebaseAuthService";
import {
  DAILY_BREAK_LIMIT_MINUTES,
  getActiveBreaks,
  archiveAllNotifications,
  archiveAllOverBreakNotes,
  archiveNotification,
  archiveOverBreakNote,
  deleteAllNotifications,
  deleteAllOverBreakNotes,
  deleteNotification,
  deleteOverBreakNote,
  getBreakLogsForUserOnDate,
  calculateBreakUsageMinutes,
  ensureBreakReminder,
  ensureOverBreakEscalation,
  getNotificationsForUser,
  markNotificationRead,
  markAllNotificationsRead,
  resetAllNotificationData,
  restoreNotification,
  restoreOverBreakNote,
  getOverBreakNotes,
} from "./services/breakService";
import {
  getBusinessDayKey,
  getStoredAttendanceResetTime,
  setStoredAttendanceResetTime,
} from "./utils/attendanceDate";
import {
  resolveScheduledEndUtcMsForDayKey,
  resolveScheduledStartUtcMsForDayKey,
} from "./utils/scheduleTime";
import {
  DEFAULT_STORAGE_TIME_ZONE,
  DISPLAY_TIME_ZONE_MODE_DEVICE,
  getAttendanceSettings,
  resolveAttendanceDisplayTimeZone,
} from "./services/attendanceSettingsService";
import {
  getEmployeeProfilesByUserIds,
  saveEmployeeStartDate,
} from "./services/employeeProfileService";
import {
  approveAssignmentAccess,
  archiveAssignment,
  createAssignment,
  createDeadlineAlertsForAssignments,
  deleteAssignment,
  getAssignments,
  markAssignmentCompleted,
  repostAssignment,
  reviewAssignmentCompletion,
  requestAssignmentAccess,
  updateAssignment,
} from "./services/assignmentService";
import {
  createAnnouncement,
  deleteAnnouncement,
  getAnnouncements,
  permanentlyDeleteAnnouncement,
  restoreAnnouncement,
  updateAnnouncement,
} from "./services/announcementService";
import {
  getDeviceTimeZone,
  getDisplayName,
  getProfileImageUrl,
  getUserId,
  pick,
  toMillis,
} from "./utils/common";
import {
  isClockedOutLog,
  isIn,
  pickOutTs,
  pickTs,
  tsMs,
} from "./utils/attendanceLog";

import { UserPlus, LogOut, Megaphone, CalendarCheck, ClipboardList, X } from "lucide-react";
import InvoicesPage from "./components/InvoicesPage";
import AssignmentPage from "./components/AssignmentPage";
import PerformanceReportPage from "./components/PerformanceReportPage";
import ManageAnnouncementsPage from "./components/ManageAnnouncementsPage";

/* ----------------------------- helpers ----------------------------- */
const isAnnouncementNotification = (typeValue) => {
  const type = String(typeValue || "").trim().toLowerCase();
  return type === "announcement_posted" || type.startsWith("announcement_");
};

const formatTargetPageLabel = (pageKey) => {
  const raw = String(pageKey || "").trim().toLowerCase();
  if (!raw) return "Page";
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const PORTAL_USER_REQUEST_ROLE_OPTIONS = [
  { value: ROLES.ADMIN, label: "Admin" },
  { value: ROLES.ACCOUNTING, label: "Accounting" },
  { value: ROLES.VISITOR, label: "Visitor" },
];
const PERFORMANCE_PAGE_KEYS = ["perf_daily", "perf_weekly", "perf_monthly"];
const PERFORMANCE_STATUS_SERIES = [
  { key: "early", label: "Early", color: "#4b9fea" },
  { key: "onTime", label: "On Time", color: "#66bb6a" },
  { key: "late", label: "Late", color: "#f39c12" },
  { key: "pto", label: "PTO", color: "#8e44ad" },
  { key: "absent", label: "Absent", color: "#e74c3c" },
  { key: "ncns", label: "NCNS", color: "#4b5563" },
];
const PERFORMANCE_STATUS_FILTER_ITEMS = [{ key: "ALL", label: "All" }, ...PERFORMANCE_STATUS_SERIES];
const PERFORMANCE_STATUS_LABEL_BY_KEY = PERFORMANCE_STATUS_SERIES.reduce((acc, item) => {
  acc[item.key] = item.label;
  return acc;
}, {});
const CORE_PAGE_KEYS = PAGE_KEYS.filter(
  (page) => page !== "control_panel" && !PERFORMANCE_PAGE_KEYS.includes(page)
);
const ROLE_BULK_MANAGED_PAGE_KEYS = PAGE_KEYS.filter((page) => page !== "control_panel");

const toPreviewText = (value, maxLen = 140) => {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLen)).trimEnd()}...`;
};

const getTodayAttendanceKey = (resetTime, businessTimeZone) =>
  getBusinessDayKey(Date.now(), resetTime, businessTimeZone);

const addDaysYmd = (ymd, deltaDays) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
};

const enumerateYmdRange = (start, end) => {
  if (!start || !end || start > end) return [];

  const out = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    const next = addDaysYmd(cur, 1);
    if (!next || next === cur) break;
    cur = next;
  }
  return out;
};

const startOfWeekYmd = (ymd) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  const dow = d.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return addDaysYmd(ymd, -back);
};

const dayKeyFromMsInZone = (ms, timeZone) => {
  if (!Number.isFinite(ms)) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));

  const map = {};
  for (const part of parts) map[part.type] = part.value;
  if (!map.year || !map.month || !map.day) return "";
  return `${map.year}-${map.month}-${map.day}`;
};

const getLogEventTs = (log) => {
  if (isClockedOutLog(log)) return pickOutTs(log) || pickTs(log) || "";
  return pickTs(log) || pickOutTs(log) || "";
};

const getLogEventMs = (log) => {
  const ts = getLogEventTs(log);
  return ts ? tsMs(ts) : NaN;
};

const latestOf = (logs, predicate) => {
  let best = null;
  let bestT = -Infinity;

  for (const l of Array.isArray(logs) ? logs : []) {
    if (!predicate(l)) continue;
    const t = getLogEventMs(l);
    if (!Number.isFinite(t)) continue;
    if (t > bestT) {
      bestT = t;
      best = l;
    }
  }

  return best ? { log: best, t: bestT } : null;
};

const getBusinessDayLogsFromList = (logs, businessDayKey, resetTime, businessTimeZone) => {
  return (Array.isArray(logs) ? logs : []).filter((log) => {
    const ts = getLogEventTs(log);
    if (!ts) return false;
    return getBusinessDayKey(ts, resetTime, businessTimeZone) === businessDayKey;
  });
};

const getAttendanceStatusText = (log) =>
  String(
    pick(log || {}, ["status", "attendanceStatus", "dailyStatus", "remark"], "")
  ).trim();

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

const normalizePerformanceAttendanceStatus = (raw) => {
  const s = String(raw || "").toLowerCase();
  if (!s) return "";
  if (s.includes("early")) return "early";
  if (s.includes("on-time") || s.includes("on time") || s.includes("ontime") || s.includes("present")) {
    return "onTime";
  }
  if (s.includes("late")) return "late";
  if (s.includes("pto") || s.includes("leave")) return "pto";
  if (s.includes("absent")) return "absent";
  if (s.includes("ncns") || s.includes("no show") || s.includes("no-show") || s.includes("no call")) {
    return "ncns";
  }
  return "";
};

const toDateInputValue = (value) => {
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

const formatYmdForDisplay = (ymd, timeZone = "UTC") => {
  if (!ymd) return "-";
  const d = new Date(`${String(ymd)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(ymd);

  return new Intl.DateTimeFormat([], {
    timeZone: String(timeZone || "").trim() || "UTC",
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(d);
};

const formatTsForDisplay = (ts, timeZone = "UTC") => {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);

  return new Intl.DateTimeFormat([], {
    timeZone: String(timeZone || "").trim() || "UTC",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
};

const formatTimeForDisplay = (ts, timeZone = "UTC") => {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);

  return new Intl.DateTimeFormat([], {
    timeZone: String(timeZone || "").trim() || "UTC",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
};

const getEmployeePositionLabel = (employee = {}, profile = {}) =>
  pick(employee, ["position", "role", "jobTitle"], "") ||
  pick(profile, ["position", "role", "jobTitle"], "") ||
  "Unassigned Position";

const containsAbsentStatus = (statusText) =>
  String(statusText || "").trim().toLowerCase().includes("absent");

const scanAbsentStatusesInLogsByUserId = (logsByUserId = {}) => {
  const entries = Object.entries(logsByUserId || {});
  let totalLogs = 0;
  let totalAbsentLogs = 0;
  const usersWithAbsent = [];

  for (const [userId, rawLogs] of entries) {
    const logs = Array.isArray(rawLogs) ? rawLogs : [];
    totalLogs += logs.length;

    const absentStatuses = logs
      .map((log) => getAttendanceStatusText(log))
      .filter((status) => containsAbsentStatus(status));

    if (!absentStatuses.length) continue;

    totalAbsentLogs += absentStatuses.length;
    usersWithAbsent.push({
      userId,
      absentLogs: absentStatuses.length,
      statuses: Array.from(new Set(absentStatuses)).join(" | "),
    });
  }

  return {
    totalLogs,
    totalAbsentLogs,
    usersWithAbsentCount: usersWithAbsent.length,
    usersWithAbsent,
  };
};

const logAbsentStatusScan = (label, logsByUserId = {}) => {
  const report = scanAbsentStatusesInLogsByUserId(logsByUserId);
  const tag = `[Attendance Absent Scan] ${label}`;

  if (!report.totalLogs) {
    console.info(`${tag}: no logs returned from API.`);
    return report;
  }

  if (!report.totalAbsentLogs) {
    console.info(`${tag}: no 'Absent' status found in ${report.totalLogs} log(s).`);
    return report;
  }

  console.info(
    `${tag}: found ${report.totalAbsentLogs} 'Absent' status log(s) across ${report.usersWithAbsentCount} user(s).`
  );
  console.table(report.usersWithAbsent);
  return report;
};

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;

  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = { ok: true, value: await worker(items[idx], idx) };
      } catch (error) {
        results[idx] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

const HISTORY_START_DATE = "2000-01-01";

const PAGE_HEADER_TITLES = {
  dashboard: "Dashboard",
  employee_dashboard: "My Dashboard",
  attendance: "Attendance",
  schedule: "Schedule",
  assignment: "Assignment Management",
  control_panel: "Control Panel",
  register_portal_user: "Register Portal User",
  notifications: "Notifications",
  manage_announcements: "Manage Announcements",
  perf_daily: "Performance Report (Daily)",
  perf_weekly: "Performance Report (Weekly)",
  perf_monthly: "Performance Report (Monthly)",
  invoices: "Invoices",
  hours: "Hours",
};

const resolveDefaultActivePage = (authUser) => {
  const allowedPages = getAllowedPages(authUser?.role, authUser?.allowedPages);

  if (allowedPages.includes("dashboard")) return "dashboard";
  if (allowedPages.includes("employee_dashboard")) return "employee_dashboard";
  return allowedPages[0] || "dashboard";
};

const buildProfileImageMapByUserId = (rows = []) => {
  const map = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const userId = String(getUserId(row) || row?.userId || "").trim();
    if (!userId) continue;

    const imageUrl = getProfileImageUrl(row);
    if (imageUrl) {
      map[userId] = imageUrl;
    }
  }
  return map;
};

const attachProfileImagesToUsers = (rows = [], profileImagesByUserId = {}) => {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const profileMap =
    profileImagesByUserId && typeof profileImagesByUserId === "object"
      ? profileImagesByUserId
      : {};

  return sourceRows.map((row) => {
    const userId = String(getUserId(row) || row?.userId || "").trim();
    const mappedUrl = userId ? String(profileMap[userId] || "").trim() : "";
    const existingUrl = getProfileImageUrl(row);
    const finalUrl = mappedUrl || existingUrl;

    if (!finalUrl) return row;
    return {
      ...row,
      profileImg: finalUrl,
      profileImageKey: row?.profileImageKey || finalUrl,
    };
  });
};

const toDateTimeLocalValue = (value) => {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
};

const getDefaultAnnouncementWindow = () => {
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return {
    postAt: toDateTimeLocalValue(now),
    expiresAt: toDateTimeLocalValue(expires),
  };
};

export default function App() {
  const { user, isAuthenticated, authReady, signOut } = useAuth();

  const [authScreen, setAuthScreen] = useState("login");

  const apiKey = import.meta.env.VITE_HYACINTH_API_KEY;
  const departmentId = import.meta.env.VITE_HYACINTH_DEPARTMENT_ID;

  const api = useMemo(() => (apiKey ? new HyacinthAttendanceAPI(apiKey) : null), [apiKey]);

  const [attendanceResetTime, setAttendanceResetTime] = useState(() => getStoredAttendanceResetTime());
  const [attendanceDisplayTimeZoneMode, setAttendanceDisplayTimeZoneMode] = useState(
    DISPLAY_TIME_ZONE_MODE_DEVICE
  );
  const [attendanceDisplayTimeZone, setAttendanceDisplayTimeZone] = useState("");
  const [storageTimeZone, setStorageTimeZone] = useState(DEFAULT_STORAGE_TIME_ZONE);
  const [businessTimeZone, setBusinessTimeZone] = useState(() => getDeviceTimeZone());

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [employees, setEmployees] = useState([]);
  const [activePage, setActivePage] = useState("dashboard");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const [endDate, setEndDate] = useState(() =>
    getTodayAttendanceKey(getStoredAttendanceResetTime(), getDeviceTimeZone())
  );
  const [startDate, setStartDate] = useState(() =>
    getTodayAttendanceKey(getStoredAttendanceResetTime(), getDeviceTimeZone())
  );
  const RANGE_OPTIONS = useMemo(() => [1, 2, 7, 14, 30], []);
  const [rangeDays, setRangeDays] = useState(1);

  const [usersError, setUsersError] = useState("");
  const [loadingUsers, setLoadingUsers] = useState(false);

  const [schedulesByUserId, setSchedulesByUserId] = useState({});
  const [scheduleErrorsByUserId, setScheduleErrorsByUserId] = useState({});
  const [loadingSchedules, setLoadingSchedules] = useState(false);
  const [schedulesError, setSchedulesError] = useState("");

  const [logsByUserId, setLogsByUserId] = useState({});
  const [attendanceErrorsByUserId, setAttendanceErrorsByUserId] = useState({});
  const [loadingAttendance, setLoadingAttendance] = useState(false);
  const [attendanceError, setAttendanceError] = useState("");

  const [todayLogsByUserId, setTodayLogsByUserId] = useState({});
  const [loadingTodayLogs, setLoadingTodayLogs] = useState(false);

  const [historyByUserId, setHistoryByUserId] = useState({});
  const [loadingHistoryByUserId, setLoadingHistoryByUserId] = useState({});
  const [historyErrorByUserId, setHistoryErrorByUserId] = useState({});
  const historyAbortRef = useRef({});
  const historyRequestedRef = useRef(new Set());

  const [activeBreaksByUserId, setActiveBreaksByUserId] = useState({});
  const [breakUsageByUserId, setBreakUsageByUserId] = useState({});
  const [loadingBreaks, setLoadingBreaks] = useState(false);
  const [loadingBreakUsage, setLoadingBreakUsage] = useState(false);
  const [hasSeenLiveAgentsLoading, setHasSeenLiveAgentsLoading] = useState(false);
  const [hasCompletedInitialLiveAgentsLoading, setHasCompletedInitialLiveAgentsLoading] =
    useState(false);

  const [employeeProfilesByUserId, setEmployeeProfilesByUserId] = useState({});
  const [loadingEmployeeProfiles, setLoadingEmployeeProfiles] = useState(false);
  const [employeeProfilesError, setEmployeeProfilesError] = useState("");

  const [specialUsers, setSpecialUsers] = useState([]);
  const [loadingSpecialUsers, setLoadingSpecialUsers] = useState(false);
  const [specialUsersError, setSpecialUsersError] = useState("");

  const [employeePermissionsByUserId, setEmployeePermissionsByUserId] = useState({});
  const [loadingEmployeePermissions, setLoadingEmployeePermissions] = useState(false);
  const [employeePermissionsError, setEmployeePermissionsError] = useState("");

  const [assignments, setAssignments] = useState([]);
  const [archivedAssignments, setArchivedAssignments] = useState([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [assignmentsError, setAssignmentsError] = useState("");
  const [assignmentOpenRequest, setAssignmentOpenRequest] = useState({
    taskId: "",
    requestId: 0,
  });
  const [assignmentCreateRequest, setAssignmentCreateRequest] = useState({
    assigneeUserId: "",
    requestId: 0,
  });
  const [attendanceOpenRequest, setAttendanceOpenRequest] = useState({
    userId: "",
    requestId: 0,
  });
  const [announcements, setAnnouncements] = useState([]);
  const [loadingAnnouncements, setLoadingAnnouncements] = useState(false);
  const [announcementsError, setAnnouncementsError] = useState("");
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [announcementHeadline, setAnnouncementHeadline] = useState("");
  const [announcementDraft, setAnnouncementDraft] = useState("");
  const [announcementPostAt, setAnnouncementPostAt] = useState(
    () => getDefaultAnnouncementWindow().postAt
  );
  const [announcementExpireAt, setAnnouncementExpireAt] = useState(
    () => getDefaultAnnouncementWindow().expiresAt
  );
  const [savingAnnouncement, setSavingAnnouncement] = useState(false);
  const [showUserRequestModal, setShowUserRequestModal] = useState(false);
  const [requestingNewUser, setRequestingNewUser] = useState(false);
  const [newUserRequestForm, setNewUserRequestForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    role: ROLES.VISITOR,
    note: "",
  });
  const [portalUserRequests, setPortalUserRequests] = useState([]);
  const [loadingPortalUserRequests, setLoadingPortalUserRequests] = useState(false);
  const [portalUserRequestsError, setPortalUserRequestsError] = useState("");
  const [processingPortalUserRequest, setProcessingPortalUserRequest] = useState({
    id: "",
    action: "",
  });
  const [selectedNotification, setSelectedNotification] = useState(null);
  const [selectedLiveAgentId, setSelectedLiveAgentId] = useState("");
  const [showLiveAgentModal, setShowLiveAgentModal] = useState(false);
  const [liveAgentLogStatus, setLiveAgentLogStatus] = useState("ALL");

  const authSessionKey = useMemo(() => {
    if (!isAuthenticated || !user) return "";
    return String(getUserId(user) || user?.uid || user?.email || "")
      .trim()
      .toLowerCase();
  }, [isAuthenticated, user]);

  const usersAbortRef = useRef(null);
  const schedulesAbortRef = useRef(null);
  const attendanceAbortRef = useRef(null);
  const todayAbortRef = useRef(null);
  const lastAuthSessionKeyRef = useRef("");

  const [breakLogsByUserId, setBreakLogsByUserId] = useState({});

  const [notifications, setNotifications] = useState([]);
  const [archivedNotifications, setArchivedNotifications] = useState([]);
  const [overBreakNotes, setOverBreakNotes] = useState([]);
  const [archivedOverBreakNotes, setArchivedOverBreakNotes] = useState([]);
  const [profileImagesByUserId, setProfileImagesByUserId] = useState({});
  const [toastQueue, setToastQueue] = useState([]);
  const seenToastIdsRef = useRef(new Set());
  const profileImagesByUserIdRef = useRef({});
  const profileImagesInitializedRef = useRef(false);
  const announcementsRef = useRef([]);
  const periodicRefreshHandlersRef = useRef({
    reloadActiveBreaks: async () => {},
    reloadBreakUsage: async () => {},
    reloadNotifications: async () => {},
    reloadAnnouncements: async () => {},
    reloadOverBreakNotes: async () => {},
    reloadPortalUserRequests: async () => {},
  });
  const portalMainRef = useRef(null);
  const viewerRole = useMemo(
    () => String(user?.role || "").trim().toLowerCase().replace(/\s+/g, "_"),
    [user?.role]
  );
  const canManageUserAdministration = useMemo(() => {
    if (!isAuthenticated || !user) return false;
    return (
      canAccessPage(user.role, "control_panel", user?.allowedPages) ||
      canAccessPage(user.role, "register_portal_user", user?.allowedPages)
    );
  }, [isAuthenticated, user]);
  const canRequestPortalUser = useMemo(() => {
    if (!isAuthenticated || !user) return false;
    const role = normalizeRole(user.role);
    return role === ROLES.ADMIN;
  }, [isAuthenticated, user]);
  const canReviewPortalUserRequests = useMemo(
    () => canManageUserAdministration,
    [canManageUserAdministration]
  );
  const canLoadSpecialUsers = useMemo(
    () => canManageUserAdministration,
    [canManageUserAdministration]
  );
  const canPostAnnouncements = useMemo(
    () =>
      !!user &&
      canAccessPage(user.role, "manage_announcements", user?.allowedPages),
    [user]
  );
  const canAccessNotificationArchive = useMemo(
    () => !!isAuthenticated && !!user,
    [isAuthenticated, user]
  );
  const canManageNotificationArchive = useMemo(
    () => normalizeRole(user?.role) === ROLES.SUPER_ADMIN,
    [user?.role]
  );

  const handleLogoutClick = useCallback(() => {
    setShowLogoutConfirm(true);
  }, []);

  const handleConfirmLogout = useCallback(async () => {
    const logoutStartedAt = Date.now();
    setShowLogoutConfirm(false);
    setShowAnnouncementModal(false);
    setShowUserRequestModal(false);
    setSelectedNotification(null);
    setIsLoggingOut(true);

    // Ensure the overlay can paint at least once before sign-out resolves.
    await new Promise((resolve) => {
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });

    usersAbortRef.current?.abort?.();
    schedulesAbortRef.current?.abort?.();
    attendanceAbortRef.current?.abort?.();
    todayAbortRef.current?.abort?.();
    Object.values(historyAbortRef.current || {}).forEach((controller) => controller?.abort?.());
    historyAbortRef.current = {};

    try {
      await signOut();
    } finally {
      const minOverlayMs = 700;
      const elapsed = Date.now() - logoutStartedAt;
      if (elapsed < minOverlayMs) {
        await new Promise((resolve) => setTimeout(resolve, minOverlayMs - elapsed));
      }
      setIsLoggingOut(false);
    }
  }, [signOut]);

  const handleCancelLogout = useCallback(() => {
    setShowLogoutConfirm(false);
  }, []);

  const handleOpenAnnouncementModal = useCallback(() => {
    if (!canPostAnnouncements) return;
    const defaults = getDefaultAnnouncementWindow();
    setAnnouncementsError("");
    setAnnouncementHeadline("");
    setAnnouncementDraft("");
    setAnnouncementPostAt(defaults.postAt);
    setAnnouncementExpireAt(defaults.expiresAt);
    setShowAnnouncementModal(true);
  }, [canPostAnnouncements]);

  const handleOpenUserRequestModal = useCallback(() => {
    if (!canRequestPortalUser) return;
    setNewUserRequestForm({
      firstName: "",
      lastName: "",
      email: "",
      role: ROLES.VISITOR,
      note: "",
    });
    setShowUserRequestModal(true);
  }, [canRequestPortalUser]);

  const handleCloseAnnouncementModal = useCallback(() => {
    if (savingAnnouncement) return;
    const defaults = getDefaultAnnouncementWindow();
    setShowAnnouncementModal(false);
    setAnnouncementHeadline("");
    setAnnouncementDraft("");
    setAnnouncementPostAt(defaults.postAt);
    setAnnouncementExpireAt(defaults.expiresAt);
  }, [savingAnnouncement]);

  const handleCloseUserRequestModal = useCallback(() => {
    if (requestingNewUser) return;
    setShowUserRequestModal(false);
    setNewUserRequestForm({
      firstName: "",
      lastName: "",
      email: "",
      role: ROLES.VISITOR,
      note: "",
    });
  }, [requestingNewUser]);

  const closeNotificationModal = useCallback(() => {
    setSelectedNotification(null);
  }, []);

  const handleOpenAssignmentTask = useCallback((taskId) => {
    const nextTaskId = String(taskId || "").trim();
    if (!nextTaskId) return;

    setAssignmentOpenRequest((prev) => ({
      taskId: nextTaskId,
      requestId: Number(prev?.requestId || 0) + 1,
    }));
    setActivePage("assignment");
  }, []);

  const handleConsumeAssignmentOpenRequest = useCallback((requestId) => {
    const targetRequestId = Number(requestId || 0);
    if (!targetRequestId) return;

    setAssignmentOpenRequest((prev) => {
      if (Number(prev?.requestId || 0) !== targetRequestId) return prev;
      return { taskId: "", requestId: 0 };
    });
  }, []);

  const handleConsumeAssignmentCreateRequest = useCallback((requestId) => {
    const targetRequestId = Number(requestId || 0);
    if (!targetRequestId) return;

    setAssignmentCreateRequest((prev) => {
      if (Number(prev?.requestId || 0) !== targetRequestId) return prev;
      return { assigneeUserId: "", requestId: 0 };
    });
  }, []);

  const handleConsumeAttendanceOpenRequest = useCallback((requestId) => {
    const targetRequestId = Number(requestId || 0);
    if (!targetRequestId) return;

    setAttendanceOpenRequest((prev) => {
      if (Number(prev?.requestId || 0) !== targetRequestId) return prev;
      return { userId: "", requestId: 0 };
    });
  }, []);

  const handleOpenLiveAgentModal = useCallback((agent) => {
    const userId = String(agent?.id || agent?.userId || "").trim();
    if (!userId) return;

    setSelectedLiveAgentId(userId);
    setLiveAgentLogStatus("ALL");
    setShowLiveAgentModal(true);
  }, []);

  const handleCloseLiveAgentModal = useCallback(() => {
    setShowLiveAgentModal(false);
  }, []);

  const isLiveAgentsLoadingNow =
    loadingUsers || loadingTodayLogs || loadingBreaks || loadingBreakUsage;
  const showLiveAgentsStartupLoading = !hasCompletedInitialLiveAgentsLoading;

  useEffect(() => {
    if (hasCompletedInitialLiveAgentsLoading) return;

    if (isLiveAgentsLoadingNow) {
      if (!hasSeenLiveAgentsLoading) {
        setHasSeenLiveAgentsLoading(true);
      }
      return;
    }

    if (hasSeenLiveAgentsLoading || usersError) {
      setHasCompletedInitialLiveAgentsLoading(true);
    }
  }, [
    isLiveAgentsLoadingNow,
    hasSeenLiveAgentsLoading,
    hasCompletedInitialLiveAgentsLoading,
    usersError,
  ]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!showLogoutConfirm) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        setShowLogoutConfirm(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showLogoutConfirm]);

  useEffect(() => {
    if (!showAnnouncementModal) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        setShowAnnouncementModal(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showAnnouncementModal]);

  useEffect(() => {
    if (!selectedNotification) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        setSelectedNotification(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedNotification]);

  useEffect(() => {
    if (!showLiveAgentModal) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        setShowLiveAgentModal(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showLiveAgentModal]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const lockClass = "portal-scroll-lock";
    if (showLiveAgentModal) {
      document.documentElement.classList.add(lockClass);
      document.body.classList.add(lockClass);
    } else {
      document.documentElement.classList.remove(lockClass);
      document.body.classList.remove(lockClass);
    }

    return () => {
      document.documentElement.classList.remove(lockClass);
      document.body.classList.remove(lockClass);
    };
  }, [showLiveAgentModal]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const settings = await getAttendanceSettings();
        if (!active) return;

        const nextResetTime = settings?.resetTime || getStoredAttendanceResetTime();
        const nextDisplayMode =
          settings?.displayTimeZoneMode || DISPLAY_TIME_ZONE_MODE_DEVICE;
        const nextDisplayTimeZone = String(settings?.displayTimeZone || "").trim();
        const nextStorageTimeZone =
          String(settings?.storageTimeZone || "").trim() || DEFAULT_STORAGE_TIME_ZONE;
        const nextBusinessTimeZone = resolveAttendanceDisplayTimeZone(
          settings,
          getDeviceTimeZone()
        );

        setStoredAttendanceResetTime(nextResetTime);
        setAttendanceResetTime(nextResetTime);
        setAttendanceDisplayTimeZoneMode(nextDisplayMode);
        setAttendanceDisplayTimeZone(nextDisplayTimeZone);
        setStorageTimeZone(nextStorageTimeZone);
        setBusinessTimeZone(nextBusinessTimeZone);
      } catch {
        // keep local fallback
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const validEmployees = useMemo(
    () => (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e)),
    [employees]
  );

  const currentViewerIdentity = useMemo(() => {
    return {
      userId:
        user?.userId ??
        user?.id ??
        user?.uid ??
        user?.firebaseUid ??
        user?.employeeId ??
        "",
      role: user?.role || "",
    };
  }, [user]);

  useEffect(() => {
    announcementsRef.current = Array.isArray(announcements) ? announcements : [];
  }, [announcements]);

  const pushToast = useCallback(({ type = "info", title = "Notice", message = "" }) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    setToastQueue((prev) => [
      ...prev,
      {
        id,
        type,
        title,
        message,
      },
    ]);
  }, []);

  const getTodayScheduleStartUtcMs = useCallback(
    (userId) => {
      const sched = schedulesByUserId?.[String(userId)];
      if (!Array.isArray(sched) || sched.length === 0) return NaN;

      const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

      const weekdayNameFromYmd = (yyyyMmDd) => {
        const d = new Date(`${yyyyMmDd}T12:00:00Z`);
        if (Number.isNaN(d.getTime())) return null;
        return WEEKDAYS[d.getUTCDay()];
      };

      const targetWeekday = weekdayNameFromYmd(endDate);
      if (!targetWeekday) return NaN;

      const todayItem =
        sched.find(
          (s) => String(pick(s, ["dayOfWeek", "day", "weekday"], "")).toLowerCase() === targetWeekday
        ) || null;

      if (!todayItem) return NaN;
      return resolveScheduledStartUtcMsForDayKey(todayItem, endDate, businessTimeZone);
    },
    [schedulesByUserId, endDate, businessTimeZone]
  );

  const getTodayScheduleEndUtcMs = useCallback(
    (userId) => {
      const sched = schedulesByUserId?.[String(userId)];
      if (!Array.isArray(sched) || sched.length === 0) return NaN;

      const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

      const weekdayNameFromYmd = (yyyyMmDd) => {
        const d = new Date(`${yyyyMmDd}T12:00:00Z`);
        if (Number.isNaN(d.getTime())) return null;
        return WEEKDAYS[d.getUTCDay()];
      };

      const targetWeekday = weekdayNameFromYmd(endDate);
      if (!targetWeekday) return NaN;

      const todayItem =
        sched.find(
          (s) => String(pick(s, ["dayOfWeek", "day", "weekday"], "")).toLowerCase() === targetWeekday
        ) || null;

      if (!todayItem) return NaN;
      return resolveScheduledEndUtcMsForDayKey(todayItem, endDate, businessTimeZone);
    },
    [schedulesByUserId, endDate, businessTimeZone]
  );

  const isUserOnBreak = useCallback(
    (userId) => {
      const uid = String(userId || "");
      return !!activeBreaksByUserId[uid];
    },
    [activeBreaksByUserId]
  );

  const getTodayBusinessLogsForUser = useCallback(
    (userId) => {
      const uid = String(userId);
      const todayKey = getTodayAttendanceKey(attendanceResetTime, businessTimeZone);
      const sourceLogs = Array.isArray(todayLogsByUserId?.[uid]) ? todayLogsByUserId[uid] : [];

      return getBusinessDayLogsFromList(sourceLogs, todayKey, attendanceResetTime, businessTimeZone);
    },
    [todayLogsByUserId, attendanceResetTime, businessTimeZone]
  );

  const isUserLiveNow = useCallback(
    (userId) => {
      const uid = String(userId);
      const logsToday = getTodayBusinessLogsForUser(uid);

      const lastIn = latestOf(logsToday, isIn);
      if (!lastIn) return false;

      const lastOut = latestOf(logsToday, isClockedOutLog);
      if (lastOut && lastOut.t >= lastIn.t) return false;

      const GRACE_MINUTES = 10;
      const graceMs = GRACE_MINUTES * 60 * 1000;
      const schedEndMs = getTodayScheduleEndUtcMs(uid);

      if (Number.isFinite(schedEndMs) && nowMs > schedEndMs + graceMs) {
        return false;
      }

      return true;
    },
    [getTodayBusinessLogsForUser, getTodayScheduleEndUtcMs, nowMs]
  );

  const getLiveHoursSinceIn = useCallback(
    (userId) => {
      const uid = String(userId);
      const logsToday = getTodayBusinessLogsForUser(uid);

      const lastIn = latestOf(logsToday, isIn);
      if (!lastIn) return 0;

      const lastOut = latestOf(logsToday, isClockedOutLog);
      if (lastOut && lastOut.t >= lastIn.t) return 0;

      const schedStartMs = getTodayScheduleStartUtcMs(uid);
      const hasSchedule =
        Array.isArray(schedulesByUserId?.[uid]) && schedulesByUserId[uid].length > 0;
      if (hasSchedule && !Number.isFinite(schedStartMs)) return 0;

      const schedEndMs = getTodayScheduleEndUtcMs(uid);
      const endMs = Number.isFinite(schedEndMs) ? Math.min(nowMs, schedEndMs) : nowMs;
      const countedStartMs = Number.isFinite(schedStartMs) ? Math.max(lastIn.t, schedStartMs) : lastIn.t;

      const ms = Math.max(0, endMs - countedStartMs);
      return ms / (60 * 60 * 1000);
    },
    [
      getTodayBusinessLogsForUser,
      getTodayScheduleStartUtcMs,
      getTodayScheduleEndUtcMs,
      nowMs,
      schedulesByUserId,
    ]
  );

  const reloadNotifications = useCallback(async () => {
    if (!isAuthenticated || !user) {
      setNotifications((prev) => (prev.length ? [] : prev));
      setArchivedNotifications((prev) => (prev.length ? [] : prev));
      return;
    }

    if (!currentViewerIdentity?.userId) {
      setNotifications((prev) => (prev.length ? [] : prev));
      setArchivedNotifications((prev) => (prev.length ? [] : prev));
      return;
    }

    try {
      const [activeRowsRaw, archivedRowsRaw] = await Promise.all([
        getNotificationsForUser(currentViewerIdentity, { archived: false }),
        getNotificationsForUser(currentViewerIdentity, { archived: true }),
      ]);
      const activeList = Array.isArray(activeRowsRaw) ? activeRowsRaw : [];
      const archivedList = Array.isArray(archivedRowsRaw) ? archivedRowsRaw : [];
      const announcementRows = announcementsRef.current;
      const enrichRows = (rows = []) =>
        rows.map((row) => {
        if (!isAnnouncementNotification(row?.type)) return row;
        if (String(row?.message || "").trim()) return row;

        const announcementId = String(row?.announcementId || "").trim();
        if (!announcementId) return row;

        const match = announcementRows.find(
          (item) => String(item?.id || "").trim() === announcementId
        );
        if (!match) return row;

        const notePreview = toPreviewText(
          pick(match, ["note", "announcement", "announcementNote", "message", "text"], ""),
          140
        );
        const fallbackTitle = pick(match, ["headline", "title", "subject"], "Announcement");

        return {
          ...row,
          title: String(row?.title || "").trim() || fallbackTitle,
          message: notePreview || String(row?.message || ""),
        };
      });

      const enrichedActiveRows = enrichRows(activeList);
      const enrichedArchivedRows = enrichRows(archivedList);

      setNotifications(enrichedActiveRows);
      setArchivedNotifications(enrichedArchivedRows);

      const unread = enrichedActiveRows.filter((row) => !row?.read);
      const freshUnread = unread.filter((row) => !seenToastIdsRef.current.has(row.id));

      if (freshUnread.length > 0) {
        setToastQueue((prev) => [
          ...prev,
          ...freshUnread.map((row) => ({
            id: row.id,
            type: "info",
            title: row.title || "Notification",
            message: row.message || "",
          })),
        ]);

        freshUnread.forEach((row) => seenToastIdsRef.current.add(row.id));
      }
    } catch (err) {
      console.error("Failed to load notifications:", err);
    }
  }, [currentViewerIdentity, isAuthenticated, user]);

  const reloadOverBreakNotes = useCallback(async () => {
    if (!isAuthenticated || !user) {
      setOverBreakNotes((prev) => (prev.length ? [] : prev));
      setArchivedOverBreakNotes((prev) => (prev.length ? [] : prev));
      return;
    }

    try {
      const [activeRowsRaw, archivedRowsRaw] = await Promise.all([
        getOverBreakNotes(user, { archived: false }),
        getOverBreakNotes(user, { archived: true }),
      ]);
      setOverBreakNotes(Array.isArray(activeRowsRaw) ? activeRowsRaw : []);
      setArchivedOverBreakNotes(Array.isArray(archivedRowsRaw) ? archivedRowsRaw : []);
    } catch (err) {
      console.error("Failed to load over-break notes:", err);
    }
  }, [isAuthenticated, user]);

  const dismissToast = useCallback((toastId) => {
    setToastQueue((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  useEffect(() => {
    if (toastQueue.length === 0) return;

    const timers = toastQueue.map((toast) =>
      setTimeout(() => {
        dismissToast(toast.id);
      }, 5000)
    );

    return () => timers.forEach(clearTimeout);
  }, [toastQueue, dismissToast]);

  const handleNotificationClick = useCallback(
    async (notif) => {
      if (!notif?.id) return;

      const targetPage = String(notif?.targetPage || notif?.navigateTo || "").trim().toLowerCase();
      const notifType = String(notif?.type || "").trim().toLowerCase();
      const announcementNotif = isAnnouncementNotification(notifType);
      let resolvedTargetPage = targetPage;

      if (!resolvedTargetPage && notifType.startsWith("assignment_")) {
        resolvedTargetPage = "assignment";
      }

      const canNavigateToTarget =
        !!resolvedTargetPage &&
        !!user &&
        canAccessPage(user.role, resolvedTargetPage, user?.allowedPages);

      try {
        if (!notif?.read) {
          await markNotificationRead(notif.id);
        }
      } catch (err) {
        console.error("Failed to mark notification as read:", err);
      }

      let modalPayload = {
        id: String(notif?.id || ""),
        headline: pick(notif, ["title", "headline"], "") || "Notification",
        text:
          pick(notif, ["message", "note", "announcement", "description", "text"], "") ||
          "No notification content available.",
        createdBy:
          pick(notif, ["actorName", "name", "createdByName", "createdBy", "role"], "") ||
          "Notification",
        createdAtMs: toMillis(notif?.createdAt),
        actionPage: canNavigateToTarget ? resolvedTargetPage : "",
        actionLabel: canNavigateToTarget ? `Open ${formatTargetPageLabel(resolvedTargetPage)}` : "",
      };

      if (announcementNotif) {
        const announcementId = String(notif?.announcementId || "").trim();
        let announcementRow =
          Array.isArray(announcements) && announcementId
            ? announcements.find((item) => String(item?.id || "") === announcementId) || null
            : null;

        if (!announcementRow && announcementId) {
          try {
            const rows = await getAnnouncements({ limitCount: 160, includeDeleted: true });
            const nextRows = Array.isArray(rows) ? rows : [];
            setAnnouncements(nextRows);
            announcementRow =
              nextRows.find((item) => String(item?.id || "") === announcementId) || null;
          } catch (err) {
            console.error("Failed to load announcement details:", err);
          }
        }

        const headline =
          pick(notif, ["title", "headline"], "") ||
          pick(announcementRow, ["headline", "title", "subject"], "") ||
          "Announcement";
        const fullText =
          pick(announcementRow, ["note", "announcement", "announcementNote", "message", "text"], "") ||
          "No announcement content available.";

        modalPayload = {
          ...modalPayload,
          id: announcementId || String(notif?.id || ""),
          headline,
          text: fullText,
          createdBy: pick(announcementRow, ["createdByName", "createdBy"], "") || "Announcement",
          createdAtMs: toMillis(announcementRow?.createdAt ?? notif?.createdAt),
        };
      }

      setSelectedNotification(modalPayload);
      await reloadNotifications();
    },
    [announcements, reloadNotifications, user]
  );

  const handleOpenNotificationTargetPage = useCallback(() => {
    const targetPage = String(selectedNotification?.actionPage || "").trim().toLowerCase();
    if (!targetPage || !user) return;
    if (!canAccessPage(user.role, targetPage, user?.allowedPages)) return;
    setActivePage(targetPage);
    setSelectedNotification(null);
  }, [selectedNotification, user]);

  const handleMarkAllNotificationsRead = useCallback(
    async (ids = []) => {
      try {
        await markAllNotificationsRead(ids);
      } catch (err) {
        console.error("Failed to mark all notifications as read:", err);
      } finally {
        await reloadNotifications();
      }
    },
    [reloadNotifications]
  );

  const handleResetAllNotificationsData = useCallback(async () => {
    if (!canManageNotificationArchive) return;

    try {
      await resetAllNotificationData();
      pushToast({
        type: "success",
        title: "Notifications Reset",
        message: "All notification data for all users has been deleted.",
      });
    } catch (err) {
      console.error("Failed to reset all notification data:", err);
      pushToast({
        type: "error",
        title: "Reset Failed",
        message: err?.message || "Could not reset notification data.",
      });
    } finally {
      await Promise.all([reloadNotifications(), reloadOverBreakNotes()]);
    }
  }, [canManageNotificationArchive, pushToast, reloadNotifications, reloadOverBreakNotes]);

  const handleArchiveNotification = useCallback(
    async (notificationId) => {
      if (!canAccessNotificationArchive) return;
      const id = String(notificationId || "").trim();
      if (!id) return;

      try {
        await archiveNotification(id, {
          userId: currentViewerIdentity?.userId || "",
          name: user?.name || user?.displayName || user?.email || "Portal User",
          role: user?.role || "",
        });

        pushToast({
          type: "success",
          title: "Moved to Archive",
          message: "Notification moved to archive.",
        });
      } catch (err) {
        console.error("Failed to archive notification:", err);
        pushToast({
          type: "error",
          title: "Archive Failed",
          message: err?.message || "Could not move notification to archive.",
        });
      } finally {
        await reloadNotifications();
      }
    },
    [
      canAccessNotificationArchive,
      currentViewerIdentity?.userId,
      pushToast,
      reloadNotifications,
      user?.displayName,
      user?.email,
      user?.name,
      user?.role,
    ]
  );

  const handleArchiveAllNotifications = useCallback(
    async (ids = []) => {
      if (!canAccessNotificationArchive) return;

      const notificationIds = Array.from(
        new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))
      );
      if (!notificationIds.length) return;

      try {
        await archiveAllNotifications(notificationIds, {
          userId: currentViewerIdentity?.userId || "",
          name: user?.name || user?.displayName || user?.email || "Portal User",
          role: user?.role || "",
        });

        pushToast({
          type: "success",
          title: "Inbox Archived",
          message: `${notificationIds.length} notification(s) moved to archive.`,
        });
      } catch (err) {
        console.error("Failed to archive all notifications:", err);
        pushToast({
          type: "error",
          title: "Archive Failed",
          message: err?.message || "Could not move inbox to archive.",
        });
      } finally {
        await reloadNotifications();
      }
    },
    [
      canAccessNotificationArchive,
      currentViewerIdentity?.userId,
      pushToast,
      reloadNotifications,
      user?.displayName,
      user?.email,
      user?.name,
      user?.role,
    ]
  );

  const handleArchiveOverBreakNote = useCallback(
    async (noteId) => {
      if (!canAccessNotificationArchive) return;
      const id = String(noteId || "").trim();
      if (!id) return;

      try {
        await archiveOverBreakNote(id, {
          userId: currentViewerIdentity?.userId || "",
          name: user?.name || user?.displayName || user?.email || "Portal User",
          role: user?.role || "",
        });

        pushToast({
          type: "success",
          title: "Moved to Archive",
          message: "Over-break record moved to archive.",
        });
      } catch (err) {
        console.error("Failed to archive over-break record:", err);
        pushToast({
          type: "error",
          title: "Archive Failed",
          message: err?.message || "Could not move over-break record to archive.",
        });
      } finally {
        await reloadOverBreakNotes();
      }
    },
    [
      canAccessNotificationArchive,
      currentViewerIdentity?.userId,
      pushToast,
      reloadOverBreakNotes,
      user?.displayName,
      user?.email,
      user?.name,
      user?.role,
    ]
  );

  const handleArchiveAllOverBreakNotes = useCallback(
    async (ids = []) => {
      if (!canAccessNotificationArchive) return;

      const noteIds = Array.from(
        new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))
      );
      if (!noteIds.length) return;

      try {
        await archiveAllOverBreakNotes(noteIds, {
          userId: currentViewerIdentity?.userId || "",
          name: user?.name || user?.displayName || user?.email || "Portal User",
          role: user?.role || "",
        });

        pushToast({
          type: "success",
          title: "Over-break Archived",
          message: `${noteIds.length} record(s) moved to archive.`,
        });
      } catch (err) {
        console.error("Failed to archive all over-break notes:", err);
        pushToast({
          type: "error",
          title: "Archive Failed",
          message: err?.message || "Could not move over-break records to archive.",
        });
      } finally {
        await reloadOverBreakNotes();
      }
    },
    [
      canAccessNotificationArchive,
      currentViewerIdentity?.userId,
      pushToast,
      reloadOverBreakNotes,
      user?.displayName,
      user?.email,
      user?.name,
      user?.role,
    ]
  );

  const handleRestoreArchivedNotification = useCallback(
    async (notificationId) => {
      if (!canAccessNotificationArchive) return;
      const id = String(notificationId || "").trim();
      if (!id) return;

      try {
        await restoreNotification(id);
        pushToast({
          type: "success",
          title: "Restored",
          message: "Notification moved back to inbox.",
        });
      } catch (err) {
        console.error("Failed to restore notification:", err);
        pushToast({
          type: "error",
          title: "Restore Failed",
          message: err?.message || "Could not restore notification.",
        });
      } finally {
        await reloadNotifications();
      }
    },
    [canAccessNotificationArchive, pushToast, reloadNotifications]
  );

  const handleDeleteArchivedNotification = useCallback(
    async (notificationId) => {
      if (!canManageNotificationArchive) return;
      const id = String(notificationId || "").trim();
      if (!id) return;

      try {
        await deleteNotification(id);
        pushToast({
          type: "success",
          title: "Deleted",
          message: "Notification deleted permanently.",
        });
      } catch (err) {
        console.error("Failed to delete notification:", err);
        pushToast({
          type: "error",
          title: "Delete Failed",
          message: err?.message || "Could not delete notification.",
        });
      } finally {
        await reloadNotifications();
      }
    },
    [canManageNotificationArchive, pushToast, reloadNotifications]
  );

  const handleDeleteAllArchivedNotifications = useCallback(
    async (ids = []) => {
      if (!canManageNotificationArchive) return;
      const notificationIds = Array.from(
        new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))
      );
      if (!notificationIds.length) return;

      try {
        await deleteAllNotifications(notificationIds);
        pushToast({
          type: "success",
          title: "Deleted",
          message: `${notificationIds.length} archived notification(s) deleted permanently.`,
        });
      } catch (err) {
        console.error("Failed to delete all archived notifications:", err);
        pushToast({
          type: "error",
          title: "Delete Failed",
          message: err?.message || "Could not delete archived notifications.",
        });
      } finally {
        await reloadNotifications();
      }
    },
    [canManageNotificationArchive, pushToast, reloadNotifications]
  );

  const handleRestoreArchivedOverBreakNote = useCallback(
    async (noteId) => {
      if (!canAccessNotificationArchive) return;
      const id = String(noteId || "").trim();
      if (!id) return;

      try {
        await restoreOverBreakNote(id);
        pushToast({
          type: "success",
          title: "Restored",
          message: "Over-break record restored.",
        });
      } catch (err) {
        console.error("Failed to restore over-break record:", err);
        pushToast({
          type: "error",
          title: "Restore Failed",
          message: err?.message || "Could not restore over-break record.",
        });
      } finally {
        await reloadOverBreakNotes();
      }
    },
    [canAccessNotificationArchive, pushToast, reloadOverBreakNotes]
  );

  const handleDeleteArchivedOverBreakNote = useCallback(
    async (noteId) => {
      if (!canManageNotificationArchive) return;
      const id = String(noteId || "").trim();
      if (!id) return;

      try {
        await deleteOverBreakNote(id);
        pushToast({
          type: "success",
          title: "Deleted",
          message: "Over-break record deleted permanently.",
        });
      } catch (err) {
        console.error("Failed to delete over-break record:", err);
        pushToast({
          type: "error",
          title: "Delete Failed",
          message: err?.message || "Could not delete over-break record.",
        });
      } finally {
        await reloadOverBreakNotes();
      }
    },
    [canManageNotificationArchive, pushToast, reloadOverBreakNotes]
  );

  const handleDeleteAllArchivedOverBreakNotes = useCallback(
    async (ids = []) => {
      if (!canManageNotificationArchive) return;
      const noteIds = Array.from(
        new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))
      );
      if (!noteIds.length) return;

      try {
        await deleteAllOverBreakNotes(noteIds);
        pushToast({
          type: "success",
          title: "Deleted",
          message: `${noteIds.length} archived over-break record(s) deleted permanently.`,
        });
      } catch (err) {
        console.error("Failed to delete all archived over-break records:", err);
        pushToast({
          type: "error",
          title: "Delete Failed",
          message: err?.message || "Could not delete archived over-break records.",
        });
      } finally {
        await reloadOverBreakNotes();
      }
    },
    [canManageNotificationArchive, pushToast, reloadOverBreakNotes]
  );

  const reloadActiveBreaks = useCallback(async () => {
    if (!isAuthenticated || !user) {
      setActiveBreaksByUserId((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }

    setLoadingBreaks(true);

    try {
      const rows = await getActiveBreaks();
      const next = {};

      for (const row of Array.isArray(rows) ? rows : []) {
        const uid = String(row?.userId || "");
        if (!uid) continue;

        next[uid] = row;

        try {
          const reminderResult = await ensureBreakReminder({
            userId: uid,
            name: row?.name || "",
            email: row?.email || "",
            activeBreak: row,
          });

          if (reminderResult?.created) {
            await reloadNotifications();
          }
        } catch (err) {
          console.error("Failed to create break reminder:", err);
        }

        try {
          const overBreakResult = await ensureOverBreakEscalation({
            userId: uid,
            name: row?.name || "",
            email: row?.email || "",
            activeBreak: row,
          });

          if (overBreakResult?.created || overBreakResult?.updated) {
            await reloadNotifications();
            await reloadOverBreakNotes();
          }
        } catch (err) {
          console.error("Failed to save over-break escalation:", err);
        }
      }

      setActiveBreaksByUserId(next);
    } catch (err) {
      console.error("Failed to load active breaks:", err);
      setActiveBreaksByUserId((prev) => (Object.keys(prev).length ? {} : prev));
    } finally {
      setLoadingBreaks(false);
    }
  }, [isAuthenticated, reloadNotifications, reloadOverBreakNotes, user]);

  const reloadBreakUsage = useCallback(async () => {
    if (!isAuthenticated || !user) {
      setBreakUsageByUserId((prev) => (Object.keys(prev).length ? {} : prev));
      setBreakLogsByUserId((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }

    if (!validEmployees.length) {
      setBreakUsageByUserId((prev) => (Object.keys(prev).length ? {} : prev));
      setBreakLogsByUserId((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }

    setLoadingBreakUsage(true);

    try {
      const items = validEmployees.map((emp) => String(getUserId(emp)));

      const results = await mapWithConcurrency(items, 6, async (userId) => {
        const logs = await getBreakLogsForUserOnDate(userId, new Date());
        return {
          userId,
          logs,
          usage: calculateBreakUsageMinutes(logs, Date.now()),
        };
      });

      const nextUsage = {};
      const nextLogs = {};

      for (const result of results) {
        if (result?.ok) {
          nextUsage[result.value.userId] = result.value.usage;
          nextLogs[result.value.userId] = Array.isArray(result.value.logs) ? result.value.logs : [];
        }
      }

      setBreakUsageByUserId(nextUsage);
      setBreakLogsByUserId(nextLogs);
    } catch (err) {
      console.error("Failed to load break usage:", err);
    } finally {
      setLoadingBreakUsage(false);
    }
  }, [isAuthenticated, user, validEmployees]);

  const reloadEmployeeProfiles = useCallback(async () => {
    if (!isAuthenticated || !user) {
      setEmployeeProfilesByUserId({});
      setEmployeeProfilesError("");
      return;
    }

    if (!validEmployees.length) {
      setEmployeeProfilesByUserId({});
      setEmployeeProfilesError("");
      return;
    }

    setLoadingEmployeeProfiles(true);
    setEmployeeProfilesError("");

    try {
      const userIds = validEmployees.map((emp) => String(getUserId(emp)));
      const profiles = await getEmployeeProfilesByUserIds(userIds);
      setEmployeeProfilesByUserId(profiles || {});
    } catch (err) {
      console.error("Failed to load employee profiles:", err);
      setEmployeeProfilesByUserId({});
      setEmployeeProfilesError(err?.message || "Failed to load employee profiles");
    } finally {
      setLoadingEmployeeProfiles(false);
    }
  }, [isAuthenticated, user, validEmployees]);

  const reloadSpecialUsers = useCallback(async () => {
    if (!isAuthenticated || !user || !canLoadSpecialUsers) {
      setSpecialUsers([]);
      setSpecialUsersError("");
      return;
    }

    setLoadingSpecialUsers(true);
    setSpecialUsersError("");

    try {
      const rows = await getSpecialPortalUsers();
      setSpecialUsers(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.error("Failed to load special users:", err);
      setSpecialUsers([]);
      setSpecialUsersError(err?.message || "Failed to load special users");
    } finally {
      setLoadingSpecialUsers(false);
    }
  }, [canLoadSpecialUsers, isAuthenticated, user]);

  const reloadPortalUserRequests = useCallback(async () => {
    if (!isAuthenticated || !user || !canReviewPortalUserRequests) {
      setPortalUserRequests([]);
      setPortalUserRequestsError("");
      return;
    }

    setLoadingPortalUserRequests(true);
    setPortalUserRequestsError("");

    try {
      const rows = await getPortalUserRequests();
      setPortalUserRequests(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.error("Failed to load portal user requests:", err);
      setPortalUserRequests([]);
      setPortalUserRequestsError(err?.message || "Failed to load pending user requests");
    } finally {
      setLoadingPortalUserRequests(false);
    }
  }, [canReviewPortalUserRequests, isAuthenticated, user]);

  const reloadEmployeePermissions = useCallback(async () => {
    if (
      !isAuthenticated ||
      !user ||
      !canAccessPage(user.role, "control_panel", user?.allowedPages)
    ) {
      setEmployeePermissionsByUserId({});
      setEmployeePermissionsError("");
      return;
    }

    if (!validEmployees.length) {
      setEmployeePermissionsByUserId({});
      setEmployeePermissionsError("");
      return;
    }

    setLoadingEmployeePermissions(true);
    setEmployeePermissionsError("");

    try {
      const userIds = validEmployees.map((emp) => String(getUserId(emp)));
      const results = await mapWithConcurrency(userIds, 8, async (userId) => {
        const permission = await getEmployeePermission(userId);
        return { userId, permission };
      });

      const next = {};
      const failed = [];

      for (let idx = 0; idx < results.length; idx++) {
        const userId = userIds[idx];
        if (results[idx]?.ok) {
          next[userId] = results[idx].value.permission || null;
        } else {
          failed.push(userId);
        }
      }

      setEmployeePermissionsByUserId(next);

      if (failed.length > 0) {
        setEmployeePermissionsError("Some employee permissions could not be loaded.");
      }
    } catch (err) {
      console.error("Failed to load employee permissions:", err);
      setEmployeePermissionsByUserId({});
      setEmployeePermissionsError(err?.message || "Failed to load employee permissions");
    } finally {
      setLoadingEmployeePermissions(false);
    }
  }, [isAuthenticated, user, validEmployees]);

  const reloadAssignments = useCallback(async () => {
    if (!isAuthenticated || !user || !canAccessPage(user.role, "assignment", user?.allowedPages)) {
      setAssignments([]);
      setArchivedAssignments([]);
      setAssignmentsError("");
      return;
    }

    setLoadingAssignments(true);
    setAssignmentsError("");

    try {
      const rows = await getAssignments({ includeArchived: true });
      const allRows = Array.isArray(rows) ? rows : [];
      const activeRows = allRows.filter((row) => !row?.archived);
      const archivedRows = allRows.filter((row) => !!row?.archived);
      setAssignments(activeRows);
      setArchivedAssignments(archivedRows);

      try {
        await createDeadlineAlertsForAssignments(activeRows);
      } catch (err) {
        console.error("Failed to create assignment deadline alerts:", err);
      }
    } catch (err) {
      console.error("Failed to load assignments:", err);
      setAssignments([]);
      setArchivedAssignments([]);
      setAssignmentsError(err?.message || "Failed to load assignments");
    } finally {
      setLoadingAssignments(false);
    }
  }, [isAuthenticated, user]);

  const reloadAnnouncements = useCallback(async () => {
    if (!isAuthenticated || !user) {
      setAnnouncements([]);
      setAnnouncementsError("");
      return;
    }

    setLoadingAnnouncements(true);
    setAnnouncementsError("");

    try {
      const rows = await getAnnouncements({ limitCount: 120, includeDeleted: true });
      setAnnouncements(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.error("Failed to load announcements:", err);
      setAnnouncements([]);
      setAnnouncementsError(err?.message || "Failed to load announcements");
    } finally {
      setLoadingAnnouncements(false);
    }
  }, [isAuthenticated, user]);

  const handleSaveEmployeeStartDate = useCallback(async (payload = {}) => {
    const uid = String(payload?.userId || "");
    if (!uid) throw new Error("Missing userId");

    const saved = await saveEmployeeStartDate(payload);

    setEmployeeProfilesByUserId((prev) => ({
      ...prev,
      [uid]: {
        ...(prev[uid] || {}),
        ...(saved || {}),
        userId: uid,
      },
    }));

    return saved;
  }, []);

  const handleUpdateEmployeeAllowedPages = useCallback(
    async ({ userId, allowedPages = [], employeeData = {} } = {}) => {
      const uid = String(userId || "");
      if (!uid) throw new Error("Missing employee user id");

      const result = await updateEmployeeAllowedPages(uid, allowedPages, employeeData);
      const nextAllowedPages = Array.isArray(result?.allowedPages) ? result.allowedPages : [];

      setEmployeePermissionsByUserId((prev) => ({
        ...prev,
        [uid]: {
          ...(prev[uid] || {}),
          userId: uid,
          role: ROLES.EMPLOYEE,
          name: employeeData?.name || prev[uid]?.name || "",
          email: employeeData?.email || prev[uid]?.email || "",
          allowedPages: nextAllowedPages,
        },
      }));

      return result;
    },
    []
  );

  const handleUpdatePortalUserAllowedPages = useCallback(async ({ userId, allowedPages = [] } = {}) => {
    const uid = String(userId || "");
    if (!uid) throw new Error("Missing portal user id");

    const result = await updatePortalUserAllowedPages(uid, allowedPages);
    const nextAllowedPages = Array.isArray(result?.allowedPages) ? result.allowedPages : [];

    setSpecialUsers((prev) =>
      prev.map((row) =>
        String(row?.uid || row?.id || "") === uid ? { ...row, allowedPages: nextAllowedPages } : row
      )
    );

    return result;
  }, []);

  const handleTransferEmployeeToPortalRole = useCallback(
    async ({ userId, role, employeeData = {} } = {}) => {
      const uid = String(userId || "").trim();
      if (!uid) throw new Error("Missing employee user id");

      return transferEmployeeToPortalRole(uid, role, employeeData);
    },
    []
  );

  const handleTransferSpecialUserToEmployeeRole = useCallback(
    async ({ userId, userData = {} } = {}) => {
      const uid = String(userId || "").trim();
      if (!uid) throw new Error("Missing user id");

      return transferPortalUserToEmployeeRole(uid, userData);
    },
    []
  );

  const handleDeleteAdminPortalUser = useCallback(async ({ userId } = {}) => {
    const uid = String(userId || "").trim();
    if (!uid) throw new Error("Missing user id");

    return deleteAdminPortalUser(uid);
  }, []);

  const handleAdminUpdateEmployeePassword = useCallback(
    async ({ userId, newPassword, employeeData = {} } = {}) => {
      const uid = String(userId || "").trim();
      if (!uid) throw new Error("Missing employee user id");

      return adminUpdateEmployeePortalPassword({
        userId: uid,
        newPassword,
        employeeData,
      });
    },
    []
  );

  const handleApplyRoleCorePagesToAll = useCallback(
    async ({ role, corePages = [], performancePages = [] } = {}) => {
      const normalizedRole = normalizeRole(role);
      const cleanCorePages = Array.from(
        new Set(
          (Array.isArray(corePages) ? corePages : [])
            .map((page) => String(page || "").trim().toLowerCase())
            .filter((page) => CORE_PAGE_KEYS.includes(page))
        )
      );
      const cleanPerformancePages = Array.from(
        new Set(
          (Array.isArray(performancePages) ? performancePages : [])
            .map((page) => String(page || "").trim().toLowerCase())
            .filter((page) => PERFORMANCE_PAGE_KEYS.includes(page))
        )
      );
      const nextRoleManagedPages = Array.from(
        new Set([...cleanCorePages, ...cleanPerformancePages]).values()
      ).filter((page) => ROLE_BULK_MANAGED_PAGE_KEYS.includes(page));

      const mergeWithNonCorePages = (existingAllowedPages = []) => {
        const preserved = (Array.isArray(existingAllowedPages) ? existingAllowedPages : []).filter(
          (page) =>
            PAGE_KEYS.includes(page) &&
            !ROLE_BULK_MANAGED_PAGE_KEYS.includes(page)
        );
        return Array.from(new Set([...nextRoleManagedPages, ...preserved]));
      };

      if (normalizedRole === ROLES.EMPLOYEE) {
        const targets = validEmployees
          .map((emp) => {
            const uid = String(getUserId(emp) || "").trim();
            if (!uid) return null;

            const permission = employeePermissionsByUserId?.[uid] || {};
            const existingAllowedPages =
              Array.isArray(permission?.allowedPages) && permission.allowedPages.length > 0
                ? permission.allowedPages
                : DEFAULT_ROLE_PAGES[ROLES.EMPLOYEE] || [];

            return {
              uid,
              name: getDisplayName(emp),
              email: pick(emp, ["email"], ""),
              allowedPages: mergeWithNonCorePages(existingAllowedPages),
            };
          })
          .filter(Boolean);

        const results = await mapWithConcurrency(targets, 8, async (target) => {
          await updateEmployeeAllowedPages(target.uid, target.allowedPages, {
            name: target.name,
            email: target.email,
          });
          return target;
        });

        const succeeded = [];
        const failed = [];
        for (let idx = 0; idx < results.length; idx += 1) {
          const result = results[idx];
          if (result?.ok) {
            succeeded.push(result.value);
          } else {
            failed.push(targets[idx]?.uid || `index_${idx}`);
          }
        }

        if (succeeded.length) {
          setEmployeePermissionsByUserId((prev) => {
            const next = { ...(prev || {}) };
            for (const item of succeeded) {
              next[item.uid] = {
                ...(next[item.uid] || {}),
                userId: item.uid,
                role: ROLES.EMPLOYEE,
                name: item.name || next[item.uid]?.name || "",
                email: item.email || next[item.uid]?.email || "",
                allowedPages: item.allowedPages,
              };
            }
            return next;
          });
        }

        return {
          role: normalizedRole,
          updatedCount: succeeded.length,
          failedCount: failed.length,
        };
      }

      const supportedSpecialRoles = [ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR];
      if (!supportedSpecialRoles.includes(normalizedRole)) {
        throw new Error("Choose Admin, Accounting, Visitor, or Employee.");
      }

      const targets = (Array.isArray(specialUsers) ? specialUsers : [])
        .filter((row) => normalizeRole(row?.role) === normalizedRole)
        .map((row) => {
          const uid = String(row?.uid || row?.id || "").trim();
          if (!uid) return null;

          const existingAllowedPages =
            Array.isArray(row?.allowedPages) && row.allowedPages.length > 0
              ? row.allowedPages
              : DEFAULT_ROLE_PAGES[normalizedRole] || [];

          return {
            uid,
            allowedPages: mergeWithNonCorePages(existingAllowedPages),
          };
        })
        .filter(Boolean);

      const results = await mapWithConcurrency(targets, 8, async (target) => {
        await updatePortalUserAllowedPages(target.uid, target.allowedPages);
        return target;
      });

      const succeeded = [];
      const failed = [];
      for (let idx = 0; idx < results.length; idx += 1) {
        const result = results[idx];
        if (result?.ok) {
          succeeded.push(result.value);
        } else {
          failed.push(targets[idx]?.uid || `index_${idx}`);
        }
      }

      if (succeeded.length) {
        const byId = new Map(succeeded.map((item) => [item.uid, item.allowedPages]));
        setSpecialUsers((prev) =>
          (Array.isArray(prev) ? prev : []).map((row) => {
            const uid = String(row?.uid || row?.id || "").trim();
            if (!uid || !byId.has(uid)) return row;
            return {
              ...row,
              allowedPages: byId.get(uid),
            };
          })
        );
      }

      return {
        role: normalizedRole,
        updatedCount: succeeded.length,
        failedCount: failed.length,
      };
    },
    [employeePermissionsByUserId, specialUsers, validEmployees]
  );

  const handleCreateAssignment = useCallback(
    async (payload = {}) => {
      const result = await createAssignment(payload);
      await reloadAssignments();
      return result;
    },
    [reloadAssignments]
  );

  const handleUpdateAssignment = useCallback(
    async (assignmentId, updates = {}) => {
      await updateAssignment(assignmentId, updates);
      await reloadAssignments();
    },
    [reloadAssignments]
  );

  const handleDeleteAssignment = useCallback(
    async (assignmentId, actor = {}) => {
      await deleteAssignment(assignmentId, actor);
      await reloadAssignments();
    },
    [reloadAssignments]
  );

  const handleArchiveAssignment = useCallback(
    async (assignmentId, actor = {}) => {
      await archiveAssignment(assignmentId, actor);
      await reloadAssignments();
    },
    [reloadAssignments]
  );

  const handleRepostAssignment = useCallback(
    async (assignmentId, updates = {}, actor = {}) => {
      await repostAssignment(assignmentId, updates, actor);
      await reloadAssignments();
      await reloadNotifications();
    },
    [reloadAssignments, reloadNotifications]
  );

  const handleMarkAssignmentCompleted = useCallback(
    async (assignmentId, actor = {}) => {
      await markAssignmentCompleted(assignmentId, actor);
      await reloadAssignments();
      await reloadNotifications();
    },
    [reloadAssignments, reloadNotifications]
  );

  const handleReviewAssignmentCompletion = useCallback(
    async (assignmentId, decision = "", reviewer = {}) => {
      await reviewAssignmentCompletion(assignmentId, decision, reviewer);
      await reloadAssignments();
      await reloadNotifications();
    },
    [reloadAssignments, reloadNotifications]
  );

  const handleRequestAssignmentAccess = useCallback(
    async (assignmentId, payload = {}) => {
      await requestAssignmentAccess(assignmentId, payload);
      await reloadAssignments();
      await reloadNotifications();
    },
    [reloadAssignments, reloadNotifications]
  );

  const handleApproveAssignmentAccess = useCallback(
    async (assignmentId, requesterUserId, approver = {}) => {
      await approveAssignmentAccess(assignmentId, requesterUserId, approver);
      await reloadAssignments();
      await reloadNotifications();
    },
    [reloadAssignments, reloadNotifications]
  );

  const handleSubmitPortalUserRequest = useCallback(
    async (e) => {
      e?.preventDefault?.();
      if (!canRequestPortalUser || !user) return;

      setRequestingNewUser(true);
      try {
        const result = await createPortalUserRequest({
          firstName: newUserRequestForm.firstName,
          lastName: newUserRequestForm.lastName,
          email: newUserRequestForm.email,
          role: newUserRequestForm.role,
          note: newUserRequestForm.note,
          requestedBy: user,
        });

        setShowUserRequestModal(false);
        setNewUserRequestForm({
          firstName: "",
          lastName: "",
          email: "",
          role: ROLES.VISITOR,
          note: "",
        });

        pushToast({
          type: "success",
          title: "Request Sent",
          message: `Super Admin approval is required before ${
            result?.email || "this user"
          } is created.`,
        });

        await reloadNotifications();
      } catch (err) {
        console.error("Failed to submit portal user request:", err);
        pushToast({
          type: "error",
          title: "Request Failed",
          message: err?.message || "Could not submit user request.",
        });
      } finally {
        setRequestingNewUser(false);
      }
    },
    [canRequestPortalUser, newUserRequestForm, pushToast, reloadNotifications, user]
  );

  const handleApprovePortalUserRequest = useCallback(
    async (requestId, payload = {}) => {
      if (!canReviewPortalUserRequests || !user) return;

      const normalizedRequestId = String(requestId || "").trim();
      if (!normalizedRequestId) throw new Error("Missing request id");

      setProcessingPortalUserRequest({
        id: normalizedRequestId,
        action: "approve",
      });

      try {
        const result = await approvePortalUserRequest(normalizedRequestId, {
          password: payload?.password || "",
          approvedBy: user,
        });

        await reloadPortalUserRequests();
        await reloadSpecialUsers();
        await reloadNotifications();

        const createdName = `${result?.user?.firstName || ""} ${result?.user?.lastName || ""}`.trim();
        pushToast({
          type: "success",
          title: "Request Approved",
          message: `${createdName || result?.user?.email || "User"} has been created.`,
        });
      } finally {
        setProcessingPortalUserRequest({
          id: "",
          action: "",
        });
      }
    },
    [
      canReviewPortalUserRequests,
      pushToast,
      reloadNotifications,
      reloadPortalUserRequests,
      reloadSpecialUsers,
      user,
    ]
  );

  const handleRejectPortalUserRequest = useCallback(
    async (requestId, payload = {}) => {
      if (!canReviewPortalUserRequests || !user) return;

      const normalizedRequestId = String(requestId || "").trim();
      if (!normalizedRequestId) throw new Error("Missing request id");

      setProcessingPortalUserRequest({
        id: normalizedRequestId,
        action: "reject",
      });

      try {
        await rejectPortalUserRequest(normalizedRequestId, {
          reason: payload?.reason || "",
          rejectedBy: user,
        });

        await reloadPortalUserRequests();
        await reloadNotifications();

        pushToast({
          type: "success",
          title: "Request Rejected",
          message: "The user creation request has been rejected.",
        });
      } finally {
        setProcessingPortalUserRequest({
          id: "",
          action: "",
        });
      }
    },
    [canReviewPortalUserRequests, pushToast, reloadNotifications, reloadPortalUserRequests, user]
  );

  const handleUpdateSpecialUserProfile = useCallback(
    async (userId, payload = {}) => {
      try {
        const result = await updatePortalUserProfileDetails(userId, payload);
        await reloadSpecialUsers();

        const fullName = `${result?.firstName || ""} ${result?.lastName || ""}`.trim();
        pushToast({
          type: "success",
          title: "Profile Updated",
          message: `${fullName || "User profile"} details were updated.`,
        });

        return result;
      } catch (err) {
        pushToast({
          type: "error",
          title: "Update Failed",
          message: err?.message || "Could not update user profile details.",
        });
        throw err;
      }
    },
    [pushToast, reloadSpecialUsers]
  );

  const handleChangeSpecialUserEmail = useCallback(
    async (userId, nextEmail) => {
      try {
        const result = await updatePortalUserEmail(userId, nextEmail);
        await reloadSpecialUsers();

        pushToast({
          type: "success",
          title: "Email Updated",
          message: result?.message || `Profile email changed to ${result?.email || nextEmail}.`,
        });

        return result;
      } catch (err) {
        pushToast({
          type: "error",
          title: "Email Update Failed",
          message: err?.message || "Could not change user email.",
        });
        throw err;
      }
    },
    [pushToast, reloadSpecialUsers]
  );

  const handleSendSpecialUserPasswordReset = useCallback(
    async (email) => {
      try {
        const result = await sendPortalUserPasswordResetEmail(email);
        pushToast({
          type: "success",
          title: "Reset Email Sent",
          message: result?.message || "Password reset email sent.",
        });
        return result;
      } catch (err) {
        pushToast({
          type: "error",
          title: "Reset Failed",
          message: err?.message || "Could not send password reset email.",
        });
        throw err;
      }
    },
    [pushToast]
  );

  const handleChangeOwnPassword = useCallback(
    async ({ oldPassword, newPassword, confirmPassword } = {}) => {
      const currentUserId = String(
        user?.userId ?? user?.id ?? user?.uid ?? user?.firebaseUid ?? ""
      ).trim();
      const currentRole = String(user?.role || "").trim().toLowerCase();

      try {
        const result =
          currentRole === ROLES.EMPLOYEE
            ? await updateEmployeePortalPassword(currentUserId, {
                oldPassword,
                newPassword,
                confirmPassword,
              })
            : await updatePortalUserPassword({
                userId: currentUserId,
                email: user?.email || "",
                oldPassword,
                newPassword,
                confirmPassword,
              });
        if (!result?.success) {
          throw new Error(result?.message || "Could not change password.");
        }

        pushToast({
          type: "success",
          title: "Password Updated",
          message: result?.message || "Your password has been updated.",
        });

        return result;
      } catch (err) {
        pushToast({
          type: "error",
          title: "Password Update Failed",
          message: err?.message || "Could not change password.",
        });
        throw err;
      }
    },
    [pushToast, user?.email, user?.firebaseUid, user?.id, user?.role, user?.uid, user?.userId]
  );

  const handlePostAnnouncement = useCallback(
    async (e) => {
      e?.preventDefault?.();

      if (!canPostAnnouncements) return;

      const headline = String(announcementHeadline || "").trim();
      const note = String(announcementDraft || "").trim();
      if (!headline) {
        pushToast({
          type: "warning",
          title: "Headline Required",
          message: "Please enter a headline before posting.",
        });
        return;
      }
      if (!note) {
        pushToast({
          type: "warning",
          title: "Note Required",
          message: "Please enter a note before posting.",
        });
        return;
      }

      const postAtMs = new Date(announcementPostAt).getTime();
      const expireAtMs = new Date(announcementExpireAt).getTime();
      if (!Number.isFinite(postAtMs) || !Number.isFinite(expireAtMs)) {
        pushToast({
          type: "warning",
          title: "Invalid Time",
          message: "Please set valid post and expire date/time values.",
        });
        return;
      }
      if (expireAtMs <= postAtMs) {
        pushToast({
          type: "warning",
          title: "Invalid Time Range",
          message: "Expire time must be later than post time.",
        });
        return;
      }

      setSavingAnnouncement(true);
      try {
        let portalUsers = Array.isArray(specialUsers) ? specialUsers : [];
        if (!portalUsers.length && canLoadSpecialUsers) {
          try {
            const rows = await getSpecialPortalUsers();
            portalUsers = Array.isArray(rows) ? rows : [];
          } catch {
            // Keep posting flow resilient even if this lookup is denied.
            portalUsers = [];
          }
        }

        const recipientUserIds = Array.from(
          new Set(
            [
              ...validEmployees.map((emp) => String(getUserId(emp) || "").trim()),
              ...portalUsers.map((acct) => String(getUserId(acct) || "").trim()),
              String(currentViewerIdentity?.userId || "").trim(),
            ].filter(Boolean)
          )
        );

        await createAnnouncement({
          headline,
          note,
          createdByUserId: String(currentViewerIdentity?.userId || ""),
          createdByName: user?.name || user?.displayName || user?.email || "Portal User",
          createdByRole: viewerRole,
          publishAt: new Date(postAtMs),
          expiresAt: new Date(expireAtMs),
          recipientUserIds,
          notifyEmployees: true,
        });

        await reloadAnnouncements();
        await reloadNotifications();

        setShowAnnouncementModal(false);
        setAnnouncementHeadline("");
        setAnnouncementDraft("");
        pushToast({
          type: "success",
          title: "Announcement Posted",
          message: "The note is now visible on Employee Dashboard.",
        });
      } catch (err) {
        console.error("Failed to post announcement:", err);
        pushToast({
          type: "error",
          title: "Post Failed",
          message: err?.message || "Could not post announcement.",
        });
      } finally {
        setSavingAnnouncement(false);
      }
    },
    [
      announcementHeadline,
      announcementDraft,
      announcementExpireAt,
      announcementPostAt,
      canPostAnnouncements,
      canLoadSpecialUsers,
      currentViewerIdentity?.userId,
      pushToast,
      reloadAnnouncements,
      reloadNotifications,
      specialUsers,
      user?.displayName,
      user?.email,
      user?.name,
      validEmployees,
      viewerRole,
    ]
  );

  const handleUpdateAnnouncement = useCallback(
    async (announcementId, updates = {}) => {
      await updateAnnouncement(announcementId, updates);
      await reloadAnnouncements();
    },
    [reloadAnnouncements]
  );

  const handleDeleteAnnouncement = useCallback(
    async (announcementId) => {
      await deleteAnnouncement(announcementId, {
        userId: currentViewerIdentity?.userId || "",
        name: user?.name || user?.displayName || user?.email || "Portal User",
      });
      await reloadAnnouncements();
    },
    [currentViewerIdentity?.userId, reloadAnnouncements, user?.displayName, user?.email, user?.name]
  );

  const handleRestoreAnnouncement = useCallback(
    async (announcementId) => {
      await restoreAnnouncement(announcementId);
      await reloadAnnouncements();
    },
    [reloadAnnouncements]
  );

  const handlePermanentDeleteAnnouncement = useCallback(
    async (announcementId) => {
      await permanentlyDeleteAnnouncement(announcementId);
      await reloadAnnouncements();
    },
    [reloadAnnouncements]
  );

  useEffect(() => {
    periodicRefreshHandlersRef.current = {
      reloadActiveBreaks,
      reloadBreakUsage,
      reloadNotifications,
      reloadAnnouncements,
      reloadOverBreakNotes,
      reloadPortalUserRequests,
    };
  }, [
    reloadActiveBreaks,
    reloadBreakUsage,
    reloadNotifications,
    reloadAnnouncements,
    reloadOverBreakNotes,
    reloadPortalUserRequests,
  ]);

  useEffect(() => {
    let cancelled = false;
    let running = false;

    const run = async () => {
      if (cancelled || running) return;

      running = true;
      try {
        const handlers = periodicRefreshHandlersRef.current;
        if (cancelled) return;
        await handlers.reloadActiveBreaks();
        if (cancelled) return;
        await handlers.reloadBreakUsage();
        if (cancelled) return;
        await handlers.reloadNotifications();
        if (cancelled) return;
        await handlers.reloadAnnouncements();
        if (cancelled) return;
        await handlers.reloadOverBreakNotes();
        if (cancelled) return;
        await handlers.reloadPortalUserRequests();
      } finally {
        running = false;
      }
    };

    run();

    const id = setInterval(() => {
      run();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    reloadEmployeeProfiles();
  }, [reloadEmployeeProfiles]);

  useEffect(() => {
    reloadSpecialUsers();
  }, [reloadSpecialUsers]);

  useEffect(() => {
    reloadPortalUserRequests();
  }, [reloadPortalUserRequests]);

  useEffect(() => {
    reloadEmployeePermissions();
  }, [reloadEmployeePermissions]);

  useEffect(() => {
    reloadAssignments();
  }, [reloadAssignments]);

  useEffect(() => {
    reloadAnnouncements();
  }, [reloadAnnouncements]);

  const dashboardEmployees = useMemo(() => {
    const list = Array.isArray(employees) ? employees : [];

    return list.map((emp) => {
      const id = getUserId(emp);
      const uid = id != null ? String(id) : null;

      const dashboardSchedule = uid && Array.isArray(schedulesByUserId?.[uid]) ? schedulesByUserId[uid] : [];
      const dashboardLogsToday = uid ? getTodayBusinessLogsForUser(uid) : [];

      return {
        ...emp,
        dashboardSchedule,
        dashboardLogsToday,
        isLive: uid ? isUserLiveNow(uid) : false,
        isOnBreak: uid ? isUserOnBreak(uid) : false,
        liveHours: uid ? getLiveHoursSinceIn(uid) : 0,
        attendanceStatus: uid
          ? isUserOnBreak(uid)
            ? "On Break"
            : isUserLiveNow(uid)
              ? "Live"
              : "Offline"
          : "Offline",
      };
    });
  }, [employees, schedulesByUserId, getTodayBusinessLogsForUser, isUserLiveNow, isUserOnBreak, getLiveHoursSinceIn]);

  const allEmployeesForSharedPages = useMemo(() => dashboardEmployees, [dashboardEmployees]);

  const employeeDashboardEmployees = useMemo(() => {
    if (!user) return [];

    const normalizedRole = normalizeRole(user?.role);
    const currentUserId = String(
      getUserId(user) ||
        user?.userId ||
        user?.uid ||
        user?.id ||
        user?.firebaseUid ||
        user?.employeeId ||
        ""
    ).trim();

    if (normalizedRole === ROLES.EMPLOYEE) {
      return dashboardEmployees.filter((emp) => {
        const employeeUserId = String(getUserId(emp) || emp?.userId || emp?.id || "").trim();
        return employeeUserId === currentUserId;
      });
    }

    return dashboardEmployees;
  }, [dashboardEmployees, user]);

  const attendanceAndScheduleEmployees = useMemo(() => dashboardEmployees, [dashboardEmployees]);

  const specialUserIdSet = useMemo(
    () =>
      new Set(
        (Array.isArray(specialUsers) ? specialUsers : [])
          .map((row) => String(row?.uid || row?.id || "").trim())
          .filter(Boolean)
      ),
    [specialUsers]
  );

  const controlPanelEmployees = useMemo(() => {
    return validEmployees
      .filter((emp) => {
        const uid = String(getUserId(emp) || "").trim();
        return !!uid && !specialUserIdSet.has(uid);
      })
      .map((emp) => {
      const uid = String(getUserId(emp) || "");
      const permission = employeePermissionsByUserId?.[uid] || {};

      return {
        uid,
        id: uid,
        firstName: getDisplayName(emp),
        lastName: "",
        email: pick(emp, ["email"], ""),
        name: getDisplayName(emp),
        role: ROLES.EMPLOYEE,
        allowedPages:
          Array.isArray(permission?.allowedPages) && permission.allowedPages.length > 0
            ? permission.allowedPages
            : DEFAULT_ROLE_PAGES[ROLES.EMPLOYEE] || [],
      };
    });
  }, [validEmployees, employeePermissionsByUserId, specialUserIdSet]);

  useEffect(() => {
    if (!isAuthenticated || !user) {
      lastAuthSessionKeyRef.current = "";
      return;
    }

    const nextSessionKey = authSessionKey || "__authenticated__";
    if (lastAuthSessionKeyRef.current === nextSessionKey) return;

    lastAuthSessionKeyRef.current = nextSessionKey;
    setActivePage(resolveDefaultActivePage(user));
    setSelectedEmployeeId("");
  }, [isAuthenticated, user, authSessionKey]);

  useEffect(() => {
    if (!user) return;

    if (!canAccessPage(user.role, activePage, user?.allowedPages)) {
      if (canAccessPage(user.role, "employee_dashboard", user?.allowedPages)) {
        setActivePage("employee_dashboard");
      } else {
        setActivePage("dashboard");
      }
    }
  }, [user, activePage]);

  useEffect(() => {
    if (!user) return;

    const normalizedRole = normalizeRole(user?.role);
    const currentUserId = String(
      getUserId(user) ||
        user?.userId ||
        user?.uid ||
        user?.id ||
        user?.firebaseUid ||
        user?.employeeId ||
        ""
    ).trim();

    if (normalizedRole === ROLES.EMPLOYEE) {
      if (String(selectedEmployeeId) !== currentUserId) {
        setSelectedEmployeeId(currentUserId);
      }
      return;
    }

    if (selectedEmployeeId) {
      const exists = employeeDashboardEmployees.some(
        (e) => String(getUserId(e) ?? "") === String(selectedEmployeeId)
      );
      if (exists) return;
    }

    const first = employeeDashboardEmployees.length
      ? String(getUserId(employeeDashboardEmployees[0]) ?? "")
      : "";

    if (String(selectedEmployeeId) !== first) {
      setSelectedEmployeeId(first);
    }
  }, [employeeDashboardEmployees, selectedEmployeeId, user]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const resetScrollPosition = () => {
      const mainEl = portalMainRef.current;
      if (mainEl && typeof mainEl.scrollTo === "function") {
        mainEl.scrollTo({ top: 0, left: 0, behavior: "auto" });
      } else if (mainEl) {
        mainEl.scrollTop = 0;
      }

      if (typeof window.scrollTo === "function") {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
    };

    const rafId = window.requestAnimationFrame(resetScrollPosition);
    return () => window.cancelAnimationFrame(rafId);
  }, [activePage]);

  const selectedEmployee = useMemo(() => {
    const list = Array.isArray(employeeDashboardEmployees) ? employeeDashboardEmployees : [];
    const id = String(selectedEmployeeId || "");
    if (!id) return null;
    return list.find((e) => String(getUserId(e) ?? "") === id) || null;
  }, [employeeDashboardEmployees, selectedEmployeeId]);

  const fetchFullHistoryForUser = useCallback(
    async (userId) => {
      if (!api || !userId) return [];

      const uid = String(userId);

      if (historyRequestedRef.current.has(uid)) {
        return Array.isArray(historyByUserId?.[uid]) ? historyByUserId[uid] : [];
      }

      historyRequestedRef.current.add(uid);

      if (historyAbortRef.current[uid]?.abort) {
        historyAbortRef.current[uid].abort();
      }

      const ac = new AbortController();
      historyAbortRef.current[uid] = ac;

      setLoadingHistoryByUserId((p) => ({ ...p, [uid]: true }));
      setHistoryErrorByUserId((p) => ({ ...p, [uid]: "" }));

      try {
        const logs = await api.getAttendanceLogs(
          { userId: uid, startDate: HISTORY_START_DATE, endDate },
          ac.signal
        );

        const arr = Array.isArray(logs) ? logs : [];
        logAbsentStatusScan(`full-history user ${uid}`, { [uid]: arr });
        setHistoryByUserId((p) => ({ ...p, [uid]: arr }));
        return arr;
      } catch (e) {
        historyRequestedRef.current.delete(uid);

        if (e?.name !== "AbortError") {
          setHistoryErrorByUserId((p) => ({
            ...p,
            [uid]: e?.message || "Failed to load full history",
          }));
        }

        return [];
      } finally {
        setLoadingHistoryByUserId((p) => ({ ...p, [uid]: false }));
      }
    },
    [api, endDate, historyByUserId]
  );

  useEffect(() => {
    if (!showLiveAgentModal) return;
    const uid = String(selectedLiveAgentId || "").trim();
    if (!uid) return;

    fetchFullHistoryForUser(uid).catch(() => {});
  }, [showLiveAgentModal, selectedLiveAgentId, fetchFullHistoryForUser]);

  useEffect(() => {
    const syncBusinessDay = () => {
      const t = getTodayAttendanceKey(attendanceResetTime, businessTimeZone);
      setEndDate((prev) => (prev === t ? prev : t));
    };

    syncBusinessDay();

    const id = setInterval(syncBusinessDay, 60 * 1000);
    return () => clearInterval(id);
  }, [attendanceResetTime, businessTimeZone]);

  useEffect(() => {
    const end = endDate;
    if (rangeDays <= 1) {
      setStartDate(end);
      return;
    }

    const endDt = new Date(`${end}T00:00:00Z`);
    endDt.setUTCDate(endDt.getUTCDate() - (Number(rangeDays) - 1));
    const start = endDt.toISOString().slice(0, 10);
    setStartDate((prev) => (prev === start ? prev : start));
  }, [rangeDays, endDate]);

  useEffect(() => {
    if (!apiKey || !departmentId || !api) {
      setUsersError("Missing VITE_HYACINTH_API_KEY or VITE_HYACINTH_DEPARTMENT_ID in .env");
      return;
    }

    usersAbortRef.current?.abort?.();
    const ac = new AbortController();
    usersAbortRef.current = ac;

    (async () => {
      setLoadingUsers(true);
      setUsersError("");

      try {
        const data = await api.getUsersByDepartment(departmentId, ac.signal);
        const fetchedUsers = Array.isArray(data) ? data : [];

        if (!profileImagesInitializedRef.current) {
          const initialProfileImageMap = buildProfileImageMapByUserId(fetchedUsers);
          profileImagesByUserIdRef.current = initialProfileImageMap;
          profileImagesInitializedRef.current = true;
          setProfileImagesByUserId(initialProfileImageMap);
        }

        const usersWithProfileImages = attachProfileImagesToUsers(
          fetchedUsers,
          profileImagesByUserIdRef.current
        );
        setEmployees(usersWithProfileImages);
      } catch (e) {
        if (e?.name !== "AbortError") {
          setUsersError(e?.message || "Failed to load users");
        }
      } finally {
        setLoadingUsers(false);
      }
    })();

    return () => ac.abort();
  }, [apiKey, departmentId, api]);

  const reloadSchedules = useCallback(async () => {
    if (!api || validEmployees.length === 0) {
      setSchedulesByUserId({});
      setScheduleErrorsByUserId({});
      setSchedulesError("");
      return;
    }

    schedulesAbortRef.current?.abort?.();
    const ac = new AbortController();
    schedulesAbortRef.current = ac;

    setLoadingSchedules(true);
    setSchedulesError("");
    setScheduleErrorsByUserId({});

    try {
      const items = validEmployees.map((emp) => String(getUserId(emp)));

      const results = await mapWithConcurrency(items, 8, async (userId) => {
        const sched = await api.getUserSchedule(userId, ac.signal);
        return { userId, sched: Array.isArray(sched) ? sched : [] };
      });

      const next = {};
      const errs = {};

      for (let idx = 0; idx < results.length; idx++) {
        const userId = items[idx];
        if (results[idx].ok) {
          next[userId] = results[idx].value.sched;
        } else {
          next[userId] = [];
          errs[userId] = results[idx].error?.message || "Failed to load schedule";
        }
      }

      setSchedulesByUserId(next);
      setScheduleErrorsByUserId(errs);
    } catch (e) {
      if (e?.name !== "AbortError") {
        setSchedulesError(e?.message || "Failed to load schedules");
      }
    } finally {
      setLoadingSchedules(false);
    }
  }, [api, validEmployees]);

  useEffect(() => {
    reloadSchedules();
  }, [reloadSchedules]);

  const reloadAttendance = useCallback(async () => {
    if (!api || validEmployees.length === 0) {
      setLogsByUserId({});
      setAttendanceErrorsByUserId({});
      setAttendanceError("");
      return;
    }

    attendanceAbortRef.current?.abort?.();
    const ac = new AbortController();
    attendanceAbortRef.current = ac;

    setLoadingAttendance(true);
    setAttendanceError("");
    setAttendanceErrorsByUserId({});

    try {
      const items = validEmployees.map((emp) => String(getUserId(emp)));

      const results = await mapWithConcurrency(items, 6, async (userId) => {
        const logs = await api.getAttendanceLogs({ userId, startDate, endDate }, ac.signal);
        return { userId, logs: Array.isArray(logs) ? logs : [] };
      });

      const nextLogs = {};
      const errs = {};

      for (let idx = 0; idx < results.length; idx++) {
        const userId = items[idx];
        if (results[idx].ok) {
          nextLogs[userId] = results[idx].value.logs;
        } else {
          nextLogs[userId] = [];
          errs[userId] = results[idx].error?.message || "Failed to load attendance logs";
        }
      }

      logAbsentStatusScan(`range ${startDate} -> ${endDate}`, nextLogs);
      setLogsByUserId(nextLogs);
      setAttendanceErrorsByUserId(errs);
    } catch (e) {
      if (e?.name !== "AbortError") {
        setAttendanceError(e?.message || "Failed to load attendance logs");
      }
    } finally {
      setLoadingAttendance(false);
    }
  }, [api, validEmployees, startDate, endDate]);

  useEffect(() => {
    reloadAttendance();
  }, [reloadAttendance]);

  const reloadTodayLogs = useCallback(async () => {
    if (!api || validEmployees.length === 0) {
      setTodayLogsByUserId({});
      return;
    }

    todayAbortRef.current?.abort?.();
    const ac = new AbortController();
    todayAbortRef.current = ac;

    setLoadingTodayLogs(true);

    const todayBusinessKey = getTodayAttendanceKey(attendanceResetTime, businessTimeZone);
    const fetchStart = addDaysYmd(todayBusinessKey, -1);
    const fetchEnd = addDaysYmd(todayBusinessKey, 1);

    try {
      const items = validEmployees.map((emp) => String(getUserId(emp)));

      const results = await mapWithConcurrency(items, 8, async (userId) => {
        const logs = await api.getAttendanceLogs(
          { userId, startDate: fetchStart, endDate: fetchEnd },
          ac.signal
        );

        const arr = Array.isArray(logs) ? logs : [];
        const filtered = getBusinessDayLogsFromList(
          arr,
          todayBusinessKey,
          attendanceResetTime,
          businessTimeZone
        );

        return { userId, logs: filtered };
      });

      const next = {};
      for (let idx = 0; idx < results.length; idx++) {
        const userId = items[idx];
        next[userId] = results[idx].ok ? results[idx].value.logs : [];
      }

      logAbsentStatusScan(`business-day ${todayBusinessKey}`, next);
      setTodayLogsByUserId(next);
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error("Failed to load business-day logs:", err);
      }
    } finally {
      setLoadingTodayLogs(false);
    }
  }, [api, validEmployees, attendanceResetTime, businessTimeZone]);

  useEffect(() => {
    reloadTodayLogs();
  }, [reloadTodayLogs]);

  const liveAgentsForSidebar = useMemo(() => {
    const idToName = new Map();

    for (const emp of Array.isArray(employees) ? employees : []) {
      const id = getUserId(emp);
      if (!id) continue;
      idToName.set(String(id), getDisplayName(emp));
    }

    const live = [];
    for (const emp of validEmployees) {
      const userId = String(getUserId(emp));
      if (!isUserLiveNow(userId)) continue;

      live.push({
        id: userId,
        name: idToName.get(userId) || `User ${userId}`,
        status: isUserOnBreak(userId) ? "On Break" : "Live",
      });
    }

    return live.sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, validEmployees, isUserLiveNow, isUserOnBreak]);

  const canUseAssignTaskShortcut = useMemo(() => {
    if (!user) return false;
    const role = normalizeRole(user.role);
    if (role !== ROLES.ADMIN && role !== ROLES.SUPER_ADMIN) return false;
    return canAccessPage(user.role, "assignment", user?.allowedPages);
  }, [user]);

  const liveAgentWeeklyWindow = useMemo(() => {
    const end = String(endDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return {
        start: "",
        end: "",
        dayKeySet: new Set(),
      };
    }

    const start = startOfWeekYmd(end);
    const weekEnd = addDaysYmd(start, 6);
    const endForWeek = weekEnd > end ? end : weekEnd;
    const dayKeys = enumerateYmdRange(start, endForWeek);

    return {
      start,
      end: endForWeek,
      dayKeySet: new Set(dayKeys),
    };
  }, [endDate]);

  const selectedLiveAgent = useMemo(() => {
    const uid = String(selectedLiveAgentId || "").trim();
    if (!uid) return null;

    const employee =
      dashboardEmployees.find((emp) => String(getUserId(emp) || "") === uid) || null;
    if (!employee) return null;

    const profile = employeeProfilesByUserId?.[uid] || {};
    const sidebarLiveEntry =
      liveAgentsForSidebar.find((entry) => String(entry?.id || "") === uid) || null;

    const profileImg = String(profileImagesByUserId?.[uid] || "").trim() || getProfileImageUrl(employee);
    const position = getEmployeePositionLabel(employee, profile);

    const joinedYmd = toDateInputValue(
      profile?.startDate ||
        employee?.startDate ||
        employee?.dateJoined ||
        employee?.joinedDate ||
        ""
    );
    const joinedFallbackMs = toMillis(profile?.createdAt ?? employee?.createdAt ?? null);

    const rangeLogs = Array.isArray(logsByUserId?.[uid]) ? logsByUserId[uid] : [];
    const historyLogs = Array.isArray(historyByUserId?.[uid]) ? historyByUserId[uid] : [];

    const tableSourceLogs = historyLogs.length ? historyLogs : rangeLogs;
    const attendanceRows = [];

    for (const log of tableSourceLogs) {
      const tsValue = pick(log, ["timestamp", "createdAt", "time"], null);
      const ts = toMillis(tsValue);
      if (!Number.isFinite(ts)) continue;

      const dayKey = dayKeyFromMsInZone(ts, businessTimeZone);
      if (!liveAgentWeeklyWindow.dayKeySet.has(dayKey)) continue;

      const statusText = pick(log, ["status", "attendanceStatus", "dailyStatus", "remark"], "");
      const statusKey = normalizePerformanceAttendanceStatus(statusText);
      if (!statusKey) continue;

      const rawNoteText = pick(
        log,
        [
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
        ],
        ""
      );
      const noteText =
        String(rawNoteText || "").trim().toLowerCase() ===
        String(statusText || "").trim().toLowerCase()
          ? ""
          : String(rawNoteText || "").trim();

      attendanceRows.push({
        userId: uid,
        employeeName: getDisplayName(employee),
        dayKey,
        statusKey,
        statusText: statusText || PERFORMANCE_STATUS_LABEL_BY_KEY[statusKey] || "",
        noteText,
        ts,
      });
    }

    attendanceRows.sort((a, b) => b.ts - a.ts);
    const breakdownCounts = PERFORMANCE_STATUS_SERIES.reduce((acc, item) => {
      acc[item.key] = 0;
      return acc;
    }, {});

    for (const row of attendanceRows) {
      if (breakdownCounts[row.statusKey] !== undefined) {
        breakdownCounts[row.statusKey] += 1;
      }
    }
    const breakdownTotal = attendanceRows.length;
    const breakdownPieBackground = buildPieConicGradient(
      PERFORMANCE_STATUS_SERIES.map((item) => ({
        color: item.color,
        value: breakdownCounts[item.key],
      })),
      breakdownTotal
    );

    const filteredRows =
      liveAgentLogStatus === "ALL"
        ? attendanceRows
        : attendanceRows.filter((row) => row.statusKey === liveAgentLogStatus);

    const breakLimitMinutes = Math.max(1, Number(DAILY_BREAK_LIMIT_MINUTES) || 60);
    const breakUsage = breakUsageByUserId?.[uid] || {};
    const breakUsedMinutes = Math.max(0, Number(breakUsage?.totalMinutes || 0));
    const breakMinutesLeft = Math.max(0, breakLimitMinutes - breakUsedMinutes);
    const breakRemainingPct = Math.min(
      100,
      Math.max(0, (breakMinutesLeft / Math.max(1, breakLimitMinutes)) * 100)
    );
    const breakHue = Math.round((breakMinutesLeft / Math.max(1, breakLimitMinutes)) * 120);
    const breakRingColor = `hsl(${breakHue} 78% 42%)`;
    const breakRingBackground = `conic-gradient(${breakRingColor} ${breakRemainingPct}%, #e2e8f0 0)`;

    return {
      userId: uid,
      name: getDisplayName(employee),
      email: pick(employee, ["email"], "") || uid,
      position,
      status: sidebarLiveEntry?.status || (isUserOnBreak(uid) ? "On Break" : "Live"),
      joinedText: joinedYmd
        ? formatYmdForDisplay(joinedYmd, businessTimeZone)
        : Number.isFinite(joinedFallbackMs)
          ? formatTsForDisplay(joinedFallbackMs, businessTimeZone)
          : "-",
      profileImg,
      breakdownCounts,
      breakdownTotal,
      breakdownPieBackground,
      breakdownRangeLabel:
        liveAgentWeeklyWindow.start && liveAgentWeeklyWindow.end
          ? `${liveAgentWeeklyWindow.start} -> ${liveAgentWeeklyWindow.end}`
          : "-",
      recentLogs: filteredRows,
      totalRecentLogs: attendanceRows.length,
      hasLogStatusFilter: liveAgentLogStatus !== "ALL",
      hasHistory: historyLogs.length > 0,
      historyLoading: !!loadingHistoryByUserId?.[uid],
      historyError: String(historyErrorByUserId?.[uid] || ""),
      breakLimitMinutes,
      breakUsedMinutes,
      breakMinutesLeft,
      breakRemainingPct,
      breakRingBackground,
    };
  }, [
    selectedLiveAgentId,
    dashboardEmployees,
    employeeProfilesByUserId,
    liveAgentsForSidebar,
    profileImagesByUserId,
    logsByUserId,
    historyByUserId,
    liveAgentLogStatus,
    businessTimeZone,
    loadingHistoryByUserId,
    historyErrorByUserId,
    liveAgentWeeklyWindow,
    isUserOnBreak,
    breakUsageByUserId,
  ]);

  const handleOpenLiveAgentAttendance = useCallback(() => {
    const uid = String(selectedLiveAgent?.userId || "").trim();
    if (!uid) return;

    setSelectedEmployeeId(uid);
    setAttendanceOpenRequest((prev) => ({
      userId: uid,
      requestId: Number(prev?.requestId || 0) + 1,
    }));
    setShowLiveAgentModal(false);
    setActivePage("attendance");
  }, [selectedLiveAgent]);

  const handleOpenLiveAgentAssignTask = useCallback(() => {
    const uid = String(selectedLiveAgent?.userId || "").trim();
    if (!uid) return;

    setAssignmentCreateRequest((prev) => ({
      assigneeUserId: uid,
      requestId: Number(prev?.requestId || 0) + 1,
    }));
    setShowLiveAgentModal(false);
    setActivePage("assignment");
  }, [selectedLiveAgent]);

  const invoiceEmbedUrl =
    import.meta.env.VITE_INVOICES_EMBED_URL ||
    "https://us-central1-zahga-crm.cloudfunctions.net/api/invoices?apiKey=hhi_0e2ba3c7f94bd6c11b324d01c01ce7f28910d04dfe4163672b0e5dcba0bce5e3";

  const sharedPageData = useMemo(
    () => ({
      employees: allEmployeesForSharedPages,
      schedulesByUserId,
      logsByUserId,
      todayLogsByUserId,
      historyByUserId,
      breakLogsByUserId,
      activeBreaksByUserId,
      breakUsageByUserId,
      employeeProfilesByUserId,
      assignments,
      archivedAssignments,
      announcements,
      specialUsers,
      portalUserRequests,
      employeePermissionsByUserId,
      notifications,
      archivedNotifications,
      overBreakNotes,
      archivedOverBreakNotes,
      profileImagesByUserId,
      attendanceResetTime,
      businessTimeZone,
      startDate,
      endDate,
      rangeDays,
      rangeOptions: RANGE_OPTIONS,
      nowMs,
      loading: {
        users: loadingUsers,
        schedules: loadingSchedules,
        attendance: loadingAttendance,
        todayLogs: loadingTodayLogs,
        breaks: loadingBreaks,
        breakUsage: loadingBreakUsage,
        employeeProfiles: loadingEmployeeProfiles,
        specialUsers: loadingSpecialUsers,
        employeePermissions: loadingEmployeePermissions,
        assignments: loadingAssignments,
        announcements: loadingAnnouncements,
        portalUserRequests: loadingPortalUserRequests,
      },
      errors: {
        users: usersError,
        schedules: schedulesError,
        attendance: attendanceError,
        employeeProfiles: employeeProfilesError,
        specialUsers: specialUsersError,
        employeePermissions: employeePermissionsError,
        assignments: assignmentsError,
        announcements: announcementsError,
        portalUserRequests: portalUserRequestsError,
      },
      reload: {
        schedules: reloadSchedules,
        attendance: reloadAttendance,
        todayLogs: reloadTodayLogs,
        employeeProfiles: reloadEmployeeProfiles,
        specialUsers: reloadSpecialUsers,
        employeePermissions: reloadEmployeePermissions,
        assignments: reloadAssignments,
        announcements: reloadAnnouncements,
        portalUserRequests: reloadPortalUserRequests,
        activeBreaks: reloadActiveBreaks,
        breakUsage: reloadBreakUsage,
        notifications: reloadNotifications,
        overBreakNotes: reloadOverBreakNotes,
      },
      actions: {
        saveEmployeeStartDate: handleSaveEmployeeStartDate,
        updateEmployeeAllowedPages: handleUpdateEmployeeAllowedPages,
        updatePortalUserAllowedPages: handleUpdatePortalUserAllowedPages,
        createAssignment: handleCreateAssignment,
        updateAssignment: handleUpdateAssignment,
        deleteAssignment: handleDeleteAssignment,
        archiveAssignment: handleArchiveAssignment,
        repostAssignment: handleRepostAssignment,
        completeAssignment: handleMarkAssignmentCompleted,
        reviewAssignmentCompletion: handleReviewAssignmentCompletion,
        requestAssignmentAccess: handleRequestAssignmentAccess,
        approveAssignmentAccess: handleApproveAssignmentAccess,
        createAnnouncement: handlePostAnnouncement,
        updateAnnouncement: handleUpdateAnnouncement,
        deleteAnnouncement: handleDeleteAnnouncement,
        restoreAnnouncement: handleRestoreAnnouncement,
        permanentlyDeleteAnnouncement: handlePermanentDeleteAnnouncement,
      },
      viewer: user,
      invoiceEmbedUrl,
    }),
    [
      allEmployeesForSharedPages,
      schedulesByUserId,
      logsByUserId,
      todayLogsByUserId,
      historyByUserId,
      breakLogsByUserId,
      activeBreaksByUserId,
      breakUsageByUserId,
      employeeProfilesByUserId,
      assignments,
      archivedAssignments,
      announcements,
      specialUsers,
      portalUserRequests,
      employeePermissionsByUserId,
      notifications,
      archivedNotifications,
      overBreakNotes,
      archivedOverBreakNotes,
      profileImagesByUserId,
      attendanceResetTime,
      businessTimeZone,
      startDate,
      endDate,
      rangeDays,
      RANGE_OPTIONS,
      nowMs,
      loadingUsers,
      loadingSchedules,
      loadingAttendance,
      loadingTodayLogs,
      loadingBreaks,
      loadingBreakUsage,
      loadingEmployeeProfiles,
      loadingSpecialUsers,
      loadingEmployeePermissions,
      loadingAssignments,
      loadingAnnouncements,
      loadingPortalUserRequests,
      usersError,
      schedulesError,
      attendanceError,
      employeeProfilesError,
      specialUsersError,
      employeePermissionsError,
      assignmentsError,
      announcementsError,
      portalUserRequestsError,
      reloadSchedules,
      reloadAttendance,
      reloadTodayLogs,
      reloadEmployeeProfiles,
      reloadSpecialUsers,
      reloadEmployeePermissions,
      reloadAssignments,
      reloadAnnouncements,
      reloadPortalUserRequests,
      reloadActiveBreaks,
      reloadBreakUsage,
      reloadNotifications,
      reloadOverBreakNotes,
      handleSaveEmployeeStartDate,
      handleUpdateEmployeeAllowedPages,
      handleUpdatePortalUserAllowedPages,
      handleCreateAssignment,
      handleUpdateAssignment,
      handleDeleteAssignment,
      handleArchiveAssignment,
      handleRepostAssignment,
      handleMarkAssignmentCompleted,
      handleReviewAssignmentCompletion,
      handleRequestAssignmentAccess,
      handleApproveAssignmentAccess,
      handlePostAnnouncement,
      handleUpdateAnnouncement,
      handleDeleteAnnouncement,
      handleRestoreAnnouncement,
      handlePermanentDeleteAnnouncement,
      user,
      invoiceEmbedUrl,
    ]
  );

  const globalError = usersError || schedulesError || attendanceError || employeeProfilesError;
  const activePageHeader = useMemo(
    () => PAGE_HEADER_TITLES[activePage] || formatTargetPageLabel(activePage),
    [activePage]
  );

  const formatNotificationModalDate = (ms) => {
    if (!Number.isFinite(ms)) return "Recent";
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: String(businessTimeZone || "").trim() || getDeviceTimeZone(),
    });
  };

  if (isLoggingOut) {
    return (
      <div className="portal-logout-overlay" role="status" aria-live="polite" aria-busy="true">
        <div className="portal-logout-spinner" />
        <div className="portal-logout-text">Logging out...</div>
      </div>
    );
  }

  if (!authReady) {
    return (
      <div className="portal-auth-loading" role="status" aria-live="polite" aria-busy="true">
        <div className="portal-logout-spinner" />
        <div className="portal-logout-text">Restoring session...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return authScreen === "register" ? (
      <RegisterPortalUser onBackToLogin={() => setAuthScreen("login")} />
    ) : (
      <LoginPage onGoToRegister={() => setAuthScreen("register")} />
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        loadingLive={showLiveAgentsStartupLoading}
        liveAgents={liveAgentsForSidebar}
        userRole={user?.role}
        userAllowedPages={user?.allowedPages || []}
        onSelectLiveAgent={handleOpenLiveAgentModal}
      />

      <div className="secondheader">
        <Header
          employee={selectedEmployee}
          viewer={user}
          profileImagesByUserId={profileImagesByUserId}
          notifications={notifications}
          onNotificationClick={handleNotificationClick}
          onMarkAllNotificationsRead={handleMarkAllNotificationsRead}
          onOpenNotificationsPage={() => setActivePage("notifications")}
          onChangeOwnPassword={handleChangeOwnPassword}
        />

        <div className="portal-topbar">
          <div className="portal-topbar-left">
            <div className="portal-topbar-title">{activePageHeader}</div>
          </div>

          <div className="portal-topbar-actions">
            {canAccessPage(user?.role, "register_portal_user", user?.allowedPages) ? (
              <button
                className="portal-btn portal-btn-primary"
                onClick={() => setActivePage("register_portal_user")}
              >
                <UserPlus size={16} strokeWidth={2} />
                <span>Register User</span>
              </button>
            ) : null}

            {canRequestPortalUser ? (
              <button
                className="portal-btn portal-btn-primary"
                onClick={handleOpenUserRequestModal}
              >
                <UserPlus size={16} strokeWidth={2} />
                <span>Request New User</span>
              </button>
            ) : null}

            {canPostAnnouncements ? (
              <button
                className="portal-btn portal-btn-secondary"
                onClick={handleOpenAnnouncementModal}
              >
                <Megaphone size={16} strokeWidth={2} />
                <span>Post Announcement</span>
              </button>
            ) : null}

            <button className="portal-btn portal-btn-danger" onClick={handleLogoutClick}>
              <LogOut size={16} strokeWidth={2} />
              <span>Logout</span>
            </button>
          </div>
        </div>

        {(loadingUsers || loadingSchedules) && (
          <p className="portal-loading-hint">
            Loading... {loadingUsers ? "Users" : ""}{" "}
            {loadingSchedules ? (loadingUsers ? " + Schedules" : "Schedules") : ""}
          </p>
        )}

        {globalError && <p className="portal-global-error">{globalError}</p>}

        <main ref={portalMainRef} className="portal-main">

          {activePage === "control_panel" && (
            <div className="portal-page-pad">
              <ControlPanelPage
                viewer={user}
                specialUsers={specialUsers}
                employees={controlPanelEmployees}
                loadingUsersData={loadingSpecialUsers || loadingEmployeePermissions}
                usersError={specialUsersError || employeePermissionsError}
                attendanceResetTime={attendanceResetTime}
                businessTimeZone={businessTimeZone}
                attendanceDisplayTimeZoneMode={attendanceDisplayTimeZoneMode}
                attendanceDisplayTimeZone={attendanceDisplayTimeZone}
                storageTimeZone={storageTimeZone}
                onSaveEmployeeAllowedPages={handleUpdateEmployeeAllowedPages}
                onSaveSpecialUserAllowedPages={handleUpdatePortalUserAllowedPages}
                onTransferEmployeeToPortalRole={handleTransferEmployeeToPortalRole}
                onTransferSpecialUserToEmployeeRole={handleTransferSpecialUserToEmployeeRole}
                onDeleteAdminUser={handleDeleteAdminPortalUser}
                onSetEmployeePassword={handleAdminUpdateEmployeePassword}
                employeeProfilesByUserId={employeeProfilesByUserId}
                onSaveEmployeeStartDate={handleSaveEmployeeStartDate}
                onApplyRoleCorePagesToAll={handleApplyRoleCorePagesToAll}
                onReloadUsers={async () => {
                  await reloadSpecialUsers();
                  await reloadEmployeePermissions();
                }}
                userRequests={portalUserRequests}
                loadingRequests={loadingPortalUserRequests}
                requestsError={portalUserRequestsError}
                processingRequestId={processingPortalUserRequest.id}
                processingRequestAction={processingPortalUserRequest.action}
                onApproveRequest={handleApprovePortalUserRequest}
                onRejectRequest={handleRejectPortalUserRequest}
                onUpdateUserProfile={handleUpdateSpecialUserProfile}
                onChangeUserEmail={handleChangeSpecialUserEmail}
                onSendPasswordReset={handleSendSpecialUserPasswordReset}
                onReloadRequests={reloadPortalUserRequests}
                onAttendanceSettingsChange={(nextSettings) => {
                  const nextReset = nextSettings?.resetTime || attendanceResetTime;
                  const nextMode =
                    nextSettings?.displayTimeZoneMode || DISPLAY_TIME_ZONE_MODE_DEVICE;
                  const nextDisplay = String(nextSettings?.displayTimeZone || "").trim();
                  const nextStorage =
                    String(nextSettings?.storageTimeZone || "").trim() ||
                    DEFAULT_STORAGE_TIME_ZONE;
                  const resolvedDisplay =
                    String(nextSettings?.resolvedBusinessTimeZone || "").trim() ||
                    resolveAttendanceDisplayTimeZone(nextSettings, getDeviceTimeZone());

                  setStoredAttendanceResetTime(nextReset);
                  setAttendanceResetTime(nextReset);
                  setAttendanceDisplayTimeZoneMode(nextMode);
                  setAttendanceDisplayTimeZone(nextDisplay);
                  setStorageTimeZone(nextStorage);
                  setBusinessTimeZone(resolvedDisplay);
                }}
                onAttendanceResetTimeChange={(value) => {
                  setStoredAttendanceResetTime(value);
                  setAttendanceResetTime(value);
                }}
                onBusinessTimeZoneChange={(value) => {
                  setBusinessTimeZone(value);
                }}
                onToast={pushToast}
                pageData={sharedPageData}
              />
            </div>
          )}

          {activePage === "register_portal_user" && (
            <div className="portal-page-pad">
              <RegisterPortalUser onBackToLogin={() => setActivePage("dashboard")} />
            </div>
          )}

          {activePage === "notifications" && (
            <div className="portal-page-pad">
              <NotificationsPage
                notifications={notifications}
                archivedNotifications={archivedNotifications}
                overBreakNotes={overBreakNotes}
                archivedOverBreakNotes={archivedOverBreakNotes}
                onMarkNotificationRead={handleNotificationClick}
                onMarkAllRead={handleMarkAllNotificationsRead}
                onResetAllNotificationData={handleResetAllNotificationsData}
                onArchiveNotification={handleArchiveNotification}
                onArchiveAllNotifications={handleArchiveAllNotifications}
                onArchiveOverBreakNote={handleArchiveOverBreakNote}
                onArchiveAllOverBreakNotes={handleArchiveAllOverBreakNotes}
                onRestoreArchivedNotification={handleRestoreArchivedNotification}
                onDeleteArchivedNotification={handleDeleteArchivedNotification}
                onDeleteAllArchivedNotifications={handleDeleteAllArchivedNotifications}
                onRestoreArchivedOverBreakNote={handleRestoreArchivedOverBreakNote}
                onDeleteArchivedOverBreakNote={handleDeleteArchivedOverBreakNote}
                onDeleteAllArchivedOverBreakNotes={handleDeleteAllArchivedOverBreakNotes}
                canAccessNotificationArchive={canAccessNotificationArchive}
                canManageNotificationArchive={canManageNotificationArchive}
                businessTimeZone={businessTimeZone}
                pageData={sharedPageData}
              />
            </div>
          )}

          {activePage === "manage_announcements" && (
            <div className="portal-page-pad">
              <ManageAnnouncementsPage
                announcements={announcements}
                loading={loadingAnnouncements}
                error={announcementsError}
                onReloadAnnouncements={reloadAnnouncements}
                onUpdateAnnouncement={handleUpdateAnnouncement}
                onDeleteAnnouncement={handleDeleteAnnouncement}
                onRestoreAnnouncement={handleRestoreAnnouncement}
                onPermanentDeleteAnnouncement={handlePermanentDeleteAnnouncement}
                onToast={pushToast}
                businessTimeZone={businessTimeZone}
                pageData={sharedPageData}
              />
            </div>
          )}

          {activePage === "dashboard" && (
            <div className="portal-page-pad">
              <Dashboard
                employees={allEmployeesForSharedPages}
                loading={
                  loadingUsers ||
                  loadingSchedules ||
                  loadingTodayLogs ||
                  loadingAttendance ||
                  loadingBreaks ||
                  loadingBreakUsage ||
                  loadingEmployeeProfiles
                }
                error={globalError}
                startDate={startDate}
                endDate={endDate}
                rangeDays={rangeDays}
                logsByUserId={logsByUserId}
                schedulesByUserId={schedulesByUserId}
                nowMs={nowMs}
                onFetchFullHistory={fetchFullHistoryForUser}
                historyByUserId={historyByUserId}
                loadingHistoryByUserId={loadingHistoryByUserId}
                historyErrorByUserId={historyErrorByUserId}
                breakLogsByUserId={breakLogsByUserId}
                announcements={announcements}
                loadingAnnouncements={loadingAnnouncements}
                announcementsError={announcementsError}
                viewerRole={user?.role || ""}
                employeeProfilesByUserId={employeeProfilesByUserId}
                attendanceResetTime={attendanceResetTime}
                businessTimeZone={businessTimeZone}
                pageData={sharedPageData}
              />
            </div>
          )}

          {activePage === "employee_dashboard" && (
            <div className="portal-page-pad">
              <EmployeeDashboard
                employees={employeeDashboardEmployees}
                announcements={announcements}
                assignments={assignments}
                schedulesByUserId={schedulesByUserId}
                logsByUserId={todayLogsByUserId}
                loadingAssignments={loadingAssignments}
                assignmentsError={assignmentsError}
                nowMs={nowMs}
                endDate={endDate}
                businessTimeZone={businessTimeZone}
                onFetchFullHistory={fetchFullHistoryForUser}
                historyByUserId={historyByUserId}
                loadingHistoryByUserId={loadingHistoryByUserId}
                historyErrorByUserId={historyErrorByUserId}
                selectedEmployeeId={selectedEmployeeId}
                onSelectEmployeeId={setSelectedEmployeeId}
                activeBreaksByUserId={activeBreaksByUserId}
                breakUsageByUserId={breakUsageByUserId}
                onBreakStatusChanged={async () => {
                  await reloadActiveBreaks();
                  await reloadBreakUsage();
                  await reloadNotifications();
                  await reloadOverBreakNotes();
                }}
                onOpenTaskDetails={handleOpenAssignmentTask}
                pageData={sharedPageData}
              />
            </div>
          )}

          {activePage === "attendance" && (
            <AttendancePage
              employees={attendanceAndScheduleEmployees}
              rangeDays={rangeDays}
              setRangeDays={setRangeDays}
              startDate={startDate}
              endDate={endDate}
              rangeOptions={RANGE_OPTIONS}
              logsByUserId={logsByUserId}
              errorsByUserId={attendanceErrorsByUserId}
              schedulesByUserId={schedulesByUserId}
              loading={loadingAttendance}
              error={attendanceError}
              onReload={reloadAttendance}
              onFetchFullHistory={fetchFullHistoryForUser}
              historyByUserId={historyByUserId}
              loadingHistoryByUserId={loadingHistoryByUserId}
              historyErrorByUserId={historyErrorByUserId}
              activeBreaksByUserId={activeBreaksByUserId}
              attendanceResetTime={attendanceResetTime}
              businessTimeZone={businessTimeZone}
              openEmployeeDrawerRequest={attendanceOpenRequest}
              onConsumeOpenEmployeeDrawerRequest={handleConsumeAttendanceOpenRequest}
              pageData={sharedPageData}
            />
          )}

          {activePage === "schedule" && (
            <SchedulePage
              employees={attendanceAndScheduleEmployees}
              schedulesByUserId={schedulesByUserId}
              errorsByUserId={scheduleErrorsByUserId}
              businessTimeZone={businessTimeZone}
              loading={loadingSchedules}
              error={schedulesError}
              onReload={reloadSchedules}
              pageData={sharedPageData}
            />
          )}

          {activePage === "assignment" && (
            <div className="portal-page-pad">
              <AssignmentPage
                employees={allEmployeesForSharedPages}
                viewer={user}
                assignments={assignments}
                archivedAssignments={archivedAssignments}
                loadingAssignments={loadingAssignments}
                assignmentsError={assignmentsError}
                employeeProfilesByUserId={employeeProfilesByUserId}
                onReloadAssignments={reloadAssignments}
                onCreateAssignment={handleCreateAssignment}
                onUpdateAssignment={handleUpdateAssignment}
                onDeleteAssignment={handleDeleteAssignment}
                onArchiveAssignment={handleArchiveAssignment}
                onRepostAssignment={handleRepostAssignment}
                onMarkAssignmentCompleted={handleMarkAssignmentCompleted}
                onReviewAssignmentCompletion={handleReviewAssignmentCompletion}
                onRequestAssignmentAccess={handleRequestAssignmentAccess}
                onApproveAssignmentAccess={handleApproveAssignmentAccess}
                onToast={pushToast}
                openTaskRequest={assignmentOpenRequest}
                onConsumeOpenTaskRequest={handleConsumeAssignmentOpenRequest}
                openCreateRequest={assignmentCreateRequest}
                onConsumeOpenCreateRequest={handleConsumeAssignmentCreateRequest}
                pageData={sharedPageData}
              />
            </div>
          )}

          {activePage === "hours" && (
            <div className="portal-page-pad">
              <h1>hours</h1>
              <p>Page not implemented yet.</p>
            </div>
          )}

          {["perf_daily", "perf_weekly", "perf_monthly"].includes(activePage) && (
            <div className="portal-page-pad">
              <PerformanceReportPage
                mode={
                  activePage === "perf_daily"
                    ? "daily"
                    : activePage === "perf_weekly"
                      ? "weekly"
                      : "monthly"
                }
                employees={allEmployeesForSharedPages}
                logsByUserId={logsByUserId}
                historyByUserId={historyByUserId}
                loadingHistoryByUserId={loadingHistoryByUserId}
                historyErrorByUserId={historyErrorByUserId}
                onFetchFullHistory={fetchFullHistoryForUser}
                loading={loadingUsers || loadingAttendance}
                error={attendanceError || usersError || ""}
                endDate={endDate}
                rangeDays={rangeDays}
                businessTimeZone={businessTimeZone}
                pageData={sharedPageData}
              />
            </div>
          )}

          {activePage === "invoices" && (
            <InvoicesPage invoiceUrl={invoiceEmbedUrl} pageData={sharedPageData} />
          )}
        </main>
      </div>

      {showLogoutConfirm && (
        <>
          <div onClick={handleCancelLogout} className="portal-modal-backdrop" />

          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
            className="portal-dialog portal-dialog-logout"
          >
            <h2 id="logout-confirm-title" className="portal-dialog-title">
              Confirm Logout
            </h2>

            <p className="portal-dialog-text portal-dialog-text-spaced">
              Are you sure you want to log out?
            </p>

            <div className="portal-dialog-actions">
              <button
                type="button"
                onClick={handleCancelLogout}
                className="portal-dialog-btn portal-dialog-btn-cancel"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleConfirmLogout}
                className="portal-dialog-btn portal-dialog-btn-danger"
              >
                Logout
              </button>
            </div>
          </div>
        </>
      )}

      {showAnnouncementModal && (
        <>
          <div className="portal-modal-backdrop" />

          <form
            onSubmit={handlePostAnnouncement}
            role="dialog"
            aria-modal="true"
            aria-labelledby="announcement-modal-title"
            className="portal-dialog portal-dialog-announcement"
          >
            <h2 id="announcement-modal-title" className="portal-dialog-title portal-dialog-title-tight">
              Post Employee Note
            </h2>

            <p className="portal-dialog-subtext">
              This note will be visible on the right side of Employee Dashboard.
            </p>

            <div className="portal-announce-grid">
              <label className="portal-announce-field">
                <span className="portal-announce-label">Post at</span>
                <input
                  type="datetime-local"
                  value={announcementPostAt}
                  onChange={(e) => setAnnouncementPostAt(e.target.value)}
                  className="portal-announce-input portal-announce-input-sm"
                />
              </label>

              <label className="portal-announce-field">
                <span className="portal-announce-label">Expire at</span>
                <input
                  type="datetime-local"
                  value={announcementExpireAt}
                  onChange={(e) => setAnnouncementExpireAt(e.target.value)}
                  className="portal-announce-input portal-announce-input-sm"
                />
              </label>
            </div>

            <input
              type="text"
              value={announcementHeadline}
              onChange={(e) => setAnnouncementHeadline(e.target.value)}
              placeholder="Headline (what employees will see in the list)"
              className="portal-announce-input portal-announce-headline"
            />

            <textarea
              value={announcementDraft}
              onChange={(e) => setAnnouncementDraft(e.target.value)}
              placeholder="Write your note for employees..."
              rows={5}
              className="portal-announce-input portal-announce-textarea"
            />

            {announcementsError ? (
              <div className="portal-announce-error">
                {announcementsError}
              </div>
            ) : null}

            <div className="portal-dialog-actions portal-dialog-actions-spaced">
              <button
                type="button"
                onClick={handleCloseAnnouncementModal}
                disabled={savingAnnouncement}
                className="portal-dialog-btn portal-dialog-btn-cancel"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={savingAnnouncement}
                className="portal-dialog-btn portal-dialog-btn-dark"
              >
                {savingAnnouncement ? "Posting..." : "Post Note"}
              </button>
            </div>
          </form>
        </>
      )}

      {showUserRequestModal && (
        <>
          <div
            className="portal-modal-backdrop"
            onClick={handleCloseUserRequestModal}
          />

          <form
            onSubmit={handleSubmitPortalUserRequest}
            role="dialog"
            aria-modal="true"
            aria-labelledby="portal-user-request-title"
            className="portal-dialog portal-dialog-user-request"
          >
            <h2 id="portal-user-request-title" className="portal-dialog-title portal-dialog-title-tight">
              Request New User
            </h2>

            <p className="portal-dialog-subtext">
              Submit the new user details. A Super Admin must approve this request before the account is created.
            </p>

            <div className="portal-user-request-grid">
              <label className="portal-user-request-field">
                <span className="portal-user-request-label">First name</span>
                <input
                  type="text"
                  value={newUserRequestForm.firstName}
                  onChange={(e) =>
                    setNewUserRequestForm((prev) => ({
                      ...prev,
                      firstName: e.target.value,
                    }))
                  }
                  className="portal-user-request-input"
                  placeholder="Enter first name"
                  required
                />
              </label>

              <label className="portal-user-request-field">
                <span className="portal-user-request-label">Last name</span>
                <input
                  type="text"
                  value={newUserRequestForm.lastName}
                  onChange={(e) =>
                    setNewUserRequestForm((prev) => ({
                      ...prev,
                      lastName: e.target.value,
                    }))
                  }
                  className="portal-user-request-input"
                  placeholder="Enter last name"
                  required
                />
              </label>
            </div>

            <label className="portal-user-request-field">
              <span className="portal-user-request-label">Email</span>
              <input
                type="email"
                value={newUserRequestForm.email}
                onChange={(e) =>
                  setNewUserRequestForm((prev) => ({
                    ...prev,
                    email: e.target.value,
                  }))
                }
                className="portal-user-request-input"
                placeholder="newuser@email.com"
                required
              />
            </label>

            <label className="portal-user-request-field">
              <span className="portal-user-request-label">Role</span>
              <select
                value={newUserRequestForm.role}
                onChange={(e) =>
                  setNewUserRequestForm((prev) => ({
                    ...prev,
                    role: e.target.value,
                  }))
                }
                className="portal-user-request-input"
              >
                {PORTAL_USER_REQUEST_ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="portal-user-request-field">
              <span className="portal-user-request-label">Note for Super Admin (optional)</span>
              <textarea
                value={newUserRequestForm.note}
                onChange={(e) =>
                  setNewUserRequestForm((prev) => ({
                    ...prev,
                    note: e.target.value,
                  }))
                }
                rows={3}
                className="portal-user-request-input portal-user-request-textarea"
                placeholder="Why this user account is needed..."
              />
            </label>

            <div className="portal-dialog-actions portal-dialog-actions-spaced">
              <button
                type="button"
                onClick={handleCloseUserRequestModal}
                disabled={requestingNewUser}
                className="portal-dialog-btn portal-dialog-btn-cancel"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={requestingNewUser}
                className="portal-dialog-btn portal-dialog-btn-dark"
              >
                {requestingNewUser ? "Submitting..." : "Submit Request"}
              </button>
            </div>
          </form>
        </>
      )}

      {showLiveAgentModal && selectedLiveAgent ? (
        <>
          <div
            onClick={handleCloseLiveAgentModal}
            className="portal-modal-backdrop portal-live-agent-backdrop"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="live-agent-modal-title"
            className="portal-dialog portal-dialog-live-agent"
          >
            <div className="portal-live-agent-head">
              <div className="portal-live-agent-profile">
                <div className="portal-live-agent-avatar" aria-label={selectedLiveAgent.name}>
                  {selectedLiveAgent.profileImg ? (
                    <img
                      src={selectedLiveAgent.profileImg}
                      alt={`${selectedLiveAgent.name} profile`}
                      className="portal-live-agent-avatar-img"
                      loading="lazy"
                    />
                  ) : (
                    String(selectedLiveAgent.name || "?")
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join("")
                      .toUpperCase() || "?"
                  )}
                </div>

                <div className="portal-live-agent-meta">
                  <h2 id="live-agent-modal-title" className="portal-dialog-title portal-live-agent-title">
                    {selectedLiveAgent.name}
                  </h2>
                  <div className="portal-live-agent-sub">{selectedLiveAgent.email}</div>
                  <div className="portal-live-agent-top-tags">
                    <span className="portal-live-agent-tag">{selectedLiveAgent.position}</span>
                    <span className="portal-live-agent-tag">Joined: {selectedLiveAgent.joinedText}</span>
                    <span className="portal-live-agent-tag status">{selectedLiveAgent.status}</span>
                  </div>
                </div>
              </div>

              <div className="portal-live-agent-head-right">
                <div className="portal-live-agent-break-ring-wrap">
                  <div
                    className="portal-live-agent-break-ring"
                    style={{ background: selectedLiveAgent.breakRingBackground }}
                    aria-label={`Break minutes remaining ${Math.round(selectedLiveAgent.breakMinutesLeft || 0)} out of ${Math.round(selectedLiveAgent.breakLimitMinutes || 0)}`}
                  >
                    <div className="portal-live-agent-break-ring-inner">
                      <div className="portal-live-agent-break-ring-value">
                        {Math.round(selectedLiveAgent.breakMinutesLeft || 0)}
                      </div>
                      <div className="portal-live-agent-break-ring-label">min left</div>
                    </div>
                  </div>
                  <div className="portal-live-agent-break-ring-caption">
                    Break Remaining
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCloseLiveAgentModal}
                  className="portal-live-agent-close"
                  aria-label="Close employee details"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="portal-live-agent-body">
              <div className="portal-live-agent-grid">
                <div className="portal-live-agent-card portal-live-agent-card-summary">
                  <div className="portal-live-agent-card-title">Basic Employee Info</div>
                  <div className="portal-live-agent-donut-block">
                    <div
                      className="attPie"
                      style={{ background: selectedLiveAgent.breakdownPieBackground }}
                      aria-label={`Attendance breakdown total ${selectedLiveAgent.breakdownTotal}`}
                    >
                      <div className="attHole">
                        <div className="attHoleLabel">Range</div>
                        <div className="attHoleValue">{selectedLiveAgent.breakdownRangeLabel}</div>

                        <div className="attHoleLabel attHoleLabelSpacing">Total Counted</div>
                        <div className="attHoleTotal">{selectedLiveAgent.breakdownTotal}</div>
                      </div>
                    </div>
                    <div className="portal-live-agent-summary-list">
                      {PERFORMANCE_STATUS_SERIES.map((item) => (
                        <div key={`live-agent-breakdown-${item.key}`} className="portal-live-agent-breakdown-row">
                          <span className="portal-live-agent-breakdown-label">
                            <span className={`dot dash-tone-${item.key}`} />
                            <span>{item.label}</span>
                          </span>
                          <strong>{Number(selectedLiveAgent.breakdownCounts?.[item.key] || 0)}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="portal-live-agent-card portal-live-agent-card-logs">
                  <div className="prpCardTop">
                    <div className="prpCardHead">Weekly Attendance Logs</div>
                    <div className="prpLogFilters">
                      <div className="prpStatusFilter">
                        <span className="prpStatusFilterLabel">Status</span>
                        <div className="prpStatusFilterChips" role="group" aria-label="Status filter">
                          {PERFORMANCE_STATUS_FILTER_ITEMS.map((item) => {
                            const isActive = liveAgentLogStatus === item.key;
                            const isAll = item.key === "ALL";

                            return (
                              <button
                                key={`live-agent-status-filter-${item.key}`}
                                type="button"
                                className={`prpStatusChip ${isActive ? "isActive" : ""} ${isAll ? "isAll" : ""} ${isAll ? "" : `prpStatusTone-${item.key}`}`}
                                onClick={() => setLiveAgentLogStatus(item.key)}
                              >
                                {item.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                  {selectedLiveAgent.historyError ? (
                    <div className="portal-live-agent-error">{selectedLiveAgent.historyError}</div>
                  ) : null}
                  {selectedLiveAgent.historyLoading && !selectedLiveAgent.hasHistory ? (
                    <div className="prpEmpty">Loading attendance logs...</div>
                  ) : selectedLiveAgent.recentLogs.length === 0 ? (
                    <div className="prpEmpty">
                      {selectedLiveAgent.hasLogStatusFilter
                        ? "No logs match the selected filters."
                        : "No attendance logs found for this employee."}
                    </div>
                  ) : (
                    <div className="prpTableWrap portal-live-agent-prp-wrap">
                      <table className="prpTable">
                        <thead>
                          <tr>
                            <th>Employee</th>
                            <th>Day</th>
                            <th>Time</th>
                            <th>Status</th>
                            <th>Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedLiveAgent.recentLogs.slice(0, 20).map((row) => (
                            <tr key={`${row.userId}-${row.ts}-${row.statusKey}`}>
                              <td>{row.employeeName}</td>
                              <td>{row.dayKey || "-"}</td>
                              <td>{formatTimeForDisplay(row.ts, businessTimeZone)}</td>
                              <td>
                                <span className={`prpStatusPill prpStatusTone-${row.statusKey}`}>
                                  {row.statusText}
                                </span>
                              </td>
                              <td className="prpNotesCell">{row.noteText || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="portal-live-agent-actions">
              {canUseAssignTaskShortcut ? (
                <button
                  type="button"
                  className="portal-btn portal-btn-primary portal-live-agent-action-btn"
                  onClick={handleOpenLiveAgentAssignTask}
                >
                  <ClipboardList size={16} strokeWidth={2} />
                  <span>Assign a Task</span>
                </button>
              ) : null}

              <button
                type="button"
                className="portal-btn portal-btn-secondary portal-live-agent-action-btn"
                onClick={handleOpenLiveAgentAttendance}
              >
                <CalendarCheck size={16} strokeWidth={2} />
                <span>Attendance</span>
              </button>
            </div>
          </div>
        </>
      ) : null}

      {selectedNotification ? (
        <>
          <div onClick={closeNotificationModal} className="portal-modal-backdrop" />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="Notification details"
            className="portal-dialog portal-dialog-notification"
          >
            <div className="portal-notification-head">
              <div>
                <h2 className="portal-notification-title">
                  {selectedNotification.headline || "Notification"}
                </h2>
                <div className="portal-notification-meta">
                  <span>{selectedNotification.createdBy || "Notification"}</span>
                  <span>{formatNotificationModalDate(selectedNotification.createdAtMs)}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={closeNotificationModal}
                className="portal-notification-close"
                aria-label="Close notification"
              >
                x
              </button>
            </div>

            <div className="portal-notification-body">
              {selectedNotification.text || "No notification content available."}
            </div>

            {selectedNotification.actionPage ? (
              <div className="portal-notification-actions">
                <button
                  type="button"
                  onClick={handleOpenNotificationTargetPage}
                  className="portal-dialog-btn portal-dialog-btn-dark portal-notification-open-btn"
                >
                  {selectedNotification.actionLabel || "Open page"}
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="toast-stack">
        {toastQueue.map((toast) => (
          <div key={toast.id} className={`app-toast ${toast.type ? `app-toast-${toast.type}` : ""}`}>
            <div className="app-toast-title">{toast.title}</div>
            <div className="app-toast-message">{toast.message}</div>
            <button
              type="button"
              className="app-toast-close"
              onClick={() => dismissToast(toast.id)}
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

