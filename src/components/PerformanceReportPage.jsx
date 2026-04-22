import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./performanceReportPage.css";
import { getDisplayName, getUserId, pick, toMillis } from "../utils/common";

const STATUS_SERIES = [
  { key: "early", label: "Early", color: "#4b9fea" },
  { key: "onTime", label: "On Time", color: "#66bb6a" },
  { key: "late", label: "Late", color: "#f39c12" },
  { key: "pto", label: "PTO", color: "#8e44ad" },
  { key: "absent", label: "Absent", color: "#e74c3c" },
  { key: "ncns", label: "NCNS", color: "#4b5563" },
];

const STATUS_FILTER_ITEMS = [{ key: "ALL", label: "All" }, ...STATUS_SERIES];

const MODE_LABELS = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const formatYmdUtc = (date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const addDaysYmd = (ymd, deltaDays) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return formatYmdUtc(d);
};

const enumerateYmdRange = (start, end) => {
  if (!start || !end) return [];
  if (start > end) return [];

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

const enumerateMonthRange = (startMonth, endMonth) => {
  if (!startMonth || !endMonth || startMonth > endMonth) return [];

  const out = [];
  let cur = `${startMonth}-01`;
  const end = `${endMonth}-01`;

  while (cur <= end) {
    out.push(cur.slice(0, 7));
    const d = new Date(`${cur}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) break;
    d.setUTCMonth(d.getUTCMonth() + 1);
    cur = formatYmdUtc(d);
  }

  return out;
};

const endOfMonthYmd = (monthKey) => {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) return "";
  const d = new Date(`${monthKey}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return formatYmdUtc(d);
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

const normalizeAttendanceStatus = (raw) => {
  const s = String(raw || "").toLowerCase();
  if (!s) return "";
  if (s.includes("early")) return "early";
  if (s.includes("on-time") || s.includes("on time") || s.includes("ontime") || s.includes("present")) return "onTime";
  if (s.includes("late")) return "late";
  if (s.includes("pto") || s.includes("leave")) return "pto";
  if (s.includes("absent")) return "absent";
  if (s.includes("ncns") || s.includes("no show") || s.includes("no-show") || s.includes("no call")) return "ncns";
  return "";
};

const formatDayLabel = (dayKey, mode) => {
  const d = new Date(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dayKey;
  if (mode === "weekly") {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  if (mode === "daily") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const formatMonthLabel = (monthKey) => {
  const d = new Date(`${monthKey}-01T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return monthKey;
  return d.toLocaleDateString(undefined, { month: "short" });
};

const formatMonthOptionLabel = (monthKey) => {
  const d = new Date(`${monthKey}-01T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return monthKey;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

const formatWeekOptionLabel = (startYmd, endYmd) => {
  const start = new Date(`${startYmd}T12:00:00Z`);
  const end = new Date(`${endYmd}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startYmd} -> ${endYmd}`;
  }

  const left = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const right = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${left} - ${right}`;
};

const diffDaysInclusiveYmd = (startYmd, endYmd) => {
  const start = new Date(`${startYmd}T00:00:00Z`);
  const end = new Date(`${endYmd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((end.getTime() - start.getTime()) / msPerDay) + 1;
};

const formatTime = (ms, timeZone) =>
  new Date(ms).toLocaleTimeString(undefined, {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
  });

const AttendanceTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload || {};
  return (
    <div className="prpTooltip">
      <div className="prpTooltipTitle">{label}</div>
      {STATUS_SERIES.map((item) => (
        <div key={`tooltip-${item.key}`} className="prpTooltipRow">
          <span className={`prpTooltipDot prpStatusTone-${item.key}`} />
          <span>{item.label}</span>
          <strong>{Number(row[item.key] || 0)}</strong>
        </div>
      ))}
    </div>
  );
};

export default function PerformanceReportPage({
  mode = "daily",
  employees = [],
  logsByUserId = {},
  historyByUserId = {},
  loadingHistoryByUserId = {},
  historyErrorByUserId = {},
  onFetchFullHistory,
  loading = false,
  error = "",
  endDate = "",
  rangeDays = 1,
  businessTimeZone = "America/Chicago",
}) {
  const validMode = MODE_LABELS[mode] ? mode : "daily";
  const requestedHistoryRef = useRef(new Set());

  const validEmployees = useMemo(
    () => (Array.isArray(employees) ? employees : []).filter((emp) => !!getUserId(emp)),
    [employees]
  );

  const employeeFilterOptions = useMemo(() => {
    return validEmployees
      .map((emp) => ({
        id: String(getUserId(emp)),
        name: getDisplayName(emp),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [validEmployees]);

  const [selectedEmployeeId, setSelectedEmployeeId] = useState("ALL");
  const effectiveSelectedEmployeeId = useMemo(() => {
    if (selectedEmployeeId === "ALL") return "ALL";
    const exists = validEmployees.some(
      (emp) => String(getUserId(emp)) === String(selectedEmployeeId)
    );
    return exists ? selectedEmployeeId : "ALL";
  }, [validEmployees, selectedEmployeeId]);

  const filteredEmployees = useMemo(() => {
    if (effectiveSelectedEmployeeId === "ALL") return validEmployees;
    return validEmployees.filter(
      (emp) => String(getUserId(emp)) === String(effectiveSelectedEmployeeId)
    );
  }, [validEmployees, effectiveSelectedEmployeeId]);

  const defaultYear = useMemo(() => {
    const fromEndDate = String(endDate || "").slice(0, 4);
    if (/^\d{4}$/.test(fromEndDate)) return fromEndDate;
    return String(new Date().getFullYear());
  }, [endDate]);

  const defaultMonth = useMemo(() => {
    const fromEndDate = String(endDate || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(fromEndDate)) return fromEndDate;
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }, [endDate]);
  const defaultWeekStart = useMemo(() => {
    const fromEndDate = String(endDate || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromEndDate)) {
      return startOfWeekYmd(fromEndDate);
    }
    return "";
  }, [endDate]);

  const availableYears = useMemo(() => {
    const years = new Set([defaultYear]);

    for (const emp of filteredEmployees) {
      const uid = String(getUserId(emp));
      const mergedLogs = [
        ...(Array.isArray(historyByUserId?.[uid]) ? historyByUserId[uid] : []),
        ...(Array.isArray(logsByUserId?.[uid]) ? logsByUserId[uid] : []),
      ];

      for (const log of mergedLogs) {
        const tsValue = pick(log, ["timestamp", "createdAt", "time"], null);
        const ts = toMillis(tsValue);
        if (!Number.isFinite(ts)) continue;
        const dayKey = dayKeyFromMsInZone(ts, businessTimeZone);
        const year = String(dayKey || "").slice(0, 4);
        if (/^\d{4}$/.test(year)) years.add(year);
      }
    }

    return Array.from(years).sort((a, b) => Number(b) - Number(a));
  }, [defaultYear, filteredEmployees, historyByUserId, logsByUserId, businessTimeZone]);

  const [selectedYear, setSelectedYear] = useState(defaultYear);
  const [selectedDailyMonth, setSelectedDailyMonth] = useState(defaultMonth);
  const [selectedWeekStart, setSelectedWeekStart] = useState(defaultWeekStart);
  const [selectedLogMonth, setSelectedLogMonth] = useState("ALL");
  const [selectedLogStatus, setSelectedLogStatus] = useState("ALL");

  const availableDailyMonths = useMemo(() => {
    if (validMode !== "daily") return [];

    const months = new Set([defaultMonth]);

    for (const emp of filteredEmployees) {
      const uid = String(getUserId(emp));
      const mergedLogs = [
        ...(Array.isArray(historyByUserId?.[uid]) ? historyByUserId[uid] : []),
        ...(Array.isArray(logsByUserId?.[uid]) ? logsByUserId[uid] : []),
      ];

      for (const log of mergedLogs) {
        const tsValue = pick(log, ["timestamp", "createdAt", "time"], null);
        const ts = toMillis(tsValue);
        if (!Number.isFinite(ts)) continue;

        const dayKey = dayKeyFromMsInZone(ts, businessTimeZone);
        const monthKey = String(dayKey || "").slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(monthKey)) months.add(monthKey);
      }
    }

    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }, [validMode, defaultMonth, filteredEmployees, historyByUserId, logsByUserId, businessTimeZone]);

  const effectiveSelectedDailyMonth = useMemo(() => {
    if (validMode !== "daily") return defaultMonth;
    return availableDailyMonths.includes(selectedDailyMonth)
      ? selectedDailyMonth
      : availableDailyMonths[0] || defaultMonth;
  }, [validMode, selectedDailyMonth, availableDailyMonths, defaultMonth]);

  const availableWeeklyStarts = useMemo(() => {
    if (validMode !== "weekly") return [];

    const weekStarts = new Set();
    if (/^\d{4}-\d{2}-\d{2}$/.test(defaultWeekStart)) {
      weekStarts.add(defaultWeekStart);
      let cursor = defaultWeekStart;
      for (let i = 0; i < 25; i += 1) {
        cursor = addDaysYmd(cursor, -7);
        if (!cursor) break;
        weekStarts.add(cursor);
      }
    }

    for (const emp of filteredEmployees) {
      const uid = String(getUserId(emp));
      const mergedLogs = [
        ...(Array.isArray(historyByUserId?.[uid]) ? historyByUserId[uid] : []),
        ...(Array.isArray(logsByUserId?.[uid]) ? logsByUserId[uid] : []),
      ];

      for (const log of mergedLogs) {
        const tsValue = pick(log, ["timestamp", "createdAt", "time"], null);
        const ts = toMillis(tsValue);
        if (!Number.isFinite(ts)) continue;
        const dayKey = dayKeyFromMsInZone(ts, businessTimeZone);
        if (!dayKey) continue;
        const weekStart = startOfWeekYmd(dayKey);
        if (weekStart) weekStarts.add(weekStart);
      }
    }

    return Array.from(weekStarts).sort((a, b) => b.localeCompare(a));
  }, [validMode, defaultWeekStart, filteredEmployees, historyByUserId, logsByUserId, businessTimeZone]);

  const effectiveSelectedWeekStart = useMemo(() => {
    if (validMode !== "weekly") return defaultWeekStart;
    if (availableWeeklyStarts.includes(selectedWeekStart)) return selectedWeekStart;
    return availableWeeklyStarts[0] || defaultWeekStart;
  }, [validMode, availableWeeklyStarts, selectedWeekStart, defaultWeekStart]);

  const effectiveSelectedYear = useMemo(() => {
    if (validMode !== "monthly") return defaultYear;
    return availableYears.includes(selectedYear)
      ? selectedYear
      : availableYears[0] || defaultYear;
  }, [validMode, availableYears, selectedYear, defaultYear]);

  const reportWindow = useMemo(() => {
    const end = String(endDate || "");
    if (!end) {
      return {
        label: MODE_LABELS[validMode],
        start: "",
        end: "",
        dayKeys: [],
        monthKeys: [],
        dayKeySet: new Set(),
      };
    }

    if (validMode === "daily") {
      const targetMonth = /^\d{4}-\d{2}$/.test(effectiveSelectedDailyMonth)
        ? effectiveSelectedDailyMonth
        : defaultMonth;
      const start = `${targetMonth}-01`;
      const monthEnd = endOfMonthYmd(targetMonth);
      const endForMonth = String(end).startsWith(`${targetMonth}-`) ? end : monthEnd;
      const dayKeys = enumerateYmdRange(start, endForMonth);
      return {
        label: MODE_LABELS[validMode],
        start,
        end: endForMonth,
        dayKeys,
        monthKeys: [targetMonth],
        dayKeySet: new Set(dayKeys),
      };
    }

    if (validMode === "weekly") {
      const start =
        /^\d{4}-\d{2}-\d{2}$/.test(effectiveSelectedWeekStart)
          ? effectiveSelectedWeekStart
          : startOfWeekYmd(end);
      const weekEnd = addDaysYmd(start, 6);
      const endForWeek = weekEnd > end ? end : weekEnd;
      const dayKeys = enumerateYmdRange(start, endForWeek);
      return {
        label: MODE_LABELS[validMode],
        start,
        end: endForWeek,
        dayKeys,
        monthKeys: [],
        dayKeySet: new Set(dayKeys),
      };
    }

    const targetYear =
      /^\d{4}$/.test(effectiveSelectedYear) ? effectiveSelectedYear : defaultYear;
    const start = `${targetYear}-01-01`;
    const currentYear = String(end).slice(0, 4);
    const endForYear = targetYear === currentYear ? end : `${targetYear}-12-31`;
    const dayKeys = enumerateYmdRange(start, endForYear);
    const monthKeys = enumerateMonthRange(`${targetYear}-01`, String(endForYear).slice(0, 7));

    return {
      label: MODE_LABELS[validMode],
      start,
      end: endForYear,
      dayKeys,
      monthKeys,
      dayKeySet: new Set(dayKeys),
    };
  }, [
    validMode,
    endDate,
    effectiveSelectedDailyMonth,
    effectiveSelectedWeekStart,
    effectiveSelectedYear,
    defaultMonth,
    defaultYear,
  ]);

  const needDays = useMemo(() => {
    const depthToRequestedStart = diffDaysInclusiveYmd(
      String(reportWindow.start || ""),
      String(endDate || reportWindow.end || "")
    );
    return Math.max(depthToRequestedStart, reportWindow.dayKeys.length, 1);
  }, [reportWindow.start, reportWindow.end, reportWindow.dayKeys.length, endDate]);

  const availableLogMonths = useMemo(() => {
    if (validMode !== "monthly") return [];
    return reportWindow.monthKeys;
  }, [validMode, reportWindow.monthKeys]);
  const effectiveSelectedLogMonth = useMemo(() => {
    if (validMode !== "monthly") return "ALL";
    if (selectedLogMonth === "ALL") return "ALL";
    return availableLogMonths.includes(selectedLogMonth) ? selectedLogMonth : "ALL";
  }, [validMode, selectedLogMonth, availableLogMonths]);

  useEffect(() => {
    requestedHistoryRef.current.clear();
  }, [validMode]);

  useEffect(() => {
    if (!onFetchFullHistory) return;
    if (Number(rangeDays) >= needDays) return;

    for (const emp of filteredEmployees) {
      const uid = String(getUserId(emp));
      if (!uid) continue;

      const hasHistory = Array.isArray(historyByUserId?.[uid]) && historyByUserId[uid].length > 0;
      const isLoading = !!loadingHistoryByUserId?.[uid];

      if (hasHistory || isLoading || requestedHistoryRef.current.has(uid)) continue;
      requestedHistoryRef.current.add(uid);
      Promise.resolve(onFetchFullHistory(uid)).catch(() => {
        requestedHistoryRef.current.delete(uid);
      });
    }
  }, [
    onFetchFullHistory,
    rangeDays,
    needDays,
    filteredEmployees,
    historyByUserId,
    loadingHistoryByUserId,
  ]);

  const attendanceRows = useMemo(() => {
    const rows = [];

    for (const emp of filteredEmployees) {
      const uid = String(getUserId(emp));
      const srcLogs =
        Array.isArray(historyByUserId?.[uid]) && historyByUserId[uid].length > 0
          ? historyByUserId[uid]
          : Array.isArray(logsByUserId?.[uid])
            ? logsByUserId[uid]
            : [];

      for (const log of srcLogs) {
        const tsValue = pick(log, ["timestamp", "createdAt", "time"], null);
        const ts = toMillis(tsValue);
        if (!Number.isFinite(ts)) continue;

        const dayKey = dayKeyFromMsInZone(ts, businessTimeZone);
        if (!reportWindow.dayKeySet.has(dayKey)) continue;

        const statusText = pick(log, ["status", "attendanceStatus", "dailyStatus", "remark"], "");
        const statusKey = normalizeAttendanceStatus(statusText);
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

        rows.push({
          userId: uid,
          employeeName: getDisplayName(emp),
          dayKey,
          statusKey,
          statusText: statusText || STATUS_SERIES.find((item) => item.key === statusKey)?.label || "",
          noteText,
          ts,
        });
      }
    }

    return rows.sort((a, b) => b.ts - a.ts);
  }, [filteredEmployees, historyByUserId, logsByUserId, reportWindow.dayKeySet, businessTimeZone]);

  const statusCounts = useMemo(() => {
    const counts = STATUS_SERIES.reduce((acc, item) => {
      acc[item.key] = 0;
      return acc;
    }, {});

    for (const row of attendanceRows) {
      if (counts[row.statusKey] !== undefined) counts[row.statusKey] += 1;
    }

    return {
      ...counts,
      total: attendanceRows.length,
    };
  }, [attendanceRows]);

  const chartData = useMemo(() => {
    if (validMode === "monthly") {
      return reportWindow.monthKeys.map((monthKey) => {
        const base = {
          bucketKey: monthKey,
          label: formatMonthLabel(monthKey),
        };
        for (const status of STATUS_SERIES) base[status.key] = 0;
        return base;
      });
    }

    return reportWindow.dayKeys.map((dayKey) => {
      const base = {
        bucketKey: dayKey,
        label: formatDayLabel(dayKey, validMode),
      };
      for (const status of STATUS_SERIES) base[status.key] = 0;
      return base;
    });
  }, [reportWindow.monthKeys, reportWindow.dayKeys, validMode]);

  const chartDataWithCounts = useMemo(() => {
    const map = new Map(chartData.map((row) => [row.bucketKey, { ...row }]));
    for (const row of attendanceRows) {
      const bucketKey = validMode === "monthly" ? String(row.dayKey).slice(0, 7) : row.dayKey;
      const bucket = map.get(bucketKey);
      if (!bucket) continue;
      bucket[row.statusKey] += 1;
    }
    return Array.from(map.values());
  }, [chartData, attendanceRows, validMode]);

  const hasAttendanceData = attendanceRows.length > 0;
  const showHistoryLoading = Number(rangeDays) < needDays && filteredEmployees.some(
    (emp) => loadingHistoryByUserId?.[String(getUserId(emp))]
  );

  const historyError = useMemo(() => {
    if (Number(rangeDays) >= needDays) return "";
    const messages = [];
    for (const emp of filteredEmployees) {
      const uid = String(getUserId(emp));
      const msg = historyErrorByUserId?.[uid];
      if (msg) messages.push(`${getDisplayName(emp)}: ${msg}`);
    }
    return messages.slice(0, 2).join(" | ");
  }, [rangeDays, needDays, filteredEmployees, historyErrorByUserId]);

  const visibleAttendanceRows = useMemo(() => {
    let rows = attendanceRows;

    if (validMode === "monthly" && effectiveSelectedLogMonth !== "ALL") {
      rows = rows.filter((row) =>
        String(row.dayKey).startsWith(`${effectiveSelectedLogMonth}-`)
      );
    }

    if (selectedLogStatus !== "ALL") {
      rows = rows.filter((row) => row.statusKey === selectedLogStatus);
    }

    return rows;
  }, [attendanceRows, validMode, effectiveSelectedLogMonth, selectedLogStatus]);

  const hasLogFiltersApplied =
    (validMode === "monthly" && effectiveSelectedLogMonth !== "ALL") ||
    selectedLogStatus !== "ALL";

  return (
    <div className="prpPage">
      <div className="prpHeader">
        <div className="prpHeaderControls">

          <div className="prpRangePill">
            {reportWindow.start && reportWindow.end
              ? `${reportWindow.start} -> ${reportWindow.end}`
              : "Range unavailable"}
          </div>
          {validMode === "monthly" ? (
            <div className="prpYearFilter">
              <label htmlFor="prp-year-filter">Year</label>
              <select
                id="prp-year-filter"
                value={effectiveSelectedYear}
                onChange={(e) => setSelectedYear(e.target.value)}
              >
                {availableYears.map((year) => (
                  <option key={`year-${year}`} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {validMode === "daily" ? (
            <div className="prpMonthFilter">
              <label htmlFor="prp-daily-month-filter">Month</label>
              <select
                id="prp-daily-month-filter"
                value={effectiveSelectedDailyMonth}
                onChange={(e) => setSelectedDailyMonth(e.target.value)}
              >
                {availableDailyMonths.map((monthKey) => (
                  <option key={`daily-month-${monthKey}`} value={monthKey}>
                    {formatMonthOptionLabel(monthKey)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {validMode === "weekly" ? (
            <div className="prpMonthFilter">
              <label htmlFor="prp-week-filter">Week</label>
              <select
                id="prp-week-filter"
                value={effectiveSelectedWeekStart}
                onChange={(e) => setSelectedWeekStart(e.target.value)}
              >
                {availableWeeklyStarts.map((weekStart) => {
                  const weekEnd = addDaysYmd(weekStart, 6) || weekStart;
                  return (
                    <option key={`week-${weekStart}`} value={weekStart}>
                      {formatWeekOptionLabel(weekStart, weekEnd)}
                    </option>
                  );
                })}
              </select>
            </div>
          ) : null}

          <div className="prpEmployeeFilter">
            <label htmlFor="prp-employee-filter">Employee</label>
            <select
              id="prp-employee-filter"
              value={effectiveSelectedEmployeeId}
              onChange={(e) => setSelectedEmployeeId(e.target.value)}
            >
              <option value="ALL">All Employees</option>
              {employeeFilterOptions.map((option) => (
                <option key={`employee-${option.id}`} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          
        </div>
      </div>

      {loading ? <div className="prpBanner">Loading attendance data...</div> : null}
      {error ? <div className="prpBanner error">{error}</div> : null}
      {showHistoryLoading ? (
        <div className="prpBanner">
          Loading extra attendance history for {reportWindow.label.toLowerCase()} view...
        </div>
      ) : null}
      {historyError ? <div className="prpBanner error">{historyError}</div> : null}

      <section className="prpSection">
        <div className="prpSectionHead">
          <h3>Attendance</h3>
          <p>Logs and chart for the selected {reportWindow.label.toLowerCase()} range.</p>
        </div>

        <div className="prpStatsGrid">
          <div className="prpStatCard total">
            <div className="prpStatLabel">Total Logs</div>
            <div className="prpStatValue">{statusCounts.total}</div>
          </div>
          {STATUS_SERIES.map((item) => (
            <div key={`stat-${item.key}`} className="prpStatCard">
              <div className="prpStatLabel">{item.label}</div>
              <div className="prpStatValue">{Number(statusCounts[item.key] || 0)}</div>
            </div>
          ))}
        </div>

        <div className="prpCard">
          <div className="prpCardHead">Attendance Graph</div>
          {!hasAttendanceData ? (
            <div className="prpEmpty">No attendance logs available for this range.</div>
          ) : (
            <div className="prpChartWrap">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={1}>
                <BarChart data={chartDataWithCounts} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.08)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#334155" }} interval={0} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#334155" }} />
                  <Tooltip content={<AttendanceTooltip />} />
                  {STATUS_SERIES.map((item) => (
                    <Bar key={`bar-${item.key}`} dataKey={item.key} stackId="attendance" fill={item.color} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="prpCard">
          <div className="prpCardTop">
            <div className="prpCardHead">Recent Attendance Logs</div>
            <div className="prpLogFilters">
              {validMode === "monthly" ? (
                <div className="prpMonthFilter">
                  <label htmlFor="prp-month-filter">Month</label>
                  <select
                  id="prp-month-filter"
                  value={effectiveSelectedLogMonth}
                  onChange={(e) => setSelectedLogMonth(e.target.value)}
                >
                    <option value="ALL">All months</option>
                    {availableLogMonths.map((monthKey) => (
                      <option key={`log-month-${monthKey}`} value={monthKey}>
                        {formatMonthOptionLabel(monthKey)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="prpStatusFilter">
                <span className="prpStatusFilterLabel">Status</span>
                <div className="prpStatusFilterChips" role="group" aria-label="Status filter">
                  {STATUS_FILTER_ITEMS.map((item) => {
                    const isActive = selectedLogStatus === item.key;
                    const isAll = item.key === "ALL";

                    return (
                      <button
                        key={`status-filter-${item.key}`}
                        type="button"
                        className={`prpStatusChip ${isActive ? "isActive" : ""} ${isAll ? "isAll" : ""} ${isAll ? "" : `prpStatusTone-${item.key}`}`}
                        onClick={() => setSelectedLogStatus(item.key)}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          {visibleAttendanceRows.length === 0 ? (
            <div className="prpEmpty">
              {hasLogFiltersApplied ? "No logs match the selected filters." : "No logs to display."}
            </div>
          ) : (
            <div className="prpTableWrap">
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
                  {visibleAttendanceRows.slice(0, 20).map((row) => (
                    <tr key={`${row.userId}-${row.ts}-${row.statusKey}`}>
                      <td>{row.employeeName}</td>
                      <td>{row.dayKey}</td>
                      <td>{formatTime(row.ts, businessTimeZone)}</td>
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
      </section>

      <section className="prpSection">
        <div className="prpSectionHead">
          <h3>Performance</h3>
          <span className="prpComingBadge">Coming soon</span>
        </div>

        <div className="prpComingGrid">
          <div className="prpComingCard">
            <div className="prpComingTitle">Total Calls</div>
            <div className="prpComingValue">Coming soon</div>
            <div className="prpComingHint">Calls metrics are not connected yet.</div>
          </div>

          <div className="prpComingCard">
            <div className="prpComingTitle">Total Bookings</div>
            <div className="prpComingValue">Coming soon</div>
            <div className="prpComingHint">Booking metrics are not connected yet.</div>
          </div>

          <div className="prpComingCard wide">
            <div className="prpComingTitle">Top Employees by Bookings</div>
            <div className="prpComingChart">Coming soon</div>
          </div>

          <div className="prpComingCard wide">
            <div className="prpComingTitle">Top Employees by Calls</div>
            <div className="prpComingChart">Coming soon</div>
          </div>
        </div>
      </section>
    </div>
  );
}
