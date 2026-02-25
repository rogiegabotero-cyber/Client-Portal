// src/pages/SchedulePage.jsx
import React, { useEffect, useMemo, useState } from "react";
import HyacinthAttendanceAPI from "../api/hyacinthAttendanceApi";
import "./schedule.css";

/* -----------------------------
   Helpers (aligned w/ Attendance)
------------------------------ */

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

const safeLower = (v) => String(v ?? "").toLowerCase();

const pick = (obj, keys, fallback = "") => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).length) return v;
  }
  return fallback;
};

const initials = (name = "") => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
};

const pad2 = (n) => String(n).padStart(2, "0");

const addHoursToHHMM = (hhmm, hoursToAdd) => {
  const [hRaw, mRaw] = String(hhmm || "").split(":").map(Number);
  const hrs = Number(hoursToAdd);

  if (!Number.isFinite(hRaw) || !Number.isFinite(mRaw) || !Number.isFinite(hrs)) {
    return { outHHMM: "—", dayOffset: 0 };
  }

  const startMin = hRaw * 60 + mRaw;
  const addMin = Math.round(hrs * 60);
  const total = startMin + addMin;

  // handle wrap past midnight
  const dayOffset = Math.floor(total / (24 * 60));
  const mod = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);

  const outH = Math.floor(mod / 60);
  const outM = mod % 60;

  return { outHHMM: `${pad2(outH)}:${pad2(outM)}`, dayOffset };
};

const tzChip = (tz) => (!tz || tz === "—" ? "—" : tz);

/* -----------------------------
   Day-range formatting
------------------------------ */

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_ABBR = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

const normalizeDayKey = (v) => {
  const s = safeLower(v).trim();
  if (!s) return null;
  if (s.startsWith("mon")) return "monday";
  if (s.startsWith("tue")) return "tuesday";
  if (s.startsWith("wed")) return "wednesday";
  if (s.startsWith("thu")) return "thursday";
  if (s.startsWith("fri")) return "friday";
  if (s.startsWith("sat")) return "saturday";
  if (s.startsWith("sun")) return "sunday";
  return null;
};

const formatDayRanges = (dayKeys) => {
  const set = new Set((dayKeys || []).filter(Boolean));
  const ordered = DAY_KEYS.filter((d) => set.has(d));
  if (ordered.length === 0) return "No Schedule";

  const parts = [];
  let start = ordered[0];
  let prev = ordered[0];

  const pushRange = (a, b) => {
    if (a === b) parts.push(DAY_ABBR[a]);
    else parts.push(`${DAY_ABBR[a]}–${DAY_ABBR[b]}`);
  };

  for (let i = 1; i < ordered.length; i++) {
    const cur = ordered[i];
    const prevIdx = DAY_KEYS.indexOf(prev);
    const curIdx = DAY_KEYS.indexOf(cur);

    if (curIdx === prevIdx + 1) {
      prev = cur; // continue streak
    } else {
      pushRange(start, prev);
      start = cur;
      prev = cur;
    }
  }
  pushRange(start, prev);

  return parts.join(", ");
};

const pickPrimarySchedule = (scheduleArr) => {
  if (!Array.isArray(scheduleArr) || scheduleArr.length === 0) return null;

  // Prefer Monday; else take first
  const monday = scheduleArr.find(
    (s) => normalizeDayKey(pick(s, ["dayOfWeek", "day", "weekday"], "")) === "monday"
  );
  return monday || scheduleArr[0];
};

/* -----------------------------
   Page
------------------------------ */

export default function SchedulePage({ employees = [] }) {
  const apiKey = import.meta.env.VITE_HYACINTH_API_KEY;

  const api = useMemo(() => {
    if (!apiKey) return null;
    return new HyacinthAttendanceAPI(apiKey);
  }, [apiKey]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [schedulesByUserId, setSchedulesByUserId] = useState({});
  const [errorsByUserId, setErrorsByUserId] = useState({});

  const [query, setQuery] = useState("");

  const validEmployees = (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e));
  const perUserErrorCount = Object.keys(errorsByUserId || {}).length;

  useEffect(() => {
    if (!apiKey) {
      setError("Missing VITE_HYACINTH_API_KEY in .env");
      return;
    }
    if (!api) return;

    if (validEmployees.length === 0) {
      setSchedulesByUserId({});
      setErrorsByUserId({});
      setError("");
      return;
    }

    let cancelled = false;

    const loadAllSchedules = async () => {
      setLoading(true);
      setError("");
      setErrorsByUserId({});

      try {
        const results = await Promise.all(
          validEmployees.map(async (emp) => {
            const userId = String(getUserId(emp));
            try {
              const schedule = await api.getUserSchedule(userId);
              return {
                userId,
                schedule: Array.isArray(schedule) ? schedule : [],
                err: null,
              };
            } catch (e) {
              return { userId, schedule: [], err: e?.message || "Failed to load schedule" };
            }
          })
        );

        if (cancelled) return;

        const nextSchedules = {};
        const nextErrors = {};

        for (const r of results) {
          nextSchedules[r.userId] = r.schedule;
          if (r.err) nextErrors[r.userId] = r.err;
        }

        setSchedulesByUserId(nextSchedules);
        setErrorsByUserId(nextErrors);
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load schedules");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadAllSchedules();
    return () => {
      cancelled = true;
    };
  }, [api, apiKey, validEmployees.length]);

  // ✅ 1 row per employee
  const rows = useMemo(() => {
    const out = [];

    for (const emp of validEmployees) {
      const userId = String(getUserId(emp));
      const name = getDisplayName(emp);
      const email = pick(emp || {}, ["email"], "");

      const scheduleArr = schedulesByUserId?.[userId] || [];
      const hasSchedule = Array.isArray(scheduleArr) && scheduleArr.length > 0;

      const tz = hasSchedule ? scheduleArr?.[0]?.timeRegion || "—" : "—";

      // Day label: "Mon–Fri"
      const dayKeys = (hasSchedule ? scheduleArr : [])
        .map((s) => normalizeDayKey(pick(s, ["dayOfWeek", "day", "weekday"], "")))
        .filter(Boolean);

      const dayLabel = formatDayRanges(dayKeys);

      // Primary schedule: use Monday else first entry
      const primary = hasSchedule ? pickPrimarySchedule(scheduleArr) : null;

      const timeIn = primary ? pick(primary, ["timeIn", "time_in", "startTime", "start"], "—") : "—";
      const duration = primary ? Number(pick(primary, ["shiftDuration", "hours", "durationHours"], null)) : null;

      const { outHHMM, dayOffset } = hasSchedule ? addHoursToHHMM(timeIn, duration) : { outHHMM: "—", dayOffset: 0 };

      out.push({
        key: userId,
        userId,
        name,
        email,

        hasSchedule,
        dayLabel,
        timeIn: hasSchedule ? timeIn : "—",
        duration: hasSchedule && Number.isFinite(duration) ? duration : null,
        timeOut: hasSchedule ? outHHMM : "—",
        dayOffset: hasSchedule ? dayOffset : 0,
        tz,

        perUserError: errorsByUserId?.[userId] || "",
        raw: scheduleArr,
      });
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [validEmployees, schedulesByUserId, errorsByUserId]);

  const filtered = useMemo(() => {
    const q = safeLower(query).trim();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        safeLower(r.name).includes(q) ||
        safeLower(r.email).includes(q) ||
        safeLower(r.userId).includes(q) ||
        safeLower(r.dayLabel).includes(q)
    );
  }, [rows, query]);

  const kpis = useMemo(() => {
    const totalUsers = validEmployees.length;
    const withSchedule = rows.filter((r) => r.hasSchedule).length;
    const noSchedule = totalUsers - withSchedule;
    return { totalUsers, withSchedule, noSchedule };
  }, [validEmployees.length, rows]);

  return (
    <div className="schx">
      <div className="schxTop">
        <div className="schxTitleWrap">
          <div className="schxTitle">Schedules</div>
          <div className="schxSub">
            Users: {validEmployees.length}
            {perUserErrorCount ? ` • Errors: ${perUserErrorCount}` : ""}
          </div>
        </div>

        <div className="schxControls">
          <div className="schxField" style={{ minWidth: 260 }}>
            <div className="schxLabel">Search</div>
            <input
              className="schxInput"
              placeholder="Search name / email / userId / days…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="schxPill">
            Rows: <span style={{ color: "var(--text)" }}>{filtered.length}</span>
          </div>
        </div>
      </div>

      {error && <div className="schxAlert">{error}</div>}

      <div className="schxKpis">
        <div className="schxTile">
          <div className="schxTileLabel">Users</div>
          <div className="schxTileValue">{kpis.totalUsers}</div>
          <div className="schxTileHint">Valid userId detected</div>
        </div>

        <div className="schxTile">
          <div className="schxTileLabel">With Schedule</div>
          <div className="schxTileValue">{kpis.withSchedule}</div>
          <div className="schxTileHint">Non-empty schedule array</div>
        </div>

        <div className="schxTile">
          <div className="schxTileLabel">No Schedule</div>
          <div className="schxTileValue">{kpis.noSchedule}</div>
          <div className="schxTileHint">Needs assignment</div>
        </div>
      </div>

      <div className="schxCard">
        <div className="schxCardHead">
          <div className="schxCardTitle">Schedule Table</div>
          <div style={{ color: "rgba(255,255,255,.65)", fontWeight: 900, fontSize: 12 }}>
            Showing {filtered.length} of {rows.length}
          </div>
        </div>

        <div className="schxTableWrap">
          <table className="schxTable">
            <thead>
              <tr>
                <th>User</th>
                <th>Days</th>
                <th>Time In</th>
                <th>Time Out</th>
                <th>Hours</th>
                <th>Timezone</th>
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
                    No schedules match your search.
                  </td>
                </tr>
              ) : (
                filtered.slice(0, 400).map((r) => (
                  <tr className="schxTr" key={r.key}>
                    <td>
                      <div className="schxPerson">
                        <div className="schxAvatar">{initials(r.name)}</div>
                        <div>
                          <div className="schxName">{r.name}</div>
                          <div className="schxEmail">{r.email || r.userId}</div>
                        </div>
                      </div>

                      {r.perUserError && <div className="schxErrMini">{r.perUserError}</div>}
                    </td>

                    <td>
                      {r.hasSchedule ? (
                        <span className="schxChip">{r.dayLabel}</span>
                      ) : (
                        <span className="schxChip schxChipNoSched">No Schedule</span>
                      )}
                    </td>

                    <td>
                      <span className="schxTime">{r.timeIn}</span>
                    </td>

                    <td>
                      <div className="schxTimeWrap">
                        <span className="schxTime">{r.timeOut}</span>
                        {r.dayOffset > 0 && <span className="schxMiniPill">{`+${r.dayOffset}d`}</span>}
                      </div>
                    </td>

                    <td>
                      <span className="schxChip schxChipGood">
                        {r.duration == null ? "—" : `${r.duration}h`}
                      </span>
                    </td>

                    <td>
                      <span className="schxChip schxChipTz">{tzChip(r.tz)}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {loading && (
        <div className="schxLoadingOverlay" role="status" aria-live="polite">
          <div className="schxLoadingModal">
            <div className="schxSpinner" />
            <div className="schxLoadingText">Fetching schedules…</div>
            <div className="schxLoadingSub">Users: {validEmployees.length}</div>
          </div>
        </div>
      )}
    </div>
  );
}