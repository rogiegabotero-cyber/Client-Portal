// src/components/SchedulePage.jsx
import React, { useMemo, useState } from "react";
import "./schedule.css";

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
  emp?.name ?? emp?.fullName ?? emp?.displayName ?? emp?.email ?? `User ${getUserId(emp) ?? ""}`.trim();

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
    return { outHHMM: "-", dayOffset: 0 };
  }

  const startMin = hRaw * 60 + mRaw;
  const addMin = Math.round(hrs * 60);
  const total = startMin + addMin;

  const dayOffset = Math.floor(total / (24 * 60));
  const mod = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);

  const outH = Math.floor(mod / 60);
  const outM = mod % 60;

  return { outHHMM: `${pad2(outH)}:${pad2(outM)}`, dayOffset };
};

const tzChip = (tz) => (!tz || tz === "-" ? "-" : tz);

// Day-range formatting
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
    else parts.push(`${DAY_ABBR[a]}-${DAY_ABBR[b]}`);
  };

  for (let i = 1; i < ordered.length; i++) {
    const cur = ordered[i];
    const prevIdx = DAY_KEYS.indexOf(prev);
    const curIdx = DAY_KEYS.indexOf(cur);

    if (curIdx === prevIdx + 1) {
      prev = cur;
    } else {
      pushRange(start, prev);
      start = cur;
      prev = cur;
    }
  }
  pushRange(start, prev);

  return parts.join(", ");
};

const getScheduleTimeIn = (item) =>
  pick(item, ["timeIn", "time_in", "startTime", "shiftStart", "start"], "-");

const getScheduleDuration = (item) => {
  const value = Number(pick(item, ["shiftDuration", "hours", "durationHours"], null));
  return Number.isFinite(value) ? value : null;
};

const getScheduleTimezone = (item) =>
  pick(item, ["timeRegion", "timezone", "tz", "scheduleTimezone"], "-");

const formatUtcIsoToHHMM = (utcIso, timeZone) => {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
};

const buildScheduleGroups = (scheduleArr = [], businessTimeZone = "America/Chicago") => {
  if (!Array.isArray(scheduleArr) || scheduleArr.length === 0) return [];

  const groupsMap = new Map();

  for (const item of scheduleArr) {
    const dayKey = normalizeDayKey(pick(item, ["dayOfWeek", "day", "weekday"], ""));
    if (!dayKey) continue;

    const utcTimeIn = pick(item, ["utcTimeIn", "utcStart", "startUtc", "utcTimeStart"], "");
    const utcTimeOut = pick(item, ["utcTimeOut", "utcEnd", "endUtc", "utcTimeEnd"], "");

    const convertedIn = utcTimeIn ? formatUtcIsoToHHMM(utcTimeIn, businessTimeZone) : "";
    const timeIn = convertedIn || getScheduleTimeIn(item);
    const duration = getScheduleDuration(item);
    const tz = String(businessTimeZone || "").trim() || getScheduleTimezone(item);

    const convertedOut = utcTimeOut ? formatUtcIsoToHHMM(utcTimeOut, businessTimeZone) : "";
    const { outHHMM, dayOffset } = convertedOut
      ? { outHHMM: convertedOut, dayOffset: 0 }
      : timeIn !== "-" && duration != null
        ? addHoursToHHMM(timeIn, duration)
        : { outHHMM: "-", dayOffset: 0 };

    const groupKey = JSON.stringify({
      timeIn,
      duration,
      timeOut: outHHMM,
      dayOffset,
      tz,
    });

    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, {
        key: groupKey,
        dayKeys: [],
        timeIn,
        duration,
        timeOut: outHHMM,
        dayOffset,
        tz,
      });
    }

    groupsMap.get(groupKey).dayKeys.push(dayKey);
  }

  const groups = Array.from(groupsMap.values()).map((group) => ({
    ...group,
    dayLabel: formatDayRanges(group.dayKeys),
  }));

  groups.sort((a, b) => {
    const aIdx = Math.min(...a.dayKeys.map((d) => DAY_KEYS.indexOf(d)).filter((n) => n >= 0));
    const bIdx = Math.min(...b.dayKeys.map((d) => DAY_KEYS.indexOf(d)).filter((n) => n >= 0));
    return aIdx - bIdx;
  });

  return groups;
};

export default function SchedulePage({
  employees = [],
  schedulesByUserId = {},
  errorsByUserId = {},
  businessTimeZone = "America/Chicago",
  loading = false,
  error = "",
  onReload,
}) {
  const [query, setQuery] = useState("");

  const validEmployees = (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e));
  const perUserErrorCount = Object.keys(errorsByUserId || {}).length;

  const rows = useMemo(() => {
    const out = [];

    for (const emp of validEmployees) {
      const userId = String(getUserId(emp));
      const name = getDisplayName(emp);
      const email = pick(emp || {}, ["email"], "");

      const scheduleArr = Array.isArray(schedulesByUserId?.[userId]) ? schedulesByUserId[userId] : [];
      const hasSchedule = scheduleArr.length > 0;
      const scheduleGroups = buildScheduleGroups(scheduleArr, businessTimeZone);

      out.push({
        key: userId,
        userId,
        name,
        email,
        hasSchedule,
        scheduleGroups,
        tz:
          scheduleGroups.length === 1
            ? scheduleGroups[0].tz
            : scheduleGroups.length > 1
              ? "Multiple"
              : "-",
        perUserError: errorsByUserId?.[userId] || "",
        raw: scheduleArr,
      });
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [validEmployees, schedulesByUserId, errorsByUserId, businessTimeZone]);

  const filtered = useMemo(() => {
    const q = safeLower(query).trim();
    if (!q) return rows;

    return rows.filter((r) => {
      const groupText = r.scheduleGroups
        .map((g) => `${g.dayLabel} ${g.timeIn} ${g.timeOut} ${g.duration ?? ""} ${g.tz}`)
        .join(" ");

      return (
        safeLower(r.name).includes(q) ||
        safeLower(r.email).includes(q) ||
        safeLower(r.userId).includes(q) ||
        safeLower(groupText).includes(q)
      );
    });
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
            {perUserErrorCount ? `  |  Errors: ${perUserErrorCount}` : ""}
          </div>
        </div>

        <div className="schxControls">
          <div className="schxField schxFieldSearch">
            <div className="schxLabel">Search</div>
            <input
              className="schxInput"
              placeholder="Search name / email / userId / days / time..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <button className="schxBtn" type="button" onClick={onReload} disabled={loading}>
            {loading ? "Loading..." : "Reload"}
          </button>

          <div className="schxPill">
            Rows: <span className="schxPillValue">{filtered.length}</span>
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
          <div className="schxCardMeta">
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
                  <td colSpan={6} className="schxTableEmpty">
                    No employees found (or userId not detected).
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="schxTableEmpty">
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
                      {!r.hasSchedule ? (
                        <span className="schxChip schxChipNoSched">No Schedule</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <span key={`${r.key}-days-${idx}`} className="schxChip">
                              {g.dayLabel}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxTime">-</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <span key={`${r.key}-in-${idx}`} className="schxTime">
                              {g.timeIn}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxTime">-</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <div key={`${r.key}-out-${idx}`} className="schxTimeWrap">
                              <span className="schxTime">{g.timeOut}</span>
                              {g.dayOffset > 0 && <span className="schxMiniPill">{`+${g.dayOffset}d`}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxChip schxChipGood">-</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <span key={`${r.key}-hrs-${idx}`} className="schxChip schxChipGood">
                              {g.duration == null ? "-" : `${g.duration}h`}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    <td>
                      {!r.hasSchedule ? (
                        <span className="schxChip schxChipTz">-</span>
                      ) : (
                        <div className="schxStack">
                          {r.scheduleGroups.map((g, idx) => (
                            <span key={`${r.key}-tz-${idx}`} className="schxChip schxChipTz">
                              {tzChip(g.tz)}
                            </span>
                          ))}
                        </div>
                      )}
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
            <div className="schxLoadingText">Fetching schedules...</div>
            <div className="schxLoadingSub">Users: {validEmployees.length}</div>
          </div>
        </div>
      )}
    </div>
  );
}



