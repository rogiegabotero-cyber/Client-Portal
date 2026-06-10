import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CalendarDays,
  Clock3,
  Filter,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import "./manageBreaksPage.css";
import {
  DAILY_BREAK_LIMIT_MINUTES,
  createBreakLogEntry,
  deleteBreakLogEntry,
  getBreakLogsByUserIdsInRange,
  updateBreakLogEntry,
} from "../services/breakService";
import { getBusinessDayKey } from "../utils/attendanceDate";
import { getDisplayName, getUserId, toMillis, toText } from "../utils/common";

const MINUTE_MS = 60 * 1000;

// Persist for this browser session/runtime so navigating away and back does not re-fetch.
const BREAK_LOGS_STARTUP_CACHE = {
  hydrated: false,
  rows: [],
  loadedAtMs: 0,
};

const toMonthInputValue = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const formatMonthLabel = (monthValue = "") => {
  const [yearPart, monthPart] = String(monthValue || "").split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return String(monthValue || "").trim() || "Month";
  }
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

const getMonthRange = (monthValue) => {
  const [yearPart, monthPart] = String(monthValue || "").split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { startDayKey: "", endDayKey: "" };
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    startDayKey: start.toISOString().slice(0, 10),
    endDayKey: end.toISOString().slice(0, 10),
  };
};

const toDateTimeLocalValue = (ms) => {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
};

const fromDateTimeLocalValue = (value) => {
  const str = String(value || "").trim();
  if (!str) return NaN;
  const ms = new Date(str).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

const formatDateTime = (ms, timeZone = "America/Chicago") => {
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString(undefined, {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatDurationLabel = (minutes) => {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hrs = Math.floor(total / 60);
  const mins = total % 60;
  if (hrs && mins) return `${hrs}h ${mins}m`;
  if (hrs) return `${hrs}h`;
  return `${mins}m`;
};

const buildEmployeeLabel = (employee = {}) => {
  const name = toText(getDisplayName(employee));
  const email = toText(employee?.email);
  if (email && name && email.toLowerCase() !== name.toLowerCase()) {
    return `${name} (${email})`;
  }
  return name || email || "Unknown Employee";
};

const getDurationMinutes = (row, nowMs = Date.now()) => {
  const startMs = toMillis(row?.startedAt);
  if (!Number.isFinite(startMs)) return 0;
  const endMs = row?.endedAt ? toMillis(row.endedAt) : nowMs;
  if (!Number.isFinite(endMs) || endMs < startMs) return 0;
  return Math.max(0, Math.round((endMs - startMs) / MINUTE_MS));
};

const createEmptyDraft = (defaultUserId = "") => ({
  userId: defaultUserId,
  startedAt: "",
  endedAt: "",
  isActive: false,
  note: "",
});

const sortRows = (rows = []) =>
  [...(Array.isArray(rows) ? rows : [])].sort((a, b) => b.startedAtMs - a.startedAtMs);

const TABLE_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "ended", label: "Ended" },
  { value: "over_limit", label: "Over Limit" },
];

export default function ManageBreaksPage({
  employees = [],
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago",
  onCreateBreakLog,
  onUpdateBreakLog,
  onDeleteBreakLog,
  onToast,
  pageData = null,
}) {
  void pageData;

  const [selectedMonth, setSelectedMonth] = useState(() => toMonthInputValue(new Date()));
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("all");
  const [cachedRows, setCachedRows] = useState(() =>
    Array.isArray(BREAK_LOGS_STARTUP_CACHE.rows) ? BREAK_LOGS_STARTUP_CACHE.rows : []
  );
  const [cacheLoadedAtMs, setCacheLoadedAtMs] = useState(
    Number(BREAK_LOGS_STARTUP_CACHE.loadedAtMs || 0)
  );
  const [loadingRows, setLoadingRows] = useState(() => !BREAK_LOGS_STARTUP_CACHE.hydrated);
  const [loadError, setLoadError] = useState("");
  const [tableQuickFilter, setTableQuickFilter] = useState("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRowId, setEditingRowId] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [deletingRowId, setDeletingRowId] = useState("");
  const [draft, setDraft] = useState(createEmptyDraft());
  const pageRootRef = useRef(null);

  const employeeOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    for (const employee of Array.isArray(employees) ? employees : []) {
      const userId = String(getUserId(employee) || "").trim();
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      options.push({
        userId,
        name: toText(employee?.name) || toText(getDisplayName(employee)),
        email: toText(employee?.email),
        label: buildEmployeeLabel(employee),
      });
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [employees]);

  const employeeMapById = useMemo(() => {
    const map = {};
    for (const option of employeeOptions) map[option.userId] = option;
    return map;
  }, [employeeOptions]);

  const { startDayKey, endDayKey } = useMemo(
    () => getMonthRange(selectedMonth),
    [selectedMonth]
  );

  const buildNormalizedRow = useCallback(
    (rawRow = {}, fallbackUserId = "") => {
      const startedAt = rawRow?.startedAt ?? null;
      const endedAt = rawRow?.endedAt ?? null;
      const startedAtMs = toMillis(startedAt);
      const endedAtMs = toMillis(endedAt);
      const userId = String(rawRow?.userId || fallbackUserId || "").trim();
      const employee = employeeMapById[userId];

      const durationMinutes =
        Number.isFinite(rawRow?.totalBreakMinutes) && Number(rawRow.totalBreakMinutes) >= 0
          ? Number(rawRow.totalBreakMinutes)
          : getDurationMinutes({ startedAt, endedAt });

      return {
        id: String(rawRow?.id || "").trim(),
        userId,
        name: toText(rawRow?.name) || employee?.name || employee?.label || "Unknown Employee",
        email: toText(rawRow?.email) || employee?.email || "",
        note: toText(rawRow?.note),
        startedAt,
        endedAt,
        startedAtMs,
        endedAtMs,
        dayKey: Number.isFinite(startedAtMs)
          ? getBusinessDayKey(startedAtMs, attendanceResetTime, businessTimeZone)
          : "",
        isActive: !!rawRow?.isActive && !endedAt,
        durationMinutes,
      };
    },
    [attendanceResetTime, businessTimeZone, employeeMapById]
  );

  const buildNormalizedRowsFromMap = useCallback(
    (logsByUserId = {}, userIds = []) => {
      const out = [];
      for (const userId of Array.isArray(userIds) ? userIds : []) {
        const rows = Array.isArray(logsByUserId?.[userId]) ? logsByUserId[userId] : [];
        for (const row of rows) {
          const normalized = buildNormalizedRow(row, userId);
          if (normalized.id) out.push(normalized);
        }
      }
      return sortRows(out);
    },
    [buildNormalizedRow]
  );

  const commitCacheRows = useCallback((rows = []) => {
    const normalized = sortRows(rows);
    BREAK_LOGS_STARTUP_CACHE.hydrated = true;
    BREAK_LOGS_STARTUP_CACHE.rows = normalized;
    BREAK_LOGS_STARTUP_CACHE.loadedAtMs = Date.now();
    setCachedRows(normalized);
    setCacheLoadedAtMs(BREAK_LOGS_STARTUP_CACHE.loadedAtMs);
  }, []);

  const hydrateStartupCache = useCallback(async () => {
    if (BREAK_LOGS_STARTUP_CACHE.hydrated) {
      setCachedRows(sortRows(BREAK_LOGS_STARTUP_CACHE.rows));
      setCacheLoadedAtMs(Number(BREAK_LOGS_STARTUP_CACHE.loadedAtMs || 0));
      setLoadingRows(false);
      setLoadError("");
      return;
    }

    const allIds = employeeOptions.map((option) => option.userId);
    if (!allIds.length) {
      setLoadingRows(false);
      setLoadError("");
      return;
    }

    setLoadingRows(true);
    setLoadError("");
    try {
      // Fetch all available break history once, then keep browsing by filters from cache only.
      const logsByUserId = await getBreakLogsByUserIdsInRange(allIds, {
        attendanceResetTime,
        businessTimeZone,
      });
      const rows = buildNormalizedRowsFromMap(logsByUserId, allIds);
      commitCacheRows(rows);
    } catch (err) {
      console.error("Failed startup break-log cache hydration:", err);
      setLoadError(err?.message || "Failed to load break logs.");
      setCachedRows([]);
      setLoadingRows(false);
    } finally {
      setLoadingRows(false);
    }
  }, [
    employeeOptions,
    attendanceResetTime,
    businessTimeZone,
    buildNormalizedRowsFromMap,
    commitCacheRows,
  ]);

  useEffect(() => {
    hydrateStartupCache();
  }, [hydrateStartupCache]);

  useEffect(() => {
    if (!editorOpen || typeof document === "undefined") return undefined;

    const portalMainEl =
      pageRootRef.current?.closest?.(".portal-main") ||
      document.querySelector(".portal-main");

    const prevOverflow = document.body.style.overflow;
    const prevTouchAction = document.body.style.touchAction;
    const prevPortalMainOverflowY = portalMainEl?.style?.overflowY || "";
    const prevPortalMainOverscroll = portalMainEl?.style?.overscrollBehavior || "";
    const prevPortalMainTouchAction = portalMainEl?.style?.touchAction || "";

    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    if (portalMainEl) {
      portalMainEl.style.overflowY = "hidden";
      portalMainEl.style.overscrollBehavior = "none";
      portalMainEl.style.touchAction = "none";
    }

    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.touchAction = prevTouchAction;
      if (portalMainEl) {
        portalMainEl.style.overflowY = prevPortalMainOverflowY;
        portalMainEl.style.overscrollBehavior = prevPortalMainOverscroll;
        portalMainEl.style.touchAction = prevPortalMainTouchAction;
      }
    };
  }, [editorOpen]);

  const refreshViewFromCache = useCallback(() => {
    setLoadError("");
    setCachedRows((prev) => sortRows(prev));
  }, []);

  const rows = useMemo(() => {
    if (!startDayKey || !endDayKey) return [];
    const isAll = selectedEmployeeId === "all";
    return sortRows(
      cachedRows.filter((row) => {
        if (!row?.id || !row?.dayKey) return false;
        if (!isAll && row.userId !== selectedEmployeeId) return false;
        return row.dayKey >= startDayKey && row.dayKey <= endDayKey;
      })
    );
  }, [cachedRows, selectedEmployeeId, startDayKey, endDayKey]);

  const stats = useMemo(() => {
    const totalLogs = rows.length;
    const totalMinutes = rows.reduce((sum, row) => sum + getDurationMinutes(row), 0);
    const activeCount = rows.filter((row) => row.isActive).length;
    const overLimitCount = rows.filter(
      (row) => getDurationMinutes(row) > DAILY_BREAK_LIMIT_MINUTES
    ).length;
    const avgMinutes = totalLogs ? Math.round(totalMinutes / totalLogs) : 0;
    return { totalLogs, totalMinutes, activeCount, overLimitCount, avgMinutes };
  }, [rows]);

  const selectedEmployeeLabel = useMemo(() => {
    if (selectedEmployeeId === "all") return "All Employees";
    return employeeMapById[selectedEmployeeId]?.label || "Selected Employee";
  }, [selectedEmployeeId, employeeMapById]);

  const tableRows = useMemo(() => {
    if (tableQuickFilter === "active") {
      return rows.filter((row) => row.isActive);
    }
    if (tableQuickFilter === "ended") {
      return rows.filter((row) => !row.isActive);
    }
    if (tableQuickFilter === "over_limit") {
      return rows.filter((row) => getDurationMinutes(row) > DAILY_BREAK_LIMIT_MINUTES);
    }
    return rows;
  }, [rows, tableQuickFilter]);

  const monthOptions = useMemo(() => {
    const set = new Set();
    for (const row of Array.isArray(cachedRows) ? cachedRows : []) {
      const monthKey = String(row?.dayKey || "").slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(monthKey)) set.add(monthKey);
    }
    const currentMonth = toMonthInputValue(new Date());
    set.add(selectedMonth || currentMonth);
    set.add(currentMonth);

    return Array.from(set)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .map((value) => ({
        value,
        label: formatMonthLabel(value),
      }));
  }, [cachedRows, selectedMonth]);

  const beginCreate = () => {
    const defaultUserId =
      selectedEmployeeId !== "all" ? selectedEmployeeId : employeeOptions[0]?.userId || "";
    setEditingRowId("");
    setDraft({
      ...createEmptyDraft(defaultUserId),
      startedAt: toDateTimeLocalValue(Date.now()),
    });
    setEditorOpen(true);
  };

  const beginEdit = (row) => {
    setEditingRowId(row.id);
    setDraft({
      userId: row.userId || "",
      startedAt: toDateTimeLocalValue(row.startedAtMs),
      endedAt: row.isActive ? "" : toDateTimeLocalValue(row.endedAtMs),
      isActive: !!row.isActive,
      note: row.note || "",
    });
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (savingDraft) return;
    setEditorOpen(false);
    setEditingRowId("");
    setDraft(createEmptyDraft(selectedEmployeeId !== "all" ? selectedEmployeeId : ""));
  };

  const handleSaveDraft = async (event) => {
    event?.preventDefault?.();

    const userId = String(draft.userId || "").trim();
    const startedAtMs = fromDateTimeLocalValue(draft.startedAt);
    const endedAtMs = fromDateTimeLocalValue(draft.endedAt);
    const isActive = !!draft.isActive;

    if (!userId) {
      onToast?.({
        type: "warning",
        title: "Employee Required",
        message: "Select an employee for this break log.",
      });
      return;
    }
    if (!Number.isFinite(startedAtMs)) {
      onToast?.({
        type: "warning",
        title: "Start Time Required",
        message: "Enter a valid break start time.",
      });
      return;
    }
    if (!isActive && !Number.isFinite(endedAtMs)) {
      onToast?.({
        type: "warning",
        title: "End Time Required",
        message: "Set an end time or mark this as an active break.",
      });
      return;
    }
    if (Number.isFinite(endedAtMs) && endedAtMs < startedAtMs) {
      onToast?.({
        type: "warning",
        title: "Invalid Time Range",
        message: "End time must be later than the start time.",
      });
      return;
    }

    const employee = employeeMapById[userId];
    const payload = {
      userId,
      name: employee?.name || "",
      email: employee?.email || "",
      startedAt: new Date(startedAtMs),
      endedAt: isActive ? null : Number.isFinite(endedAtMs) ? new Date(endedAtMs) : null,
      isActive,
      note: toText(draft.note),
    };

    setSavingDraft(true);
    try {
      if (editingRowId) {
        if (typeof onUpdateBreakLog === "function") {
          await onUpdateBreakLog(editingRowId, payload);
        } else {
          await updateBreakLogEntry(editingRowId, payload);
        }

        const nextRow = buildNormalizedRow({ id: editingRowId, ...payload }, userId);
        commitCacheRows([
          ...cachedRows.filter((row) => row.id !== editingRowId),
          nextRow,
        ]);

        onToast?.({
          type: "success",
          title: "Break Updated",
          message: "Break log updated successfully.",
        });
      } else {
        let createdRow = null;
        if (typeof onCreateBreakLog === "function") {
          createdRow = await onCreateBreakLog(payload);
        } else {
          createdRow = await createBreakLogEntry(payload);
        }

        const resolvedCreated = createdRow && typeof createdRow === "object"
          ? createdRow
          : { id: `local-${Date.now()}`, ...payload };
        const nextRow = buildNormalizedRow(resolvedCreated, userId);
        commitCacheRows([...cachedRows, nextRow]);

        onToast?.({
          type: "success",
          title: "Break Added",
          message: "Break log created successfully.",
        });
      }

      setEditorOpen(false);
      setEditingRowId("");
      setDraft(createEmptyDraft(selectedEmployeeId !== "all" ? selectedEmployeeId : ""));
    } catch (err) {
      console.error("Failed to save break log entry:", err);
      onToast?.({
        type: "error",
        title: "Save Failed",
        message: err?.message || "Could not save break log.",
      });
    } finally {
      setSavingDraft(false);
    }
  };

  const handleDeleteRow = async (row) => {
    if (!row?.id) {
      return;
    }
    const targetLabel = toText(row?.name || row?.email || row?.userId || "this break log");
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(`Delete break log for ${targetLabel}?`);
    if (!confirmed) return;

    setDeletingRowId(row.id);
    try {
      if (typeof onDeleteBreakLog === "function") {
        await onDeleteBreakLog(row.id);
      } else {
        await deleteBreakLogEntry(row.id);
      }

      commitCacheRows(cachedRows.filter((item) => item.id !== row.id));
      onToast?.({
        type: "success",
        title: "Break Deleted",
        message: "Break log entry was deleted.",
      });
    } catch (err) {
      console.error("Failed to delete break log:", err);
      onToast?.({
        type: "error",
        title: "Delete Failed",
        message: err?.message || "Could not delete break log entry.",
      });
    } finally {
      setDeletingRowId("");
    }
  };

  return (
    <div className="mb-page" ref={pageRootRef}>
      {loadError ? <div className="mb-error">{loadError}</div> : null}

      <div className="mb-stats">
        <div className="mb-stat-card">
          <div className="mb-stat-head">
            <CalendarDays size={16} />
            <span>Total Logs</span>
          </div>
          <div className="mb-stat-value">{stats.totalLogs}</div>
        </div>
        <div className="mb-stat-card">
          <div className="mb-stat-head">
            <Clock3 size={16} />
            <span>Total Break Time</span>
          </div>
          <div className="mb-stat-value">{formatDurationLabel(stats.totalMinutes)}</div>
        </div>
        <div className="mb-stat-card">
          <div className="mb-stat-head">
            <UserRound size={16} />
            <span>Avg Break</span>
          </div>
          <div className="mb-stat-value">{formatDurationLabel(stats.avgMinutes)}</div>
        </div>
        <div className="mb-stat-card">
          <div className="mb-stat-head">
            <Clock3 size={16} />
            <span>Over Limit</span>
          </div>
          <div className="mb-stat-value">{stats.overLimitCount}</div>
        </div>
      </div>

      <section className="mb-table-card">
        <div className="mb-table-head">
          <div className="mb-table-head-main">
            <h2>Break Logs</h2>
            <div className="mb-table-subhead">
              Showing {selectedEmployeeLabel} for {selectedMonth}
              {stats.activeCount > 0 ? ` | ${stats.activeCount} active` : ""}
              {cacheLoadedAtMs ? ` | Cached ${formatDateTime(cacheLoadedAtMs, businessTimeZone)}` : ""}
            </div>
          </div>

          <div className="mb-table-head-filters">
            <label className="mb-filter">
              <span>Month</span>
              <select
                value={selectedMonth}
                onChange={(event) => setSelectedMonth(event.target.value)}
              >
                {monthOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="mb-filter">
              <span>Employee Filter</span>
              <select
                value={selectedEmployeeId}
                onChange={(event) => setSelectedEmployeeId(event.target.value)}
              >
                <option value="all">All employees</option>
                {employeeOptions.map((option) => (
                  <option key={option.userId} value={option.userId}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="mb-table-head-actions">
              <label className="mb-table-quick-filter" title="Table quick filter">
                <Filter size={14} />
                <select
                  value={tableQuickFilter}
                  onChange={(event) => setTableQuickFilter(event.target.value)}
                  aria-label="Table quick filter"
                >
                  {TABLE_FILTER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="mb-btn mb-btn-icon"
                onClick={refreshViewFromCache}
                aria-label="Refresh view"
                title="Refresh view"
              >
                <RefreshCw size={15} />
              </button>
              <button
                type="button"
                className="mb-btn mb-btn-primary mb-btn-icon"
                onClick={beginCreate}
                aria-label="Add break log"
                title="Add break log"
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
        </div>

        {loadingRows ? (
          <div className="mb-empty">Loading break logs...</div>
        ) : tableRows.length === 0 ? (
          <div className="mb-empty">No break logs found for the selected filters.</div>
        ) : (
          <div className="mb-table-wrap">
            <table className="mb-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Day</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th>Note</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => {
                  const durationMinutes = getDurationMinutes(row);
                  const isOver = durationMinutes > DAILY_BREAK_LIMIT_MINUTES;
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="mb-cell-name">{row.name || row.userId}</div>
                        <div className="mb-cell-sub">{row.email || row.userId}</div>
                      </td>
                      <td>{row.dayKey || "-"}</td>
                      <td>{formatDateTime(row.startedAtMs, businessTimeZone)}</td>
                      <td>
                        {row.isActive
                          ? "In progress"
                          : formatDateTime(row.endedAtMs, businessTimeZone)}
                      </td>
                      <td>{formatDurationLabel(durationMinutes)}</td>
                      <td>
                        <span
                          className={`mb-pill ${row.isActive ? "active" : "ended"} ${
                            isOver ? "over" : ""
                          }`}
                        >
                          {row.isActive ? "Active" : isOver ? "Over Limit" : "Ended"}
                        </span>
                      </td>
                      <td className="mb-note-cell">{row.note || "-"}</td>
                      <td>
                        <div className="mb-row-actions">
                          <button type="button" className="mb-btn" onClick={() => beginEdit(row)}>
                            <Pencil size={14} />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            className="mb-btn mb-btn-danger"
                            onClick={() => handleDeleteRow(row)}
                            disabled={deletingRowId === row.id}
                          >
                            <Trash2 size={14} />
                            <span>{deletingRowId === row.id ? "Deleting..." : "Delete"}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editorOpen && typeof document !== "undefined"
        ? createPortal(
            <div className="mb-editor-backdrop" role="dialog" aria-modal="true">
              <form className="mb-editor" onSubmit={handleSaveDraft}>
                <div className="mb-editor-head">
                  <h3>{editingRowId ? "Edit Break Log" : "Add Break Log"}</h3>
                  <button
                    type="button"
                    className="mb-editor-close"
                    onClick={closeEditor}
                    disabled={savingDraft}
                  >
                    <X size={16} />
                  </button>
                </div>

                <label className="mb-editor-field">
                  <span>Employee</span>
                  <select
                    value={draft.userId}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, userId: event.target.value }))
                    }
                    disabled={savingDraft}
                  >
                    <option value="">Select employee</option>
                    {employeeOptions.map((option) => (
                      <option key={`editor-${option.userId}`} value={option.userId}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="mb-editor-grid">
                  <label className="mb-editor-field">
                    <span>Start Time</span>
                    <input
                      type="datetime-local"
                      value={draft.startedAt}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, startedAt: event.target.value }))
                      }
                      disabled={savingDraft}
                    />
                  </label>

                  <label className="mb-editor-field">
                    <span>End Time</span>
                    <input
                      type="datetime-local"
                      value={draft.endedAt}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, endedAt: event.target.value }))
                      }
                      disabled={savingDraft || draft.isActive}
                    />
                  </label>
                </div>

                <label className="mb-editor-check">
                  <input
                    type="checkbox"
                    checked={draft.isActive}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        isActive: event.target.checked,
                        endedAt: event.target.checked ? "" : prev.endedAt,
                      }))
                    }
                    disabled={savingDraft}
                  />
                  <span>Active break (no end time yet)</span>
                </label>

                <label className="mb-editor-field">
                  <span>Note (optional)</span>
                  <textarea
                    rows={3}
                    value={draft.note}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, note: event.target.value }))
                    }
                    disabled={savingDraft}
                    placeholder="Add note for this break..."
                  />
                </label>

                <div className="mb-editor-actions">
                  <button
                    type="button"
                    className="mb-btn"
                    onClick={closeEditor}
                    disabled={savingDraft}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="mb-btn mb-btn-primary" disabled={savingDraft}>
                    <Save size={14} />
                    <span>{savingDraft ? "Saving..." : "Save"}</span>
                  </button>
                </div>
              </form>
            </div>,
            document.body
          )
        : null}

    </div>
  );
}
