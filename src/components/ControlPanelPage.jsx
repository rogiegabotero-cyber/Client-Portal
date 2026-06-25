import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ROLE_PAGES,
  PAGE_KEYS,
  ROLES,
  normalizeRole,
} from "../auth/roleUtils";
import {
  normalizeResetTime,
  setStoredAttendanceResetTime,
} from "../utils/attendanceDate";
import {
  saveAttendanceSettings,
  DEFAULT_STORAGE_TIME_ZONE,
  DISPLAY_TIME_ZONE_MODE_DEVICE,
  DISPLAY_TIME_ZONE_MODE_FIXED,
  resolveAttendanceDisplayTimeZone,
  sanitizeTimeZone,
} from "../services/attendanceSettingsService";
import {
  getDefaultEmployeeProcessSettings,
  saveEmployeeProcessRotation,
  subscribeEmployeeProcessSettings,
} from "../services/employeeProcessService";
import { getDeviceTimeZone } from "../utils/common";
import { auth, db } from "../firebase";
import { EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import {
  ClipboardList,
  Database,
  Eye,
  FileText,
  GripVertical,
  Settings,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  RefreshCcw,
  Save,
  Search,
  Trash2,
  User,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import "./controlPanelPage.css";

const PAGE_LABELS = {
  dashboard: "Dashboard",
  employee_dashboard: "My Dashboard",
  attendance: "Attendance",
  assignment: "Assignment",
  schedule: "Schedule",
  hours: "Hours",
  notifications: "Notifications",
  manage_announcements: "Manage Announcements",
  manage_breaks: "Manage Breaks",
  perf_daily: "Daily",
  perf_weekly: "Weekly",
  perf_monthly: "Monthly",
  invoices: "Invoices",
  special_users: "Special Users",
  register_portal_user: "Register User",
  manage_employee: "Manage Employee",
  control_panel: "Control Panel",
};

const PERFORMANCE_PAGE_KEYS = ["perf_daily", "perf_weekly", "perf_monthly"];
const TRANSFER_ROLE_OPTIONS = [
  { value: ROLES.ADMIN, label: "Admin" },
  { value: ROLES.ACCOUNTING, label: "Accounting" },
  { value: ROLES.VISITOR, label: "Visitor" },
];
const ROLE_BULK_OPTIONS = [
  { value: ROLES.ADMIN, label: "Admin" },
  { value: ROLES.ACCOUNTING, label: "Accounting" },
  { value: ROLES.VISITOR, label: "Visitor" },
  { value: ROLES.EMPLOYEE, label: "Employee" },
];
const EDITABLE_ROLE_OPTIONS = [
  { value: ROLES.SUPER_ADMIN, label: "Super Admin" },
  { value: ROLES.ADMIN, label: "Admin" },
  { value: ROLES.ACCOUNTING, label: "Accounting" },
  { value: ROLES.VISITOR, label: "Visitor" },
];

const PERMISSION_PAGE_ORDER = [
  "dashboard",
  "employee_dashboard",
  "attendance",
  "assignment",
  "schedule",
  "hours",
  "notifications",
  "manage_announcements",
  "manage_breaks",
  "perf_daily",
  "perf_weekly",
  "perf_monthly",
  "invoices",
  "special_users",
  "register_portal_user",
  "manage_employee",
  "control_panel",
];

const SIMPLE_TIME_ZONE_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];

const DEVICE_TIME_ZONE_OPTION = "__DEVICE_TIME_ZONE__";
const DATA_VIEWER_DEFAULT_LIMIT = 50;
const DATA_TABS = {
  ACCESS: "access",
  DATA: "data",
};
const SETTINGS_DRAWER_VIEWS = {
  ATTENDANCE: "attendance",
  EMPLOYEE_PROCESS: "employee_process",
  ROLE_BULK: "role_bulk",
  USER_ACTIONS: "user_actions",
  PENDING_REQUESTS: "pending_requests",
  BREAK_LOG_RECORDS: "break_log_records",
};
const USER_LIST_FILTERS = {
  SPECIAL: "special",
  EMPLOYEE: "employee",
};

const DATA_COLLECTIONS = {
  employee_announcements: {
    label: "Announcements",
    collection: "employee_announcements",
    description: "Portal announcements shown to employees.",
    columns: ["headline", "note", "createdByName", "createdByRole", "publishAt", "expiresAt", "createdAt", "updatedAt"],
    hiddenFields: ["deletedByUserId"],
    readOnlyFields: ["createdAt", "updatedAt", "deletedAt"],
    defaultCreateValue: {
      headline: "",
      note: "",
      createdByName: "",
      createdByRole: "",
    },
    canCreate: true,
    canEdit: true,
    canDelete: true,
  },
  employeeAssignments: {
    label: "Assignments",
    collection: "employeeAssignments",
    description: "Assignments and review status records.",
    columns: ["title", "employeeUserId", "status", "deadlineDate", "createdAt", "updatedAt"],
    hiddenFields: [],
    readOnlyFields: ["createdAt", "updatedAt"],
    defaultCreateValue: {
      title: "",
      description: "",
      employeeUserId: "",
      status: "pending",
    },
    canCreate: true,
    canEdit: true,
    canDelete: true,
  },
  employee_profiles: {
    label: "Employee Profiles",
    collection: "employee_profiles",
    description: "Employee profile metadata used around the portal.",
    columns: ["userId", "name", "email", "position", "startDate", "createdAt", "updatedAt"],
    hiddenFields: [],
    readOnlyFields: ["createdAt", "updatedAt"],
    defaultCreateValue: {
      userId: "",
      name: "",
      email: "",
      position: "",
    },
    canCreate: true,
    canEdit: true,
    canDelete: false,
  },
  break_logs: {
    label: "Break Logs",
    collection: "break_logs",
    description: "Break entries captured from attendance actions.",
    columns: ["userId", "name", "email", "breakType", "startedAt", "endedAt", "createdAt", "updatedAt"],
    hiddenFields: [],
    readOnlyFields: ["createdAt", "updatedAt"],
    defaultCreateValue: {
      userId: "",
      name: "",
      email: "",
      breakType: "lunch",
    },
    canCreate: false,
    canEdit: true,
    canDelete: false,
  },
  break_notifications: {
    label: "Break Notifications",
    collection: "break_notifications",
    description: "Reminders and over-break alerts.",
    columns: ["userId", "type", "title", "message", "read", "createdAt", "updatedAt"],
    hiddenFields: [],
    readOnlyFields: ["createdAt", "updatedAt"],
    defaultCreateValue: {
      userId: "",
      type: "manual_notice",
      title: "",
      message: "",
      read: false,
    },
    canCreate: true,
    canEdit: true,
    canDelete: true,
  },
  over_break_notes: {
    label: "Over Break Notes",
    collection: "over_break_notes",
    description: "Escalated over-break notes for employee activity.",
    columns: ["userId", "name", "email", "overBreakMinutes", "note", "createdAt", "updatedAt"],
    hiddenFields: [],
    readOnlyFields: ["createdAt", "updatedAt"],
    defaultCreateValue: {
      userId: "",
      name: "",
      email: "",
      overBreakMinutes: 0,
      note: "",
    },
    canCreate: false,
    canEdit: true,
    canDelete: false,
  },
  portal_user_requests: {
    label: "Portal User Requests",
    collection: "portal_user_requests",
    description: "Pending and processed portal access requests.",
    columns: ["email", "firstName", "lastName", "role", "status", "createdAt", "updatedAt"],
    hiddenFields: [],
    readOnlyFields: ["createdAt", "updatedAt"],
    defaultCreateValue: {
      email: "",
      firstName: "",
      lastName: "",
      role: "visitor",
      status: "pending",
    },
    canCreate: false,
    canEdit: true,
    canDelete: false,
  },
};

const buildSimpleTimeZoneOptions = (...values) => {
  const list = [...SIMPLE_TIME_ZONE_OPTIONS];
  for (const value of values) {
    const tz = String(value || "").trim();
    if (!tz) continue;
    if (!list.includes(tz)) list.push(tz);
  }
  return list;
};

const toSafeText = (value) => String(value ?? "").trim();
const toStatus = (value) => String(value || "").trim().toLowerCase();
const toRoleLabel = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .replace(/^\w/, (ch) => ch.toUpperCase());

const isTimestampLike = (value) =>
  !!value &&
  (value instanceof Date ||
    typeof value?.toDate === "function" ||
    (typeof value?.seconds === "number" && typeof value?.nanoseconds === "number"));

const timestampToDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === "function") {
    const converted = value.toDate();
    return converted instanceof Date && Number.isFinite(converted.getTime()) ? converted : null;
  }
  if (typeof value?.seconds === "number") {
    const millis = value.seconds * 1000 + Math.round((value.nanoseconds || 0) / 1000000);
    const converted = new Date(millis);
    return Number.isFinite(converted.getTime()) ? converted : null;
  }
  const converted = new Date(value);
  return Number.isFinite(converted.getTime()) ? converted : null;
};

const serializeForEditor = (value) => {
  if (isTimestampLike(value)) {
    const d = timestampToDate(value);
    return {
      __type: "timestamp",
      value: d ? d.toISOString() : "",
    };
  }

  if (Array.isArray(value)) return value.map(serializeForEditor);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, serializeForEditor(inner)])
    );
  }

  return value;
};

const deserializeFromEditor = (value) => {
  if (Array.isArray(value)) return value.map(deserializeFromEditor);

  if (value && typeof value === "object") {
    if (value.__type === "timestamp") {
      const d = new Date(value.value);
      if (!Number.isFinite(d.getTime())) {
        throw new Error(`Invalid timestamp value: ${value.value || "empty"}`);
      }
      return Timestamp.fromDate(d);
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, deserializeFromEditor(inner)])
    );
  }

  return value;
};

const formatCellValue = (value) => {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);

  const d = timestampToDate(value);
  if (d) return d.toLocaleString();

  if (Array.isArray(value)) return value.length ? `${value.length} item(s)` : "[]";
  if (typeof value === "object") return JSON.stringify(serializeForEditor(value));

  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return "—";
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
};

const rowMatchesSearch = (row, term, columns) => {
  const q = toSafeText(term).toLowerCase();
  if (!q) return true;

  return columns.some((column) => {
    const value = formatCellValue(row?.[column]).toLowerCase();
    return value.includes(q);
  });
};

const getComparableValue = (value) => {
  if (value == null) return -Infinity;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const d = timestampToDate(value);
  if (d) return d.getTime();
  return String(value).toLowerCase();
};

const sortRows = (rows = [], columns = []) => {
  const preferredKey = ["updatedAt", "createdAt", ...columns].find((key) =>
    rows.some((row) => row && row[key] != null)
  );

  if (!preferredKey) return [...rows];

  return [...rows].sort((a, b) => {
    const left = getComparableValue(a?.[preferredKey]);
    const right = getComparableValue(b?.[preferredKey]);
    if (left === right) return 0;
    return left > right ? -1 : 1;
  });
};

const buildDataColumns = (config, rows) => {
  const base = Array.isArray(config?.columns) ? config.columns : [];
  const hidden = new Set(config?.hiddenFields || []);
  const fromRows = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    for (const key of Object.keys(row || {})) {
      if (key === "id" || hidden.has(key) || base.includes(key) || fromRows.includes(key)) {
        continue;
      }
      fromRows.push(key);
    }
  }

  return [...base, ...fromRows].filter((key) => key !== "id" && !hidden.has(key));
};

const toEditorJson = (value) => JSON.stringify(serializeForEditor(value), null, 2);

const getInitialEditorText = (tableKey, row = null) => {
  const config = DATA_COLLECTIONS[tableKey];
  const source = row
    ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id"))
    : config?.defaultCreateValue || {};
  return toEditorJson(source);
};

const preparePayload = (tableKey, editorText, mode = "edit") => {
  let parsed;
  try {
    parsed = JSON.parse(editorText || "{}");
  } catch {
    throw new Error("JSON editor contains invalid JSON.");
  }

  const config = DATA_COLLECTIONS[tableKey];
  const hidden = new Set(config?.hiddenFields || []);
  const readOnly = new Set(mode === "create" ? [] : config?.readOnlyFields || []);
  const cleaned = {};

  for (const [key, value] of Object.entries(parsed || {})) {
    if (!key || key === "id" || hidden.has(key) || readOnly.has(key)) continue;
    cleaned[key] = deserializeFromEditor(value);
  }

  return cleaned;
};

const canUseDataBrowser = (viewer) => !!viewer;
const getPortalUserDocId = (value) => String(value?.uid || value?.id || "").trim();
const getUserDisplayLabel = (user = {}) =>
  String(user?.name || "").trim() ||
  `${user?.firstName || ""} ${user?.lastName || ""}`.trim() ||
  String(user?.email || "").trim() ||
  getPortalUserDocId(user) ||
  "Unnamed User";
const getEmployeeProcessUserId = (employee = {}) =>
  String(
    employee?.userId ||
      employee?.uid ||
      employee?.id ||
      employee?.employeeUserId ||
      employee?.employeeId ||
      ""
  ).trim();
const formatDateTime = (value, timeZone = "America/New_York") => {
  const resolved = timestampToDate(value);
  if (!resolved) return "-";
  return resolved.toLocaleString(undefined, {
    timeZone: String(timeZone || "").trim() || "America/New_York",
  });
};
const toDateInputValue = (value) => {
  if (!value) return "";

  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return "";
  }

  if (typeof value?.toDate === "function") {
    const parsed = value.toDate();
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }

  return "";
};

const toTimestampMillis = (value) => {
  const date = timestampToDate(value);
  return date ? date.getTime() : Number.NaN;
};

const formatBreakDuration = (row) => {
  const startMs = toTimestampMillis(row?.startedAt || row?.startTime);
  if (!Number.isFinite(startMs)) return "-";
  const endMs = toTimestampMillis(row?.endedAt || row?.endTime);
  const resolvedEndMs = Number.isFinite(endMs) ? endMs : Date.now();
  const minutes = Math.max(0, Math.round((resolvedEndMs - startMs) / 60000));
  return `${minutes} min`;
};

export default function ControlPanelPage({
  specialUsers = [],
  employees = [],
  loadingUsersData = false,
  usersError = "",
  viewer = null,
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago",
  attendanceDisplayTimeZoneMode = DISPLAY_TIME_ZONE_MODE_DEVICE,
  attendanceDisplayTimeZone = "",
  storageTimeZone = DEFAULT_STORAGE_TIME_ZONE,
  onSaveEmployeeAllowedPages,
  onSaveSpecialUserAllowedPages,
  onTransferEmployeeToPortalRole,
  onTransferSpecialUserToEmployeeRole,
  onDeleteAdminUser,
  onSetEmployeePassword,
  employeeProfilesByUserId = {},
  onSaveEmployeeStartDate,
  onApplyRoleCorePagesToAll,
  onReloadUsers,
  userRequests = [],
  loadingRequests = false,
  requestsError = "",
  processingRequestId = "",
  processingRequestAction = "",
  onApproveRequest,
  onRejectRequest,
  onReloadRequests,
  onUpdateUserProfile,
  onChangeUserEmail,
  onSendPasswordReset,
  onAttendanceSettingsChange,
  onAttendanceResetTimeChange,
  onBusinessTimeZoneChange,
  onToast,
  canOpenRegisterUser = false,
  onOpenRegisterUser = null,
}) {
  const [activeTab, setActiveTab] = useState(DATA_TABS.ACCESS);
  const [selectedType, setSelectedType] = useState("special");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userListFilter, setUserListFilter] = useState(USER_LIST_FILTERS.SPECIAL);
  const [selectedPages, setSelectedPages] = useState([]);
  const [saving, setSaving] = useState(false);
  const [transferRoleDraft, setTransferRoleDraft] = useState(ROLES.ADMIN);
  const [transferringEmployee, setTransferringEmployee] = useState(false);
  const [transferringToEmployee, setTransferringToEmployee] = useState(false);
  const [specialTransferTargetUserId, setSpecialTransferTargetUserId] = useState("");
  const [deletingSpecialUser, setDeletingSpecialUser] = useState(false);
  const [employeePasswordDraft, setEmployeePasswordDraft] = useState("");
  const [employeePasswordConfirmDraft, setEmployeePasswordConfirmDraft] = useState("");
  const [employeePasswordDropdownOpen, setEmployeePasswordDropdownOpen] = useState(false);
  const [savingEmployeePassword, setSavingEmployeePassword] = useState(false);
  const [employeeStartDateDraft, setEmployeeStartDateDraft] = useState("");
  const [savingEmployeeStartDate, setSavingEmployeeStartDate] = useState(false);
  const [approvalPasswordById, setApprovalPasswordById] = useState({});
  const [rejectionReasonById, setRejectionReasonById] = useState({});
  const [requestActionErrorById, setRequestActionErrorById] = useState({});
  const [specialProfileEditMode, setSpecialProfileEditMode] = useState(false);
  const [specialProfileDraft, setSpecialProfileDraft] = useState({
    firstName: "",
    lastName: "",
    role: ROLES.VISITOR,
  });
  const [specialEmailDraft, setSpecialEmailDraft] = useState("");
  const [savingSpecialProfile, setSavingSpecialProfile] = useState(false);
  const [savingSpecialEmail, setSavingSpecialEmail] = useState(false);
  const [sendingSpecialReset, setSendingSpecialReset] = useState(false);
  const [specialActionError, setSpecialActionError] = useState("");
  const [specialActionMessage, setSpecialActionMessage] = useState("");
  const [bulkRoleDraft, setBulkRoleDraft] = useState(ROLES.ADMIN);
  const [bulkRoleCorePagesDraft, setBulkRoleCorePagesDraft] = useState([]);
  const [bulkRolePerformancePagesDraft, setBulkRolePerformancePagesDraft] = useState([]);
  const [applyingRoleCorePages, setApplyingRoleCorePages] = useState(false);
  const [savingAttendanceSettings, setSavingAttendanceSettings] = useState(false);
  const [employeeProcessSettings, setEmployeeProcessSettings] = useState(getDefaultEmployeeProcessSettings());
  const [employeeProcessDraftIds, setEmployeeProcessDraftIds] = useState([]);
  const [employeeProcessLoading, setEmployeeProcessLoading] = useState(false);
  const [employeeProcessSaving, setEmployeeProcessSaving] = useState(false);
  const [employeeProcessMessage, setEmployeeProcessMessage] = useState("");
  const [employeeProcessError, setEmployeeProcessError] = useState("");
  const [draggingEmployeeProcessId, setDraggingEmployeeProcessId] = useState("");
  const [localError, setLocalError] = useState("");
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [settingsDrawerView, setSettingsDrawerView] = useState("");
  const breakLogMenuRef = useRef(null);
  const [breakLogRows, setBreakLogRows] = useState([]);
  const [breakLogLoading, setBreakLogLoading] = useState(false);
  const [breakLogError, setBreakLogError] = useState("");
  const [breakLogFilterEmployeeId, setBreakLogFilterEmployeeId] = useState("");
  const [breakLogMenuOpen, setBreakLogMenuOpen] = useState(false);
  const [breakLogArchiveView, setBreakLogArchiveView] = useState(false);
  const [breakLogRefreshTick, setBreakLogRefreshTick] = useState(0);
  const [breakClearModalOpen, setBreakClearModalOpen] = useState(false);
  const [breakClearPassword, setBreakClearPassword] = useState("");
  const [breakClearError, setBreakClearError] = useState("");
  const [breakClearBusy, setBreakClearBusy] = useState(false);
  const [breakDeleteArchiveModalOpen, setBreakDeleteArchiveModalOpen] = useState(false);
  const [breakDeleteArchivePassword, setBreakDeleteArchivePassword] = useState("");
  const [breakDeleteArchiveConfirmText, setBreakDeleteArchiveConfirmText] = useState("");
  const [breakDeleteArchiveError, setBreakDeleteArchiveError] = useState("");
  const [breakDeleteArchiveBusy, setBreakDeleteArchiveBusy] = useState(false);
  const [archivingBreakLogId, setArchivingBreakLogId] = useState("");
  const [restoringBreakLogId, setRestoringBreakLogId] = useState("");
  const [deletingArchivedBreakLogId, setDeletingArchivedBreakLogId] = useState("");
  const [restoringAllBreakLogs, setRestoringAllBreakLogs] = useState(false);
  const deviceTimeZone = getDeviceTimeZone();

  const [resetTimeDraft, setResetTimeDraft] = useState(() =>
    normalizeResetTime(attendanceResetTime)
  );
  const [displayTimeZoneModeDraft, setDisplayTimeZoneModeDraft] = useState(
    attendanceDisplayTimeZoneMode || DISPLAY_TIME_ZONE_MODE_DEVICE
  );
  const [displayTimeZoneDraft, setDisplayTimeZoneDraft] = useState(
    String(attendanceDisplayTimeZone || "").trim()
  );
  const [storageTimeZoneDraft, setStorageTimeZoneDraft] = useState(
    String(storageTimeZone || "").trim() || DEFAULT_STORAGE_TIME_ZONE
  );

  const dataBrowserEnabled = useMemo(() => canUseDataBrowser(viewer), [viewer]);
  const dataOptions = useMemo(() => Object.keys(DATA_COLLECTIONS), []);
  const [selectedTableKey, setSelectedTableKey] = useState(dataOptions[0] || "employee_announcements");
  const [dataRows, setDataRows] = useState([]);
  const [dataColumns, setDataColumns] = useState([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState("");
  const [dataQuery, setDataQuery] = useState("");
  const [dataLimit, setDataLimit] = useState(DATA_VIEWER_DEFAULT_LIMIT);
  const [dataRefreshTick, setDataRefreshTick] = useState(0);
  const [inspectedRow, setInspectedRow] = useState(null);
  const [editorMode, setEditorMode] = useState("view");
  const [editorRowId, setEditorRowId] = useState("");
  const [editorText, setEditorText] = useState("");
  const [editorError, setEditorError] = useState("");
  const [savingDataRow, setSavingDataRow] = useState(false);

  const employeeProcessOptions = useMemo(
    () =>
      (Array.isArray(employees) ? employees : [])
        .map((employee) => {
          const userId = getEmployeeProcessUserId(employee);
          if (!userId) return null;
          return {
            userId,
            name: getUserDisplayLabel(employee),
            email: toSafeText(employee?.email),
          };
        })
        .filter(Boolean),
    [employees]
  );

  const employeeProcessOptionById = useMemo(
    () => new Map(employeeProcessOptions.map((row) => [row.userId, row])),
    [employeeProcessOptions]
  );

  const employeeProcessIncludedRows = useMemo(
    () => employeeProcessDraftIds.map((userId) => employeeProcessOptionById.get(userId)).filter(Boolean),
    [employeeProcessDraftIds, employeeProcessOptionById]
  );

  const employeeProcessAvailableRows = useMemo(() => {
    const included = new Set(employeeProcessDraftIds);
    return employeeProcessOptions.filter((row) => !included.has(row.userId));
  }, [employeeProcessDraftIds, employeeProcessOptions]);

  const resetEmployeeProcessDraft = (settings = employeeProcessSettings) => {
    const savedIds = Array.isArray(settings?.rotationUserIds) ? settings.rotationUserIds : [];
    const optionIds = new Set(employeeProcessOptions.map((row) => row.userId));
    const nextIds = savedIds.map((userId) => String(userId || "").trim()).filter((userId) => optionIds.has(userId));
    setEmployeeProcessDraftIds(nextIds.length ? nextIds : employeeProcessOptions.map((row) => row.userId));
  };

  const moveEmployeeProcessDraftId = (fromId, toId) => {
    const sourceId = String(fromId || "").trim();
    const targetId = String(toId || "").trim();
    if (!sourceId || !targetId || sourceId === targetId) return;

    setEmployeeProcessDraftIds((prev) => {
      const next = [...prev];
      const fromIndex = next.indexOf(sourceId);
      const toIndex = next.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const addEmployeeToProcessDraft = (userId) => {
    const nextId = String(userId || "").trim();
    if (!nextId) return;
    setEmployeeProcessDraftIds((prev) => (prev.includes(nextId) ? prev : [...prev, nextId]));
  };

  const removeEmployeeFromProcessDraft = (userId) => {
    const nextId = String(userId || "").trim();
    setEmployeeProcessDraftIds((prev) => prev.filter((id) => id !== nextId));
  };

  const saveEmployeeProcessDraft = async () => {
    setEmployeeProcessSaving(true);
    setEmployeeProcessError("");
    setEmployeeProcessMessage("");
    try {
      await saveEmployeeProcessRotation({
        rotationUserIds: employeeProcessDraftIds,
        updatedByUserId: getPortalUserDocId(viewer),
        updatedByName: getUserDisplayLabel(viewer || {}),
      });
      setEmployeeProcessMessage("Saved IB/NL employee order.");
    } catch (err) {
      setEmployeeProcessError(err?.message || "Failed to save IB/NL employee order.");
    } finally {
      setEmployeeProcessSaving(false);
    }
  };

  useEffect(() => {
    setResetTimeDraft(normalizeResetTime(attendanceResetTime));
  }, [attendanceResetTime]);

  useEffect(() => {
    setDisplayTimeZoneModeDraft(
      attendanceDisplayTimeZoneMode === DISPLAY_TIME_ZONE_MODE_FIXED
        ? DISPLAY_TIME_ZONE_MODE_FIXED
        : DISPLAY_TIME_ZONE_MODE_DEVICE
    );
  }, [attendanceDisplayTimeZoneMode]);

  useEffect(() => {
    setDisplayTimeZoneDraft(String(attendanceDisplayTimeZone || "").trim());
  }, [attendanceDisplayTimeZone]);

  useEffect(() => {
    setStorageTimeZoneDraft(
      String(storageTimeZone || "").trim() || DEFAULT_STORAGE_TIME_ZONE
    );
  }, [storageTimeZone]);

  useEffect(() => {
    let active = true;
    setEmployeeProcessLoading(true);
    setEmployeeProcessError("");

    const unsubscribe = subscribeEmployeeProcessSettings(
      (settings) => {
        if (!active) return;
        setEmployeeProcessSettings(settings || getDefaultEmployeeProcessSettings());
        setEmployeeProcessLoading(false);
      },
      (err) => {
        if (!active) return;
        setEmployeeProcessError(err?.message || "Failed to load IB/NL employee order.");
        setEmployeeProcessLoading(false);
      }
    );

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (settingsDrawerView !== SETTINGS_DRAWER_VIEWS.EMPLOYEE_PROCESS) return;
    const savedIds = Array.isArray(employeeProcessSettings?.rotationUserIds)
      ? employeeProcessSettings.rotationUserIds
      : [];
    const optionIds = new Set(employeeProcessOptions.map((row) => row.userId));
    const nextIds = savedIds.map((userId) => String(userId || "").trim()).filter((userId) => optionIds.has(userId));
    setEmployeeProcessDraftIds(nextIds.length ? nextIds : employeeProcessOptions.map((row) => row.userId));
    setEmployeeProcessMessage("");
  }, [employeeProcessOptions, employeeProcessSettings?.rotationUserIds, settingsDrawerView]);

  useEffect(() => {
    if (displayTimeZoneModeDraft !== DISPLAY_TIME_ZONE_MODE_FIXED) return;
    if (String(displayTimeZoneDraft || "").trim()) return;
    setDisplayTimeZoneDraft(deviceTimeZone);
  }, [displayTimeZoneModeDraft, displayTimeZoneDraft, deviceTimeZone]);

  const timeZoneSelectOptions = useMemo(
    () =>
      buildSimpleTimeZoneOptions(
        deviceTimeZone,
        displayTimeZoneDraft,
        storageTimeZoneDraft,
        businessTimeZone,
        DEFAULT_STORAGE_TIME_ZONE
      ),
    [deviceTimeZone, displayTimeZoneDraft, storageTimeZoneDraft, businessTimeZone]
  );

  const resolvedDisplayTimeZonePreview = useMemo(
    () =>
      resolveAttendanceDisplayTimeZone(
        {
          displayTimeZoneMode: displayTimeZoneModeDraft,
          displayTimeZone: displayTimeZoneDraft,
        },
        deviceTimeZone
      ),
    [displayTimeZoneModeDraft, displayTimeZoneDraft, deviceTimeZone]
  );

  useEffect(() => {
    const special = (Array.isArray(specialUsers) ? specialUsers : []).filter(
      (user) => String(user?.role || "").toLowerCase() !== ROLES.SUPER_ADMIN
    );
    const employeeList = Array.isArray(employees) ? employees : [];

    if (selectedType === "special") {
      const found = special.some(
        (user) => String(user?.uid || user?.id || "") === String(selectedUserId)
      );
      if (found) return;
    }

    if (selectedType === "employee") {
      const found = employeeList.some(
        (user) => String(user?.uid || user?.id || "") === String(selectedUserId)
      );
      if (found) return;
    }

    if (special.length > 0) {
      setSelectedType("special");
      setSelectedUserId(String(special[0]?.uid || special[0]?.id || ""));
      return;
    }

    if (employeeList.length > 0) {
      setSelectedType("employee");
      setSelectedUserId(String(employeeList[0]?.uid || employeeList[0]?.id || ""));
      return;
    }

    setSelectedUserId("");
  }, [specialUsers, employees, selectedType, selectedUserId]);

  const filteredSpecialUsers = useMemo(
    () =>
      (Array.isArray(specialUsers) ? specialUsers : []).filter(
        (user) => String(user?.role || "").toLowerCase() !== ROLES.SUPER_ADMIN
      ),
    [specialUsers]
  );

  const selectedUser = useMemo(() => {
    const source = selectedType === "employee" ? employees : filteredSpecialUsers;

    return (
      source.find(
        (user) => String(user.uid || user.id || "") === String(selectedUserId)
      ) || null
    );
  }, [selectedType, selectedUserId, filteredSpecialUsers, employees]);
  const selectedSpecialUser = selectedType === "special" ? selectedUser : null;
  const specialTransferTargetOptions = useMemo(() => {
    const source = Array.isArray(employees) ? employees : [];
    const options = source
      .map((user) => {
        const value = getPortalUserDocId(user);
        if (!value) return null;
        return {
          value,
          label: getUserDisplayLabel(user),
          user,
        };
      })
      .filter(Boolean);

    options.sort((a, b) => String(a?.label || "").localeCompare(String(b?.label || "")));
    return options;
  }, [employees]);
  const selectedSpecialTransferTarget = useMemo(
    () =>
      specialTransferTargetOptions.find(
        (option) => String(option?.value || "") === String(specialTransferTargetUserId || "")
      ) || null,
    [specialTransferTargetOptions, specialTransferTargetUserId]
  );
  const selectedEmployeeProfile =
    selectedType === "employee" && selectedUserId
      ? employeeProfilesByUserId?.[String(selectedUserId)] || {}
      : {};
  const pendingRequests = useMemo(
    () =>
      (Array.isArray(userRequests) ? userRequests : []).filter(
        (row) => toStatus(row?.status) === "pending"
      ),
    [userRequests]
  );
  const breakLogEmployeeOptions = useMemo(() => {
    const source = Array.isArray(employees) ? employees : [];
    const seen = new Set();
    const options = [];

    for (const employee of source) {
      const userId = String(employee?.uid || employee?.id || employee?.userId || "").trim();
      if (!userId || seen.has(userId)) continue;

      const displayName =
        String(employee?.name || "").trim() ||
        `${employee?.firstName || ""} ${employee?.lastName || ""}`.trim() ||
        String(employee?.email || "").trim() ||
        userId;

      seen.add(userId);
      options.push({
        value: userId,
        label: displayName,
      });
    }

    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [employees]);

  const breakLogVisibleRows = useMemo(() => {
    const selectedEmployeeId = String(breakLogFilterEmployeeId || "").trim();
    const rows = (Array.isArray(breakLogRows) ? breakLogRows : []).filter(
      (row) => !!row?.archived === breakLogArchiveView
    );
    if (!selectedEmployeeId) return rows;

    return rows.filter((row) => {
      const rowUserId = String(row?.userId || row?.uid || row?.id || "").trim();
      return rowUserId === selectedEmployeeId;
    });
  }, [breakLogRows, breakLogArchiveView, breakLogFilterEmployeeId]);
  const activeBreakLogIds = useMemo(
    () =>
      (Array.isArray(breakLogRows) ? breakLogRows : [])
        .filter((row) => !row?.archived)
        .map((row) => String(row?.id || "").trim())
        .filter(Boolean),
    [breakLogRows]
  );
  const archivedBreakLogIds = useMemo(
    () =>
      (Array.isArray(breakLogRows) ? breakLogRows : [])
        .filter((row) => !!row?.archived)
        .map((row) => String(row?.id || "").trim())
        .filter(Boolean),
    [breakLogRows]
  );

  useEffect(() => {
    if (!breakLogFilterEmployeeId) return;
    const exists = breakLogEmployeeOptions.some(
      (option) => option.value === breakLogFilterEmployeeId
    );
    if (!exists) {
      setBreakLogFilterEmployeeId("");
    }
  }, [breakLogFilterEmployeeId, breakLogEmployeeOptions]);

  useEffect(() => {
    if (selectedType !== "special") return;
    if (!specialTransferTargetOptions.length) {
      if (specialTransferTargetUserId) {
        setSpecialTransferTargetUserId("");
      }
      return;
    }

    const hasCurrent = specialTransferTargetOptions.some(
      (option) => String(option?.value || "") === String(specialTransferTargetUserId || "")
    );
    if (hasCurrent) return;
    setSpecialTransferTargetUserId(String(specialTransferTargetOptions[0]?.value || ""));
  }, [selectedType, specialTransferTargetOptions, specialTransferTargetUserId]);

  const permissionPageKeys = useMemo(() => {
    const ordered = PERMISSION_PAGE_ORDER.filter((page) => PAGE_KEYS.includes(page));
    const extras = PAGE_KEYS.filter((page) => !ordered.includes(page));
    const merged = [...ordered, ...extras].filter((page) => page !== "control_panel");

    for (const perfPage of PERFORMANCE_PAGE_KEYS) {
      if (!merged.includes(perfPage) && PAGE_KEYS.includes(perfPage)) {
        merged.push(perfPage);
      }
    }

    return merged;
  }, []);

  const performancePermissionPageKeys = useMemo(
    () => permissionPageKeys.filter((page) => PERFORMANCE_PAGE_KEYS.includes(page)),
    [permissionPageKeys]
  );

  const corePermissionPageKeys = useMemo(
    () => permissionPageKeys.filter((page) => !PERFORMANCE_PAGE_KEYS.includes(page)),
    [permissionPageKeys]
  );

  useEffect(() => {
    let sourceAllowedPages = [];

    if (bulkRoleDraft === ROLES.EMPLOYEE) {
      const firstEmployee = (Array.isArray(employees) ? employees : []).find(
        (user) => String(user?.uid || user?.id || "").trim().length > 0
      );
      sourceAllowedPages = Array.isArray(firstEmployee?.allowedPages)
        ? firstEmployee.allowedPages
        : [];
    } else {
      const firstRoleUser = (Array.isArray(filteredSpecialUsers) ? filteredSpecialUsers : []).find(
        (user) => normalizeRole(user?.role) === bulkRoleDraft
      );
      sourceAllowedPages = Array.isArray(firstRoleUser?.allowedPages)
        ? firstRoleUser.allowedPages
        : [];
    }

    const defaults =
      Array.isArray(sourceAllowedPages) && sourceAllowedPages.length > 0
        ? sourceAllowedPages
        : Array.isArray(DEFAULT_ROLE_PAGES[bulkRoleDraft])
          ? DEFAULT_ROLE_PAGES[bulkRoleDraft]
          : [];
    setBulkRoleCorePagesDraft(
      defaults.filter((page) => corePermissionPageKeys.includes(page))
    );
    setBulkRolePerformancePagesDraft(
      defaults.filter((page) => performancePermissionPageKeys.includes(page))
    );
  }, [
    bulkRoleDraft,
    corePermissionPageKeys,
    performancePermissionPageKeys,
    employees,
    filteredSpecialUsers,
  ]);

  useEffect(() => {
    if (!selectedUser) return;
    setSelectedPages(
      Array.isArray(selectedUser.allowedPages) && selectedUser.allowedPages.length > 0
        ? selectedUser.allowedPages
        : DEFAULT_ROLE_PAGES[selectedUser.role] || []
    );
  }, [selectedUser]);

  useEffect(() => {
    setEmployeePasswordDraft("");
    setEmployeePasswordConfirmDraft("");
    setEmployeePasswordDropdownOpen(false);
  }, [selectedType, selectedUserId]);

  useEffect(() => {
    if (selectedType !== "employee") {
      setEmployeeStartDateDraft("");
      return;
    }
    setEmployeeStartDateDraft(
      toDateInputValue(selectedEmployeeProfile?.startDate || selectedUser?.startDate)
    );
  }, [selectedType, selectedUserId, selectedEmployeeProfile?.startDate, selectedUser?.startDate]);

  useEffect(() => {
    if (!selectedSpecialUser) {
      setSpecialProfileEditMode(false);
      setSpecialActionError("");
      setSpecialActionMessage("");
      return;
    }

    setSpecialProfileDraft({
      firstName: String(selectedSpecialUser?.firstName || "").trim(),
      lastName: String(selectedSpecialUser?.lastName || "").trim(),
      role: normalizeRole(selectedSpecialUser?.role) || ROLES.VISITOR,
    });
    setSpecialEmailDraft(String(selectedSpecialUser?.email || "").trim());
    setSpecialProfileEditMode(false);
    setSpecialActionError("");
    setSpecialActionMessage("");
  }, [selectedSpecialUser]);

  useEffect(() => {
    if (!settingsDrawerOpen) return undefined;

    const handleEscape = (event) => {
      if (event.key !== "Escape") return;
      if (breakDeleteArchiveModalOpen) {
        if (!breakDeleteArchiveBusy) {
          setBreakDeleteArchiveModalOpen(false);
          setBreakDeleteArchivePassword("");
          setBreakDeleteArchiveConfirmText("");
          setBreakDeleteArchiveError("");
        }
        return;
      }
      if (breakClearModalOpen) {
        if (!breakClearBusy) {
          setBreakClearModalOpen(false);
          setBreakClearPassword("");
          setBreakClearError("");
        }
        return;
      }
      if (breakLogMenuOpen) {
        setBreakLogMenuOpen(false);
        return;
      }
      setSettingsDrawerOpen(false);
      setSettingsMenuOpen(false);
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [
    settingsDrawerOpen,
    breakLogMenuOpen,
    breakClearModalOpen,
    breakClearBusy,
    breakDeleteArchiveModalOpen,
    breakDeleteArchiveBusy,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    if (!settingsDrawerOpen) return undefined;

    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
    };
  }, [settingsDrawerOpen]);

  const selectedTableConfig = DATA_COLLECTIONS[selectedTableKey];

  const filteredDataRows = useMemo(() => {
    const rows = Array.isArray(dataRows) ? dataRows : [];
    const columns = Array.isArray(dataColumns) ? dataColumns : [];
    return rows.filter((row) => rowMatchesSearch(row, dataQuery, columns));
  }, [dataRows, dataColumns, dataQuery]);

  useEffect(() => {
    if (!dataBrowserEnabled || activeTab !== DATA_TABS.DATA || !selectedTableKey) return;

    let cancelled = false;

    async function loadRows() {
      setDataLoading(true);
      setDataError("");

      try {
        const config = DATA_COLLECTIONS[selectedTableKey];
        const safeLimit = Math.max(1, Number(dataLimit) || DATA_VIEWER_DEFAULT_LIMIT);
        const snap = await getDocs(query(collection(db, config.collection), limit(safeLimit)));
        const hidden = new Set(config.hiddenFields || []);
        const rawRows = snap.docs.map((item) => {
          const data = item.data() || {};
          const cleaned = { id: item.id };

          for (const [key, value] of Object.entries(data)) {
            if (hidden.has(key)) continue;
            cleaned[key] = value;
          }

          return cleaned;
        });

        const columns = buildDataColumns(config, rawRows);
        const sortedRows = sortRows(rawRows, columns);

        if (!cancelled) {
          setDataColumns(columns);
          setDataRows(sortedRows);
          if (inspectedRow) {
            const fresh = sortedRows.find((row) => row.id === inspectedRow.id) || null;
            setInspectedRow(fresh);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setDataRows([]);
          setDataColumns([]);
          setDataError(error?.message || "Failed to load collection.");
        }
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    }

    loadRows();
    return () => {
      cancelled = true;
    };
  }, [dataBrowserEnabled, activeTab, selectedTableKey, dataLimit, dataRefreshTick, inspectedRow]);

  useEffect(() => {
    const isBreakLogViewOpen =
      settingsDrawerOpen && settingsDrawerView === SETTINGS_DRAWER_VIEWS.BREAK_LOG_RECORDS;
    if (!isBreakLogViewOpen) return;

    let cancelled = false;

    async function loadBreakLogs() {
      setBreakLogLoading(true);
      setBreakLogError("");

      try {
        const snap = await getDocs(collection(db, "break_logs"));

        const rows = snap.docs
          .map((item) => ({
            id: item.id,
            ...(item.data() || {}),
          }))
          .sort((a, b) => {
            const leftMs = toTimestampMillis(a?.updatedAt || a?.createdAt);
            const rightMs = toTimestampMillis(b?.updatedAt || b?.createdAt);
            if (Number.isFinite(rightMs) && Number.isFinite(leftMs)) {
              return rightMs - leftMs;
            }
            if (Number.isFinite(rightMs)) return 1;
            if (Number.isFinite(leftMs)) return -1;
            return 0;
          });

        if (!cancelled) {
          setBreakLogRows(rows);
        }
      } catch (error) {
        if (!cancelled) {
          setBreakLogRows([]);
          setBreakLogError(error?.message || "Failed to load break logs.");
        }
      } finally {
        if (!cancelled) {
          setBreakLogLoading(false);
        }
      }
    }

    loadBreakLogs();
    return () => {
      cancelled = true;
    };
  }, [settingsDrawerOpen, settingsDrawerView, breakLogRefreshTick]);

  useEffect(() => {
    if (settingsDrawerView === SETTINGS_DRAWER_VIEWS.BREAK_LOG_RECORDS) return;
    setBreakLogMenuOpen(false);
    setBreakClearModalOpen(false);
    setBreakClearError("");
    setBreakClearPassword("");
    setBreakDeleteArchiveModalOpen(false);
    setBreakDeleteArchiveError("");
    setBreakDeleteArchivePassword("");
    setBreakDeleteArchiveConfirmText("");
  }, [settingsDrawerView]);

  useEffect(() => {
    if (!breakLogMenuOpen) return undefined;

    const onOutsideClick = (event) => {
      if (breakLogMenuRef.current && !breakLogMenuRef.current.contains(event.target)) {
        setBreakLogMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onOutsideClick);
    return () => {
      document.removeEventListener("mousedown", onOutsideClick);
    };
  }, [breakLogMenuOpen]);

  function togglePage(pageKey) {
    setSelectedPages((prev) => {
      if (prev.includes(pageKey)) {
        return prev.filter((item) => item !== pageKey);
      }
      return [...prev, pageKey];
    });
  }

  function toggleBulkRoleCorePage(pageKey) {
    setBulkRoleCorePagesDraft((prev) => {
      if (prev.includes(pageKey)) {
        return prev.filter((item) => item !== pageKey);
      }
      return [...prev, pageKey];
    });
  }

  function toggleBulkRolePerformancePage(pageKey) {
    setBulkRolePerformancePagesDraft((prev) => {
      if (prev.includes(pageKey)) {
        return prev.filter((item) => item !== pageKey);
      }
      return [...prev, pageKey];
    });
  }

  async function handleApplyBulkRoleCorePages() {
    if (!onApplyRoleCorePagesToAll) return;

    setApplyingRoleCorePages(true);
    setLocalError("");

    try {
      const result = await onApplyRoleCorePagesToAll({
        role: bulkRoleDraft,
        corePages: bulkRoleCorePagesDraft,
        performancePages: bulkRolePerformancePagesDraft,
      });
      await onReloadUsers?.();

      const updatedCount = Number(result?.updatedCount || 0);
      const failedCount = Number(result?.failedCount || 0);

      onToast?.({
        type: failedCount > 0 ? "info" : "success",
        title: failedCount > 0 ? "Applied with warnings" : "Applied",
        message:
          failedCount > 0
            ? `Updated ${updatedCount} user(s), ${failedCount} failed.`
            : `Updated ${updatedCount} user(s) in ${toRoleLabel(bulkRoleDraft)} role.`,
      });
    } catch (err) {
      const msg = err?.message || "Failed to apply role core pages";
      setLocalError(msg);
      onToast?.({
        type: "error",
        title: "Bulk apply failed",
        message: msg,
      });
    } finally {
      setApplyingRoleCorePages(false);
    }
  }

  async function handleSave() {
    if (!selectedUser) return;

    setSaving(true);
    setLocalError("");

    try {
      if (selectedType === "employee") {
        await onSaveEmployeeAllowedPages?.({
          userId: selectedUser.uid || selectedUser.id,
          allowedPages: selectedPages,
          employeeData: {
            name: selectedUser.name,
            email: selectedUser.email,
          },
        });
      } else {
        await onSaveSpecialUserAllowedPages?.({
          userId: selectedUser.uid || selectedUser.id,
          allowedPages: selectedPages,
        });
      }

      await onReloadUsers?.();

      onToast?.({
        type: "success",
        title: "Saved",
        message: "Permissions updated successfully.",
      });
    } catch (err) {
      const msg = err?.message || "Failed to update permissions";
      setLocalError(msg);
      onToast?.({
        type: "error",
        title: "Save failed",
        message: msg,
      });
    } finally {
      setSaving(false);
    }
  }

  function resetToDefault() {
    if (!selectedUser) return;
    setSelectedPages(DEFAULT_ROLE_PAGES[selectedUser.role] || []);
  }

  function selectSpecialUser(user) {
    setSelectedType("special");
    setSelectedUserId(String(user.uid || user.id || ""));
  }

  function selectEmployee(user) {
    setSelectedType("employee");
    setSelectedUserId(String(user.uid || user.id || ""));
  }

  async function handleTransferSelectedEmployee() {
    if (!selectedUser || selectedType !== "employee") return;

    const targetUserId = String(selectedUser.uid || selectedUser.id || "").trim();
    if (!targetUserId) {
      setLocalError("Selected employee is missing user id.");
      return;
    }

    setTransferringEmployee(true);
    setLocalError("");

    try {
      await onTransferEmployeeToPortalRole?.({
        userId: targetUserId,
        role: transferRoleDraft,
        employeeData: {
          name:
            selectedUser?.name ||
            `${selectedUser?.firstName || ""} ${selectedUser?.lastName || ""}`.trim(),
          email: selectedUser?.email || "",
          firstName: selectedUser?.firstName || "",
          lastName: selectedUser?.lastName || "",
        },
      });

      await onReloadUsers?.();
      setSelectedType("special");
      setSelectedUserId(targetUserId);

      onToast?.({
        type: "success",
        title: "Transferred",
        message: `${selectedUser?.name || selectedUser?.email || "Employee"} moved to ${toRoleLabel(
          transferRoleDraft
        )}.`,
      });
    } catch (err) {
      const msg = err?.message || "Failed to transfer employee role";
      setLocalError(msg);
      onToast?.({
        type: "error",
        title: "Transfer failed",
        message: msg,
      });
    } finally {
      setTransferringEmployee(false);
    }
  }

  async function handleTransferSelectedSpecialToEmployee() {
    if (!selectedUser || selectedType !== "special") return;
    if (normalizeRole(selectedUser?.role) === ROLES.SUPER_ADMIN) {
      setLocalError("Super Admin cannot be transferred to employee from this panel.");
      return;
    }

    const targetUserId = String(selectedUser.uid || selectedUser.id || "").trim();
    if (!targetUserId) {
      setLocalError("Selected user is missing user id.");
      return;
    }
    if (!selectedSpecialTransferTarget?.user) {
      setLocalError("Select the employee user to transfer this special user to.");
      return;
    }

    const targetEmployee = selectedSpecialTransferTarget.user;

    setTransferringToEmployee(true);
    setLocalError("");

    try {
      await onTransferSpecialUserToEmployeeRole?.({
        userId: targetUserId,
        userData: {
          name: getUserDisplayLabel(targetEmployee),
          email: selectedUser?.email || "",
          firstName: targetEmployee?.firstName || selectedUser?.firstName || "",
          lastName: targetEmployee?.lastName || selectedUser?.lastName || "",
          employeeId: targetEmployee?.employeeId || selectedUser?.employeeId || "",
        },
      });

      await onReloadUsers?.();
      setSelectedType("employee");
      setSelectedUserId(targetUserId);

      onToast?.({
        type: "success",
        title: "Transferred",
        message: `${selectedUser?.name || selectedUser?.email || "User"} moved to employee as ${getUserDisplayLabel(
          targetEmployee
        )}.`,
      });
    } catch (err) {
      const msg = err?.message || "Failed to transfer user to employee";
      setLocalError(msg);
      onToast?.({
        type: "error",
        title: "Transfer failed",
        message: msg,
      });
    } finally {
      setTransferringToEmployee(false);
    }
  }

  async function handleDeleteSelectedSpecialUser() {
    if (!selectedUser || selectedType !== "special") return;
    if (normalizeRole(selectedUser?.role) === ROLES.SUPER_ADMIN) return;
    if (!onDeleteAdminUser) return;

    const targetUserId = String(selectedUser.uid || selectedUser.id || "").trim();
    if (!targetUserId) {
      setLocalError("Selected user is missing user id.");
      return;
    }

    const targetLabel =
      selectedUser?.name ||
      `${selectedUser?.firstName || ""} ${selectedUser?.lastName || ""}`.trim() ||
      selectedUser?.email ||
      targetUserId;

    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            `Delete special user "${targetLabel}"? This permanently deletes the account from portal data and Firebase Authentication.`
          );
    if (!confirmed) return;

    setDeletingSpecialUser(true);
    setLocalError("");

    try {
      await onDeleteAdminUser({ userId: targetUserId });
      await onReloadUsers?.();

      onToast?.({
        type: "success",
        title: "User Deleted",
        message: `${targetLabel} was removed.`,
      });
    } catch (err) {
      const msg = err?.message || "Failed to delete special user";
      setLocalError(msg);
      onToast?.({
        type: "error",
        title: "Delete failed",
        message: msg,
      });
    } finally {
      setDeletingSpecialUser(false);
    }
  }

  async function handleSaveSelectedEmployeePassword() {
    if (!selectedUser || selectedType !== "employee") return;
    if (!onSetEmployeePassword) return;

    const targetUserId = String(selectedUser.uid || selectedUser.id || "").trim();
    if (!targetUserId) {
      setLocalError("Selected employee is missing user id.");
      return;
    }

    const newPassword = String(employeePasswordDraft || "").trim();
    const confirmPassword = String(employeePasswordConfirmDraft || "").trim();

    if (!newPassword) {
      setLocalError("Enter a new password.");
      return;
    }
    if (newPassword.length < 6) {
      setLocalError("New password must be at least 6 characters.");
      return;
    }
    if (confirmPassword && confirmPassword !== newPassword) {
      setLocalError("Password and confirm password do not match.");
      return;
    }

    setSavingEmployeePassword(true);
    setLocalError("");

    try {
      const result = await onSetEmployeePassword({
        userId: targetUserId,
        newPassword,
        employeeData: {
          name:
            selectedUser?.name ||
            `${selectedUser?.firstName || ""} ${selectedUser?.lastName || ""}`.trim(),
          email: selectedUser?.email || "",
        },
      });

      setEmployeePasswordDraft("");
      setEmployeePasswordConfirmDraft("");

      onToast?.({
        type: "success",
        title: "Password Updated",
        message: result?.authUserCreated
          ? `Password updated and Authentication account created for ${
              selectedUser?.name || selectedUser?.email || "employee"
            }.`
          : `Updated password for ${selectedUser?.name || selectedUser?.email || "employee"}.`,
      });
    } catch (err) {
      const msg = err?.message || "Failed to update employee password";
      setLocalError(msg);
      onToast?.({
        type: "error",
        title: "Password update failed",
        message: msg,
      });
    } finally {
      setSavingEmployeePassword(false);
    }
  }

  async function handleSaveSelectedEmployeeStartDate() {
    if (!selectedUser || selectedType !== "employee") return;
    if (!onSaveEmployeeStartDate) return;

    const targetUserId = String(selectedUser.uid || selectedUser.id || "").trim();
    if (!targetUserId) {
      setLocalError("Selected employee is missing user id.");
      return;
    }

    const startDate = String(employeeStartDateDraft || "").trim();
    if (!startDate) {
      setLocalError("Please select a start date.");
      return;
    }

    setSavingEmployeeStartDate(true);
    setLocalError("");

    try {
      await onSaveEmployeeStartDate({
        userId: targetUserId,
        startDate,
        name:
          selectedUser?.name ||
          `${selectedUser?.firstName || ""} ${selectedUser?.lastName || ""}`.trim(),
        email: selectedUser?.email || "",
        employeeData: selectedUser,
        updatedBy: {
          uid: viewer?.uid || viewer?.userId || viewer?.id || "",
          email: viewer?.email || "",
          role: viewer?.role || "",
          name: viewer?.name || viewer?.displayName || "",
        },
      });

      onToast?.({
        type: "success",
        title: "Saved",
        message: `Start date saved for ${selectedUser?.name || selectedUser?.email || "employee"}.`,
      });
    } catch (err) {
      const msg = err?.message || "Failed to save employee start date";
      setLocalError(msg);
      onToast?.({
        type: "error",
        title: "Save failed",
        message: msg,
      });
    } finally {
      setSavingEmployeeStartDate(false);
    }
  }

  async function handleApprovePendingRequest(requestRow) {
    if (!onApproveRequest) return;

    const requestId = String(requestRow?.id || "").trim();
    const password = String(approvalPasswordById?.[requestId] || "").trim();
    if (!requestId) return;

    setRequestActionErrorById((prev) => ({ ...prev, [requestId]: "" }));

    try {
      await onApproveRequest(requestId, { password });
      setApprovalPasswordById((prev) => ({ ...prev, [requestId]: "" }));
      setRejectionReasonById((prev) => ({ ...prev, [requestId]: "" }));
    } catch (error) {
      setRequestActionErrorById((prev) => ({
        ...prev,
        [requestId]: error?.message || "Could not approve request.",
      }));
    }
  }

  async function handleRejectPendingRequest(requestRow) {
    if (!onRejectRequest) return;

    const requestId = String(requestRow?.id || "").trim();
    if (!requestId) return;

    setRequestActionErrorById((prev) => ({ ...prev, [requestId]: "" }));

    try {
      await onRejectRequest(requestId, {
        reason: String(rejectionReasonById?.[requestId] || "").trim(),
      });
      setApprovalPasswordById((prev) => ({ ...prev, [requestId]: "" }));
      setRejectionReasonById((prev) => ({ ...prev, [requestId]: "" }));
    } catch (error) {
      setRequestActionErrorById((prev) => ({
        ...prev,
        [requestId]: error?.message || "Could not reject request.",
      }));
    }
  }

  async function handleSaveSpecialProfile() {
    if (!selectedSpecialUser || !onUpdateUserProfile) return;

    const targetUserId = getPortalUserDocId(selectedSpecialUser);
    if (!targetUserId) return;

    setSavingSpecialProfile(true);
    setSpecialActionError("");
    setSpecialActionMessage("");

    try {
      const result = await onUpdateUserProfile(targetUserId, {
        firstName: specialProfileDraft.firstName,
        lastName: specialProfileDraft.lastName,
        role: specialProfileDraft.role,
      });

      const fullName = `${result?.firstName || specialProfileDraft.firstName || ""} ${
        result?.lastName || specialProfileDraft.lastName || ""
      }`.trim();
      setSpecialActionMessage(`${fullName || "Profile"} details updated.`);
      setSpecialProfileEditMode(false);
    } catch (error) {
      setSpecialActionError(error?.message || "Could not update profile details.");
    } finally {
      setSavingSpecialProfile(false);
    }
  }

  async function handleSaveSpecialEmail() {
    if (!selectedSpecialUser || !onChangeUserEmail) return;

    const targetUserId = getPortalUserDocId(selectedSpecialUser);
    if (!targetUserId) return;

    setSavingSpecialEmail(true);
    setSpecialActionError("");
    setSpecialActionMessage("");

    try {
      const result = await onChangeUserEmail(targetUserId, specialEmailDraft);
      const nextEmail = String(result?.email || specialEmailDraft || "").trim();
      if (nextEmail) {
        setSpecialEmailDraft(nextEmail);
      }
      setSpecialActionMessage(result?.message || `Email updated to ${nextEmail || specialEmailDraft}.`);
    } catch (error) {
      setSpecialActionError(error?.message || "Could not update email.");
    } finally {
      setSavingSpecialEmail(false);
    }
  }

  async function handleSendSpecialPasswordReset() {
    if (!onSendPasswordReset) return;

    const fallbackEmail = String(selectedSpecialUser?.email || "").trim();
    const targetEmail = String(specialEmailDraft || fallbackEmail).trim();
    if (!targetEmail) {
      setSpecialActionError("Email is required to send password reset.");
      return;
    }

    setSendingSpecialReset(true);
    setSpecialActionError("");
    setSpecialActionMessage("");

    try {
      const result = await onSendPasswordReset(targetEmail);
      setSpecialActionMessage(
        result?.message || `Password reset email sent to ${result?.email || targetEmail}.`
      );
    } catch (error) {
      setSpecialActionError(error?.message || "Could not send password reset email.");
    } finally {
      setSendingSpecialReset(false);
    }
  }

  function handleDisplayTimeZoneSelection(value) {
    const next = String(value || "").trim();

    if (next === DEVICE_TIME_ZONE_OPTION) {
      setDisplayTimeZoneModeDraft(DISPLAY_TIME_ZONE_MODE_DEVICE);
      setDisplayTimeZoneDraft("");
      return;
    }

    setDisplayTimeZoneModeDraft(DISPLAY_TIME_ZONE_MODE_FIXED);
    setDisplayTimeZoneDraft(next);
  }

  async function handleSaveAttendanceSettings() {
    setSavingAttendanceSettings(true);
    setLocalError("");

    try {
      const normalizedResetTime = normalizeResetTime(resetTimeDraft);
      const normalizedDisplayMode =
        displayTimeZoneModeDraft === DISPLAY_TIME_ZONE_MODE_FIXED
          ? DISPLAY_TIME_ZONE_MODE_FIXED
          : DISPLAY_TIME_ZONE_MODE_DEVICE;
      const normalizedDisplayTimeZone =
        normalizedDisplayMode === DISPLAY_TIME_ZONE_MODE_FIXED
          ? sanitizeTimeZone(displayTimeZoneDraft, deviceTimeZone)
          : "";
      const normalizedStorageTimeZone = sanitizeTimeZone(
        storageTimeZoneDraft,
        DEFAULT_STORAGE_TIME_ZONE
      );

      const savedSettings = await saveAttendanceSettings(
        {
          resetTime: normalizedResetTime,
          displayTimeZoneMode: normalizedDisplayMode,
          displayTimeZone: normalizedDisplayTimeZone,
          storageTimeZone: normalizedStorageTimeZone,
        },
        {
          uid: viewer?.uid || viewer?.userId || viewer?.id || "",
          email: viewer?.email || "",
          role: viewer?.role || "",
          name: viewer?.name || viewer?.displayName || "",
        }
      );
      const resolvedDisplayTimeZone = resolveAttendanceDisplayTimeZone(
        savedSettings,
        deviceTimeZone
      );

      setStoredAttendanceResetTime(savedSettings.resetTime);
      setResetTimeDraft(savedSettings.resetTime);
      setDisplayTimeZoneModeDraft(savedSettings.displayTimeZoneMode);
      setDisplayTimeZoneDraft(savedSettings.displayTimeZone);
      setStorageTimeZoneDraft(savedSettings.storageTimeZone);

      onAttendanceSettingsChange?.({
        ...savedSettings,
        resolvedBusinessTimeZone: resolvedDisplayTimeZone,
      });
      onAttendanceResetTimeChange?.(savedSettings.resetTime);
      onBusinessTimeZoneChange?.(resolvedDisplayTimeZone);

      onToast?.({
        type: "success",
        title: "Saved",
        message: `Saved reset ${savedSettings.resetTime}, display TZ ${resolvedDisplayTimeZone}, DB TZ ${savedSettings.storageTimeZone}.`,
      });
    } catch (err) {
      const msg = err?.message || "Failed to save attendance settings";
      setLocalError(msg);
      onToast?.({
        type: "error",
        title: "Save failed",
        message: msg,
      });
    } finally {
      setSavingAttendanceSettings(false);
    }
  }

  function openViewer(row) {
    setEditorMode("view");
    setEditorRowId(row?.id || "");
    setEditorText(toEditorJson(row || {}));
    setEditorError("");
    setInspectedRow(row || null);
  }

  function openEditor(row) {
    setEditorMode("edit");
    setEditorRowId(row?.id || "");
    setEditorText(getInitialEditorText(selectedTableKey, row));
    setEditorError("");
    setInspectedRow(row || null);
  }

  function openCreateEditor() {
    setEditorMode("create");
    setEditorRowId("");
    setEditorText(getInitialEditorText(selectedTableKey, null));
    setEditorError("");
    setInspectedRow(null);
  }

  function closeEditorPanel() {
    setEditorMode("view");
    setEditorRowId("");
    setEditorText("");
    setEditorError("");
    setInspectedRow(null);
  }

  async function handleSaveDataRow() {
    if (!selectedTableKey) return;

    setSavingDataRow(true);
    setEditorError("");

    try {
      const payload = preparePayload(selectedTableKey, editorText, editorMode);
      const config = DATA_COLLECTIONS[selectedTableKey];

      if (editorMode === "create") {
        if (!config.canCreate) throw new Error("Create is disabled for this collection.");
        await addDoc(collection(db, config.collection), {
          ...payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else if (editorMode === "edit") {
        if (!config.canEdit) throw new Error("Edit is disabled for this collection.");
        if (!editorRowId) throw new Error("Missing row id.");
        await updateDoc(doc(db, config.collection, editorRowId), {
          ...payload,
          updatedAt: serverTimestamp(),
        });
      } else {
        return;
      }

      onToast?.({
        type: "success",
        title: editorMode === "create" ? "Document created" : "Document saved",
        message: `${config.label} updated successfully.`,
      });
      closeEditorPanel();
      setDataRefreshTick((v) => v + 1);
    } catch (error) {
      const msg = error?.message || "Failed to save document.";
      setEditorError(msg);
      onToast?.({
        type: "error",
        title: "Save failed",
        message: msg,
      });
    } finally {
      setSavingDataRow(false);
    }
  }

  async function handleDeleteRow(row) {
    if (!row?.id || !selectedTableKey) return;

    const config = DATA_COLLECTIONS[selectedTableKey];
    if (!config.canDelete) {
      onToast?.({
        type: "error",
        title: "Delete blocked",
        message: `Delete is disabled for ${config.label}.`,
      });
      return;
    }

    const confirmed = window.confirm(`Delete document ${row.id}? This cannot be undone.`);
    if (!confirmed) return;

    try {
      await deleteDoc(doc(db, config.collection, row.id));
      onToast?.({
        type: "success",
        title: "Deleted",
        message: `Document ${row.id} removed.`,
      });
      if (editorRowId === row.id) closeEditorPanel();
      setDataRefreshTick((v) => v + 1);
    } catch (error) {
      const msg = error?.message || "Failed to delete document.";
      setDataError(msg);
      onToast?.({
        type: "error",
        title: "Delete failed",
        message: msg,
      });
    }
  }

  function openSettingsDrawer(viewKey) {
    const allowed = Object.values(SETTINGS_DRAWER_VIEWS);
    const nextView = allowed.includes(viewKey) ? viewKey : SETTINGS_DRAWER_VIEWS.ATTENDANCE;
    if (nextView === SETTINGS_DRAWER_VIEWS.BREAK_LOG_RECORDS) {
      setBreakLogArchiveView(false);
    }
    setSettingsDrawerView(nextView);
    setSettingsDrawerOpen(true);
    setSettingsMenuOpen(false);
    setBreakLogMenuOpen(false);
    setBreakClearModalOpen(false);
    setBreakClearPassword("");
    setBreakClearError("");
    setBreakDeleteArchiveModalOpen(false);
    setBreakDeleteArchivePassword("");
    setBreakDeleteArchiveConfirmText("");
    setBreakDeleteArchiveError("");
  }

  function closeSettingsDrawer() {
    setSettingsDrawerOpen(false);
    setEmployeePasswordDropdownOpen(false);
    setBreakLogMenuOpen(false);
    setBreakClearModalOpen(false);
    setBreakClearPassword("");
    setBreakClearError("");
    setBreakDeleteArchiveModalOpen(false);
    setBreakDeleteArchivePassword("");
    setBreakDeleteArchiveConfirmText("");
    setBreakDeleteArchiveError("");
  }

  function openBreakClearModal() {
    setBreakLogMenuOpen(false);
    setBreakDeleteArchiveModalOpen(false);
    setBreakClearError("");
    setBreakClearPassword("");
    setBreakClearModalOpen(true);
  }

  function closeBreakClearModal() {
    if (breakClearBusy) return;
    setBreakClearModalOpen(false);
    setBreakClearPassword("");
    setBreakClearError("");
  }

  function openBreakDeleteArchiveModal() {
    setBreakLogMenuOpen(false);
    setBreakClearModalOpen(false);
    setBreakDeleteArchiveError("");
    setBreakDeleteArchivePassword("");
    setBreakDeleteArchiveConfirmText("");
    setBreakDeleteArchiveModalOpen(true);
  }

  function closeBreakDeleteArchiveModal() {
    if (breakDeleteArchiveBusy) return;
    setBreakDeleteArchiveModalOpen(false);
    setBreakDeleteArchivePassword("");
    setBreakDeleteArchiveConfirmText("");
    setBreakDeleteArchiveError("");
  }

  async function handleClearBreakLogs() {
    if (breakClearBusy) return;

    const normalizedPassword = String(breakClearPassword || "").trim();
    if (!normalizedPassword) {
      setBreakClearError("Enter your super admin password to continue.");
      return;
    }

    if (normalizeRole(viewer?.role) !== ROLES.SUPER_ADMIN) {
      setBreakClearError("Only super admins can clear break logs.");
      return;
    }

    if (activeBreakLogIds.length === 0) {
      setBreakClearModalOpen(false);
      onToast?.({
        type: "info",
        title: "No Active Logs",
        message: "There are no active break logs to move into Break Archive.",
      });
      return;
    }

    const currentUser = auth.currentUser;
    const authEmail = String(currentUser?.email || viewer?.email || "").trim();

    if (!currentUser || !authEmail) {
      setBreakClearError("Could not verify your account session. Please sign in again.");
      return;
    }

    setBreakClearBusy(true);
    setBreakClearError("");

    try {
      const credential = EmailAuthProvider.credential(authEmail, normalizedPassword);
      await reauthenticateWithCredential(currentUser, credential);

      const actorUserId = String(
        viewer?.uid || viewer?.userId || viewer?.id || currentUser.uid || ""
      ).trim();
      const actorName = String(
        viewer?.name || viewer?.displayName || viewer?.email || authEmail || "Super Admin"
      ).trim();

      await Promise.all(
        activeBreakLogIds.map((breakLogId) =>
          updateDoc(doc(db, "break_logs", breakLogId), {
            archived: true,
            archivedAt: serverTimestamp(),
            archivedByUserId: actorUserId,
            archivedByName: actorName,
            updatedAt: serverTimestamp(),
          })
        )
      );

      setBreakClearModalOpen(false);
      setBreakClearPassword("");
      setBreakLogArchiveView(true);
      setBreakLogRefreshTick((v) => v + 1);

      onToast?.({
        type: "success",
        title: "Break Logs Archived",
        message: `${activeBreakLogIds.length} break log(s) moved to Break Archive.`,
      });
    } catch (error) {
      const code = String(error?.code || "").trim().toLowerCase();
      if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
        setBreakClearError("Incorrect password. Please try again.");
      } else {
        setBreakClearError(error?.message || "Could not clear break logs.");
      }
    } finally {
      setBreakClearBusy(false);
    }
  }

  async function handleClearBreakArchive() {
    if (breakDeleteArchiveBusy) return;

    const normalizedPassword = String(breakDeleteArchivePassword || "").trim();
    if (!normalizedPassword) {
      setBreakDeleteArchiveError("Enter your super admin password to continue.");
      return;
    }

    const normalizedConfirmText = String(breakDeleteArchiveConfirmText || "").trim().toUpperCase();
    if (normalizedConfirmText !== "DELETE") {
      setBreakDeleteArchiveError('Type "DELETE" to confirm permanent deletion.');
      return;
    }

    if (normalizeRole(viewer?.role) !== ROLES.SUPER_ADMIN) {
      setBreakDeleteArchiveError("Only super admins can clear break archive.");
      return;
    }

    if (archivedBreakLogIds.length === 0) {
      setBreakDeleteArchiveModalOpen(false);
      onToast?.({
        type: "info",
        title: "Archive Is Empty",
        message: "There are no archived break logs to delete.",
      });
      return;
    }

    const currentUser = auth.currentUser;
    const authEmail = String(currentUser?.email || viewer?.email || "").trim();

    if (!currentUser || !authEmail) {
      setBreakDeleteArchiveError("Could not verify your account session. Please sign in again.");
      return;
    }

    setBreakDeleteArchiveBusy(true);
    setBreakDeleteArchiveError("");

    try {
      const credential = EmailAuthProvider.credential(authEmail, normalizedPassword);
      await reauthenticateWithCredential(currentUser, credential);

      await Promise.all(
        archivedBreakLogIds.map((breakLogId) => deleteDoc(doc(db, "break_logs", breakLogId)))
      );

      setBreakDeleteArchiveModalOpen(false);
      setBreakDeleteArchivePassword("");
      setBreakDeleteArchiveConfirmText("");
      setBreakLogRefreshTick((v) => v + 1);

      onToast?.({
        type: "success",
        title: "Break Archive Cleared",
        message: `${archivedBreakLogIds.length} archived break log(s) deleted permanently.`,
      });
    } catch (error) {
      const code = String(error?.code || "").trim().toLowerCase();
      if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
        setBreakDeleteArchiveError("Incorrect password. Please try again.");
      } else {
        setBreakDeleteArchiveError(error?.message || "Could not clear break archive.");
      }
    } finally {
      setBreakDeleteArchiveBusy(false);
    }
  }

  async function handleArchiveSingleBreakLog(row = {}) {
    const breakLogId = String(row?.id || "").trim();
    if (!breakLogId || !!row?.archived) return;

    const label =
      String(row?.name || "").trim() ||
      String(row?.email || "").trim() ||
      String(row?.userId || "").trim() ||
      breakLogId;

    const confirmed = window.confirm(`Move break log for "${label}" to Break Archive?`);
    if (!confirmed) return;

    setArchivingBreakLogId(breakLogId);
    try {
      const currentUser = auth.currentUser;
      const actorUserId = String(
        viewer?.uid || viewer?.userId || viewer?.id || currentUser?.uid || ""
      ).trim();
      const actorName = String(
        viewer?.name ||
          viewer?.displayName ||
          viewer?.email ||
          currentUser?.email ||
          "Portal User"
      ).trim();

      await updateDoc(doc(db, "break_logs", breakLogId), {
        archived: true,
        archivedAt: serverTimestamp(),
        archivedByUserId: actorUserId,
        archivedByName: actorName,
        updatedAt: serverTimestamp(),
      });

      setBreakLogRefreshTick((value) => value + 1);
      onToast?.({
        type: "success",
        title: "Break Log Archived",
        message: `Moved break log for ${label} to Break Archive.`,
      });
    } catch (error) {
      onToast?.({
        type: "error",
        title: "Archive Failed",
        message: error?.message || "Could not move break log to archive.",
      });
    } finally {
      setArchivingBreakLogId("");
    }
  }

  async function handleRestoreSingleBreakLog(row = {}) {
    const breakLogId = String(row?.id || "").trim();
    if (!breakLogId || !row?.archived) return;

    const label =
      String(row?.name || "").trim() ||
      String(row?.email || "").trim() ||
      String(row?.userId || "").trim() ||
      breakLogId;

    const confirmed = window.confirm(`Restore break log for "${label}" to live break logs?`);
    if (!confirmed) return;

    setRestoringBreakLogId(breakLogId);
    try {
      await updateDoc(doc(db, "break_logs", breakLogId), {
        archived: false,
        archivedAt: null,
        archivedByUserId: "",
        archivedByName: "",
        updatedAt: serverTimestamp(),
      });

      setBreakLogRefreshTick((value) => value + 1);
      onToast?.({
        type: "success",
        title: "Break Log Restored",
        message: `Restored break log for ${label}.`,
      });
    } catch (error) {
      onToast?.({
        type: "error",
        title: "Restore Failed",
        message: error?.message || "Could not restore break log.",
      });
    } finally {
      setRestoringBreakLogId("");
    }
  }

  async function handleDeleteArchivedBreakLog(row = {}) {
    const breakLogId = String(row?.id || "").trim();
    if (!breakLogId || !row?.archived) return;

    const label =
      String(row?.name || "").trim() ||
      String(row?.email || "").trim() ||
      String(row?.userId || "").trim() ||
      breakLogId;

    const confirmed = window.confirm(
      `Permanently delete archived break log for "${label}"? This cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingArchivedBreakLogId(breakLogId);
    try {
      await deleteDoc(doc(db, "break_logs", breakLogId));
      setBreakLogRefreshTick((value) => value + 1);
      onToast?.({
        type: "success",
        title: "Archived Break Log Deleted",
        message: `Deleted archived break log for ${label}.`,
      });
    } catch (error) {
      onToast?.({
        type: "error",
        title: "Delete Failed",
        message: error?.message || "Could not delete archived break log.",
      });
    } finally {
      setDeletingArchivedBreakLogId("");
    }
  }

  async function handleRestoreAllBreakLogs() {
    if (restoringAllBreakLogs) return;
    if (archivedBreakLogIds.length === 0) {
      onToast?.({
        type: "info",
        title: "Archive Is Empty",
        message: "There are no archived break logs to restore.",
      });
      return;
    }

    const confirmed = window.confirm(
      `Restore all ${archivedBreakLogIds.length} archived break log(s) to live break logs?`
    );
    if (!confirmed) return;

    setRestoringAllBreakLogs(true);
    try {
      await Promise.all(
        archivedBreakLogIds.map((breakLogId) =>
          updateDoc(doc(db, "break_logs", breakLogId), {
            archived: false,
            archivedAt: null,
            archivedByUserId: "",
            archivedByName: "",
            updatedAt: serverTimestamp(),
          })
        )
      );
      setBreakLogRefreshTick((value) => value + 1);
      onToast?.({
        type: "success",
        title: "Break Logs Restored",
        message: `${archivedBreakLogIds.length} archived break log(s) restored.`,
      });
    } catch (error) {
      onToast?.({
        type: "error",
        title: "Restore All Failed",
        message: error?.message || "Could not restore archived break logs.",
      });
    } finally {
      setRestoringAllBreakLogs(false);
    }
  }

  const settingsDrawerTitle =
    settingsDrawerView === SETTINGS_DRAWER_VIEWS.ROLE_BULK
      ? "Role Core Pages (Bulk)"
      : settingsDrawerView === SETTINGS_DRAWER_VIEWS.EMPLOYEE_PROCESS
        ? "IB/NL Employee Process"
      : settingsDrawerView === SETTINGS_DRAWER_VIEWS.BREAK_LOG_RECORDS
        ? breakLogArchiveView
          ? "Break Archive"
          : "Break Log Record"
      : settingsDrawerView === SETTINGS_DRAWER_VIEWS.PENDING_REQUESTS
        ? "Pending User Requests"
      : settingsDrawerView === SETTINGS_DRAWER_VIEWS.USER_ACTIONS
        ? "User Actions"
        : "Attendance Settings";

  return (
    <div className="control-panel-page">

      <div className="control-panel-tabbar">
        <div className="control-panel-tabbar-left">
          <button
            type="button"
            className={`control-panel-tab ${activeTab === DATA_TABS.ACCESS ? "active" : ""}`}
            onClick={() => setActiveTab(DATA_TABS.ACCESS)}
          >
            Access & Settings
          </button>
          <button
            type="button"
            className={`control-panel-tab ${activeTab === DATA_TABS.DATA ? "active" : ""}`}
            onClick={() => setActiveTab(DATA_TABS.DATA)}
          >
            <Database size={16} />
            Data Browser
          </button>
        </div>

        <div className="control-panel-tabbar-right">
          {canOpenRegisterUser && typeof onOpenRegisterUser === "function" ? (
            <button
              type="button"
              className="control-panel-tab control-panel-tab-register"
              onClick={onOpenRegisterUser}
            >
              <UserPlus size={16} />
              Register User
            </button>
          ) : null}
          <button
            type="button"
            className="control-panel-tab control-panel-tab-icon control-panel-tab-attendance"
            onClick={() => openSettingsDrawer(SETTINGS_DRAWER_VIEWS.ATTENDANCE)}
            aria-label="Open attendance settings"
            title="Attendance Settings"
          >
            <span className="control-panel-attendance-icon-wrap" aria-hidden="true">
              <ClipboardList size={16} />
              <span className="control-panel-attendance-icon-gear">
                <Settings size={9} />
              </span>
            </span>
          </button>
          <button
            type="button"
            className="control-panel-tab control-panel-tab-icon control-panel-tab-employee-process"
            onClick={() => openSettingsDrawer(SETTINGS_DRAWER_VIEWS.EMPLOYEE_PROCESS)}
            aria-label="Open IB/NL employee process"
            title="IB/NL Employee Process"
          >
            <span className="control-panel-process-icon-wrap" aria-hidden="true">
              <Users size={16} />
              <span className="control-panel-process-icon-badge">IB</span>
            </span>
          </button>
          <button
            type="button"
            className="control-panel-tab control-panel-tab-icon control-panel-tab-role-bulk"
            onClick={() => openSettingsDrawer(SETTINGS_DRAWER_VIEWS.ROLE_BULK)}
            aria-label="Open role core pages bulk editor"
            title="Role Core Pages (Bulk)"
            disabled={!onApplyRoleCorePagesToAll}
          >
            <span className="control-panel-role-bulk-icon-wrap" aria-hidden="true">
              <FileText size={16} />
              <span className="control-panel-role-bulk-icon-pencil">
                <Pencil size={9} />
              </span>
            </span>
          </button>
          <button
            type="button"
            className="control-panel-tab control-panel-tab-icon control-panel-tab-pending-icon"
            onClick={() => openSettingsDrawer(SETTINGS_DRAWER_VIEWS.PENDING_REQUESTS)}
            aria-label="Open pending user requests"
            title="Pending User Requests"
          >
            <span className="control-panel-pending-icon-wrap" aria-hidden="true">
              <User size={16} />
              <span className="control-panel-pending-icon-alert">!</span>
              <span className="control-panel-pending-icon-badge">
                {pendingRequests.length > 99 ? "99+" : pendingRequests.length}
              </span>
            </span>
          </button>
        </div>
      </div>

      {loadingUsersData ? <div className="control-panel-state">Loading control panel...</div> : null}
      {usersError ? <div className="control-panel-error">{usersError}</div> : null}
      {localError ? <div className="control-panel-error">{localError}</div> : null}

      {activeTab === DATA_TABS.ACCESS && !loadingUsersData && !usersError ? (
        <div className="control-panel-layout">
          <div className="control-panel-users">
            <div className="control-panel-user-filter-bar">
              <button
                type="button"
                className={`control-panel-user-filter-btn ${
                  userListFilter === USER_LIST_FILTERS.SPECIAL ? "active" : ""
                }`}
                onClick={() => {
                  setUserListFilter(USER_LIST_FILTERS.SPECIAL);
                  if (selectedType === "special") return;
                  const first = filteredSpecialUsers[0];
                  if (first) {
                    selectSpecialUser(first);
                  } else {
                    setSelectedType("special");
                    setSelectedUserId("");
                  }
                }}
              >
                Special Users
              </button>
              <button
                type="button"
                className={`control-panel-user-filter-btn ${
                  userListFilter === USER_LIST_FILTERS.EMPLOYEE ? "active" : ""
                }`}
                onClick={() => {
                  setUserListFilter(USER_LIST_FILTERS.EMPLOYEE);
                  if (selectedType === "employee") return;
                  const first = employees[0];
                  if (first) {
                    selectEmployee(first);
                  } else {
                    setSelectedType("employee");
                    setSelectedUserId("");
                  }
                }}
              >
                Employees
              </button>
            </div>

            {userListFilter === USER_LIST_FILTERS.SPECIAL ? (
              <>
                <h2>Special Users</h2>

                <div className="control-panel-user-list">
                  {filteredSpecialUsers.map((user) => {
                    const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
                    const isActive =
                      selectedType === "special" &&
                      String(user.uid || user.id || "") === String(selectedUserId);

                    return (
                      <button
                        type="button"
                        key={user.uid || user.id || user.email}
                        className={`control-panel-user-card ${isActive ? "active" : ""}`}
                        onClick={() => selectSpecialUser(user)}
                      >
                        <div className="control-panel-user-name">
                          {fullName || "Unnamed User"}
                        </div>
                        <div className="control-panel-user-email">{user.email}</div>
                        <span className="control-panel-user-role">{user.role}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <h2>Employees</h2>

                <div className="control-panel-user-list">
                  {employees.map((user) => {
                    const fullName =
                      user?.name ||
                      `${user?.firstName || ""} ${user?.lastName || ""}`.trim();

                    const isActive =
                      selectedType === "employee" &&
                      String(user.uid || user.id || "") === String(selectedUserId);

                    return (
                      <button
                        type="button"
                        key={user.uid || user.id || user.email}
                        className={`control-panel-user-card ${isActive ? "active" : ""}`}
                        onClick={() => selectEmployee(user)}
                      >
                        <div className="control-panel-user-name">
                          {fullName || "Unnamed Employee"}
                        </div>
                        <div className="control-panel-user-email">{user.email}</div>
                        <span className="control-panel-user-role">{user.role}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="control-panel-permissions">
            <div className="control-panel-permissions-head">
              <h2>User Permissions</h2>
              <div className="control-panel-permissions-head-actions">
                {selectedUser ? (
                  <button
                    type="button"
                    className="control-panel-btn secondary"
                    onClick={() => openSettingsDrawer(SETTINGS_DRAWER_VIEWS.USER_ACTIONS)}
                  >
                    {selectedType === "employee" ? "User Action" : "Special User Actions"}
                  </button>
                ) : null}
              </div>
            </div>

            {selectedUser ? (
              <>
                <div className="control-panel-selected-user">
                  <strong>
                    {selectedUser?.name ||
                      `${selectedUser?.firstName || ""} ${selectedUser?.lastName || ""}`.trim() ||
                      "Unnamed User"}
                  </strong>
                  <span>{selectedUser?.email}</span>
                  <span className="control-panel-user-role">{selectedUser?.role}</span>
                </div>

                <div className="control-panel-permission-group">
                  <h3 className="control-panel-permission-title">Core Pages</h3>
                  <div className="control-panel-checkbox-grid">
                    {corePermissionPageKeys.map((page) => (
                      <label key={page} className="control-panel-checkbox-card">
                        <input
                          type="checkbox"
                          checked={selectedPages.includes(page)}
                          onChange={() => togglePage(page)}
                        />
                        <span>{PAGE_LABELS[page] || page}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="control-panel-permission-group">
                  <h3 className="control-panel-permission-title">Performance Reports</h3>
                  <div className="control-panel-checkbox-grid">
                    {performancePermissionPageKeys.map((page) => (
                      <label key={page} className="control-panel-checkbox-card">
                        <input
                          type="checkbox"
                          checked={selectedPages.includes(page)}
                          onChange={() => togglePage(page)}
                        />
                        <span>{PAGE_LABELS[page] || page}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="control-panel-actions">
                  <button
                    type="button"
                    className="control-panel-btn secondary"
                    onClick={resetToDefault}
                  >
                    Reset to Default
                  </button>

                  <button
                    type="button"
                    className="control-panel-btn primary"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? "Saving..." : "Save Permissions"}
                  </button>
                </div>
              </>
            ) : (
              <div className="control-panel-state">Select a user to edit permissions.</div>
            )}
          </div>
        </div>
      ) : null}

      {activeTab === DATA_TABS.DATA ? (
        <div className="control-panel-data-browser">
          {!dataBrowserEnabled ? (
            <div className="control-panel-data-guard">
              <div className="control-panel-data-guard-icon">
                <ShieldAlert size={22} />
              </div>
              <div>
                <h2>Data Browser Restricted</h2>
                <p>
                  This panel is intentionally restricted to <strong>super admin</strong> accounts.
                  Firestore rules still enforce access, but the UI is also locked down for safety.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="control-panel-data-toolbar">
                <div className="control-panel-data-toolbar-left">
                  <div className="control-panel-field-block">
                    <label>Collection</label>
                    <select
                      value={selectedTableKey}
                      onChange={(e) => {
                        setSelectedTableKey(e.target.value);
                        closeEditorPanel();
                      }}
                      className="control-panel-time-input control-panel-time-select"
                    >
                      {dataOptions.map((key) => (
                        <option key={key} value={key}>
                          {DATA_COLLECTIONS[key].label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="control-panel-field-block">
                    <label>Search</label>
                    <div className="control-panel-searchbox">
                      <Search size={16} />
                      <input
                        type="text"
                        value={dataQuery}
                        onChange={(e) => setDataQuery(e.target.value)}
                        placeholder="Search visible columns..."
                      />
                    </div>
                  </div>

                  <div className="control-panel-field-block control-panel-field-block-small">
                    <label>Limit</label>
                    <input
                      type="number"
                      min="1"
                      max="200"
                      value={dataLimit}
                      onChange={(e) => setDataLimit(e.target.value)}
                      className="control-panel-time-input"
                    />
                  </div>
                </div>

                <div className="control-panel-data-toolbar-right">
                  <button
                    type="button"
                    className="control-panel-btn secondary"
                    onClick={() => setDataRefreshTick((v) => v + 1)}
                  >
                    <RefreshCcw size={16} />
                    Refresh
                  </button>
                  <button
                    type="button"
                    className="control-panel-btn primary"
                    onClick={openCreateEditor}
                    disabled={!selectedTableConfig?.canCreate}
                  >
                    <Plus size={16} />
                    New Document
                  </button>
                </div>
              </div>

              <div className="control-panel-data-meta">
                <div>
                  <strong>{selectedTableConfig?.label}</strong>
                  <p>{selectedTableConfig?.description}</p>
                </div>
                <div className="control-panel-data-meta-pills">
                  <span>{filteredDataRows.length} visible row(s)</span>
                  <span>{dataColumns.length} column(s)</span>
                  <span>Firestore SDK fetch preserved</span>
                </div>
              </div>

              {dataError ? <div className="control-panel-error">{dataError}</div> : null}

              <div className="control-panel-data-layout">
                <div className="control-panel-data-table-card">
                  {dataLoading ? (
                    <div className="control-panel-state">Loading collection...</div>
                  ) : filteredDataRows.length ? (
                    <div className="control-panel-table-wrap">
                      <table className="control-panel-data-table">
                        <thead>
                          <tr>
                            <th>Document ID</th>
                            {dataColumns.slice(0, 6).map((column) => (
                              <th key={column}>{column}</th>
                            ))}
                            <th className="control-panel-actions-col">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredDataRows.map((row) => (
                            <tr key={row.id}>
                              <td className="control-panel-doc-id">{row.id}</td>
                              {dataColumns.slice(0, 6).map((column) => (
                                <td key={`${row.id}-${column}`}>{formatCellValue(row[column])}</td>
                              ))}
                              <td>
                                <div className="control-panel-row-actions">
                                  <button type="button" onClick={() => openViewer(row)} title="View row">
                                    <Eye size={16} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openEditor(row)}
                                    title="Edit row"
                                    disabled={!selectedTableConfig?.canEdit}
                                  >
                                    <Pencil size={16} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteRow(row)}
                                    title="Delete row"
                                    disabled={!selectedTableConfig?.canDelete}
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="control-panel-state">No rows matched this query.</div>
                  )}
                </div>

                <div className="control-panel-data-editor-card">
                  <div className="control-panel-data-editor-header">
                    <div>
                      <h3>
                        {editorMode === "create"
                          ? `Create ${selectedTableConfig?.label || "document"}`
                          : editorMode === "edit"
                          ? `Edit ${editorRowId || "document"}`
                          : inspectedRow
                          ? `Viewing ${inspectedRow.id}`
                          : "Row Inspector"}
                      </h3>
                      <p>
                        {editorMode === "view"
                          ? "Inspect the current document safely."
                          : "Edit the JSON payload. Firestore timestamps can be kept using the __type marker."}
                      </p>
                    </div>
                    {(editorRowId || editorMode === "create" || inspectedRow) ? (
                      <button
                        type="button"
                        className="control-panel-editor-close"
                        onClick={closeEditorPanel}
                      >
                        <X size={16} />
                      </button>
                    ) : null}
                  </div>

                  {editorError ? <div className="control-panel-error">{editorError}</div> : null}

                  {editorMode === "view" && !inspectedRow ? (
                    <div className="control-panel-state">
                      Select a row to inspect, or create a new document.
                    </div>
                  ) : (
                    <>
                      <textarea
                        className="control-panel-json-editor"
                        value={editorText}
                        onChange={(e) => setEditorText(e.target.value)}
                        readOnly={editorMode === "view"}
                        spellCheck={false}
                      />

                      <div className="control-panel-editor-help">
                        <div>
                          Hidden fields stay blocked. Read-only fields like <code>createdAt</code> and <code>updatedAt</code> are protected during updates.
                        </div>
                        <div>
                          Example timestamp format: <code>{`{"__type":"timestamp","value":"2026-04-13T12:00:00.000Z"}`}</code>
                        </div>
                      </div>

                      {editorMode !== "view" ? (
                        <div className="control-panel-actions">
                          <button
                            type="button"
                            className="control-panel-btn secondary"
                            onClick={closeEditorPanel}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="control-panel-btn primary"
                            onClick={handleSaveDataRow}
                            disabled={savingDataRow}
                          >
                            <Save size={16} />
                            {savingDataRow ? "Saving..." : editorMode === "create" ? "Create Document" : "Save Changes"}
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}

      {settingsDrawerOpen ? (
        <>
          <button
            type="button"
            className="control-panel-drawer-backdrop"
            onClick={closeSettingsDrawer}
            aria-label="Close settings drawer"
          />

          <aside
            className="control-panel-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={settingsDrawerTitle}
          >
            <div className="control-panel-drawer-head">
              <div>
                <h2>{settingsDrawerTitle}</h2>
                <p>
                  {settingsDrawerView === SETTINGS_DRAWER_VIEWS.ROLE_BULK
                    ? "Manage default page access for all users in a selected role."
                    : settingsDrawerView === SETTINGS_DRAWER_VIEWS.EMPLOYEE_PROCESS
                      ? "Choose who appears in the IB/NL process and drag employees into the saved order."
                    : settingsDrawerView === SETTINGS_DRAWER_VIEWS.BREAK_LOG_RECORDS
                      ? "Review all break logs, filter by employee, and archive logs into Break Archive."
                    : settingsDrawerView === SETTINGS_DRAWER_VIEWS.PENDING_REQUESTS
                      ? "Review and process pending portal access requests."
                    : settingsDrawerView === SETTINGS_DRAWER_VIEWS.USER_ACTIONS
                      ? "Manage transfer and password actions for the selected user."
                      : "Manage attendance reset time and timezone display settings."}
                </p>
              </div>

              <button
                type="button"
                className="control-panel-editor-close"
                onClick={closeSettingsDrawer}
                aria-label="Close drawer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="control-panel-drawer-body">
              {settingsDrawerView === SETTINGS_DRAWER_VIEWS.ATTENDANCE ? (
                <div className="control-panel-attendance-settings">
                  <p className="control-panel-attendance-help">
                    Set reset time and choose simple timezone options for display and saved timestamp tags.
                  </p>

                  <div className="control-panel-attendance-grid">
                    <div className="control-panel-attendance-card">
                      <h3>Business Day Reset</h3>
                      <p>Defines when a new attendance day starts.</p>
                      <input
                        type="time"
                        value={resetTimeDraft}
                        onChange={(e) => setResetTimeDraft(e.target.value)}
                        className="control-panel-time-input"
                      />
                    </div>

                    <div className="control-panel-attendance-card">
                      <h3>Display Time Zone</h3>
                      <p>Choose the timezone used for displaying all times in the app.</p>
                      <select
                        value={
                          displayTimeZoneModeDraft === DISPLAY_TIME_ZONE_MODE_DEVICE
                            ? DEVICE_TIME_ZONE_OPTION
                            : displayTimeZoneDraft
                        }
                        onChange={(e) => handleDisplayTimeZoneSelection(e.target.value)}
                        className="control-panel-time-input control-panel-time-select"
                      >
                        <option value={DEVICE_TIME_ZONE_OPTION}>
                          Device Time Zone (Auto: {deviceTimeZone})
                        </option>
                        {timeZoneSelectOptions.map((tz) => (
                          <option key={tz} value={tz}>
                            {tz}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="control-panel-attendance-card">
                      <h3>DB Save Time Zone</h3>
                      <p>Timezone tag for saved timestamps.</p>
                      <select
                        value={storageTimeZoneDraft}
                        onChange={(e) => setStorageTimeZoneDraft(e.target.value)}
                        className="control-panel-time-input control-panel-time-select"
                      >
                        {timeZoneSelectOptions.map((tz) => (
                          <option key={`save-${tz}`} value={tz}>
                            {tz}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="control-panel-attendance-actions">
                    <button
                      type="button"
                      className="control-panel-btn primary"
                      onClick={handleSaveAttendanceSettings}
                      disabled={savingAttendanceSettings}
                    >
                      {savingAttendanceSettings ? "Saving..." : "Save Attendance Settings"}
                    </button>
                  </div>

                  <div className="control-panel-attendance-example">
                    Display timezone in app: <strong>{resolvedDisplayTimeZonePreview}</strong>{" "}
                    | Active app timezone: <strong>{String(businessTimeZone || "").trim() || resolvedDisplayTimeZonePreview}</strong>{" "}
                    | Saved timestamp timezone tag: <strong>{storageTimeZoneDraft || DEFAULT_STORAGE_TIME_ZONE}</strong>
                  </div>
                </div>
              ) : null}

              {settingsDrawerView === SETTINGS_DRAWER_VIEWS.EMPLOYEE_PROCESS ? (
                <div className="control-panel-process-settings">
                  <div className="control-panel-process-toolbar">
                    <div>
                      <h3>Included Employees</h3>
                      <p>Drag rows to set the top-to-bottom IB/NL rotation.</p>
                    </div>
                    <div className="control-panel-process-actions">
                      <button
                        type="button"
                        className="control-panel-btn secondary"
                        onClick={() => resetEmployeeProcessDraft()}
                        disabled={employeeProcessSaving}
                      >
                        Reset Draft
                      </button>
                      <button
                        type="button"
                        className="control-panel-btn primary"
                        onClick={saveEmployeeProcessDraft}
                        disabled={employeeProcessSaving}
                      >
                        {employeeProcessSaving ? "Saving..." : "Save Order"}
                      </button>
                    </div>
                  </div>

                  {employeeProcessLoading ? (
                    <div className="control-panel-state">Loading IB/NL process settings...</div>
                  ) : null}
                  {employeeProcessError ? <div className="control-panel-error">{employeeProcessError}</div> : null}
                  {employeeProcessMessage ? (
                    <div className="control-panel-success">{employeeProcessMessage}</div>
                  ) : null}

                  <div className="control-panel-process-grid">
                    <section className="control-panel-process-card">
                      <div className="control-panel-process-list">
                        {employeeProcessIncludedRows.length === 0 ? (
                          <div className="control-panel-state">No employees included yet.</div>
                        ) : (
                          employeeProcessIncludedRows.map((row, index) => (
                            <div
                              key={`process-included-${row.userId}`}
                              className={`control-panel-process-row${
                                draggingEmployeeProcessId === row.userId ? " dragging" : ""
                              }`}
                              draggable
                              onDragStart={(event) => {
                                setDraggingEmployeeProcessId(row.userId);
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", row.userId);
                              }}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={(event) => {
                                event.preventDefault();
                                const sourceId =
                                  event.dataTransfer.getData("text/plain") || draggingEmployeeProcessId;
                                moveEmployeeProcessDraftId(sourceId, row.userId);
                                setDraggingEmployeeProcessId("");
                              }}
                              onDragEnd={() => setDraggingEmployeeProcessId("")}
                            >
                              <div className="control-panel-process-drag">
                                <GripVertical size={16} aria-hidden="true" />
                                <span>{index + 1}</span>
                              </div>
                              <div className="control-panel-process-person">
                                <strong>{row.name}</strong>
                                <span>{row.email || row.userId}</span>
                              </div>
                              <button
                                type="button"
                                className="control-panel-btn danger"
                                onClick={() => removeEmployeeFromProcessDraft(row.userId)}
                                disabled={employeeProcessSaving}
                              >
                                Remove
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </section>

                    <section className="control-panel-process-card">
                      <div className="control-panel-process-card-head">
                        <h3>Available To Add</h3>
                      </div>
                      <div className="control-panel-process-list compact">
                        {employeeProcessAvailableRows.length === 0 ? (
                          <div className="control-panel-state">All employees are included.</div>
                        ) : (
                          employeeProcessAvailableRows.map((row) => (
                            <div key={`process-available-${row.userId}`} className="control-panel-process-row">
                              <div className="control-panel-process-person">
                                <strong>{row.name}</strong>
                                <span>{row.email || row.userId}</span>
                              </div>
                              <button
                                type="button"
                                className="control-panel-btn secondary"
                                onClick={() => addEmployeeToProcessDraft(row.userId)}
                                disabled={employeeProcessSaving}
                              >
                                Add
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              ) : null}

              {settingsDrawerView === SETTINGS_DRAWER_VIEWS.BREAK_LOG_RECORDS ? (
                <div className="control-panel-break-record-card">
                  <div className="control-panel-break-record-head">
                    <h3>{breakLogArchiveView ? "Break Archive" : "Break Log Record"}</h3>
                    <span>{breakLogVisibleRows.length}</span>
                  </div>

                  <div className="control-panel-break-record-toolbar">
                    <button
                      type="button"
                      className="control-panel-btn secondary"
                      onClick={() => setBreakLogRefreshTick((value) => value + 1)}
                      disabled={breakLogLoading}
                    >
                      {breakLogLoading ? "Loading..." : "Reload Logs"}
                    </button>

                    <div className="control-panel-break-record-toolbar-right">
                      <label className="control-panel-break-filter-label" htmlFor="control-panel-break-filter">
                        Employee Name Filter
                      </label>
                      <select
                        id="control-panel-break-filter"
                        className="control-panel-time-input control-panel-time-select control-panel-break-filter-input"
                        value={breakLogFilterEmployeeId}
                        onChange={(event) => setBreakLogFilterEmployeeId(event.target.value)}
                      >
                        <option value="">All Employees</option>
                        {breakLogEmployeeOptions.map((option) => (
                          <option key={`break-filter-${option.value}`} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>

                      {breakLogArchiveView ? (
                        <div className="control-panel-break-bulk-actions">
                          <button
                            type="button"
                            className="control-panel-break-toolbar-icon-btn restore"
                            onClick={handleRestoreAllBreakLogs}
                            disabled={restoringAllBreakLogs || archivedBreakLogIds.length === 0}
                            title="Restore all archived break logs"
                            aria-label="Restore all archived break logs"
                          >
                            <RotateCcw size={14} />
                          </button>
                          <button
                            type="button"
                            className="control-panel-break-toolbar-icon-btn danger"
                            onClick={openBreakDeleteArchiveModal}
                            disabled={breakDeleteArchiveBusy || archivedBreakLogIds.length === 0}
                            title="Delete all archived break logs permanently"
                            aria-label="Delete all archived break logs permanently"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ) : null}

                      <div className="control-panel-break-menu-wrap" ref={breakLogMenuRef}>
                        <button
                          type="button"
                          className="control-panel-break-menu-trigger"
                          onClick={() => setBreakLogMenuOpen((prev) => !prev)}
                          aria-haspopup="menu"
                          aria-expanded={breakLogMenuOpen}
                          aria-label="Break log options"
                        >
                          <MoreVertical size={16} />
                        </button>

                        {breakLogMenuOpen ? (
                          <div className="control-panel-break-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="control-panel-break-menu-item danger"
                              onClick={openBreakClearModal}
                              disabled={breakClearBusy || activeBreakLogIds.length === 0}
                            >
                              Clear Break Logs
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="control-panel-break-menu-item"
                              onClick={() => {
                                setBreakLogMenuOpen(false);
                                setBreakLogArchiveView((prev) => !prev);
                              }}
                            >
                              {breakLogArchiveView ? "Live Break Logs" : "Break Archive"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {breakLogError ? <div className="control-panel-error">{breakLogError}</div> : null}

                  {breakLogLoading ? (
                    <div className="control-panel-state">Loading break logs...</div>
                  ) : breakLogVisibleRows.length === 0 ? (
                    <div className="control-panel-state">
                      {breakLogArchiveView
                        ? "No break logs in Break Archive."
                        : "No active break logs found."}
                    </div>
                  ) : (
                    <div className="control-panel-table-wrap">
                      <table className="control-panel-data-table control-panel-break-table">
                        <thead>
                          <tr>
                            <th>Employee</th>
                            <th>Email</th>
                            <th>Type</th>
                            <th>Started</th>
                            <th>Ended</th>
                            <th>Duration</th>
                            <th>Status</th>
                            <th className="control-panel-break-actions-col">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {breakLogVisibleRows.map((row) => {
                            const isArchived = !!row?.archived;
                            const isOnBreak = !row?.endedAt && !row?.endTime;
                            const rowId = String(row?.id || "").trim();
                            const isArchivingThisRow = rowId && archivingBreakLogId === rowId;
                            const isRestoringThisRow = rowId && restoringBreakLogId === rowId;
                            const isDeletingArchivedThisRow =
                              rowId && deletingArchivedBreakLogId === rowId;
                            const statusLabel = isArchived
                              ? "Archived"
                              : isOnBreak
                                ? "On Break"
                                : "Completed";
                            return (
                              <tr key={String(row?.id || `${row?.userId || "row"}-${row?.startedAt || ""}`)}>
                                <td>{row?.name || row?.userName || row?.userId || "-"}</td>
                                <td>{row?.email || "-"}</td>
                                <td>{row?.breakType || "-"}</td>
                                <td>{formatDateTime(row?.startedAt || row?.startTime, businessTimeZone)}</td>
                                <td>{formatDateTime(row?.endedAt || row?.endTime, businessTimeZone)}</td>
                                <td>{formatBreakDuration(row)}</td>
                                <td>
                                  <span
                                    className={`control-panel-break-status ${
                                      isArchived ? "archived" : isOnBreak ? "active" : "complete"
                                    }`}
                                  >
                                    {statusLabel}
                                  </span>
                                </td>
                                <td>
                                  {!breakLogArchiveView ? (
                                    <button
                                      type="button"
                                      className="control-panel-break-row-archive-btn"
                                      onClick={() => handleArchiveSingleBreakLog(row)}
                                      title="Move to Break Archive"
                                      aria-label="Move break log to archive"
                                      disabled={isArchived || !rowId || isArchivingThisRow}
                                    >
                                      {isArchivingThisRow ? "..." : "Move to Bin"}
                                    </button>
                                  ) : (
                                    <div className="control-panel-break-row-actions">
                                      <button
                                        type="button"
                                        className="control-panel-break-row-action-btn restore"
                                        onClick={() => handleRestoreSingleBreakLog(row)}
                                        title="Restore to live break logs"
                                        aria-label="Restore break log to live break logs"
                                        disabled={isRestoringThisRow || !rowId}
                                      >
                                        <RotateCcw size={14} />
                                      </button>
                                      <button
                                        type="button"
                                        className="control-panel-break-row-action-btn danger"
                                        onClick={() => handleDeleteArchivedBreakLog(row)}
                                        title="Delete permanently"
                                        aria-label="Delete archived break log permanently"
                                        disabled={isDeletingArchivedThisRow || !rowId}
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : null}

              {settingsDrawerView === SETTINGS_DRAWER_VIEWS.ROLE_BULK && onApplyRoleCorePagesToAll ? (
                <div className="control-panel-role-bulk-card">
                  <h2>Role Core Pages (Bulk)</h2>
                  <p className="control-panel-role-bulk-help">
                    Set Core + Performance pages for a role and apply to every user in that role. You can still edit users individually afterward.
                  </p>

                  <div className="control-panel-role-bulk-top">
                    <div className="control-panel-transfer-field">
                      <label htmlFor="control-panel-role-bulk-select">Role</label>
                      <select
                        id="control-panel-role-bulk-select"
                        value={bulkRoleDraft}
                        onChange={(e) => setBulkRoleDraft(e.target.value)}
                        className="control-panel-time-input control-panel-time-select"
                      >
                        {ROLE_BULK_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      className="control-panel-btn warning"
                      onClick={handleApplyBulkRoleCorePages}
                      disabled={applyingRoleCorePages}
                    >
                      {applyingRoleCorePages
                        ? "Applying..."
                        : `Apply Core Pages To All ${toRoleLabel(bulkRoleDraft)} Users`}
                    </button>
                  </div>

                  <div className="control-panel-permission-group">
                    <h3 className="control-panel-permission-title">Core Pages For This Role</h3>
                    <div className="control-panel-checkbox-grid">
                      {corePermissionPageKeys.map((page) => (
                        <label key={`bulk-role-page-${page}`} className="control-panel-checkbox-card">
                          <input
                            type="checkbox"
                            checked={bulkRoleCorePagesDraft.includes(page)}
                            onChange={() => toggleBulkRoleCorePage(page)}
                          />
                          <span>{PAGE_LABELS[page] || page}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="control-panel-permission-group">
                    <h3 className="control-panel-permission-title">
                      Performance Reports For This Role
                    </h3>
                    <div className="control-panel-checkbox-grid">
                      {performancePermissionPageKeys.map((page) => (
                        <label
                          key={`bulk-role-performance-page-${page}`}
                          className="control-panel-checkbox-card"
                        >
                          <input
                            type="checkbox"
                            checked={bulkRolePerformancePagesDraft.includes(page)}
                            onChange={() => toggleBulkRolePerformancePage(page)}
                          />
                          <span>{PAGE_LABELS[page] || page}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsDrawerView === SETTINGS_DRAWER_VIEWS.USER_ACTIONS ? (
                !selectedUser ? (
                  <div className="control-panel-state">
                    Select a user first to manage transfer/password/delete actions.
                  </div>
                ) : (
                  <div className="control-panel-special-actions-card">
                    <div className="control-panel-selected-user">
                      <strong>
                        {selectedUser?.name ||
                          `${selectedUser?.firstName || ""} ${selectedUser?.lastName || ""}`.trim() ||
                          "Unnamed User"}
                      </strong>
                      <span>{selectedUser?.email}</span>
                      <span className="control-panel-user-role">{selectedUser?.role}</span>
                    </div>

                    <h3 className="control-panel-permission-title">Employee Actions</h3>
                    <p className="control-panel-special-actions-help">
                      Transfer employee to admin side, update password, and manage employee profile details.
                    </p>
                    {selectedType !== "employee" ? (
                      <div className="control-panel-state">
                        Select an employee to use employee actions.
                      </div>
                    ) : (
                      <>
                        {onTransferEmployeeToPortalRole ? (
                          <div className="control-panel-transfer-card">
                            <h3 className="control-panel-permission-title">Transfer Employee to Admin Side</h3>
                            <p>
                              Move this employee into Special Users and assign an admin-side portal role.
                            </p>

                            <div className="control-panel-transfer-row">
                              <div className="control-panel-transfer-field">
                                <label htmlFor="control-panel-transfer-role">Target Role</label>
                                <select
                                  id="control-panel-transfer-role"
                                  value={transferRoleDraft}
                                  onChange={(e) => setTransferRoleDraft(e.target.value)}
                                  className="control-panel-time-input control-panel-time-select"
                                >
                                  {TRANSFER_ROLE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              <button
                                type="button"
                                className="control-panel-btn warning"
                                onClick={handleTransferSelectedEmployee}
                                disabled={transferringEmployee}
                              >
                                {transferringEmployee ? "Transferring..." : "Transfer to Admin User"}
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {onSetEmployeePassword ? (
                          <div className="control-panel-transfer-card control-panel-transfer-card-password">
                            <button
                              type="button"
                              className="control-panel-inline-dropdown-toggle"
                              onClick={() =>
                                setEmployeePasswordDropdownOpen((prev) => !prev)
                              }
                            >
                              <span>Edit Employee Password</span>
                              <span>{employeePasswordDropdownOpen ? "Hide" : "Show"}</span>
                            </button>
                            {employeePasswordDropdownOpen ? (
                              <>
                                <p>
                                  Set a new password for this employee account.
                                </p>
                                <div className="control-panel-transfer-row">
                                  <div className="control-panel-transfer-field">
                                    <label htmlFor="control-panel-employee-password">New Password</label>
                                    <input
                                      id="control-panel-employee-password"
                                      type="password"
                                      value={employeePasswordDraft}
                                      onChange={(e) => setEmployeePasswordDraft(e.target.value)}
                                      className="control-panel-time-input"
                                      placeholder="Minimum 6 characters"
                                    />
                                  </div>
                                  <div className="control-panel-transfer-field">
                                    <label htmlFor="control-panel-employee-password-confirm">Confirm Password</label>
                                    <input
                                      id="control-panel-employee-password-confirm"
                                      type="password"
                                      value={employeePasswordConfirmDraft}
                                      onChange={(e) => setEmployeePasswordConfirmDraft(e.target.value)}
                                      className="control-panel-time-input"
                                      placeholder="Re-enter password"
                                    />
                                  </div>
                                  <button
                                    type="button"
                                    className="control-panel-btn primary"
                                    onClick={handleSaveSelectedEmployeePassword}
                                    disabled={savingEmployeePassword}
                                  >
                                    {savingEmployeePassword ? "Saving..." : "Update Password"}
                                  </button>
                                </div>
                              </>
                            ) : null}
                          </div>
                        ) : null}

                        {onSaveEmployeeStartDate ? (
                          <div className="control-panel-transfer-card control-panel-transfer-card-employee">
                            <h3 className="control-panel-permission-title">Employee Profile Details</h3>
                            <p>
                              Update Date Joined / Start Date and review employee profile details.
                            </p>

                            <div className="control-panel-special-profile-grid">
                              <div className="control-panel-special-profile-row">
                                <span>User ID</span>
                                <strong>{String(selectedUser?.uid || selectedUser?.id || "").trim() || "-"}</strong>
                              </div>
                              <div className="control-panel-special-profile-row">
                                <span>Position / Role</span>
                                <strong>
                                  {selectedUser?.position || selectedUser?.role || selectedUser?.jobTitle || "-"}
                                </strong>
                              </div>
                              <div className="control-panel-special-profile-row">
                                <span>Department</span>
                                <strong>{selectedUser?.department || selectedUser?.departmentName || "-"}</strong>
                              </div>
                              <div className="control-panel-special-profile-row">
                                <span>Employee ID</span>
                                <strong>{selectedUser?.employeeId || selectedEmployeeProfile?.employeeId || "-"}</strong>
                              </div>
                            </div>

                            <div className="control-panel-transfer-row">
                              <div className="control-panel-transfer-field">
                                <label htmlFor="control-panel-employee-start-date">Date Joined / Start Date</label>
                                <input
                                  id="control-panel-employee-start-date"
                                  type="date"
                                  value={employeeStartDateDraft}
                                  onChange={(e) => setEmployeeStartDateDraft(e.target.value)}
                                  className="control-panel-time-input"
                                />
                              </div>
                              <button
                                type="button"
                                className="control-panel-btn primary"
                                onClick={handleSaveSelectedEmployeeStartDate}
                                disabled={savingEmployeeStartDate}
                              >
                                {savingEmployeeStartDate ? "Saving..." : "Save Start Date"}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </>
                    )}

                    <h3 className="control-panel-permission-title">Special User Actions</h3>
                    <p className="control-panel-special-actions-help">
                      Transfer special users back to employee and delete special users.
                    </p>
                    {selectedType !== "special" ? (
                      <div className="control-panel-state">
                        Select a special user to use special-user actions.
                      </div>
                    ) : normalizeRole(selectedUser?.role) === ROLES.SUPER_ADMIN ? (
                      <div className="control-panel-state">
                        Super Admin actions are restricted.
                      </div>
                    ) : (
                      <div className="control-panel-transfer-row">
                        {onTransferSpecialUserToEmployeeRole ? (
                          <>
                            <label className="control-panel-transfer-field">
                              <span>Transfer To Employee User</span>
                              <select
                                value={specialTransferTargetUserId}
                                onChange={(e) => setSpecialTransferTargetUserId(e.target.value)}
                                className="control-panel-time-input control-panel-time-select"
                                disabled={transferringToEmployee || !specialTransferTargetOptions.length}
                              >
                                <option value="">Select employee user</option>
                                {specialTransferTargetOptions.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="control-panel-btn secondary"
                              onClick={handleTransferSelectedSpecialToEmployee}
                              disabled={transferringToEmployee || !specialTransferTargetUserId}
                            >
                              {transferringToEmployee ? "Transferring..." : "Transfer to Selected Employee"}
                            </button>
                          </>
                        ) : null}

                        {onDeleteAdminUser && normalizeRole(selectedUser?.role) !== ROLES.SUPER_ADMIN ? (
                          <button
                            type="button"
                            className="control-panel-btn danger"
                            onClick={handleDeleteSelectedSpecialUser}
                            disabled={deletingSpecialUser}
                          >
                            {deletingSpecialUser ? "Deleting..." : "Delete User"}
                          </button>
                        ) : null}
                      </div>
                    )}

                    <h3 className="control-panel-permission-title">Special User Profile</h3>
                    <p className="control-panel-special-actions-help">
                      Manage details, email, and password reset for selected special users.
                    </p>
                    {selectedType !== "special" ? (
                      <div className="control-panel-state">
                        Select a special user to manage profile details.
                      </div>
                    ) : (
                      <div className="control-panel-special-profile-card">
                        <div className="control-panel-special-profile-grid">
                          <div className="control-panel-special-profile-row">
                            <span>User ID</span>
                            <strong>{getPortalUserDocId(selectedSpecialUser) || "-"}</strong>
                          </div>
                          <div className="control-panel-special-profile-row">
                            <span>Created</span>
                            <strong>{formatDateTime(selectedSpecialUser?.createdAt, businessTimeZone)}</strong>
                          </div>
                          <div className="control-panel-special-profile-row">
                            <span>Updated</span>
                            <strong>{formatDateTime(selectedSpecialUser?.updatedAt, businessTimeZone)}</strong>
                          </div>
                        </div>

                        {specialActionError ? <div className="control-panel-error">{specialActionError}</div> : null}
                        {specialActionMessage ? (
                          <div className="control-panel-success">{specialActionMessage}</div>
                        ) : null}

                        <div className="control-panel-transfer-card control-panel-special-profile-section">
                          <div className="control-panel-special-profile-head">
                            <h4>Profile Details</h4>
                            {!specialProfileEditMode ? (
                              <button
                                type="button"
                                className="control-panel-btn secondary"
                                onClick={() => {
                                  setSpecialProfileEditMode(true);
                                  setSpecialActionError("");
                                  setSpecialActionMessage("");
                                }}
                              >
                                Edit Details
                              </button>
                            ) : null}
                          </div>

                          {specialProfileEditMode ? (
                            <div className="control-panel-special-profile-form">
                              <label className="control-panel-transfer-field">
                                <span>First name</span>
                                <input
                                  type="text"
                                  value={specialProfileDraft.firstName}
                                  onChange={(e) =>
                                    setSpecialProfileDraft((prev) => ({
                                      ...prev,
                                      firstName: e.target.value,
                                    }))
                                  }
                                  className="control-panel-time-input"
                                  disabled={savingSpecialProfile}
                                />
                              </label>
                              <label className="control-panel-transfer-field">
                                <span>Last name</span>
                                <input
                                  type="text"
                                  value={specialProfileDraft.lastName}
                                  onChange={(e) =>
                                    setSpecialProfileDraft((prev) => ({
                                      ...prev,
                                      lastName: e.target.value,
                                    }))
                                  }
                                  className="control-panel-time-input"
                                  disabled={savingSpecialProfile}
                                />
                              </label>
                              <label className="control-panel-transfer-field">
                                <span>Role</span>
                                <select
                                  value={specialProfileDraft.role}
                                  onChange={(e) =>
                                    setSpecialProfileDraft((prev) => ({
                                      ...prev,
                                      role: e.target.value,
                                    }))
                                  }
                                  className="control-panel-time-input control-panel-time-select"
                                  disabled={savingSpecialProfile}
                                >
                                  {EDITABLE_ROLE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <div className="control-panel-transfer-row">
                                <button
                                  type="button"
                                  className="control-panel-btn primary"
                                  onClick={handleSaveSpecialProfile}
                                  disabled={savingSpecialProfile}
                                >
                                  {savingSpecialProfile ? "Saving..." : "Save Details"}
                                </button>
                                <button
                                  type="button"
                                  className="control-panel-btn secondary"
                                  onClick={() => {
                                    setSpecialProfileEditMode(false);
                                    setSpecialProfileDraft({
                                      firstName: String(selectedSpecialUser?.firstName || "").trim(),
                                      lastName: String(selectedSpecialUser?.lastName || "").trim(),
                                      role: normalizeRole(selectedSpecialUser?.role) || ROLES.VISITOR,
                                    });
                                  }}
                                  disabled={savingSpecialProfile}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="control-panel-special-profile-grid">
                              <div className="control-panel-special-profile-row">
                                <span>First name</span>
                                <strong>{selectedSpecialUser?.firstName || "-"}</strong>
                              </div>
                              <div className="control-panel-special-profile-row">
                                <span>Last name</span>
                                <strong>{selectedSpecialUser?.lastName || "-"}</strong>
                              </div>
                              <div className="control-panel-special-profile-row">
                                <span>Role</span>
                                <strong>{toRoleLabel(selectedSpecialUser?.role)}</strong>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="control-panel-transfer-card control-panel-special-profile-section">
                          <h4>Change Email Address</h4>
                          <div className="control-panel-transfer-row">
                            <label className="control-panel-transfer-field">
                              <span>Email</span>
                              <input
                                type="email"
                                value={specialEmailDraft}
                                onChange={(e) => setSpecialEmailDraft(e.target.value)}
                                className="control-panel-time-input"
                                disabled={savingSpecialEmail}
                              />
                            </label>
                            <button
                              type="button"
                              className="control-panel-btn primary"
                              onClick={handleSaveSpecialEmail}
                              disabled={savingSpecialEmail}
                            >
                              {savingSpecialEmail ? "Saving..." : "Save Email"}
                            </button>
                          </div>
                        </div>

                        <div className="control-panel-transfer-card control-panel-special-profile-section">
                          <h4>Reset Password</h4>
                          <p>Send a password reset email to this special user.</p>
                          <button
                            type="button"
                            className="control-panel-btn warning"
                            onClick={handleSendSpecialPasswordReset}
                            disabled={sendingSpecialReset}
                          >
                            {sendingSpecialReset ? "Sending..." : "Send Reset Email"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              ) : null}

              {settingsDrawerView === SETTINGS_DRAWER_VIEWS.PENDING_REQUESTS ? (
                <div className="control-panel-requests-card">
                  <div className="control-panel-requests-head">
                    <h3>Pending User Requests</h3>
                    <span>{pendingRequests.length}</span>
                  </div>

                  <p className="control-panel-special-actions-help">
                    Snapshot view. Click Reload Requests when you want to refresh.
                  </p>

                  {onReloadRequests ? (
                    <div className="control-panel-requests-toolbar">
                      <button
                        type="button"
                        className="control-panel-btn secondary"
                        onClick={onReloadRequests}
                        disabled={loadingRequests}
                      >
                        {loadingRequests ? "Loading..." : "Reload Requests"}
                      </button>
                    </div>
                  ) : null}

                  {loadingRequests ? (
                    <div className="control-panel-state">Loading user requests...</div>
                  ) : null}
                  {requestsError ? <div className="control-panel-error">{requestsError}</div> : null}

                  {!loadingRequests && !requestsError && pendingRequests.length === 0 ? (
                    <div className="control-panel-state">
                      No pending requests. New requests will appear here.
                    </div>
                  ) : null}

                  {!loadingRequests && !requestsError && pendingRequests.length > 0 ? (
                    <div className="control-panel-requests-list">
                      {pendingRequests.map((requestRow) => {
                        const requestId = String(requestRow?.id || "").trim();
                        const requestedName = `${requestRow?.firstName || ""} ${
                          requestRow?.lastName || ""
                        }`.trim();
                        const requester =
                          requestRow?.requestedByName ||
                          requestRow?.requestedByEmail ||
                          requestRow?.requestedByUserId ||
                          "Admin";
                        const isApproving =
                          processingRequestId === requestId &&
                          toStatus(processingRequestAction) === "approve";
                        const isRejecting =
                          processingRequestId === requestId &&
                          toStatus(processingRequestAction) === "reject";
                        const isProcessing = isApproving || isRejecting;

                        return (
                          <article key={requestId} className="control-panel-request-card">
                            <div className="control-panel-request-top">
                              <div>
                                <h4>{requestedName || requestRow?.email || "Requested User"}</h4>
                                <p>{requestRow?.email || "No email"}</p>
                              </div>
                              <span className="control-panel-user-role">{toRoleLabel(requestRow?.role)}</span>
                            </div>

                            <div className="control-panel-request-meta">
                              <span>Requested by: {requester}</span>
                              <span>{formatDateTime(requestRow?.createdAt, businessTimeZone)}</span>
                            </div>

                            <div className="control-panel-request-inputs">
                              <input
                                type="password"
                                className="control-panel-time-input"
                                placeholder="Temporary password (optional)"
                                value={approvalPasswordById?.[requestId] || ""}
                                onChange={(e) =>
                                  setApprovalPasswordById((prev) => ({
                                    ...prev,
                                    [requestId]: e.target.value,
                                  }))
                                }
                                disabled={isProcessing}
                              />
                              <input
                                type="text"
                                className="control-panel-time-input"
                                placeholder="Reject reason (optional)"
                                value={rejectionReasonById?.[requestId] || ""}
                                onChange={(e) =>
                                  setRejectionReasonById((prev) => ({
                                    ...prev,
                                    [requestId]: e.target.value,
                                  }))
                                }
                                disabled={isProcessing}
                              />
                            </div>

                            <div className="control-panel-transfer-row">
                              <button
                                type="button"
                                className="control-panel-btn primary"
                                onClick={() => handleApprovePendingRequest(requestRow)}
                                disabled={isProcessing || !onApproveRequest}
                              >
                                {isApproving ? "Approving..." : "Approve & Create User"}
                              </button>
                              <button
                                type="button"
                                className="control-panel-btn danger"
                                onClick={() => handleRejectPendingRequest(requestRow)}
                                disabled={isProcessing || !onRejectRequest}
                              >
                                {isRejecting ? "Rejecting..." : "Reject Request"}
                              </button>
                            </div>

                            {requestActionErrorById?.[requestId] ? (
                              <div className="control-panel-error">{requestActionErrorById[requestId]}</div>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}


            </div>
          </aside>
        </>
      ) : null}

      {breakClearModalOpen ? (
        <div className="control-panel-break-clear-modal-root" role="dialog" aria-modal="true">
          <button
            type="button"
            className="control-panel-break-clear-modal-backdrop"
            onClick={closeBreakClearModal}
            aria-label="Close break log verification dialog"
          />

          <div className="control-panel-break-clear-modal-panel">
            <h3>Confirm Clear Break Logs</h3>
            <p>
              To clear active break logs and move them to Break Archive, enter your super admin
              password.
            </p>

            <label htmlFor="control-panel-break-clear-password">
              Super Admin Password
            </label>
            <input
              id="control-panel-break-clear-password"
              type="password"
              className="control-panel-time-input control-panel-break-clear-password"
              value={breakClearPassword}
              onChange={(event) => setBreakClearPassword(event.target.value)}
              placeholder="Enter password"
              disabled={breakClearBusy}
            />

            {breakClearError ? <div className="control-panel-error">{breakClearError}</div> : null}

            <div className="control-panel-break-clear-modal-actions">
              <button
                type="button"
                className="control-panel-btn secondary"
                onClick={closeBreakClearModal}
                disabled={breakClearBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="control-panel-btn danger"
                onClick={handleClearBreakLogs}
                disabled={breakClearBusy}
              >
                {breakClearBusy ? "Verifying..." : "Confirm Clear Break Logs"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {breakDeleteArchiveModalOpen ? (
        <div className="control-panel-break-clear-modal-root" role="dialog" aria-modal="true">
          <button
            type="button"
            className="control-panel-break-clear-modal-backdrop"
            onClick={closeBreakDeleteArchiveModal}
            aria-label="Close break archive verification dialog"
          />

          <div className="control-panel-break-clear-modal-panel">
            <h3>Clear Break Archive Permanently</h3>
            <p>
              This will permanently delete all archived break logs. Enter your super admin
              password and type DELETE to confirm.
            </p>

            <label htmlFor="control-panel-break-delete-archive-password">
              Super Admin Password
            </label>
            <input
              id="control-panel-break-delete-archive-password"
              type="password"
              className="control-panel-time-input control-panel-break-clear-password"
              value={breakDeleteArchivePassword}
              onChange={(event) => setBreakDeleteArchivePassword(event.target.value)}
              placeholder="Enter password"
              disabled={breakDeleteArchiveBusy}
            />

            <label htmlFor="control-panel-break-delete-archive-confirm">
              Type DELETE To Confirm
            </label>
            <input
              id="control-panel-break-delete-archive-confirm"
              type="text"
              className="control-panel-time-input control-panel-break-clear-password"
              value={breakDeleteArchiveConfirmText}
              onChange={(event) => setBreakDeleteArchiveConfirmText(event.target.value)}
              placeholder="DELETE"
              disabled={breakDeleteArchiveBusy}
            />

            {breakDeleteArchiveError ? (
              <div className="control-panel-error">{breakDeleteArchiveError}</div>
            ) : null}

            <div className="control-panel-break-clear-modal-actions">
              <button
                type="button"
                className="control-panel-btn secondary"
                onClick={closeBreakDeleteArchiveModal}
                disabled={breakDeleteArchiveBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="control-panel-btn danger"
                onClick={handleClearBreakArchive}
                disabled={breakDeleteArchiveBusy}
              >
                {breakDeleteArchiveBusy ? "Verifying..." : "Delete Archive Permanently"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

