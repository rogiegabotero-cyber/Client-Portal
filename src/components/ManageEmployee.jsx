import React, { useEffect, useMemo, useRef, useState } from "react";
import "./manageEmployee.css";
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
} from "../utils/attendanceLog";
import { getScheduleTimeZone } from "../utils/scheduleTime";

/* ---------------- helpers ---------------- */
const initials = (name = "") => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
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

const formatTs = (ts) => {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);

  return new Intl.DateTimeFormat([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
};

const formatUtcIsoToHHMM = (utcIso, timeZone = "America/Chicago") => {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
};

const getScheduleTimeZoneRaw = (item) =>
  String(
    pick(item, ["timeRegion", "timezone", "timeZone", "tz", "scheduleTimezone", "scheduleTimeZone"], "")
  ).trim();

const getScheduleDisplayTimeZone = (item) => {
  return getScheduleTimeZoneRaw(item) || "-";
};

const formatScheduleTime = (
  item,
  keys = [],
  utcKeys = []
) => {
  const raw = pick(item, keys, "");
  const scheduleTimeZone = getScheduleTimeZone(item);

  if (String(raw).trim()) return raw;

  const utcRaw = pick(item, utcKeys, "");
  const utcConverted = utcRaw ? formatUtcIsoToHHMM(utcRaw, scheduleTimeZone) : "";
  if (utcConverted) return utcConverted;

  return "-";
};

const normalizeStatusText = (value = "") => {
  const s = safeLower(value).trim();
  if (!s) return "";

  if (s.includes("on break")) return "On Break";
  if (s.includes("completed") || s.includes("complete")) return "Completed";
  if (s === "ncns" || s.includes("no show")) return "NCNS";
  if (s.includes("late")) return "Late";
  if (s.includes("on time")) return "On Time";
  if (s.includes("early out")) return "Early Out";
  if (s.includes("early in")) return "Early In";
  if (s.includes("leave")) return "Leave";
  if (s.includes("vacation")) return "Vacation";
  if (s.includes("holiday")) return "Holiday";
  if (s.includes("day off") || s.includes("rest day")) return "Day Off";
  if (s.includes("absent")) return "Absent";
  if (s.includes("no log")) return "No Log";
  if (s.includes("no schedule")) return "No Schedule";
  if (s.includes("present")) return "Present";
  if (s.includes("scheduled")) return "Scheduled";
  if (s.includes("live")) return "Live";
  if (s.includes("logged")) return "Logged";

  return value;
};

const getLogStatus = (log) =>
  normalizeStatusText(
    pick(log || {}, ["status", "attendanceStatus", "dailyStatus", "remark"], "")
  );

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
  if (!ts || !Number.isFinite(new Date(ts).getTime())) return "";
  return getBusinessDayKey(ts, attendanceResetTime, businessTimeZone);
};

const summarizeDayBucket = (dayLogs = [], { dayKey = "", endDate = "", isOnBreak = false } = {}) => {
  const logs = Array.isArray(dayLogs) ? dayLogs : [];
  if (!logs.length) return null;

  const dayStatuses = logs.map((log) => safeLower(getLogStatus(log))).filter(Boolean);
  const hasOut = logs.some((log) => isClockedOutLog(log));
  const hasIn = logs.some((log) => isIn(log));
  const hasOnBreakStatus = dayStatuses.some((s) => s.includes("on break"));
  const hasAbsentStatus = dayStatuses.some(
    (s) => s === "ncns" || s.includes("no show") || s === "absent" || s === "no log"
  );

  // Match Attendance page precedence: completed rows first.
  if (hasOut) return "completed";

  // Match Attendance page override: active break on today's live row.
  if ((hasOnBreakStatus || (isOnBreak && String(dayKey) === String(endDate))) && hasIn) {
    return "onBreak";
  }

  if (hasIn) return "live";
  if (hasAbsentStatus) return "absent";

  return null;
};

const buildProfileStats = ({
  rangeLogs,
  summaryLogs,
  todayLogs,
  historyLogs,
  isOnBreak,
  breakUsageMinutes,
  endDate,
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago",
}) => {
  const summary = {
    absent: 0,
    live: 0,
    onBreak: 0,
    completed: 0,
  };

  const summarySource = Array.isArray(summaryLogs) && summaryLogs.length
    ? summaryLogs
    : Array.isArray(rangeLogs)
      ? rangeLogs
      : [];

  const byDay = new Map();
  for (const log of summarySource) {
    const dayKey = getLogDayKey(log, attendanceResetTime, businessTimeZone);
    if (!dayKey) continue;
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(log);
  }

  for (const [dayKey, logs] of byDay.entries()) {
    const bucket = summarizeDayBucket(logs, { dayKey, endDate, isOnBreak });
    if (bucket && bucket in summary) {
      summary[bucket] += 1;
    }
  }

  const sortedToday = [...(Array.isArray(todayLogs) ? todayLogs : [])].sort((a, b) => {
    const at = new Date(getEventTs(a)).getTime() || 0;
    const bt = new Date(getEventTs(b)).getTime() || 0;
    return bt - at;
  });

  const latestToday = sortedToday[0] || null;
  const latestRange = [...(Array.isArray(rangeLogs) ? rangeLogs : [])]
    .sort((a, b) => {
      const at = new Date(getEventTs(a)).getTime() || 0;
      const bt = new Date(getEventTs(b)).getTime() || 0;
      return bt - at;
    })[0] || null;

  const latestHistory = [...(Array.isArray(historyLogs) ? historyLogs : [])]
    .sort((a, b) => {
      const at = new Date(getEventTs(a)).getTime() || 0;
      const bt = new Date(getEventTs(b)).getTime() || 0;
      return bt - at;
    })[0] || null;

  const timeInToday = sortedToday.find((l) => isIn(l)) || null;
  const timeOutToday = [...sortedToday].find((l) => isClockedOutLog(l)) || null;

  let liveState = "Offline";
  if (isOnBreak) liveState = "On Break";
  else if (timeInToday && !timeOutToday) liveState = "Live";
  else if (timeInToday && timeOutToday) liveState = "Completed";

  return {
    summary,
    liveState,
    latestToday,
    latestRange,
    latestHistory,
    totalRangeLogs: Array.isArray(rangeLogs) ? rangeLogs.length : 0,
    totalTodayLogs: Array.isArray(todayLogs) ? todayLogs.length : 0,
    totalHistoryLogs: Array.isArray(historyLogs) ? historyLogs.length : 0,
    breakUsageMinutes: Number(breakUsageMinutes || 0),
    firstInToday: timeInToday,
    lastOutToday: timeOutToday,
  };
};

export default function ManageEmployee({
  employees = [],
  schedulesByUserId = {},
  logsByUserId = {},
  todayLogsByUserId = {},
  historyByUserId = {},
  loadingHistoryByUserId = {},
  historyErrorByUserId = {},
  activeBreaksByUserId = {},
  breakUsageByUserId = {},
  employeeProfilesByUserId = {},
  loadingEmployeeProfiles = false,
  employeeProfilesError = "",
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago",
  startDate,
  endDate,
  rangeDays,
  viewer,
  onToast,
  onSaveEmployeeStartDate,
  onFetchFullHistory,
  pageData = null,
}) {
  const requestedHistoryRef = useRef(new Set());
  const [query, setQuery] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [startDateDraft, setStartDateDraft] = useState("");
  const [scheduleViewMode, setScheduleViewMode] = useState("cards");
  const profileImagesByUserId =
    pageData?.profileImagesByUserId && typeof pageData.profileImagesByUserId === "object"
      ? pageData.profileImagesByUserId
      : {};

  const validEmployees = useMemo(
    () => (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e)),
    [employees]
  );

  const filteredEmployees = useMemo(() => {
    const q = safeLower(query).trim();
    if (!q) return validEmployees;

    return validEmployees.filter((emp) => {
      const uid = String(getUserId(emp) || "");
      const name = getDisplayName(emp);
      const email = pick(emp, ["email"], "");
      const dept = pick(emp, ["department", "departmentName"], "");
      return (
        safeLower(uid).includes(q) ||
        safeLower(name).includes(q) ||
        safeLower(email).includes(q) ||
        safeLower(dept).includes(q)
      );
    });
  }, [validEmployees, query]);

  useEffect(() => {
    if (!selectedEmployeeId && filteredEmployees.length > 0) {
      setSelectedEmployeeId(String(getUserId(filteredEmployees[0])));
      return;
    }

    const exists = filteredEmployees.some(
      (emp) => String(getUserId(emp)) === String(selectedEmployeeId)
    );

    if (!exists && filteredEmployees.length > 0) {
      setSelectedEmployeeId(String(getUserId(filteredEmployees[0])));
    }
  }, [filteredEmployees, selectedEmployeeId]);

  const selectedEmployee = useMemo(() => {
    return (
      validEmployees.find(
        (emp) => String(getUserId(emp)) === String(selectedEmployeeId)
      ) || null
    );
  }, [validEmployees, selectedEmployeeId]);

  const selectedUserId = selectedEmployee ? String(getUserId(selectedEmployee)) : "";
  const selectedEmployeeProfileImg = useMemo(() => {
    if (!selectedEmployee || !selectedUserId) return "";
    return (
      String(profileImagesByUserId?.[selectedUserId] || "").trim() ||
      getProfileImageUrl(selectedEmployee)
    );
  }, [selectedEmployee, selectedUserId, profileImagesByUserId]);
  const selectedSavedProfile = employeeProfilesByUserId?.[selectedUserId] || {};
  const profileError = saveError || employeeProfilesError || "";

  useEffect(() => {
    if (!selectedUserId) {
      setStartDateDraft("");
      return;
    }

    setStartDateDraft(toDateInputValue(selectedSavedProfile?.startDate));
  }, [selectedUserId, selectedSavedProfile?.startDate]);

  const selectedSchedule = useMemo(() => {
    if (!selectedUserId) return [];
    return Array.isArray(schedulesByUserId?.[selectedUserId])
      ? schedulesByUserId[selectedUserId]
      : [];
  }, [selectedUserId, schedulesByUserId]);

  const selectedLogs = useMemo(() => {
    if (!selectedUserId) return [];
    return Array.isArray(logsByUserId?.[selectedUserId])
      ? logsByUserId[selectedUserId]
      : [];
  }, [selectedUserId, logsByUserId]);

  const selectedTodayLogs = useMemo(() => {
    if (!selectedUserId) return [];
    return Array.isArray(todayLogsByUserId?.[selectedUserId])
      ? todayLogsByUserId[selectedUserId]
      : [];
  }, [selectedUserId, todayLogsByUserId]);

  const selectedHistory = useMemo(() => {
    if (!selectedUserId) return [];
    return Array.isArray(historyByUserId?.[selectedUserId])
      ? historyByUserId[selectedUserId]
      : [];
  }, [selectedUserId, historyByUserId]);

  const selectedActiveBreak = !!activeBreaksByUserId?.[selectedUserId];
  const selectedBreakUsage = Number(breakUsageByUserId?.[selectedUserId] || 0);
  const selectedHistoryLoading = !!loadingHistoryByUserId?.[selectedUserId];
  const selectedHistoryError = historyErrorByUserId?.[selectedUserId] || "";
  const summarySourceLogs = selectedHistory.length ? selectedHistory : selectedLogs;

  useEffect(() => {
    const uid = String(selectedUserId || "");
    if (!uid || typeof onFetchFullHistory !== "function") return;

    const hasHistory = Array.isArray(historyByUserId?.[uid]) && historyByUserId[uid].length > 0;
    const loading = !!loadingHistoryByUserId?.[uid];

    if (hasHistory || loading || requestedHistoryRef.current.has(uid)) return;

    requestedHistoryRef.current.add(uid);
    Promise.resolve(onFetchFullHistory(uid)).catch(() => {
      requestedHistoryRef.current.delete(uid);
    });
  }, [selectedUserId, onFetchFullHistory, historyByUserId, loadingHistoryByUserId]);

  const profileStats = useMemo(
    () =>
      buildProfileStats({
        rangeLogs: selectedLogs,
        summaryLogs: summarySourceLogs,
        todayLogs: selectedTodayLogs,
        historyLogs: selectedHistory,
        isOnBreak: selectedActiveBreak,
        breakUsageMinutes: selectedBreakUsage,
        endDate,
        attendanceResetTime,
        businessTimeZone,
      }),
    [
      selectedLogs,
      summarySourceLogs,
      selectedTodayLogs,
      selectedHistory,
      selectedActiveBreak,
      selectedBreakUsage,
      endDate,
      attendanceResetTime,
      businessTimeZone,
    ]
  );

  const recentTimeline = useMemo(() => {
    const source = [
      ...selectedTodayLogs.map((log) => ({ ...log, __source: "today" })),
      ...selectedLogs.map((log) => ({ ...log, __source: "range" })),
    ];

    return source
      .sort((a, b) => {
        const at = new Date(getEventTs(a)).getTime() || 0;
        const bt = new Date(getEventTs(b)).getTime() || 0;
        return bt - at;
      })
      .slice(0, 8);
  }, [selectedTodayLogs, selectedLogs]);

  async function handleSaveStartDate() {
    if (!selectedEmployee || !selectedUserId) return;

    if (!startDateDraft) {
      onToast?.({
        type: "error",
        title: "Missing date",
        message: "Please select a start date before saving.",
      });
      return;
    }

    setSaving(true);
    setSaveError("");

    try {
      const payload = {
        userId: selectedUserId,
        startDate: startDateDraft,
        name: getDisplayName(selectedEmployee),
        email: pick(selectedEmployee, ["email"], ""),
        employeeData: selectedEmployee,
        updatedBy: {
          uid: viewer?.uid || viewer?.userId || viewer?.id || "",
          email: viewer?.email || "",
          role: viewer?.role || "",
          name: viewer?.name || viewer?.displayName || "",
        },
      };

      if (!onSaveEmployeeStartDate) {
        throw new Error("Save action is unavailable");
      }

      await onSaveEmployeeStartDate(payload);

      onToast?.({
        type: "success",
        title: "Saved",
        message: `Start date saved for ${getDisplayName(selectedEmployee)}.`,
      });
    } catch (err) {
      const msg = err?.message || "Failed to save employee start date";
      setSaveError(msg);
      onToast?.({
        type: "error",
        title: "Save failed",
        message: msg,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mep">
      <div className="mep-top">
        <div className="mep-top-pills">
          <div className="mep-pill">Employees: {validEmployees.length}</div>
          <div className="mep-pill">
            Range: {startDate || "-"} -&gt; {endDate || "-"} ({rangeDays || 1}d)
          </div>
          <div className="mep-pill">Reset: {attendanceResetTime}</div>
          <div className="mep-pill">Business TZ: {businessTimeZone}</div>
        </div>
      </div>

      <div className="mep-layout">
        <aside className="mep-sidebar">
          <div className="mep-sidebar-head">
            <div className="mep-sidebar-title">Employees</div>
            <input
              className="mep-search"
              placeholder="Search name / email / userId / department"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="mep-list">
            {filteredEmployees.length === 0 ? (
              <div className="mep-empty">No employees found.</div>
            ) : (
              filteredEmployees.map((emp) => {
                const uid = String(getUserId(emp));
                const active = uid === String(selectedEmployeeId);
                const name = getDisplayName(emp);
                const email = pick(emp, ["email"], "");
                const position = pick(emp, ["position", "role", "jobTitle"], "");
                const department = pick(emp, ["department", "departmentName"], "");
                const profileImg =
                  String(profileImagesByUserId?.[uid] || "").trim() || getProfileImageUrl(emp);

                return (
                  <button
                    type="button"
                    key={uid}
                    className={`mep-list-item ${active ? "active" : ""}`}
                    onClick={() => setSelectedEmployeeId(uid)}
                  >
                    <div className="mep-avatar-sm" aria-label={name}>
                      {profileImg ? (
                        <img
                          src={profileImg}
                          alt={`${name} profile`}
                          className="mep-avatar-img"
                          loading="lazy"
                        />
                      ) : (
                        initials(name)
                      )}
                    </div>

                    <div className="mep-list-body">
                      <div className="mep-list-top">
                        <div className="mep-list-name">{name}</div>
                        <span className={`mep-state ${active ? "selected" : ""}`}>
                          {active ? "Selected" : "Open"}
                        </span>
                      </div>

                      <div className="mep-list-email">{email || uid}</div>

                      <div className="mep-list-tags">
                        <span className="mep-tag">{position || "No Role"}</span>
                        <span className="mep-tag subtle">{department || "No Department"}</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="mep-panel">
          {!selectedEmployee ? (
            <div className="mep-panel-empty">Select an employee to view the profile.</div>
          ) : (
            <>
              <div className="mep-hero">
                <div className="mep-hero-main">
                  <div className="mep-avatar-lg" aria-label={getDisplayName(selectedEmployee)}>
                    {selectedEmployeeProfileImg ? (
                      <img
                        src={selectedEmployeeProfileImg}
                        alt={`${getDisplayName(selectedEmployee)} profile`}
                        className="mep-avatar-img"
                        loading="lazy"
                      />
                    ) : (
                      initials(getDisplayName(selectedEmployee))
                    )}
                  </div>

                  <div className="mep-hero-copy">
                    <div className="mep-hero-name">{getDisplayName(selectedEmployee)}</div>
                    <div className="mep-hero-email">
                      {pick(selectedEmployee, ["email"], "") || selectedUserId}
                    </div>

                    <div className="mep-hero-tags">
                      <span className="mep-tag">
                        {pick(selectedEmployee, ["position", "role", "jobTitle"], "No Role")}
                      </span>
                      <span className="mep-tag subtle">
                        {pick(selectedEmployee, ["department", "departmentName"], "No Department")}
                      </span>
                      <span className={`mep-tag status ${safeLower(profileStats.liveState).replace(/\s+/g, "-")}`}>
                        {profileStats.liveState}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mep-profile-form">
                      <label className="mep-label">Date Joined / Start Date</label>
                      <input
                        type="date"
                        className="mep-input"
                        value={startDateDraft}
                        onChange={(e) => setStartDateDraft(e.target.value)}
                        disabled={loadingEmployeeProfiles || saving}
                      />

                      <button
                        type="button"
                        className="mep-btn primary"
                        onClick={handleSaveStartDate}
                        disabled={loadingEmployeeProfiles || saving}
                      >
                        {saving ? "Saving..." : "Save Start Date"}
                      </button>
                    </div>
              </div>

              {profileError ? <div className="mep-alert">{profileError}</div> : null}

                <div className="mep-grid">

                  <div className="mep-div">
                  <div className="mep-card">
                    <div className="mep-card-title">Attendance Summary</div>
                    <div className="mep-card-hint">
                      {selectedHistoryLoading
                        ? "Loading full attendance history..."
                        : "Using full attendance history (not just today)."}
                    </div>
                    {selectedHistoryError ? (
                      <div className="mep-empty-state">{selectedHistoryError}</div>
                    ) : null}
                    <div className="mep-kv"><span>Absent</span><strong>{profileStats.summary.absent}</strong></div>
                    <div className="mep-kv"><span>Live</span><strong>{profileStats.summary.live}</strong></div>
                    <div className="mep-kv"><span>On Break</span><strong>{profileStats.summary.onBreak}</strong></div>
                    <div className="mep-kv"><span>Completed</span><strong>{profileStats.summary.completed}</strong></div>
                  </div>

                  <div className="mep-card mep-card-span-2">
                    <div className="mep-card-head">
                      <div>
                        <div className="mep-card-title">Recent Attendance Activity</div>
                        <div className="mep-card-hint">
                          Latest activity merged from today logs and selected range logs.
                        </div>
                      </div>
                    </div>

                    {recentTimeline.length === 0 ? (
                      <div className="mep-empty-state">No attendance activity found for this employee.</div>
                    ) : (
                      <div className="mep-timeline">
                        {recentTimeline.map((log, index) => {
                          const status = getLogStatus(log) || "Logged";
                          return (
                            <div className="mep-timeline-item" key={`${selectedUserId}-timeline-${index}`}>
                              <div className="mep-timeline-dot" />
                              <div className="mep-timeline-body">
                                <div className="mep-timeline-top">
                                  <strong>{status}</strong>
                                  <span>{log.__source === "today" ? "Today feed" : "Range feed"}</span>
                                </div>
                                <div className="mep-timeline-meta">
                                  <span>{formatTs(getEventTs(log))}</span>
                                  <span>{pick(log, ["type", "logType", "eventType"], "-")}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
          
                

                <div className="mep-card mep-card-span-2">
                  <div className="mep-card-head">
                    <div>
                      <div className="mep-card-title">Schedule</div>
                      <div className="mep-card-hint">
                        Current assigned schedule for this employee.
                      </div>
                    </div>

                    <div className="mep-toggle-stack">
                      <div className="mep-toggle">
                        <button
                          type="button"
                          className={`mep-toggle-btn ${scheduleViewMode === "cards" ? "active" : ""}`}
                          onClick={() => setScheduleViewMode("cards")}
                        >
                          Card View
                        </button>
                        <button
                          type="button"
                          className={`mep-toggle-btn ${scheduleViewMode === "table" ? "active" : ""}`}
                          onClick={() => setScheduleViewMode("table")}
                        >
                          Table View
                        </button>
                      </div>
                    </div>
                  </div>

                  {selectedSchedule.length === 0 ? (
                    <div className="mep-empty-state">No schedule data available for this employee.</div>
                  ) : scheduleViewMode === "cards" ? (
                    <div className="mep-schedule-grid">
                      {selectedSchedule.map((item, index) => (
                        <div className="mep-schedule-card" key={`${selectedUserId}-sched-${index}`}>
                          <div className="mep-schedule-day">
                            {pick(item, ["dayOfWeek", "day", "weekday"], `Day ${index + 1}`)}
                          </div>

                          <div className="mep-schedule-line">
                            <span>Start (API TZ)</span>
                            <strong>
                              {formatScheduleTime(
                                item,
                                ["timeIn", "startTime", "shiftStart", "start"],
                                ["utcTimeIn", "utcStart", "startUtc", "utcTimeStart"]
                              )}
                            </strong>
                          </div>

                          <div className="mep-schedule-line">
                            <span>End (API TZ)</span>
                            <strong>
                              {formatScheduleTime(
                                item,
                                ["timeOut", "endTime", "shiftEnd", "end"],
                                ["utcTimeOut", "utcEnd", "endUtc", "utcTimeEnd"]
                              )}
                            </strong>
                          </div>

                          <div className="mep-schedule-line">
                            <span>Hours</span>
                            <strong>{pick(item, ["shiftDuration", "hours", "durationHours"], "-")}</strong>
                          </div>

                          <div className="mep-schedule-line">
                            <span>Timezone</span>
                            <strong>{getScheduleDisplayTimeZone(item)}</strong>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mep-table-wrap">
                      <table className="mep-table">
                        <thead>
                          <tr>
                            <th>Day</th>
                            <th>Start (API TZ)</th>
                            <th>End (API TZ)</th>
                            <th>Hours</th>
                            <th>Timezone (API)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedSchedule.map((item, index) => (
                            <tr key={`${selectedUserId}-sched-row-${index}`}>
                              <td>{pick(item, ["dayOfWeek", "day", "weekday"], `Day ${index + 1}`)}</td>
                              <td>
                                {formatScheduleTime(
                                  item,
                                  ["timeIn", "startTime", "shiftStart", "start"],
                                  ["utcTimeIn", "utcStart", "startUtc", "utcTimeStart"]
                                )}
                              </td>
                              <td>
                                {formatScheduleTime(
                                  item,
                                  ["timeOut", "endTime", "shiftEnd", "end"],
                                  ["utcTimeOut", "utcEnd", "endUtc", "utcTimeEnd"]
                                )}
                              </td>
                              <td>{pick(item, ["shiftDuration", "hours", "durationHours"], "-")}</td>
                              <td>{getScheduleDisplayTimeZone(item)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

