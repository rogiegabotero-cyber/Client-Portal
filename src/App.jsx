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
import SpecialUsersPage from "./components/SpecialUsersPage";
import ControlPanelPage from "./components/ControlPanelPage";
import ManageEmployee from "./components/ManageEmployee";

import "./App.css";
import HyacinthAttendanceAPI from "./api/hyacinthAttendanceApi";
import { useAuth } from "./auth/useAuth";
import { canAccessPage, DEFAULT_ROLE_PAGES, ROLES } from "./auth/roleUtils";
import {
  getEmployeePermission,
  getSpecialPortalUsers,
  updateEmployeeAllowedPages,
  updatePortalUserAllowedPages,
} from "./auth/firebaseAuthService";
import {
  getActiveBreaks,
  getBreakLogsForUserOnDate,
  calculateBreakUsageMinutes,
  ensureBreakReminder,
  ensureOverBreakEscalation,
  getNotificationsForUser,
  markNotificationRead,
  markAllNotificationsRead,
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
  createAssignment,
  createDeadlineAlertsForAssignments,
  deleteAssignment,
  getAssignments,
  markAssignmentCompleted,
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

import { UserPlus, LogOut, Megaphone } from "lucide-react";
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
  manage_employee: "Employee Profile Center",
  control_panel: "Control Panel",
  register_portal_user: "Register Portal User",
  special_users: "Special Users",
  notifications: "Notifications",
  manage_announcements: "Manage Announcements",
  perf_daily: "Performance Report (Daily)",
  perf_weekly: "Performance Report (Weekly)",
  perf_monthly: "Performance Report (Monthly)",
  invoices: "Invoices",
  hours: "Hours",
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
  const { user, isAuthenticated, signOut } = useAuth();

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
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [assignmentsError, setAssignmentsError] = useState("");
  const [assignmentOpenRequest, setAssignmentOpenRequest] = useState({
    taskId: "",
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
  const [selectedNotification, setSelectedNotification] = useState(null);

  const usersAbortRef = useRef(null);
  const schedulesAbortRef = useRef(null);
  const attendanceAbortRef = useRef(null);
  const todayAbortRef = useRef(null);

  const [breakLogsByUserId, setBreakLogsByUserId] = useState({});

  const [notifications, setNotifications] = useState([]);
  const [overBreakNotes, setOverBreakNotes] = useState([]);
  const [profileImagesByUserId, setProfileImagesByUserId] = useState({});
  const [toastQueue, setToastQueue] = useState([]);
  const seenToastIdsRef = useRef(new Set());
  const profileImagesByUserIdRef = useRef({});
  const profileImagesInitializedRef = useRef(false);
  const portalMainRef = useRef(null);
  const viewerRole = useMemo(
    () => String(user?.role || "").trim().toLowerCase().replace(/\s+/g, "_"),
    [user?.role]
  );
  const canPostAnnouncements = useMemo(
    () => viewerRole === ROLES.VISITOR || viewerRole === ROLES.ADMIN || viewerRole === ROLES.SUPER_ADMIN,
    [viewerRole]
  );

  const handleLogoutClick = useCallback(() => {
    setShowLogoutConfirm(true);
  }, []);

  const handleConfirmLogout = useCallback(() => {
    setShowLogoutConfirm(false);
    signOut();
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

  const handleCloseAnnouncementModal = useCallback(() => {
    if (savingAnnouncement) return;
    const defaults = getDefaultAnnouncementWindow();
    setShowAnnouncementModal(false);
    setAnnouncementHeadline("");
    setAnnouncementDraft("");
    setAnnouncementPostAt(defaults.postAt);
    setAnnouncementExpireAt(defaults.expiresAt);
  }, [savingAnnouncement]);

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
    const viewerRole = String(currentViewerIdentity?.role || "").toLowerCase();
    const isAdminLike = viewerRole === ROLES.SUPER_ADMIN || viewerRole === ROLES.ADMIN;

    if (!currentViewerIdentity?.userId && !isAdminLike) {
      setNotifications([]);
      return;
    }

    try {
      const rows = await getNotificationsForUser(currentViewerIdentity);
      const list = Array.isArray(rows) ? rows : [];
      const enrichedRows = list.map((row) => {
        if (!isAnnouncementNotification(row?.type)) return row;
        if (String(row?.message || "").trim()) return row;

        const announcementId = String(row?.announcementId || "").trim();
        if (!announcementId) return row;

        const match = (Array.isArray(announcements) ? announcements : []).find(
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

      setNotifications(enrichedRows);

      const unread = enrichedRows.filter((row) => !row?.read);
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
  }, [announcements, currentViewerIdentity]);

  const reloadOverBreakNotes = useCallback(async () => {
    try {
      const rows = await getOverBreakNotes();

      if (user?.role === ROLES.SUPER_ADMIN) {
        setOverBreakNotes(rows);
        return;
      }

      const currentUid = String(
        user?.userId ?? user?.id ?? user?.uid ?? user?.firebaseUid ?? user?.employeeId ?? ""
      );

      setOverBreakNotes(rows.filter((row) => String(row?.userId || "") === currentUid));
    } catch (err) {
      console.error("Failed to load over-break notes:", err);
    }
  }, [user]);

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

  const reloadActiveBreaks = useCallback(async () => {
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
      setActiveBreaksByUserId({});
    } finally {
      setLoadingBreaks(false);
    }
  }, [reloadNotifications, reloadOverBreakNotes]);

  const reloadBreakUsage = useCallback(async () => {
    if (!validEmployees.length) {
      setBreakUsageByUserId({});
      setBreakLogsByUserId({});
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
  }, [validEmployees]);

  const reloadEmployeeProfiles = useCallback(async () => {
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
  }, [validEmployees]);

  const reloadSpecialUsers = useCallback(async () => {
    if (!canPostAnnouncements) {
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
  }, [canPostAnnouncements]);

  const reloadEmployeePermissions = useCallback(async () => {
    if (user?.role !== ROLES.SUPER_ADMIN) {
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
  }, [user?.role, validEmployees]);

  const reloadAssignments = useCallback(async () => {
    if (!isAuthenticated || !user || !canAccessPage(user.role, "assignment", user?.allowedPages)) {
      setAssignments([]);
      setAssignmentsError("");
      return;
    }

    setLoadingAssignments(true);
    setAssignmentsError("");

    try {
      const rows = await getAssignments();
      const nextRows = Array.isArray(rows) ? rows : [];
      setAssignments(nextRows);

      try {
        await createDeadlineAlertsForAssignments(nextRows);
      } catch (err) {
        console.error("Failed to create assignment deadline alerts:", err);
      }
    } catch (err) {
      console.error("Failed to load assignments:", err);
      setAssignments([]);
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
    async (assignmentId) => {
      await deleteAssignment(assignmentId);
      await reloadAssignments();
    },
    [reloadAssignments]
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
        if (!portalUsers.length) {
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
    let cancelled = false;

    const run = async () => {
      if (cancelled) return;
      await reloadActiveBreaks();
      if (cancelled) return;
      await reloadBreakUsage();
      if (cancelled) return;
      await reloadNotifications();
      if (cancelled) return;
      await reloadAnnouncements();
      if (cancelled) return;
      await reloadOverBreakNotes();
    };

    run();

    const id = setInterval(() => {
      run();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [reloadActiveBreaks, reloadBreakUsage, reloadNotifications, reloadAnnouncements, reloadOverBreakNotes]);

  useEffect(() => {
    reloadEmployeeProfiles();
  }, [reloadEmployeeProfiles]);

  useEffect(() => {
    reloadSpecialUsers();
  }, [reloadSpecialUsers]);

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

    if (user.role === ROLES.EMPLOYEE) {
      return dashboardEmployees.filter((emp) => String(getUserId(emp)) === String(user.userId));
    }

    return dashboardEmployees;
  }, [dashboardEmployees, user]);

  const attendanceAndScheduleEmployees = useMemo(() => dashboardEmployees, [dashboardEmployees]);

  const controlPanelEmployees = useMemo(() => {
    return validEmployees.map((emp) => {
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
  }, [validEmployees, employeePermissionsByUserId]);

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
  }, [employeeDashboardEmployees, selectedEmployeeId]);

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
      announcements,
      specialUsers,
      employeePermissionsByUserId,
      notifications,
      overBreakNotes,
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
      announcements,
      specialUsers,
      employeePermissionsByUserId,
      notifications,
      overBreakNotes,
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
      usersError,
      schedulesError,
      attendanceError,
      employeeProfilesError,
      specialUsersError,
      employeePermissionsError,
      assignmentsError,
      announcementsError,
      reloadSchedules,
      reloadAttendance,
      reloadTodayLogs,
      reloadEmployeeProfiles,
      reloadSpecialUsers,
      reloadEmployeePermissions,
      reloadAssignments,
      reloadAnnouncements,
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
        loadingLive={loadingTodayLogs || loadingBreaks || loadingBreakUsage}
        liveAgents={liveAgentsForSidebar}
        userRole={user?.role}
        userAllowedPages={user?.allowedPages || []}
      />

      <div className="secondheader">
        <Header
          employee={selectedEmployee}
          viewer={user}
          profileImagesByUserId={profileImagesByUserId}
          notifications={notifications}
          onNotificationClick={handleNotificationClick}
          onOpenNotificationsPage={() => setActivePage("notifications")}
        />

        <div className="portal-topbar">
          <div className="portal-topbar-left">
            <div className="portal-topbar-title">{activePageHeader}</div>
          </div>

          <div className="portal-topbar-actions">
            {user?.role === ROLES.SUPER_ADMIN ? (
              <button
                className="portal-btn portal-btn-primary"
                onClick={() => setActivePage("register_portal_user")}
              >
                <UserPlus size={16} strokeWidth={2} />
                <span>Register User</span>
              </button>
            ) : null}

            {canPostAnnouncements ? (
              <button
                className="portal-btn portal-btn-secondary"
                onClick={handleOpenAnnouncementModal}
              >
                <Megaphone size={16} strokeWidth={2} />
                <span>Post Note</span>
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
          {activePage === "manage_employee" && (
            <div className="portal-page-pad">
              {user?.role === ROLES.SUPER_ADMIN ? (
                <ManageEmployee
                  employees={allEmployeesForSharedPages}
                  schedulesByUserId={schedulesByUserId}
                  logsByUserId={logsByUserId}
                  todayLogsByUserId={todayLogsByUserId}
                  historyByUserId={historyByUserId}
                  loadingHistoryByUserId={loadingHistoryByUserId}
                  historyErrorByUserId={historyErrorByUserId}
                  activeBreaksByUserId={activeBreaksByUserId}
                  breakUsageByUserId={breakUsageByUserId}
                  employeeProfilesByUserId={employeeProfilesByUserId}
                  loadingEmployeeProfiles={loadingEmployeeProfiles}
                  employeeProfilesError={employeeProfilesError}
                  attendanceErrorsByUserId={attendanceErrorsByUserId}
                  scheduleErrorsByUserId={scheduleErrorsByUserId}
                  attendanceResetTime={attendanceResetTime}
                  businessTimeZone={businessTimeZone}
                  startDate={startDate}
                  endDate={endDate}
                  rangeDays={rangeDays}
                  viewer={user}
                  onToast={pushToast}
                  onSaveEmployeeStartDate={handleSaveEmployeeStartDate}
                  onFetchFullHistory={fetchFullHistoryForUser}
                  pageData={sharedPageData}
                />
              ) : null}
            </div>
          )}

          {activePage === "control_panel" && (
            <div className="portal-page-pad">
              {user?.role === ROLES.SUPER_ADMIN ? (
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
                  onReloadUsers={async () => {
                    await reloadSpecialUsers();
                    await reloadEmployeePermissions();
                  }}
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
              ) : null}
            </div>
          )}

          {activePage === "register_portal_user" && (
            <div className="portal-page-pad">
              {user?.role === ROLES.SUPER_ADMIN ? (
                <RegisterPortalUser onBackToLogin={() => setActivePage("dashboard")} />
              ) : null}
            </div>
          )}

          {activePage === "special_users" && (
            <div className="portal-page-pad">
              {user?.role === ROLES.SUPER_ADMIN ? (
                <SpecialUsersPage
                  users={specialUsers}
                  loading={loadingSpecialUsers}
                  error={specialUsersError}
                  onOpenControlPanel={() => setActivePage("control_panel")}
                  pageData={sharedPageData}
                />
              ) : null}
            </div>
          )}

          {activePage === "notifications" && (
            <div className="portal-page-pad">
              <NotificationsPage
                notifications={notifications}
                overBreakNotes={overBreakNotes}
                onMarkNotificationRead={handleNotificationClick}
                onMarkAllRead={handleMarkAllNotificationsRead}
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
                loadingAssignments={loadingAssignments}
                assignmentsError={assignmentsError}
                employeeProfilesByUserId={employeeProfilesByUserId}
                onReloadAssignments={reloadAssignments}
                onCreateAssignment={handleCreateAssignment}
                onUpdateAssignment={handleUpdateAssignment}
                onDeleteAssignment={handleDeleteAssignment}
                onMarkAssignmentCompleted={handleMarkAssignmentCompleted}
                onReviewAssignmentCompletion={handleReviewAssignmentCompletion}
                onRequestAssignmentAccess={handleRequestAssignmentAccess}
                onApproveAssignmentAccess={handleApproveAssignmentAccess}
                onToast={pushToast}
                openTaskRequest={assignmentOpenRequest}
                onConsumeOpenTaskRequest={handleConsumeAssignmentOpenRequest}
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

