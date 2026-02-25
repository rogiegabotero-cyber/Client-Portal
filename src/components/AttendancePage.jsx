// src/components/AttendancePage.jsx
import React, { useEffect, useMemo, useState } from "react";
import HyacinthAttendanceAPI from "../api/hyacinthAttendanceApi";
import "./attendancePage.css";

// robust userId detection
const getUserId = (emp) =>
  emp?.userId ??
  emp?.userID ??
  emp?.user_id ??
  emp?.UserId ??
  emp?.uid ??
  emp?.firebaseUid ??
  emp?.id ??
  emp?.employeeId ??
  emp?._id ??
  emp?.user?.id ??
  emp?.user?.uid ??
  emp?.user?.userId ??
  null;

const getDisplayName = (emp) =>
  emp?.name ??
  emp?.fullName ??
  emp?.displayName ??
  emp?.email ??
  `User ${getUserId(emp) ?? ""}`.trim();

const toYYYYMMDD = (d) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const todayYYYYMMDD = () => toYYYYMMDD(new Date());

const startFromDays = (daysBack, endDateYYYYMMDD) => {
  const end = new Date(`${endDateYYYYMMDD}T00:00:00`);
  end.setDate(end.getDate() - (daysBack - 1)); // 1 => same day
  return toYYYYMMDD(end);
};

const initials = (name = "") => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
};

const statusBadgeClass = (status) => {
  const s = safeLower(status);
  if (s.includes("no schedule")) return "nosched";
  if (s.includes("early")) return "early";
  if (s.includes("on time")) return "ontime";
  if (s.includes("late")) return "late";
  if (s.includes("completed")) return "done";
  if (s.includes("no time out")) return "notimeout";
  return "warn";
};

const safeLower = (v) => String(v ?? "").toLowerCase();

const pick = (obj, keys, fallback = "") => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).length) return v;
  }
  return fallback;
};

const formatTs = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

const addMinutesToTs = (ts, minutesToAdd) => {
  if (!ts) return "—";
  const base = new Date(ts);
  const mins = Number(minutesToAdd);

  if (Number.isNaN(base.getTime()) || !Number.isFinite(mins)) return "—";

  // ✅ timeDiff is minutes; divide by 60 (hours) then convert back -> same result,
  // but keeping your requirement explicit:
  const hours = mins / 60;
  const msToAdd = hours * 60 * 60 * 1000; // hours -> ms

  const out = new Date(base.getTime() + msToAdd);
  return out.toLocaleString();
};

const minutesToHrsMinText = (minutes) => {
  const mins = Number(minutes);
  if (!Number.isFinite(mins)) return "—";

  const totalMinutes = Math.round(mins);
  const hrs = Math.floor(totalMinutes / 60);
  const remMin = totalMinutes % 60;

  // example format: 8hrs,32min
  return `${hrs}hrs,${remMin}min`;
};


// --- schedule helpers ---

const getDayNameFromTs = (ts, timeZone = "UTC") => {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(d);
};

// Convert a "local wall time" (YYYY-MM-DD + HH:mm) in a given IANA timezone into a UTC Date.
// This avoids needing moment/luxon.
const utcFromZoned = (yyyyMmDd, hhmm, timeZone) => {
  try {
    const [Y, M, D] = String(yyyyMmDd).split("-").map(Number);
    const [hh, mm] = String(hhmm).split(":").map(Number);

    // initial guess: interpret desired wall-time as UTC
    let guess = new Date(Date.UTC(Y, M - 1, D, hh, mm, 0));

    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const partsToObj = (parts) => {
      const o = {};
      for (const p of parts) {
        if (p.type !== "literal") o[p.type] = p.value;
      }
      return o;
    };

    const got1 = partsToObj(fmt.formatToParts(guess));
    const gotY = Number(got1.year);
    const gotM = Number(got1.month);
    const gotD = Number(got1.day);
    const gotH = Number(got1.hour);
    const gotMin = Number(got1.minute);

    // minutes since epoch-like for comparing wall times
    const desiredMinutes =
      Date.UTC(Y, M - 1, D, hh, mm, 0) / 60000;
    const gotMinutes =
      Date.UTC(gotY, gotM - 1, gotD, gotH, gotMin, 0) / 60000;

    // adjust the guess so that in the target TZ it matches the desired wall time
    const diffMin = gotMinutes - desiredMinutes;
    guess = new Date(guess.getTime() - diffMin * 60000);

    return guess;
  } catch {
    return null;
  }
};

const getScheduleForLog = (scheduleArr, logTs) => {
  if (!Array.isArray(scheduleArr) || !logTs) return null;
  // Schedule uses timeRegion; use that to compute weekday accurately
  const tz = scheduleArr?.[0]?.timeRegion || "UTC";
  const dayName = getDayNameFromTs(logTs, tz);
  if (!dayName) return null;

  return scheduleArr.find(
    (s) => String(s?.dayOfWeek || "").toLowerCase() === String(dayName).toLowerCase()
  );
};

// Determine if log has an actual timeOut (not computed)
const hasRealTimeOut = (raw) => {
  const v = pick(raw || {}, ["timeOut", "time_out", "clockOut", "timestampOut", "outTimestamp"], "");
  return !!v;
};

// ✅ Main status computation based on Schedule
const computeStatusFromSchedule = ({ log, scheduleForDay }) => {
  // Fallback if no schedule
  if (!scheduleForDay) return "No Schedule";

  const ts = pick(log, ["timestamp", "createdAt", "time"], "");
  const clockIn = new Date(ts);
  if (!ts || Number.isNaN(clockIn.getTime())) return "No Schedule";

  const dutyTz = scheduleForDay.timeRegion || "UTC";
  const dutyTime = scheduleForDay.timeIn; // "HH:mm"
  const shiftDuration = Number(scheduleForDay.shiftDuration); // hours

  // date of the clock-in in the duty timezone
  const dateStr = (() => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: dutyTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(clockIn);
    const obj = {};
    for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
    return `${obj.year}-${obj.month}-${obj.day}`;
  })();

  const scheduledUtc = utcFromZoned(dateStr, dutyTime, dutyTz);
  if (!scheduledUtc) return "No Schedule";

  const diffMin = Math.round((clockIn.getTime() - scheduledUtc.getTime()) / 60000);

  // worked minutes (your row uses timeDiff for hours/min display)
  const workedMinutes = Number(pick(log, ["timeDiff", "diff", "workedMinutes"], null));
  const workedHours = Number.isFinite(workedMinutes) ? workedMinutes / 60 : null;

  const timeOutExists = hasRealTimeOut(log) || String(log?.type || "").toLowerCase() === "out";

  // ✅ 1) Completion statuses (highest priority)
  // Completed: has timeOut AND workedHours >= shiftDuration
  if (timeOutExists && Number.isFinite(workedHours) && Number.isFinite(shiftDuration) && workedHours >= shiftDuration) {
    return "Completed";
  }

  // No Time out: no timeOut AND workedHours > shiftDuration
  if (!timeOutExists && Number.isFinite(workedHours) && Number.isFinite(shiftDuration) && workedHours > shiftDuration) {
    return "No Time out";
  }

  // ✅ 2) Arrival statuses
  // Early: at least 15 minutes before OR (optional) any earlier than -5
  if (diffMin <= -15) return "Early";

  // On time: within 5 minutes (early or late)
  if (diffMin >= -5 && diffMin <= 5) return "On time";

  // Late: more than 5 minutes late
  if (diffMin > 5) return "Late";

  // Between -15 and -5 => still early (not "On time" per your rules)
  return "Early";
};

export default function AttendancePage({ employees = [] }) {
  const apiKey = import.meta.env.VITE_HYACINTH_API_KEY;
  const [schedulesByUserId, setSchedulesByUserId] = useState({});
  const api = useMemo(() => {
    if (!apiKey) return null;
    return new HyacinthAttendanceAPI(apiKey);
  }, [apiKey]);

  // Timeline options
  const RANGE_OPTIONS = [1, 2, 7, 14, 30];

  // Default timeline: Today (1 day), end = today
  const [rangeDays, setRangeDays] = useState(1);
  const [endDate, setEndDate] = useState(() => todayYYYYMMDD());
  const [startDate, setStartDate] = useState(() => startFromDays(1, todayYYYYMMDD()));

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [logsByUserId, setLogsByUserId] = useState({});
  const [errorsByUserId, setErrorsByUserId] = useState({});

  const [query, setQuery] = useState("");

    // ✅ Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRow, setDrawerRow] = useState(null);

  const openDrawer = (row) => {
    setDrawerRow(row);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => setDrawerRow(null), 220);
  };

  const validEmployees = (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e));

  // Keep endDate always "today" BUT only update state when the date changes (prevents refetch every minute)
  useEffect(() => {
    const id = setInterval(() => {
      const t = todayYYYYMMDD();
      setEndDate((prev) => (prev === t ? prev : t));
    }, 60 * 1000);

    // also run once immediately
    const t = todayYYYYMMDD();
    setEndDate((prev) => (prev === t ? prev : t));

    return () => clearInterval(id);
  }, []);

  // Recompute startDate whenever endDate or rangeDays changes
  useEffect(() => {
    setStartDate(startFromDays(rangeDays, endDate));
  }, [rangeDays, endDate]);

  const loadLogs = async () => {
    if (!apiKey) {
      setError("Missing VITE_HYACINTH_API_KEY in .env");
      return;
    }
    if (!api) return;

    if (validEmployees.length === 0) {
      setLogsByUserId({});
      setErrorsByUserId({});
      setError("");
      return;
    }

    setLoading(true);
    setError("");
    setErrorsByUserId({});

    try {
      const nextLogs = {};
      const nextErrors = {};
      const nextSchedules = {};

      for (const emp of validEmployees) {
        const userId = getUserId(emp);

        // 1) logs
        try {
          const logs = await api.getAttendanceLogs({ userId, startDate, endDate });
          nextLogs[userId] = Array.isArray(logs) ? logs : [];
        } catch (e) {
          nextErrors[userId] = e?.message || "Failed to load attendance logs";
          nextLogs[userId] = [];
        }

        // 2) schedule
        try {
          const sched = await api.getUserSchedule(userId);
          nextSchedules[userId] = Array.isArray(sched) ? sched : [];
        } catch {
          nextSchedules[userId] = [];
        }
      }

      setLogsByUserId(nextLogs);
      setErrorsByUserId(nextErrors);
      setSchedulesByUserId(nextSchedules);
    } catch (e) {
      setError(e?.message || "Failed to load attendance logs");
    } finally {
      setLoading(false);
    }
  };

  // Auto-load logs whenever dependencies change (range changes, date flips at midnight, employees loaded, etc.)
  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, apiKey, startDate, endDate, employees]);

  // Flatten + join employee identity
  const rows = useMemo(() => {
    // map employees by userId for quick lookup
    const empByUserId = new Map(validEmployees.map((e) => [String(getUserId(e)), e]));

    const out = [];

    for (const [userIdRaw, logs] of Object.entries(logsByUserId || {})) {
      const userId = String(userIdRaw);

      const emp = empByUserId.get(userId);
      const name = emp ? getDisplayName(emp) : "Unknown";
      const email = pick(emp || {}, ["email"], "");

      const userSchedule = schedulesByUserId?.[userId] || [];

      for (const log of Array.isArray(logs) ? logs : []) {
        const ts = pick(log, ["timestamp", "createdAt", "time"], "");

        const scheduleForDay = getScheduleForLog(userSchedule, ts);
        const computedStatus = computeStatusFromSchedule({ log, scheduleForDay });

        out.push({
          key: `${userId}:${log?.id ?? ts ?? Math.random().toString(16).slice(2)}`,
          id: log?.id ?? "—",
          userId,
          name: log?.name ?? name,
          email: log?.email ?? email,

          type: pick(log, ["type"], "—"),
          status: computedStatus,

          timestamp: ts,
          notes: pick(log, ["notes", "remark", "message"], ""),

          // keep your existing behavior (timeDiff in minutes)
          timeDiff: pick(log, ["timeDiff", "diff", "minutesLate", "workedMinutes"], null),

          deviceTz: pick(log, ["deviceTimezone", "deviceTZ"], "—"),
          schedTz: pick(log, ["scheduleTimezone", "scheduleTZ"], scheduleForDay?.timeRegion || "—"),

          // optional: schedule used for that day
          scheduleForDay,

          raw: log,
        });
      }
    }

    out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return out;
  }, [logsByUserId, validEmployees, schedulesByUserId]);

  const filtered = useMemo(() => {
    const q = safeLower(query).trim();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        safeLower(r.name).includes(q) ||
        safeLower(r.email).includes(q) ||
        safeLower(r.userId).includes(q)
    );
  }, [rows, query]);

  const kpis = useMemo(() => {
    const total = rows.length;
    const noSched = rows.filter((r) => safeLower(r.status).includes("no schedule")).length;

    const diffs = rows
      .map((r) => Number(r.timeDiff))
      .filter((n) => Number.isFinite(n));
    const avgDiff = diffs.length
      ? Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10
      : 0;

    return { total, noSched, avgDiff };
  }, [rows]);

  const perUserErrorCount = Object.keys(errorsByUserId).length;

  return (
    <div className="attx">
      <div className="attxTop">
        <div className="attxTopLeft">
          <div className="attxTitleWrap">
            <div className="attxTitle">Attendance</div>
            <div className="attxSub">
              Range: {startDate} → {endDate} • Users: {validEmployees.length}
              {perUserErrorCount ? ` • Errors: ${perUserErrorCount}` : ""}
            </div>
          </div>
        </div>

        <div className="attxTopRight">
          {/* Search */}
            <div  className="attxField">
              <div className="attxLabel">Search</div>
              <input
                className="attxInput"
                placeholder="Search name / email / userId…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          <div className="attxControls">
            {/* Timeline selector */}
            <div className="attxField">
              <div className="attxLabel">Timeline</div>

              <div>
                {RANGE_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`attxBtn ${rangeDays === n ? "active" : ""}`}
                    onClick={() => setRangeDays(n)}
                    disabled={loading}
                    title={n === 1 ? "Today" : n === 2 ? "Yesterday → Today" : `Last ${n} days`}
                  >
                    {n}
                  </button>
                ))}

                {/* +/- to move beyond presets */}
                <button
                  type="button"
                  className="attxBtn"
                  onClick={() => setRangeDays((d) => Math.min(60, d + 1))}
                  disabled={loading}
                  title="Increase range"
                >
                  +
                </button>

                <button
                  type="button"
                  className="attxBtn"
                  onClick={() => setRangeDays((d) => Math.max(1, d - 1))}
                  disabled={loading}
                  title="Decrease range"
                >
                  -
                </button>

                {/* Display today without a date picker */}
                <div className="attxPill" style={{ alignSelf: "center" }}>
                  Today: <span style={{ color: "var(--text)" }}>{endDate}</span>
                </div>
              </div>

              <div
                style={{
                  marginTop: 6,
                  color: "rgba(255,255,255,.65)",
                  fontWeight: 800,
                  fontSize: 12,
                }}
              >
                Showing: {startDate} → {endDate} ({rangeDays === 1 ? "Today" : `Last ${rangeDays} days`})
              </div>
            </div>

            <button className="attxBtn" onClick={loadLogs} disabled={loading}>
              {loading ? "Loading…" : "Reload"}
            </button>

            <div className="attxPill">
              Logs: <span style={{ color: "var(--text)" }}>{filtered.length}</span>
            </div>
            
          </div>
        </div>
      </div>

      {error && <div className="attxAlert">{error}</div>}

      <div className="attxKpis">
        <div className="attxTile">
          <div className="attxTileLabel">Total Logs</div>
          <div className="attxTileValue">{kpis.total}</div>
          <div className="attxTileHint">All events in date range</div>
        </div>

        <div className="attxTile">
          <div className="attxTileLabel">Clock In</div>
          <div className="attxTileValue">{kpis.ins}</div>
          <div className="attxTileHint">Type = In</div>
        </div>

        <div className="attxTile">
          <div className="attxTileLabel">Clock Out</div>
          <div className="attxTileValue">{kpis.outs}</div>
          <div className="attxTileHint">Type = Out</div>
        </div>

        <div className="attxTile">
          <div className="attxTileLabel">No Schedule</div>
          <div className="attxTileValue">{kpis.noSched}</div>
          <div className="attxTileHint">Status contains “No Schedule”</div>
        </div>

        <div className="attxTile">
          <div className="attxTileLabel">Avg timeDiff</div>
          <div className="attxTileValue">{kpis.avgDiff}</div>
          <div className="attxTileHint">Average minutes (when present)</div>
        </div>
      </div>

      <div className="attxCard">
        <div className="attxCardHead">
          <div className="attxCardTitle">Log Stream</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ color: "rgba(255,255,255,.65)", fontWeight: 900, fontSize: 12 }}>
              Showing {filtered.length} of {rows.length}
            </div>
          </div>
        </div>

        <div className="attxTableWrap">
          <table className="attxTable">
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Times In</th>
                <th>Time Out</th>
                <th>Total Hours</th>
                <th>Timezones</th>
                <th>Details</th>
              </tr>
            </thead>

            <tbody>
              {validEmployees.length === 0 && !loading && !error ? (
                <tr>
                  <td colSpan={6} style={{ padding: 16, color: "rgba(255,255,255,.70)", fontWeight: 900 }}>
                    No employees found (or userId not detected).
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 16, color: "rgba(255,255,255,.70)", fontWeight: 900 }}>
                    No logs match your search/range.
                  </td>
                </tr>
              ) : (
                filtered.slice(0, 300).map((r) => {
                return (
                  <React.Fragment key={r.key}>
                    <tr className="attxTr">
                      <td>
                        <div className="attxPerson">
                          <div className="attxAvatar">{initials(r.name)}</div>
                          <div>
                            <div className="attxName">{r.name}</div>
                            <div className="attxEmail">{r.email || r.userId}</div>
                          </div>
                        </div>
                      </td>

                      {/* ✅ Status */}
                      <td>
                        <span className={`attxBadge ${statusBadgeClass(r.status)}`}>
                          <span className="attxDot" />
                          {String(r.status ?? "—")}
                        </span>
                      </td>

                      {/* ✅ Times In (your timestamp + id) */}
                      <td>
                        {formatTs(r.timestamp)}
                        <div id="attxEmail" className="attxEmail">{r.id}</div>
                      </td>

                      {/* ✅ timeDiff */}
                      <td>
                        {r.timeDiff === null || r.timeDiff === undefined ? (
                          <span className="chip mid">—</span>
                        ) : (
                          <>
                            {addMinutesToTs(r.timestamp, r.timeDiff)}
                            <div id="attxEmail" className="attxEmail">{r.id}</div>
                          </>
                        )}
                      </td>

                      {/* ✅ Total Hours */}
                      <td>
                        {r.timeDiff === null || r.timeDiff === undefined ? (
                          <span className="chip mid">—</span>
                        ) : (
                          <span className="chip good">{minutesToHrsMinText(r.timeDiff)}</span>
                        )}
                      </td>

                      {/* ✅ Timezones */}
                      <td>
                        <div style={{ fontWeight: 950 }}>{r.deviceTz}</div>
                        <div className="attxEmail">Sched: {r.schedTz}</div>
                      </td>

                      {/* ✅ Details */}
                      <td>
                        <button className="attxExpand" type="button" onClick={() => openDrawer(r)}>
                          View
                        </button>
                      </td>
                    </tr>
                  </React.Fragment>
                );
              })
              )}
            </tbody>
          </table>
        </div>
      </div>
      {loading && (
        <div className="attxLoadingOverlay" role="status" aria-live="polite">
          <div className="attxLoadingModal">
            <div className="attxSpinner" />
            <div className="attxLoadingText">Fetching attendance logs…</div>
            <div className="attxLoadingSub">
              Range: {startDate} → {endDate} • Users: {validEmployees.length}
            </div>
          </div>
        </div>
      )}

            {/* ✅ Drawer Backdrop */}
      {drawerOpen && (
        <div
          className="attxDrawerBackdrop"
          onClick={closeDrawer}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Escape" && closeDrawer()}
        />
      )}

      {/* ✅ Drawer Panel (slides from right) */}
      <div className={`attxDrawer ${drawerOpen ? "open" : ""}`} role="dialog" aria-modal="true">
        <div className="attxDrawerHead">
          <div>
            <div className="attxDrawerTitle">Attendance Details</div>
            <div className="attxDrawerSub">
              {drawerRow?.name || "—"} • {drawerRow?.email || drawerRow?.userId || "—"}
            </div>
          </div>

          <button className="attxDrawerClose" type="button" onClick={closeDrawer}>
            ✕
          </button>
        </div>

        <div className="attxDrawerBody">
          {/* Top summary chips */}
          <div className="attxDetailChips">
            <span className="attxChip attxChipGood">{String(drawerRow?.status ?? "—")}</span>
            <span className="attxChip">{String(drawerRow?.type ?? "—")}</span>
            <span className="attxChip">{drawerRow?.id ? `ID: ${drawerRow.id}` : "ID: —"}</span>
          </div>

          {/* Structured details */}
          <div className="attxDetailGrid">
            <div className="attxDetailCard">
              <div className="attxDetailLabel">Name</div>
              <div className="attxDetailValue">{drawerRow?.name || "—"}</div>
            </div>

            <div className="attxDetailCard">
              <div className="attxDetailLabel">Email</div>
              <div className="attxDetailValue">{drawerRow?.email || "—"}</div>
            </div>

            <div className="attxDetailCard">
              <div className="attxDetailLabel">User ID</div>
              <div className="attxDetailValue mono">{drawerRow?.userId || "—"}</div>
            </div>

            <div className="attxDetailCard">
              <div className="attxDetailLabel">Time In</div>
              <div className="attxDetailValue">{formatTs(drawerRow?.timestamp)}</div>
            </div>

            <div className="attxDetailCard">
              <div className="attxDetailLabel">Time Out</div>
              <div className="attxDetailValue">
                {drawerRow?.timeDiff === null || drawerRow?.timeDiff === undefined
                  ? "—"
                  : addMinutesToTs(drawerRow?.timestamp, drawerRow?.timeDiff)}
              </div>
            </div>

            <div className="attxDetailCard">
              <div className="attxDetailLabel">Total Hours</div>
              <div className="attxDetailValue">
                {drawerRow?.timeDiff === null || drawerRow?.timeDiff === undefined
                  ? "—"
                  : minutesToHrsMinText(drawerRow?.timeDiff)}
              </div>
            </div>

            <div className="attxDetailCard">
              <div className="attxDetailLabel">Device Timezone</div>
              <div className="attxDetailValue">{drawerRow?.deviceTz || "—"}</div>
            </div>

            <div className="attxDetailCard">
              <div className="attxDetailLabel">Schedule Timezone</div>
              <div className="attxDetailValue">{drawerRow?.schedTz || "—"}</div>
            </div>

            <div className="attxDetailCard full">
              <div className="attxDetailLabel">Notes</div>
              <div className="attxDetailValue">
                {drawerRow?.notes === null || drawerRow?.notes === undefined || String(drawerRow?.notes).trim() === ""
                  ? "—"
                  : String(drawerRow?.notes)}
              </div>
            </div>
          </div>

          {/* Raw JSON (optional, collapsible) */}
          <details className="attxRawDetails">
            <summary className="attxRawSummary">View raw JSON</summary>
            <pre className="attxRawJson">{JSON.stringify(drawerRow?.raw ?? {}, null, 2)}</pre>
          </details>
        </div>
      </div>
    </div>
  );

  
}