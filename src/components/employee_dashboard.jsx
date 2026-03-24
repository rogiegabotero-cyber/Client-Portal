import React, { useEffect, useMemo, useRef, useState } from "react";
import "./employee_dashboard.css";
import { startBreak, endBreak, DAILY_BREAK_LIMIT_MINUTES } from "../services/breakService";
import ConfirmModal from "./ConfirmModal";
import {
  resolveScheduledDurationMinutes,
  resolveScheduledEndUtcMsForDayKey,
  resolveScheduledStartUtcMsForDayKey,
} from "../utils/scheduleTime";

/* ----------------------------- helpers ----------------------------- */
const pick = (obj, keys, fallback = "") => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).length) return v;
  }
  return fallback;
};
const toText = (value) => String(value || "").trim();
const buildFallbackHeadline = (text) => {
  const raw = toText(text);
  if (!raw) return "Announcement";
  return raw.length > 64 ? `${raw.slice(0, 64)}...` : raw;
};

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
  `User ${String(getUserId(emp) ?? "")}`.trim();

const pickTs = (log) => pick(log, ["timestamp", "createdAt", "time"], "");

const tsMs = (ts) => {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const toMillis = (value) => {
  if (value == null) return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : NaN;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const getPartsInTimeZone = (dateLike, timeZone) => {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(d);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
  };
};

const dayKeyFromTsInZone = (ts, timeZone) => {
  const parts = getPartsInTimeZone(ts, timeZone);
  if (!parts) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const monthKeyFromMsInZone = (ms, timeZone) => {
  const parts = getPartsInTimeZone(ms, timeZone);
  if (!parts) return "";
  return `${parts.year}-${parts.month}`;
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

const getScheduleTimeIn = (item) =>
  pick(item, ["timeIn", "time_in", "startTime", "shiftStart", "start"], "-");

const getScheduleDurationHours = (item) => {
  const value = Number(pick(item, ["shiftDuration", "hours", "durationHours"], null));
  return Number.isFinite(value) ? value : null;
};

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

export default function EmployeeDashboard({
  employees = [],
  announcements = [],
  schedulesByUserId = {},
  logsByUserId = {},
  onFetchFullHistory,
  historyByUserId = {},
  loadingHistoryByUserId = {},
  historyErrorByUserId = {},
  nowMs,
  endDate,
  businessTimeZone = "America/Chicago",
  selectedEmployeeId,
  onSelectEmployeeId,
  activeBreaksByUserId = {},
  breakUsageByUserId = {},
  onBreakStatusChanged,
  pageData = null,
}) {
  const requestedHistoryRef = useRef(new Set());

  const employeeIds = useMemo(
    () =>
      (Array.isArray(employees) ? employees : [])
        .map((e) => String(getUserId(e) ?? ""))
        .filter(Boolean),
    [employees]
  );

  const [localSelectedId, setLocalSelectedId] = useState("");
  const [breakLoading, setBreakLoading] = useState(false);
  const [breakError, setBreakError] = useState("");
  const [breakConfirmAction, setBreakConfirmAction] = useState("");
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const [selectedAnnouncement, setSelectedAnnouncement] = useState(null);

  const effectiveSelectedId = useMemo(() => {
    const fromParent = String(selectedEmployeeId || "");
    if (fromParent) return fromParent;
    if (localSelectedId) return localSelectedId;
    return employeeIds[0] || "";
  }, [selectedEmployeeId, localSelectedId, employeeIds]);

  const setSelected = (id) => {
    const nextId = String(id || "");
    if (typeof onSelectEmployeeId === "function") onSelectEmployeeId(nextId);
    else setLocalSelectedId(nextId);
  };

  const employee = useMemo(
    () =>
      (Array.isArray(employees) ? employees : []).find(
        (e) => String(getUserId(e) ?? "") === String(effectiveSelectedId)
      ) || null,
    [employees, effectiveSelectedId]
  );

  const announcementRows = useMemo(() => {
    if (Array.isArray(announcements) && announcements.length) return announcements;
    if (Array.isArray(pageData?.announcements)) return pageData.announcements;
    return Array.isArray(announcements) ? announcements : [];
  }, [announcements, pageData]);

  useEffect(() => {
    const uid = String(effectiveSelectedId || "");
    if (!uid || !onFetchFullHistory) return;

    const existing = Array.isArray(historyByUserId?.[uid]) && historyByUserId[uid].length > 0;
    const loading = !!loadingHistoryByUserId?.[uid];

    if (existing || loading || requestedHistoryRef.current.has(uid)) return;

    requestedHistoryRef.current.add(uid);
    Promise.resolve(onFetchFullHistory(uid)).catch(() => {
      requestedHistoryRef.current.delete(uid);
    });
  }, [effectiveSelectedId, onFetchFullHistory, historyByUserId, loadingHistoryByUserId]);

  const todaySchedule = useMemo(() => {
    const sched = schedulesByUserId?.[String(effectiveSelectedId)];
    if (!Array.isArray(sched) || sched.length === 0) return null;

    const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    const weekdayNameFromYmd = (yyyyMmDd) => {
      const d = new Date(`${yyyyMmDd}T12:00:00Z`);
      if (Number.isNaN(d.getTime())) return null;
      return WEEKDAYS[d.getUTCDay()];
    };

    const targetWeekday = weekdayNameFromYmd(endDate);
    if (!targetWeekday) return null;

    const todayItem =
      sched.find(
        (s) =>
          String(pick(s, ["dayOfWeek", "day", "weekday"], "")).toLowerCase() === targetWeekday
      ) || null;

    if (!todayItem) return null;

    const utcTimeIn = pick(todayItem, ["utcTimeIn", "utcStart", "startUtc", "utcTimeStart"], "");
    const utcTimeOut = pick(todayItem, ["utcTimeOut", "utcEnd", "endUtc", "utcTimeEnd"], "");
    const convertedIn = utcTimeIn ? formatUtcIsoToHHMM(utcTimeIn, businessTimeZone) : "";
    const timeIn = convertedIn || getScheduleTimeIn(todayItem);
    const durationHours = getScheduleDurationHours(todayItem);
    const convertedOut = utcTimeOut ? formatUtcIsoToHHMM(utcTimeOut, businessTimeZone) : "";
    const { outHHMM } = convertedOut
      ? { outHHMM: convertedOut, dayOffset: 0 }
      : timeIn !== "-" && durationHours != null
        ? addHoursToHHMM(timeIn, durationHours)
        : { outHHMM: "-", dayOffset: 0 };

    const startMs = resolveScheduledStartUtcMsForDayKey(todayItem, endDate);
    const endMs = resolveScheduledEndUtcMsForDayKey(todayItem, endDate);
    const durationMinutes =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? Math.round((endMs - startMs) / 60000)
        : resolveScheduledDurationMinutes(todayItem, 600);

    return {
      raw: todayItem,
      dayLabel: new Date(`${endDate}T12:00:00Z`).toLocaleDateString(undefined, {
        weekday: "long",
        timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
      }),
      startTimeLabel: timeIn || "-",
      endTimeLabel: outHHMM || "-",
      durationLabel: durationHours == null ? "-" : `${durationHours}h`,
      durationMinutes,
      startMs,
      endMs,
      isActive: true,
    };
  }, [schedulesByUserId, effectiveSelectedId, endDate, businessTimeZone]);

  const logsToday = useMemo(
    () => logsByUserId?.[String(effectiveSelectedId)] || [],
    [logsByUserId, effectiveSelectedId]
  );

  const historyLogs = useMemo(() => {
    if (!effectiveSelectedId) return [];
    const arr = historyByUserId?.[String(effectiveSelectedId)];
    return Array.isArray(arr) ? arr : [];
  }, [historyByUserId, effectiveSelectedId]);

  const hasHistory = historyLogs.length > 0;

  const monthlyAttendance = useMemo(() => {
    const monthKey = monthKeyFromMsInZone(nowMs, businessTimeZone);
    if (!monthKey) return 0;

    const src = hasHistory ? historyLogs : logsToday;
    const days = new Set();

    for (const log of Array.isArray(src) ? src : []) {
      const ts = pickTs(log);
      const t = tsMs(ts);
      if (!Number.isFinite(t)) continue;

      const dk = dayKeyFromTsInZone(ts, businessTimeZone);
      if (!dk) continue;

      if (dk.slice(0, 7) === monthKey) days.add(dk);
    }

    return days.size;
  }, [nowMs, hasHistory, historyLogs, logsToday, businessTimeZone]);

  const isOnBreak = !!activeBreaksByUserId?.[String(effectiveSelectedId)];
  const activeBreak = activeBreaksByUserId?.[String(effectiveSelectedId)] || null;
  const breakUsage = breakUsageByUserId?.[String(effectiveSelectedId)] || {
    totalMinutes: 0,
    activeBreakMinutes: 0,
    remainingMinutes: DAILY_BREAK_LIMIT_MINUTES,
  };

  useEffect(() => {
    if (!Number.isFinite(nowMs)) return;
    setLiveNowMs(nowMs);
  }, [nowMs]);

  useEffect(() => {
    const id = setInterval(() => setLiveNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const breakLimitMinutes = DAILY_BREAK_LIMIT_MINUTES;
  const savedTotalMinutes = Math.max(0, Number(breakUsage.totalMinutes || 0));
  const savedActiveMinutes = Math.max(0, Number(breakUsage.activeBreakMinutes || 0));
  const activeBreakStartMs = toMillis(activeBreak?.startedAt);
  const baseUsedMinutes = Math.max(0, savedTotalMinutes - savedActiveMinutes);

  const liveActiveMinutes =
    isOnBreak && Number.isFinite(activeBreakStartMs)
      ? Math.max(0, (liveNowMs - activeBreakStartMs) / 60000)
      : savedActiveMinutes;

  const effectiveUsedMinutes = Math.min(
    breakLimitMinutes,
    isOnBreak ? baseUsedMinutes + liveActiveMinutes : savedTotalMinutes
  );
  const breakMinutesActive = isOnBreak ? liveActiveMinutes : 0;
  const breakMinutesLeft = Math.max(0, breakLimitMinutes - effectiveUsedMinutes);
  const breakRemainingPct = Math.min(
    100,
    Math.max(0, (breakMinutesLeft / Math.max(1, breakLimitMinutes)) * 100)
  );
  const breakProgressPercent = Math.round(breakRemainingPct);
  let breakProgressVariant = "good";
  if (breakMinutesLeft <= 10) breakProgressVariant = "danger";
  else if (breakMinutesLeft <= 20) breakProgressVariant = "warning";
  else if (breakMinutesLeft <= 35) breakProgressVariant = "caution";

  const breakLeftLabel = isOnBreak ? breakMinutesLeft.toFixed(1) : String(Math.round(breakMinutesLeft));
  const breakUsedLabel = isOnBreak
    ? effectiveUsedMinutes.toFixed(1)
    : String(Math.round(effectiveUsedMinutes));
  const breakConfirmClockLabel = new Date(
    Number.isFinite(liveNowMs) ? liveNowMs : Date.now()
  ).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const canStartBreak = !isOnBreak && breakMinutesLeft > 0;

  async function handleBreakToggle() {
    if (!employee) return;

    setBreakLoading(true);
    setBreakError("");

    try {
      const userId = String(getUserId(employee) ?? "");
      const name = employee?.name || employee?.fullName || employee?.displayName || "";
      const email = employee?.email || "";

      if (!userId) {
        throw new Error("Employee ID not found");
      }

      if (isOnBreak) {
        await endBreak(userId);
      } else {
        if (breakMinutesLeft <= 0) {
          throw new Error("You already used the full 60-minute break allowance for today");
        }
        await startBreak({ userId, name, email });
      }

      if (typeof onBreakStatusChanged === "function") {
        await onBreakStatusChanged();
      }
    } catch (err) {
      setBreakError(err?.message || "Failed to update break");
    } finally {
      setBreakLoading(false);
    }
  }


  const requestBreakToggle = () => {
    if (!employee) return;
    if (breakLoading) return;
    if (!isOnBreak && !canStartBreak) return;
    setBreakError("");
    setBreakConfirmAction(isOnBreak ? "end" : "start");
  };

  const cancelBreakConfirm = () => {
    if (breakLoading) return;
    setBreakConfirmAction("");
  };

  const confirmBreakToggle = async () => {
    await handleBreakToggle();
    setBreakConfirmAction("");
  };

  const visitorAnnouncements = useMemo(() => {
    const rows = Array.isArray(announcementRows) ? announcementRows : [];
    const nowForWindowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const notes = rows
      .map((item) => {
        const text = toText(
          pick(item, ["note", "announcement", "announcementNote", "message", "text"], "")
        );
        if (!text) return null;
        const headline = toText(pick(item, ["headline", "title", "subject"], "")) || buildFallbackHeadline(text);

        const createdAtMs = toMillis(item?.createdAt);
        const publishAtMs = toMillis(item?.publishAt);
        const expiresAtMs = toMillis(item?.expiresAt);
        const deletedAtMs = toMillis(item?.deletedAt);

        if (Number.isFinite(deletedAtMs)) return null;
        if (Number.isFinite(publishAtMs) && nowForWindowMs < publishAtMs) return null;
        if (Number.isFinite(expiresAtMs) && nowForWindowMs > expiresAtMs) return null;

        return {
          id: toText(item?.id) || `${text}-${toText(item?.createdByUserId)}-${createdAtMs}`,
          headline,
          text,
          createdBy: toText(item?.createdByName) || "Announcement",
          createdAtMs,
        };
      })
      .filter(Boolean);

    notes.sort((a, b) => {
      const aMs = Number.isFinite(a.createdAtMs) ? a.createdAtMs : 0;
      const bMs = Number.isFinite(b.createdAtMs) ? b.createdAtMs : 0;
      return bMs - aMs;
    });

    return notes.slice(0, 6);
  }, [announcementRows, nowMs]);

  const formatAnnouncementDate = (ms) => {
    if (!Number.isFinite(ms)) return "Recent";
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
    });
  };

  const stats = useMemo(() => {
    let early = 0;
    let ontime = 0;
    let late = 0;

    for (const l of Array.isArray(logsToday) ? logsToday : []) {
      const t = String(l.type || "").toLowerCase();
      const status = String(l.status || "").toLowerCase();

      if (t.includes("in")) {
        if (status.includes("early")) early++;
        else if (status.includes("late")) late++;
        else ontime++;
      }
    }

    return {
      monthlyAttendance,
      earlyCheckins: early,
      onTimeCheckins: ontime,
      lateCheckins: late,
    };
  }, [logsToday, monthlyAttendance]);

  const now = new Date(Number.isFinite(liveNowMs) ? liveNowMs : nowMs);
  const greetingText = useMemo(() => {
    const parts = getPartsInTimeZone(
      Number.isFinite(liveNowMs) ? liveNowMs : nowMs,
      businessTimeZone
    );
    const hour = Number(parts?.hour);

    if (!Number.isFinite(hour)) return "Hello";
    if (hour < 12) return "Good Morning";
    if (hour < 18) return "Good Afternoon";
    return "Good Evening";
  }, [liveNowMs, nowMs, businessTimeZone]);
  const historyLoading = !!loadingHistoryByUserId?.[String(effectiveSelectedId)];
  const historyError = historyErrorByUserId?.[String(effectiveSelectedId)] || "";
  const closeAnnouncementModal = () => setSelectedAnnouncement(null);

  return (
    <div className="empDash">
      {!employee ? (
        <div>No employee selected</div>
      ) : (
        <>
          <div className="empDashTop">
            <h2 className="empDashTitle">Dashboard</h2>

            <div>
              <select
                className="employee-select"
                value={String(effectiveSelectedId)}
                onChange={(e) => setSelected(e.target.value)}
              >
                {employees.map((emp) => {
                  const id = String(getUserId(emp) ?? "");
                  if (!id) return null;

                  return (
                    <option key={id} value={id}>
                      {getDisplayName(emp)}
                    </option>
                  );
                })}
              </select>

              {historyLoading ? (
                <div className="empHistoryGhost">Loading full history...</div>
              ) : historyError ? (
                <div>{historyError}</div>
              ) : null}
            </div>
          </div>

          <div className="empPanel">
            <div className="empPanelHead">
              <div className="empPanelHeadLeft">
                <span>Today's Schedule</span>
              </div>
              <div className="empDatePill">
                {now.toLocaleDateString(undefined, {
                  timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
                })}
              </div>
            </div>

            <div className="empPanelBody">
              <div className="empGrid2">
                <div className="scheduleCard">
                  <div className="scheduleTopRow">
                    <div className="scheduleDay">{todaySchedule?.dayLabel || "Today"}</div>
                    <div className={`statusPill ${todaySchedule ? "active" : ""}`}>
                      {todaySchedule ? "Active" : "No Schedule"}
                    </div>
                  </div>

                  <div className="scheduleBoxes">
                    <div className="miniBox">
                      <div className="miniLabel">Start</div>
                      <div className="miniValue">{todaySchedule?.startTimeLabel || "-"}</div>
                    </div>

                    <div className="miniBox">
                      <div className="miniLabel">Duration</div>
                      <div className="miniValue">{todaySchedule?.durationLabel || "-"}</div>
                    </div>

                    <div className="miniBox">
                      <div className="miniLabel">End</div>
                      <div className="miniValue">{todaySchedule?.endTimeLabel || "-"}</div>
                    </div>
                  </div>

                  <div className="progressCard">
                    <div className="progressHead">
                      <span>Break Time Left</span>
                      <span>{Math.round(breakRemainingPct)}%</span>
                    </div>

                    <progress
                      className={`progressBar progressBar-${breakProgressVariant}`}
                      max={100}
                      value={breakProgressPercent}
                    />

                    <div className="progressMetaRow">
                      <span>Remaining</span>
                      <span>{breakLeftLabel} min</span>
                    </div>

                    <div className="progressMetaRow">
                      <span>Used</span>
                      <span>
                        {breakUsedLabel} / {breakLimitMinutes} min
                      </span>
                    </div>

                    {breakMinutesLeft <= 0 ? (
                      <div className="breakNotice breakNotice-danger">
                        No Breaks Remaining.
                      </div>
                    ) : breakMinutesLeft <= 15 ? (
                      <div className={`breakNotice breakNotice-${breakProgressVariant}`}>
                        Break time is running low.
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="empSideColumn">
                  <div className="clockedCard">
                    <div className="clockedInner">
                      <div className="clockedTitle">
                        {isOnBreak ? "Currently On Break" : "Currently Clocked In"}
                      </div>
                      <div className="clockedTimeValue">
                        {now.toLocaleTimeString(undefined, {
                          timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
                        })}
                      </div>
                    </div>

                    {isOnBreak ? (
                      <div className="infoPillRow">
                        <div className="infoPill">
                          <span>Current Break</span>
                          <span>{breakMinutesActive.toFixed(1)} min</span>
                        </div>
                      </div>
                    ) : null}

                    {breakError ? (
                      <div className="breakError">
                        {breakError}
                      </div>
                    ) : null}

                    {!isOnBreak && breakMinutesLeft <= 0 ? (
                      <div className="breakLimitWarning">
                        Daily break limit reached ({DAILY_BREAK_LIMIT_MINUTES} minutes).
                      </div>
                    ) : null}

                    <button
                      className={`breakBtn ${isOnBreak ? "back" : "break"}`}
                      onClick={requestBreakToggle}
                      disabled={breakLoading || (!isOnBreak && !canStartBreak)}
                    >
                      {breakLoading ? "Please wait..." : isOnBreak ? "BACK" : "BREAK"}
                    </button>
                  </div>

                  <div className="announcementCard">
                    <div className="announcementHead">
                      <span>Announcements</span>
                      <span className="announcementCount">{visitorAnnouncements.length}</span>
                    </div>

                    <div className="announcementBody">
                      {visitorAnnouncements.length ? (
                        visitorAnnouncements.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            className="announcementItem"
                            onClick={() => setSelectedAnnouncement(item)}
                          >
                            <div className="announcementMeta">
                              <span className="announcementAuthor">{item.createdBy}</span>
                              <span>{formatAnnouncementDate(item.createdAtMs)}</span>
                            </div>
                            <div className="announcementHeadline">{item.headline}</div>
                          </button>
                        ))
                      ) : (
                        <div className="announcementEmpty">
                          No announcements yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="greetingPanel">
            <div className="greetingTitle">{greetingText}, {employee.name || employee.email}</div>

            <div className="greetingSub">
              {now.toLocaleDateString(undefined, {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
              })}{" "}
              at{" "}
              {now.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: String(businessTimeZone || "").trim() || "America/Chicago",
              })}
            </div>

            <div className="statsRow">
              <StatCard value={stats.monthlyAttendance} label="Monthly Attendance" />
              <StatCard value={stats.earlyCheckins} label="Early Check-ins" />
              <StatCard value={stats.onTimeCheckins} label="On-Time Check-ins" />
              <StatCard value={stats.lateCheckins} label="Late Check-ins" />
            </div>
          </div>

          {selectedAnnouncement ? (
            <div className="announcementModalOverlay" onClick={closeAnnouncementModal}>
              <div
                className="announcementModalCard"
                role="dialog"
                aria-modal="true"
                aria-label="Announcement details"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="announcementModalHead">
                  <div>
                    <div className="announcementModalTitle">
                      {selectedAnnouncement.headline || "Announcement"}
                    </div>
                    <div className="announcementModalMeta">
                      <span>{selectedAnnouncement.createdBy}</span>
                      <span>{formatAnnouncementDate(selectedAnnouncement.createdAtMs)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="announcementModalClose"
                    onClick={closeAnnouncementModal}
                    aria-label="Close announcement"
                  >
                    x
                  </button>
                </div>

                <div className="announcementModalBody">
                  {selectedAnnouncement.text || "No announcement content."}
                </div>
              </div>
            </div>
          ) : null}

          <ConfirmModal
            open={!!breakConfirmAction}
            title={breakConfirmAction === "end" ? "End Break?" : "Start Break?"}
            message={
              breakConfirmAction === "end"
                ? "This will record your break end time. Continue?"
                : "This will record your break start time. Continue?"
            }
            meta={`Current device time: ${breakConfirmClockLabel}`}
            confirmText={breakConfirmAction === "end" ? "End Break" : "Start Break"}
            tone="primary"
            busy={breakLoading}
            onCancel={cancelBreakConfirm}
            onConfirm={confirmBreakToggle}
          />
        </>
      )}
    </div>
  );
}

function StatCard({ value, label }) {
  return (
    <div className="statCard">
      <div className="statValue">{value}</div>
      <div className="statLabel">{label}</div>
    </div>
  );
}



