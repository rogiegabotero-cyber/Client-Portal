import React, { useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./callActivityReportsPage.css";
import {
  formatDuration,
  getDateKey,
  subscribeCallActivityLogs,
  bulkImportCallActivityRows,
} from "../services/callActivityService";
import { getDisplayName, getProfileImageUrl, getUserId } from "../utils/common";
import * as XLSX from "xlsx";

const todayKey = () => getDateKey(new Date());
const padDatePart = (value) => String(value).padStart(2, "0");
const getMonthKey = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return todayKey().slice(0, 7);
  return `${d.getFullYear()}-${padDatePart(d.getMonth() + 1)}`;
};
const getMonthBounds = (monthKey) => {
  const [yearText, monthText] = String(monthKey || getMonthKey()).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return getMonthBounds(getMonthKey());
  }
  const lastDay = new Date(year, month, 0).getDate();
  return {
    startDate: `${yearText}-${padDatePart(month)}-01`,
    endDate: `${yearText}-${padDatePart(month)}-${padDatePart(lastDay)}`,
  };
};
const getMonthOptions = (count = 18) => {
  const current = new Date();
  const firstOfMonth = new Date(current.getFullYear(), current.getMonth(), 1);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() - index, 1);
    return {
      value: getMonthKey(date),
      label: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    };
  });
};

const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const RECENT_ROWS_PAGE_SIZE = 50;

const getEmployeeKey = (row = {}) =>
  String(row.employeeUserId || row.employeeEmail || row.employeeName || "Unknown").trim() || "Unknown";
const getEmployeeLabel = (row = {}) =>
  String(row.employeeName || row.employeeEmail || row.employeeUserId || "Unknown").trim() || "Unknown";
const compareActivityDateDesc = (a, b) =>
  String(b.entryDate || "").localeCompare(String(a.entryDate || "")) ||
  String(b.startTime || "").localeCompare(String(a.startTime || ""));

const normalizeImportText = (value) => String(value ?? "").replace(/^[^\w@]+/u, "").trim();
const normalizeImportKey = (value) => normalizeImportText(value).toLowerCase().replace(/[^a-z0-9@.]+/g, "");
const normalizeHeaderKey = (value) => normalizeImportText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");

const getEmployeeEmail = (employee = {}) =>
  String(employee.email || employee.Email || employee.user?.email || "").trim().toLowerCase();

const buildEmployeeMatcher = (employees = []) => {
  const byUserId = new Map();
  const byEmail = new Map();
  const byName = new Map();

  for (const employee of Array.isArray(employees) ? employees : []) {
    const userId = String(getUserId(employee) || "").trim();
    const email = getEmployeeEmail(employee);
    const name = getDisplayName(employee);
    if (userId) byUserId.set(userId, employee);
    if (email) byEmail.set(email, employee);
    if (name) byName.set(normalizeImportKey(name), employee);
  }

  return ({ userId = "", email = "", name = "" } = {}) => {
    const matchedByUserId = byUserId.get(String(userId || "").trim());
    if (matchedByUserId) return matchedByUserId;
    const matchedByEmail = byEmail.get(String(email || "").trim().toLowerCase());
    if (matchedByEmail) return matchedByEmail;
    return byName.get(normalizeImportKey(name)) || null;
  };
};

const parseEmployeeMonthSheetName = (sheetName = "") => {
  const name = String(sheetName || "").trim();
  const normalized = name.toUpperCase();
  if (!name || normalized === "SUMMARY" || normalized.startsWith("DATA")) return null;

  const match = name.match(/^(.+?)\s*-\s*(\d{2})-(\d{4})$/);
  if (!match) return null;

  return {
    employeeName: normalizeImportText(match[1]),
    monthKey: `${match[3]}-${match[2]}`,
  };
};

const parseDateCell = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return getDateKey(value);

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed?.y && parsed?.m && parsed?.d) {
      return `${parsed.y}-${padDatePart(parsed.m)}-${padDatePart(parsed.d)}`;
    }
  }

  const text = normalizeImportText(value);
  if (!text) return "";
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) return `${isoMatch[1]}-${padDatePart(isoMatch[2])}-${padDatePart(isoMatch[3])}`;

  const slashMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slashMatch) {
    const year = slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3];
    return `${year}-${padDatePart(slashMatch[1])}-${padDatePart(slashMatch[2])}`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : getDateKey(parsed);
};

const parseTimeCell = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${padDatePart(value.getHours())}:${padDatePart(value.getMinutes())}`;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const totalMinutes = Math.round((value % 1) * 24 * 60);
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    return `${padDatePart(hours)}:${padDatePart(minutes)}`;
  }

  const text = normalizeImportText(value);
  if (!text) return "";

  const timeMatch = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!timeMatch) return "";

  let hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const meridiem = String(timeMatch[3] || "").toUpperCase();
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "";
  return `${padDatePart(hours)}:${padDatePart(minutes)}`;
};

const getSheetCell = (rows, rowIndex, colIndex) => rows?.[rowIndex]?.[colIndex] ?? "";

const getMetadataValue = (rows, labelPattern) => {
  for (const row of rows.slice(0, 14)) {
    const cells = Array.isArray(row) ? row : [];
    for (const cell of cells) {
      const text = normalizeImportText(cell);
      const match = text.match(labelPattern);
      if (match) return normalizeImportText(match[1] || "");
    }
  }
  return "";
};

const parseCallActivitySheet = ({ sheetName, sheet, employees = [] }) => {
  const sheetInfo = parseEmployeeMonthSheetName(sheetName);
  if (!sheetInfo) return { skipped: true, reason: "not an employee monthly sheet", rows: [] };

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  const employeeNameFromHeader = normalizeImportText(getSheetCell(rows, 0, 0)) || sheetInfo.employeeName;
  const employeeUserIdFromMeta = getMetadataValue(rows, /^User\s*ID\s*:\s*(.+)$/i);
  const employeeEmailFromMeta = getMetadataValue(rows, /^Email\s*:\s*(.+)$/i).toLowerCase();
  const matchEmployee = buildEmployeeMatcher(employees);
  const matchedEmployee = matchEmployee({
    userId: employeeUserIdFromMeta,
    email: employeeEmailFromMeta,
    name: employeeNameFromHeader || sheetInfo.employeeName,
  });

  const employeeUserId = String(getUserId(matchedEmployee) || employeeUserIdFromMeta || "").trim();
  const employeeEmail = getEmployeeEmail(matchedEmployee) || employeeEmailFromMeta;
  const employeeName = matchedEmployee ? getDisplayName(matchedEmployee) : employeeNameFromHeader || sheetInfo.employeeName;

  const headerRowIndex = rows.findIndex((row) => {
    const headerKeys = (Array.isArray(row) ? row : []).map(normalizeHeaderKey);
    return headerKeys.includes("entrydate") && headerKeys.includes("starttime") && headerKeys.includes("endtime");
  });

  if (headerRowIndex < 0) return { skipped: true, reason: "missing DAR entries header", rows: [] };

  const headerKeys = rows[headerRowIndex].map(normalizeHeaderKey);
  const columnIndex = {
    entryDate: headerKeys.indexOf("entrydate"),
    startTime: headerKeys.indexOf("starttime"),
    endTime: headerKeys.indexOf("endtime"),
    activityType: headerKeys.indexOf("type"),
    count: headerKeys.indexOf("count"),
    notes: headerKeys.indexOf("description"),
  };

  const payloads = rows.slice(headerRowIndex + 1).flatMap((row) => {
    const entryDate = parseDateCell(row[columnIndex.entryDate]);
    const startTime = parseTimeCell(row[columnIndex.startTime]);
    const endTime = parseTimeCell(row[columnIndex.endTime]);
    const activityType = normalizeImportText(row[columnIndex.activityType]) || "Other";
    const notes = normalizeImportText(row[columnIndex.notes]);
    const count = Math.max(0, Number(row[columnIndex.count]) || 0);

    if (!entryDate && !startTime && !endTime && !activityType && !notes) return [];
    if (!entryDate || !startTime || !endTime) return [];

    return [{
      employeeUserId,
      employeeName,
      employeeEmail,
      entryDate,
      startTime,
      endTime,
      activityType,
      count,
      notes,
    }];
  });

  return {
    skipped: false,
    sheetName,
    employeeName,
    matchedEmployee: Boolean(matchedEmployee),
    rows: payloads,
  };
};

export default function CallActivityReportsPage({ viewer = null, employees = [] }) {
  const defaultMonth = getMonthKey();
  const defaultMonthBounds = getMonthBounds(defaultMonth);
  const [selectedMonth, setSelectedMonth] = useState(defaultMonth);
  const [startDate, setStartDate] = useState(defaultMonthBounds.startDate);
  const [endDate, setEndDate] = useState(defaultMonthBounds.endDate);
  const [selectedEmployeeKey, setSelectedEmployeeKey] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [importError, setImportError] = useState("");
  const [recentPage, setRecentPage] = useState(0);
  const [heroMenuOpen, setHeroMenuOpen] = useState(false);
  const [importProgress, setImportProgress] = useState({
    open: false,
    percent: 0,
    title: "",
    message: "",
  });
  const monthOptions = useMemo(() => getMonthOptions(), []);

  const handleMonthChange = (value) => {
    setSelectedMonth(value);
    if (!value) return;
    const bounds = getMonthBounds(value);
    setStartDate(bounds.startDate);
    setEndDate(bounds.endDate);
  };

  const handleStartDateChange = (value) => {
    setStartDate(value);
    setSelectedMonth("");
  };

  const handleEndDateChange = (value) => {
    setEndDate(value);
    setSelectedMonth("");
  };

  useEffect(() => {
    setLoading(true);
    setError("");
    const unsubscribe = subscribeCallActivityLogs(
      { startDate, endDate, maxRows: 2000 },
      (nextRows) => {
        setRows(nextRows);
        setLoading(false);
      },
      (err) => {
        setError(err?.message || "Unable to load call activity logs.");
        setLoading(false);
      }
    );
    return () => unsubscribe?.();
  }, [startDate, endDate]);

  const employeeOptions = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const key = getEmployeeKey(row);
      const label = getEmployeeLabel(row);
      const current = map.get(key) || { value: key, label, entries: 0 };
      current.entries += 1;
      if (label !== "Unknown") current.label = label;
      map.set(key, current);
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const employeeMatcher = useMemo(() => buildEmployeeMatcher(employees), [employees]);

  const filteredRows = useMemo(() => {
    if (!selectedEmployeeKey) return rows;
    return rows.filter((row) => getEmployeeKey(row) === selectedEmployeeKey);
  }, [rows, selectedEmployeeKey]);

  useEffect(() => {
    setRecentPage(0);
  }, [startDate, endDate, selectedEmployeeKey]);

  const summary = useMemo(() => {
    const totalCount = filteredRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
    const totalMinutes = filteredRows.reduce((sum, row) => sum + (Number(row.durationMinutes) || 0), 0);
    const callRows = filteredRows.filter((row) => String(row.activityType || "").toLowerCase().includes("call"));
    const bookingRows = filteredRows.filter((row) => String(row.activityType || "").toLowerCase().includes("booking"));
    return {
      totalRows: filteredRows.length,
      totalCount,
      totalMinutes,
      totalHours: totalMinutes / 60,
      callCount: callRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0),
      bookingCount: bookingRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0),
      callsPerHour: totalMinutes > 0 ? totalCount / (totalMinutes / 60) : 0,
    };
  }, [filteredRows]);

  const dailyChartRows = useMemo(() => {
    const map = new Map();
    for (const row of filteredRows) {
      const key = row.entryDate || "Unknown";
      const current = map.get(key) || { date: key, count: 0, hours: 0, entries: 0 };
      current.count += Number(row.count) || 0;
      current.hours += (Number(row.durationMinutes) || 0) / 60;
      current.entries += 1;
      map.set(key, current);
    }
    return Array.from(map.values())
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((item) => ({ ...item, hours: Number(item.hours.toFixed(2)) }));
  }, [filteredRows]);

  const typeChartRows = useMemo(() => {
    const map = new Map();
    for (const row of filteredRows) {
      const key = row.activityType || "Other";
      map.set(key, (map.get(key) || 0) + (Number(row.count) || 0));
    }
    return Array.from(map.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [filteredRows]);

  const employeeRows = useMemo(() => {
    const map = new Map();
    for (const row of filteredRows) {
      const key = getEmployeeKey(row);
      const matchedEmployee = employeeMatcher({
        userId: row.employeeUserId,
        email: row.employeeEmail,
        name: row.employeeName,
      });
      const current = map.get(key) || {
        key,
        employee: getEmployeeLabel(row),
        profileImageUrl: matchedEmployee ? getProfileImageUrl(matchedEmployee) : "",
        userId: matchedEmployee ? String(getUserId(matchedEmployee) || "").trim() : String(row.employeeUserId || "").trim(),
        email: matchedEmployee ? getEmployeeEmail(matchedEmployee) : (row.employeeEmail || ""),
        count: 0,
        hours: 0,
        entries: 0,
      };
      if (!current.profileImageUrl && matchedEmployee) {
        current.profileImageUrl = getProfileImageUrl(matchedEmployee);
      }
      current.count += Number(row.count) || 0;
      current.hours += (Number(row.durationMinutes) || 0) / 60;
      current.entries += 1;
      map.set(key, current);
    }
    return Array.from(map.values())
      .map((item) => ({ ...item, hours: Number(item.hours.toFixed(2)) }))
      .sort((a, b) => a.employee.localeCompare(b.employee));
  }, [employeeMatcher, filteredRows]);

  const employeeLeaderboardRows = useMemo(() => {
    const rows = [...employeeRows].sort((a, b) => {
      if (Number(b.count) !== Number(a.count)) return Number(b.count) - Number(a.count);
      if (Number(b.entries) !== Number(a.entries)) return Number(b.entries) - Number(a.entries);
      return String(a.employee || "").localeCompare(String(b.employee || ""));
    });

    const leaderCount = Math.max(1, ...rows.map((row) => Number(row.count) || 0));
    const leaderHours = Math.max(1, ...rows.map((row) => Number(row.hours) || 0));
    const leaderEntries = Math.max(1, ...rows.map((row) => Number(row.entries) || 0));

    return rows.slice(0, 8).map((row, index) => {
      const initials =
        row.employee
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase())
          .join("") || "U";

      const isCurrent = Boolean(
        (viewer && row.userId && viewer.uid && String(row.userId) === String(viewer.uid)) ||
        (viewer &&
          row.email &&
          viewer.email &&
          String(row.email).toLowerCase() === String(viewer.email).toLowerCase()) ||
        (viewer &&
          viewer.displayName &&
          String(row.employee).toLowerCase() === String(viewer.displayName).toLowerCase())
      );

      return {
        ...row,
        rank: index + 1,
        initials,
        countPercent: Math.max(4, Math.round((Number(row.count) / leaderCount) * 100)),
        hoursPercent: Math.max(4, Math.round((Number(row.hours) / leaderHours) * 100)),
        entriesPercent: Math.max(4, Math.round((Number(row.entries) / leaderEntries) * 100)),
        isCurrent,
      };
    });
  }, [employeeRows, viewer]);

  const sortedRecentRows = useMemo(() => {
    return [...filteredRows]
      .sort((a, b) => {
        if (selectedEmployeeKey) return compareActivityDateDesc(a, b);
        return getEmployeeLabel(a).localeCompare(getEmployeeLabel(b)) || compareActivityDateDesc(a, b);
      });
  }, [filteredRows, selectedEmployeeKey]);

  const recentPageCount = Math.max(1, Math.ceil(sortedRecentRows.length / RECENT_ROWS_PAGE_SIZE));
  const safeRecentPage = Math.min(recentPage, recentPageCount - 1);
  const recentRows = useMemo(() => {
    const start = safeRecentPage * RECENT_ROWS_PAGE_SIZE;
    return sortedRecentRows.slice(start, start + RECENT_ROWS_PAGE_SIZE);
  }, [safeRecentPage, sortedRecentRows]);
  const recentRangeStart = sortedRecentRows.length ? safeRecentPage * RECENT_ROWS_PAGE_SIZE + 1 : 0;
  const recentRangeEnd = sortedRecentRows.length
    ? Math.min(sortedRecentRows.length, recentRangeStart + recentRows.length - 1)
    : 0;

  return (
      <div className="callReportsPage">
      <div className="callReportsHero">
        <div className="callReportsHeroActions">
          <div className="callReportsFilters">
            <label>
              <span>Month</span>
              <select value={selectedMonth} onChange={(e) => handleMonthChange(e.target.value)}>
                <option value="">Custom range</option>
                {monthOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Employee</span>
              <select value={selectedEmployeeKey} onChange={(e) => setSelectedEmployeeKey(e.target.value)}>
                <option value="">All employees</option>
                {employeeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} ({option.entries})
                  </option>
                ))}
              </select>
            </label>
            {!selectedMonth ? (
              <>
                <label>
                  <span>Start date</span>
                  <input type="date" value={startDate} onChange={(e) => handleStartDateChange(e.target.value)} />
                </label>
                <label>
                  <span>End date</span>
                  <input type="date" value={endDate} onChange={(e) => handleEndDateChange(e.target.value)} />
                </label>
              </>
            ) : null}
          </div>
          <div className="callReportsHeroMenu">
            <button
              type="button"
              className="callReportsHeroMenuButton"
              onClick={() => setHeroMenuOpen((open) => !open)}
              aria-label="Open Call Reports actions"
              aria-expanded={heroMenuOpen}
            >
              ⋮
            </button>
            {heroMenuOpen ? (
              <div className="callReportsHeroMenuPanel">
                <label className="callReportsImportAction">
                  <span className="callReportsMenuIcon" aria-hidden="true">⇧</span>
                  <span className="callReportsMenuText">
                    <strong>Import sheet</strong>
                  </span>
                  <input
              type="file"
              accept=".xlsx,.xls"
              disabled={importing}
              onChange={async (e) => {
                setHeroMenuOpen(false);
                setImportError("");
                setImportStatus("");
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                setImporting(true);
                setImportProgress({
                  open: true,
                  percent: 3,
                  title: "Preparing import",
                  message: `Opening ${file.name}...`,
                });
                try {
                  const data = await file.arrayBuffer();
                  setImportProgress({
                    open: true,
                    percent: 15,
                    title: "Reading workbook",
                    message: "Scanning sheets and employee details...",
                  });
                  const workbook = XLSX.read(data, { type: "array" });
                  const parsedSheets = [];

                  for (const [index, sheetName] of workbook.SheetNames.entries()) {
                    parsedSheets.push(parseCallActivitySheet({
                      sheetName,
                      sheet: workbook.Sheets[sheetName],
                      employees,
                    }));

                    setImportProgress({
                      open: true,
                      percent: Math.min(45, 15 + Math.round(((index + 1) / workbook.SheetNames.length) * 30)),
                      title: "Extracting sheets",
                      message: `Checked ${index + 1} of ${workbook.SheetNames.length} sheet(s)...`,
                    });
                    await Promise.resolve();
                  }

                  const payloads = parsedSheets.flatMap((sheetResult) => sheetResult.rows);
                  const importedSheetCount = parsedSheets.filter((sheetResult) => !sheetResult.skipped).length;
                  const skippedSheetCount = parsedSheets.length - importedSheetCount;
                  const unmatchedSheets = parsedSheets
                    .filter((sheetResult) => !sheetResult.skipped && !sheetResult.matchedEmployee)
                    .map((sheetResult) => sheetResult.employeeName);

                  if (!payloads.length) throw new Error("No rows found in the workbook.");

                  setImportStatus(`Importing ${payloads.length} row(s) from ${importedSheetCount} employee sheet(s)...`);
                  setImportProgress({
                    open: true,
                    percent: 50,
                    title: "Saving to Firebase",
                    message: `Saving 0 of ${payloads.length} row(s)...`,
                  });
                  await bulkImportCallActivityRows(payloads, {
                    createdByUserId: viewer?.uid,
                    createdByName: viewer?.displayName,
                    createdByEmail: viewer?.email,
                  }, {
                    onProgress: ({ completed, total }) => {
                      setImportProgress({
                        open: true,
                        percent: 50 + Math.round((completed / total) * 45),
                        title: "Saving to Firebase",
                        message: `Saving ${completed} of ${total} row(s)...`,
                      });
                    },
                  });
                  setImportProgress({
                    open: true,
                    percent: 100,
                    title: "Import complete",
                    message: `Imported ${payloads.length} row(s).`,
                  });
                  setImportStatus(
                    [
                      `Imported ${payloads.length} row(s) from ${importedSheetCount} employee sheet(s).`,
                      skippedSheetCount ? `Skipped ${skippedSheetCount} non-employee sheet(s).` : "",
                      unmatchedSheets.length ? `Imported unmatched employee tab(s): ${unmatchedSheets.join(", ")}.` : "",
                    ].filter(Boolean).join(" ")
                  );
                } catch (err) {
                  console.error(err);
                  setImportError(err?.message || String(err));
                  setImportProgress({
                    open: true,
                    percent: 100,
                    title: "Import failed",
                    message: err?.message || String(err),
                  });
                } finally {
                  setImporting(false);
                  setTimeout(() => {
                    setImportProgress((prev) => ({ ...prev, open: false }));
                  }, 900);
                  e.target.value = "";
                }
              }}
            />
                </label>
                <button
                  type="button"
                  className="callReportsMenuAction"
                  onClick={() => {
                    setHeroMenuOpen(false);
                    window.print();
                  }}
                >
                  <span className="callReportsMenuIcon" aria-hidden="true">⎙</span>
                  <span className="callReportsMenuText">
                    <strong>Print</strong>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {importStatus ? <div className="callReportsLoading">{importStatus}</div> : null}
        {importError ? <div className="callReportsError">{importError}</div> : null}
      </div>

      {importProgress.open ? (
        <div className="callImportModalOverlay" role="status" aria-live="polite">
          <div className="callImportModal">
            <div className="callImportModalHead">
              <div>
                <div className="callReportsEyebrow">Sheet import</div>
                <h3>{importProgress.title || "Importing file"}</h3>
              </div>
              <strong>{Math.max(0, Math.min(100, importProgress.percent))}%</strong>
            </div>
            <div className="callImportProgressTrack">
              <div
                className="callImportProgressBar"
                style={{ width: `${Math.max(0, Math.min(100, importProgress.percent))}%` }}
              />
            </div>
            <p>{importProgress.message}</p>
          </div>
        </div>
      ) : null}

      {error ? <div className="callReportsError">{error}</div> : null}
      {loading ? <div className="callReportsLoading">Loading call activity...</div> : null}

      <div className="callReportsStats">
        <div className="callReportStat"><b>{numberFmt.format(summary.totalCount)}</b><span>Total count</span></div>
        <div className="callReportStat"><b>{formatDuration(summary.totalMinutes)}</b><span>Total duration</span></div>
        <div className="callReportStat"><b>{numberFmt.format(summary.callCount)}</b><span>Call count</span></div>
        <div className="callReportStat"><b>{numberFmt.format(summary.bookingCount)}</b><span>Bookings</span></div>
        <div className="callReportStat"><b>{numberFmt.format(summary.callsPerHour)}</b><span>Count per hour</span></div>
      </div>

      <div className="callReportsGrid">
        <section className="callReportCard callReportWide">
          <div className="callReportCardHead">
            <h3>Daily count trend</h3>
            <span>{dailyChartRows.length} day(s)</span>
          </div>
          <div className="callReportChart">
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={dailyChartRows} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="callCountFade" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#001b64" stopOpacity={0.5} />
                    <stop offset="20%" stopColor="#2563eb" stopOpacity={0.28} />
                    <stop offset="70%" stopColor="#3b82f6" stopOpacity={0.08} />
                    <stop offset="100%" stopColor="#93c5fd" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="callHoursFade" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.38} />
                    <stop offset="18%" stopColor="#60a5fa" stopOpacity={0.2} />
                    <stop offset="58%" stopColor="#93c5fd" stopOpacity={0.06} />
                    <stop offset="100%" stopColor="#dbeafe" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Area type="monotone" dataKey="count" name="Count fade" stroke="none" fill="url(#callCountFade)" legendType="none" tooltipType="none" activeDot={false} />
                <Area type="monotone" dataKey="hours" name="Hours fade" stroke="none" fill="url(#callHoursFade)" legendType="none" tooltipType="none" activeDot={false} />
                <Line type="monotone" dataKey="count" name="Count" stroke="#1d4ed8" strokeWidth={0.5} dot={false} />
                <Line type="monotone" dataKey="hours" name="Hours" stroke="#000000" strokeWidth={0.5} dot={false} strokeDasharray="6 6" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        <div className="callReportsRow">
          <section className="callReportCard callActivityTypeCard">
            <div className="callReportCardHead">
              <h3>Count by activity type</h3>
            </div>
            <div className="callReportChart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={typeChartRows} margin={{ top: 10, right: 20, left: 0, bottom: 45 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="type" angle={-25} textAnchor="end" interval={0} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" name="Count" fill="#3b82f6" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="callReportCard callActivityReportsLeaderboardPanel">
            <div className="callReportCardHead">
              <h3>Call / Activity Leaderboard</h3>
              <span>Top employees by count, hours, and entries</span>
            </div>
            {employeeLeaderboardRows.length ? (
              <div className="callActivityReportsLeaderboardStrip">
                {employeeLeaderboardRows.map((employeeRow) => (
                  <div
                    className={`callActivityReportsLeaderboardItem ${employeeRow.isCurrent ? "isSelected" : ""}`}
                    key={`call-activity-leader-${employeeRow.key}`}
                  >
                    <div
                      className="callActivityReportsLeaderboardBars"
                      title={`${employeeRow.employee}: ${numberFmt.format(employeeRow.count)} count, ${employeeRow.entries} entries`}
                    >
                      <div className="callActivityReportsLeaderboardBarsTop">
                        <div className="callActivityReportsLeaderboardRank">#{employeeRow.rank}</div>
                        {employeeRow.isCurrent ? <div className="callActivityReportsLeaderboardYou">You</div> : null}
                      </div>
                      <div className="callActivityReportsLeaderboardBarGroup">
                        <div
                          className="callActivityReportsLeaderboardBar isCount"
                          style={{ "--barPct": `${employeeRow.countPercent}%` }}
                        >
                          <span>{numberFmt.format(employeeRow.count)}</span>
                          <i aria-hidden="true" />
                          <em>Count</em>
                        </div>
                        <div
                          className="callActivityReportsLeaderboardBar isHours"
                          style={{ "--barPct": `${employeeRow.hoursPercent}%` }}
                        >
                          <span>{numberFmt.format(employeeRow.hours)}hrs</span>
                          <i aria-hidden="true" />
                          <em>Hours</em>
                        </div>
                        <div
                          className="callActivityReportsLeaderboardBar isEntries"
                          style={{ "--barPct": `${employeeRow.entriesPercent}%` }}
                        >
                          <span>{employeeRow.entries}</span>
                          <i aria-hidden="true" />
                          <em>Entries</em>
                        </div>
                      </div>
                    </div>
                    <div className="callActivityReportsLeaderboardAvatar">
                      {employeeRow.profileImageUrl ? (
                        <img src={employeeRow.profileImageUrl} alt={`${employeeRow.employee} profile`} />
                      ) : (
                        <span>{employeeRow.initials}</span>
                      )}
                    </div>
                    <div className="callActivityReportsLeaderboardName">{employeeRow.employee}</div>
                    <div className="callActivityReportsLeaderboardMeta">
                      {numberFmt.format(employeeRow.count)} count • {employeeRow.entries} entries • {numberFmt.format(employeeRow.hours)}hrs
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="employeeCompareEmpty">No activity yet.</div>
            )}
          </section>
        </div>
      </div>

      <section className="callReportCard">
        <div className="callReportCardHead">
          <h3>Recent activity logs</h3>
          <div className="callReportPager">
            <button
              type="button"
              onClick={() => setRecentPage((page) => Math.max(0, page - 1))}
              disabled={safeRecentPage <= 0}
              aria-label="Previous activity logs page"
            >
              ‹
            </button>
            <span>
              Showing {recentRangeStart}-{recentRangeEnd} of {summary.totalRows} row(s)
            </span>
            <button
              type="button"
              onClick={() => setRecentPage((page) => Math.min(recentPageCount - 1, page + 1))}
              disabled={safeRecentPage >= recentPageCount - 1}
              aria-label="Next activity logs page"
            >
              ›
            </button>
          </div>
        </div>
        <div className="callReportTableWrap">
          <table className="callReportTable">
            <thead>
              <tr>
                <th>Date</th><th>Employee</th><th>Start</th><th>End</th><th>Duration</th><th>Type</th><th>Count</th><th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {recentRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.entryDate}</td>
                  <td>{row.employeeName || row.employeeEmail || row.employeeUserId}</td>
                  <td>{row.startTime}</td>
                  <td>{row.endTime}</td>
                  <td>{formatDuration(row.durationMinutes)}</td>
                  <td>{row.activityType}</td>
                  <td>{row.count}</td>
                  <td>{row.notes || "-"}</td>
                </tr>
              ))}
              {!recentRows.length ? <tr><td colSpan="8">No activity logs found for this date range.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
