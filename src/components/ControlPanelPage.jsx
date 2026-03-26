import React, { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ROLE_PAGES,
  PAGE_KEYS,
  ROLES,
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
import { getDeviceTimeZone } from "../utils/common";
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

const PERMISSION_PAGE_ORDER = [
  "dashboard",
  "employee_dashboard",
  "attendance",
  "assignment",
  "schedule",
  "hours",
  "notifications",
  "manage_announcements",
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

const buildSimpleTimeZoneOptions = (...values) => {
  const list = [...SIMPLE_TIME_ZONE_OPTIONS];
  for (const value of values) {
    const tz = String(value || "").trim();
    if (!tz) continue;
    if (!list.includes(tz)) list.push(tz);
  }
  return list;
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
  onReloadUsers,
  onAttendanceSettingsChange,
  onAttendanceResetTimeChange,
  onBusinessTimeZoneChange,
  onToast,
}) {
  const [selectedType, setSelectedType] = useState("special");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedPages, setSelectedPages] = useState([]);
  const [saving, setSaving] = useState(false);
  const [savingAttendanceSettings, setSavingAttendanceSettings] = useState(false);
  const [localError, setLocalError] = useState("");
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
    if (!selectedUser) return;

    setSelectedPages(
      Array.isArray(selectedUser.allowedPages) && selectedUser.allowedPages.length > 0
        ? selectedUser.allowedPages
        : DEFAULT_ROLE_PAGES[selectedUser.role] || []
    );
  }, [selectedUser]);

  function togglePage(pageKey) {
    setSelectedPages((prev) => {
      if (prev.includes(pageKey)) {
        return prev.filter((item) => item !== pageKey);
      }
      return [...prev, pageKey];
    });
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

  return (
    <div className="control-panel-page">
      <div className="control-panel-header">
        <h1>Control Panel</h1>
        <p>Assign page visibility and attendance reset settings.</p>
      </div>

      {loadingUsersData ? <div className="control-panel-state">Loading control panel...</div> : null}
      {usersError ? <div className="control-panel-error">{usersError}</div> : null}
      {localError ? <div className="control-panel-error">{localError}</div> : null}

      {!loadingUsersData && !usersError ? (
        <div className="control-panel-layout">
          <div className="control-panel-users">
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

            <h2 className="control-panel-section-title">Employees</h2>

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
          </div>

          <div className="control-panel-permissions">
            <h2>Attendance Settings</h2>

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

            <h2>User Permissions</h2>

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
    </div>
  );
}
