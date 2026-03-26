import {
  collection,
  addDoc,
  updateDoc,
  getDocs,
  serverTimestamp,
  Timestamp,
  doc,
} from "firebase/firestore";
import { db } from "../firebase";
import { getBusinessDayKey } from "../utils/attendanceDate";
import { toMillis } from "../utils/common";
import { buildTimeZoneMeta, resolveStorageTimeZone } from "../utils/timeZoneMeta";

export const DAILY_BREAK_LIMIT_MINUTES = 60;
export const BREAK_REMINDER_MINUTES = 55;
export const OVERBREAK_GRACE_MINUTES = 5;
export const OVERBREAK_TRIGGER_MINUTES =
  DAILY_BREAK_LIMIT_MINUTES + OVERBREAK_GRACE_MINUTES;

const BREAK_LOGS_COLLECTION = "break_logs";
const BREAK_NOTIFICATIONS_COLLECTION = "break_notifications";
const OVERBREAK_NOTES_COLLECTION = "over_break_notes";

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === "function") return value.toDate();

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const minutesBetween = (startValue, endValue) => {
  const startMs = toMillis(startValue);
  const endMs = toMillis(endValue);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }

  return Math.max(0, Math.round((endMs - startMs) / 60000));
};

const formatDurationLabel = (mins) => {
  const total = Math.max(0, Math.round(Number(mins) || 0));
  const hrs = Math.floor(total / 60);
  const rem = total % 60;

  if (hrs && rem) return `${hrs}h ${rem}m`;
  if (hrs) return `${hrs}h`;
  return `${rem}m`;
};

const startOfLocalDay = (baseDate = new Date()) => {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfLocalDay = (baseDate = new Date()) => {
  const d = new Date(baseDate);
  d.setHours(23, 59, 59, 999);
  return d;
};

const normalizeYmd = (value) => {
  const str = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = toDate(value);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

async function findExistingOverBreakByBreakLogId(breakLogId) {
  if (!breakLogId) return null;

  const snap = await getDocs(collection(db, OVERBREAK_NOTES_COLLECTION));
  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  return rows.find((row) => String(row?.breakLogId || "") === String(breakLogId)) || null;
}

async function findExistingNotificationByBreakLogIdAndType(breakLogId, type) {
  if (!breakLogId || !type) return null;

  const snap = await getDocs(collection(db, BREAK_NOTIFICATIONS_COLLECTION));
  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  return (
    rows.find(
      (row) =>
        String(row?.breakLogId || "") === String(breakLogId) &&
        String(row?.type || "") === String(type)
    ) || null
  );
}

async function createNotification({
  userId = "",
  audience = "employee",
  role = "",
  name = "",
  email = "",
  breakLogId = "",
  overBreakId = "",
  type = "",
  title = "",
  message = "",
  minutesUsed = 0,
  minutesRemaining = 0,
  totalBreakMinutes = 0,
  overBreakMinutes = 0,
}) {
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  const ref = await addDoc(collection(db, BREAK_NOTIFICATIONS_COLLECTION), {
    userId: String(userId || "").trim(),
    audience,
    role,
    name,
    email,
    breakLogId,
    overBreakId,
    type,
    title,
    message,
    minutesUsed,
    minutesRemaining,
    totalBreakMinutes,
    overBreakMinutes,
    read: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  return ref.id;
}

async function createOrUpdateOverBreakNote({
  activeBreak,
  userId,
  name = "",
  email = "",
  endedAt = null,
}) {
  if (!activeBreak?.id) {
    return { created: false, reason: "missing-break-id" };
  }

  const uid = String(userId || activeBreak?.userId || "").trim();
  if (!uid) {
    return { created: false, reason: "missing-user-id" };
  }

  const now = endedAt ? new Date(endedAt) : new Date();
  const endedAtDate = endedAt ? new Date(endedAt) : null;
  const storageTimeZone = resolveStorageTimeZone();
  const totalBreakMinutes = minutesBetween(activeBreak.startedAt, now);

  if (totalBreakMinutes < OVERBREAK_TRIGGER_MINUTES) {
    return {
      created: false,
      reason: "not-overbreak-yet",
      totalBreakMinutes,
    };
  }

  const startedAtMs = toMillis(activeBreak.startedAt);
  const overBreakStartedAt = Number.isFinite(startedAtMs)
    ? new Date(startedAtMs + OVERBREAK_TRIGGER_MINUTES * 60 * 1000)
    : now;

  const overBreakMinutes = Math.max(0, totalBreakMinutes - OVERBREAK_TRIGGER_MINUTES);

  const existing = await findExistingOverBreakByBreakLogId(activeBreak.id);

  const payload = {
    userId: uid,
    name: name || activeBreak?.name || "",
    email: email || activeBreak?.email || "",
    breakLogId: activeBreak.id,
    startedAt: activeBreak.startedAt || null,
    endedAt: endedAtDate ? Timestamp.fromDate(endedAtDate) : activeBreak?.endedAt || null,
    overBreakStartedAt: Timestamp.fromDate(overBreakStartedAt),
    totalBreakMinutes,
    overBreakMinutes,
    overBreakDurationLabel: formatDurationLabel(overBreakMinutes),
    graceMinutes: OVERBREAK_GRACE_MINUTES,
    limitMinutes: DAILY_BREAK_LIMIT_MINUTES,
    triggerMinutes: OVERBREAK_TRIGGER_MINUTES,
    note: `Agent exceeded break limit. Over-break counted after ${OVERBREAK_GRACE_MINUTES} minutes grace. Current over-break: ${formatDurationLabel(
      overBreakMinutes
    )}. Total break: ${formatDurationLabel(totalBreakMinutes)}.`,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("startedAtClient", activeBreak.startedAt, storageTimeZone),
    ...(endedAtDate
      ? buildTimeZoneMeta("endedAtClient", endedAtDate, storageTimeZone)
      : {}),
    ...buildTimeZoneMeta("overBreakStartedAtClient", overBreakStartedAt, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  };

  if (existing?.id) {
    await updateDoc(doc(db, OVERBREAK_NOTES_COLLECTION, existing.id), payload);

    return {
      created: false,
      updated: true,
      id: existing.id,
      totalBreakMinutes,
      overBreakMinutes,
      overBreakStartedAt,
    };
  }

  const ref = await addDoc(collection(db, OVERBREAK_NOTES_COLLECTION), {
    ...payload,
    createdAt: serverTimestamp(),
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
  });

  return {
    created: true,
    updated: false,
    id: ref.id,
    totalBreakMinutes,
    overBreakMinutes,
    overBreakStartedAt,
  };
}

export async function startBreak({ userId, name = "", email = "" }) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId is required");

  const existing = await getActiveBreakForUser(uid);
  if (existing) {
    throw new Error("User already has an active break");
  }

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  const ref = await addDoc(collection(db, BREAK_LOGS_COLLECTION), {
    userId: uid,
    name,
    email,
    startedAt: Timestamp.fromDate(now),
    endedAt: null,
    isActive: true,
    reminderSent: false,
    reminderSentAt: null,
    overBreakSaved: false,
    overBreakSavedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("startedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  return {
    id: ref.id,
    userId: uid,
    name,
    email,
    startedAt: now,
    isActive: true,
    reminderSent: false,
    overBreakSaved: false,
  };
}

export async function endBreak(userId) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId is required");

  const activeBreak = await getActiveBreakForUser(uid);
  if (!activeBreak) {
    throw new Error("No active break found");
  }

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  const totalBreakMinutes = minutesBetween(activeBreak.startedAt, now);
  const overBreakMinutes = Math.max(0, totalBreakMinutes - OVERBREAK_TRIGGER_MINUTES);

  const breakRef = doc(db, BREAK_LOGS_COLLECTION, activeBreak.id);

  let overBreakRecord = null;

  if (totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES) {
    overBreakRecord = await createOrUpdateOverBreakNote({
      activeBreak,
      userId: uid,
      name: activeBreak?.name || "",
      email: activeBreak?.email || "",
      endedAt: now,
    });
  }

  await updateDoc(breakRef, {
    endedAt: Timestamp.fromDate(now),
    isActive: false,
    totalBreakMinutes,
    overBreakSaved: totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES,
    overBreakSavedAt:
      totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES
        ? Timestamp.fromDate(now)
        : activeBreak?.overBreakSavedAt || null,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("endedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    ...(totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES
      ? buildTimeZoneMeta("overBreakSavedAtClient", now, storageTimeZone)
      : {}),
  });

  return {
    id: activeBreak.id,
    userId: uid,
    endedAt: now,
    totalBreakMinutes,
    overBreakMinutes,
    overBreakRecord,
  };
}

export async function getActiveBreakForUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return null;

  const snap = await getDocs(collection(db, BREAK_LOGS_COLLECTION));
  const rows = snap.docs
    .map((row) => ({
      id: row.id,
      ...row.data(),
    }))
    .filter((row) => String(row?.userId || "") === uid && !!row?.isActive);

  rows.sort((a, b) => toMillis(b.startedAt) - toMillis(a.startedAt));
  return rows[0] || null;
}

export async function getActiveBreaks() {
  const snap = await getDocs(collection(db, BREAK_LOGS_COLLECTION));

  const rows = snap.docs
    .map((d) => ({
      id: d.id,
      ...d.data(),
    }))
    .filter((row) => !!row?.isActive);

  rows.sort((a, b) => toMillis(b.startedAt) - toMillis(a.startedAt));
  return rows;
}

export async function getBreakLogsForUserOnDate(userId, date = new Date()) {
  const uid = String(userId || "").trim();
  if (!uid) return [];

  const start = startOfLocalDay(date).getTime();
  const end = endOfLocalDay(date).getTime();

  const snap = await getDocs(collection(db, BREAK_LOGS_COLLECTION));

  const rows = snap.docs
    .map((d) => ({
      id: d.id,
      ...d.data(),
    }))
    .filter((row) => {
      if (String(row?.userId || "") !== uid) return false;
      const startedMs = toMillis(row?.startedAt);
      return Number.isFinite(startedMs) && startedMs >= start && startedMs <= end;
    });

  rows.sort((a, b) => toMillis(b.startedAt) - toMillis(a.startedAt));
  return rows;
}

export async function getBreakLogsByUserIdsInRange(
  userIds = [],
  {
    startDayKey = "",
    endDayKey = "",
    attendanceResetTime = "05:00",
    businessTimeZone = "America/Chicago",
  } = {}
) {
  const normalizedIds = Array.from(
    new Set((Array.isArray(userIds) ? userIds : []).map((v) => String(v || "").trim()).filter(Boolean))
  );
  if (!normalizedIds.length) return {};

  const start = normalizeYmd(startDayKey);
  const end = normalizeYmd(endDayKey);
  const includeAll = !start || !end;
  const allowedIds = new Set(normalizedIds);

  const snap = await getDocs(collection(db, BREAK_LOGS_COLLECTION));

  const out = normalizedIds.reduce((acc, uid) => {
    acc[uid] = [];
    return acc;
  }, {});

  for (const d of snap.docs) {
    const row = { id: d.id, ...d.data() };
    const uid = String(row?.userId || "").trim();
    if (!allowedIds.has(uid)) continue;

    const startedMs = toMillis(row?.startedAt ?? row?.createdAt);
    if (!Number.isFinite(startedMs)) continue;

    const dayKey = getBusinessDayKey(startedMs, attendanceResetTime, businessTimeZone);
    if (!includeAll) {
      if (!dayKey || dayKey < start || dayKey > end) continue;
    }

    out[uid].push(row);
  }

  for (const uid of normalizedIds) {
    out[uid].sort((a, b) => toMillis(b.startedAt) - toMillis(a.startedAt));
  }

  return out;
}

export function calculateBreakUsageMinutes(logs, nowMs = Date.now()) {
  const rows = Array.isArray(logs) ? logs : [];

  let totalMinutes = 0;
  let activeBreakMinutes = 0;

  for (const row of rows) {
    const startMs = toMillis(row?.startedAt);
    if (!Number.isFinite(startMs)) continue;

    const endMs = row?.endedAt ? toMillis(row.endedAt) : nowMs;
    if (!Number.isFinite(endMs) || endMs < startMs) continue;

    const mins = Math.max(0, Math.round((endMs - startMs) / 60000));
    totalMinutes += mins;

    if (!row?.endedAt || row?.isActive) {
      activeBreakMinutes += mins;
    }
  }

  return {
    totalMinutes,
    activeBreakMinutes,
    remainingMinutes: Math.max(0, DAILY_BREAK_LIMIT_MINUTES - totalMinutes),
  };
}

export async function ensureBreakReminder({
  userId,
  name = "",
  email = "",
  activeBreak,
}) {
  const uid = String(userId || "").trim();
  if (!uid) return { created: false, reason: "missing-user" };
  if (!activeBreak?.id) return { created: false, reason: "missing-break" };
  if (activeBreak?.reminderSent) return { created: false, reason: "already-sent" };

  const now = new Date();
  const totalBreakMinutes = minutesBetween(activeBreak.startedAt, now);
  const storageTimeZone = resolveStorageTimeZone();

  if (totalBreakMinutes < BREAK_REMINDER_MINUTES) {
    return { created: false, reason: "too-early" };
  }

  const notificationMessage =
    "You are close to exceeding your 1-hour break. Please click BACK to avoid an over-break record.";

  const notificationId = await createNotification({
    userId: uid,
    audience: "employee",
    role: "employee",
    name,
    email,
    breakLogId: activeBreak.id,
    type: "break_warning",
    title: "Break reminder",
    message: notificationMessage,
    minutesUsed: totalBreakMinutes,
    minutesRemaining: Math.max(0, OVERBREAK_TRIGGER_MINUTES - totalBreakMinutes),
    totalBreakMinutes,
    overBreakMinutes: 0,
  });

  await updateDoc(doc(db, BREAK_LOGS_COLLECTION, activeBreak.id), {
    reminderSent: true,
    reminderSentAt: Timestamp.fromDate(now),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("reminderSentAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  return {
    created: true,
    id: notificationId,
    message: notificationMessage,
    totalBreakMinutes,
  };
}

export async function ensureOverBreakEscalation({
  userId,
  name = "",
  email = "",
  activeBreak,
}) {
  const uid = String(userId || "").trim();
  if (!uid) return { created: false, reason: "missing-user" };
  if (!activeBreak?.id) return { created: false, reason: "missing-break" };
  if (activeBreak?.overBreakSaved) return { created: false, reason: "already-saved" };

  const totalBreakMinutes = minutesBetween(activeBreak.startedAt, new Date());

  if (totalBreakMinutes < OVERBREAK_TRIGGER_MINUTES) {
    return {
      created: false,
      reason: "grace-period-not-finished",
      totalBreakMinutes,
    };
  }

  const result = await createOrUpdateOverBreakNote({
    activeBreak,
    userId: uid,
    name,
    email,
    endedAt: null,
  });

  const existingAdminNotif = await findExistingNotificationByBreakLogIdAndType(
    activeBreak.id,
    "over_break_admin"
  );

  if (!existingAdminNotif) {
    await createNotification({
      userId: "admin",
      audience: "admin",
      role: "super_admin",
      name,
      email,
      breakLogId: activeBreak.id,
      overBreakId: result?.id || "",
      type: "over_break_admin",
      title: "Over-break alert",
      message: `${name || email || uid} exceeded break limit. Current total break: ${formatDurationLabel(
        totalBreakMinutes
      )}.`,
      minutesUsed: totalBreakMinutes,
      minutesRemaining: 0,
      totalBreakMinutes,
      overBreakMinutes: Math.max(0, totalBreakMinutes - OVERBREAK_TRIGGER_MINUTES),
    });
  }

  const existingEmployeeNotif = await findExistingNotificationByBreakLogIdAndType(
    activeBreak.id,
    "over_break_employee"
  );

  if (!existingEmployeeNotif) {
    await createNotification({
      userId: uid,
      audience: "employee",
      role: "employee",
      name,
      email,
      breakLogId: activeBreak.id,
      overBreakId: result?.id || "",
      type: "over_break_employee",
      title: "Over-break recorded",
      message:
        "Your break has exceeded. An over-break record has been saved.",
      minutesUsed: totalBreakMinutes,
      minutesRemaining: 0,
      totalBreakMinutes,
      overBreakMinutes: Math.max(0, totalBreakMinutes - OVERBREAK_TRIGGER_MINUTES),
    });
  }

  const overBreakSavedAt = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(doc(db, BREAK_LOGS_COLLECTION, activeBreak.id), {
    overBreakSaved: true,
    overBreakSavedAt: Timestamp.fromDate(overBreakSavedAt),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("overBreakSavedAtClient", overBreakSavedAt, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", overBreakSavedAt, storageTimeZone),
  });

  return result;
}

export async function getNotificationsForUser(user) {
  const role = String(user?.role || "").toLowerCase();
  const uid = String(
    user?.userId ?? user?.id ?? user?.uid ?? user?.firebaseUid ?? user?.employeeId ?? ""
  ).trim();
  const isAdminLike = role === "admin" || role === "super_admin" || role === "super admin";

  if (!uid && !isAdminLike) return [];

  const snap = await getDocs(collection(db, BREAK_NOTIFICATIONS_COLLECTION));

  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  const filtered = rows.filter((row) => {
    const audience = String(row?.audience || "");
    const rowUserId = String(row?.userId || "");

    if (isAdminLike) {
      return audience === "admin" || rowUserId === uid;
    }

    return rowUserId === uid;
  });

  filtered.sort((a, b) => {
    const aMs = toMillis(a?.createdAt);
    const bMs = toMillis(b?.createdAt);
    return bMs - aMs;
  });

  return filtered;
}

export async function markNotificationRead(notificationId) {
  const id = String(notificationId || "").trim();
  if (!id) return;
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(doc(db, BREAK_NOTIFICATIONS_COLLECTION, id), {
    read: true,
    readAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("readAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });
}

export async function markAllNotificationsRead(notificationIds = []) {
  const ids = Array.isArray(notificationIds)
    ? notificationIds.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  await Promise.all(ids.map((id) => markNotificationRead(id)));
}

export async function getOverBreakNotes() {
  const snap = await getDocs(collection(db, OVERBREAK_NOTES_COLLECTION));

  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  rows.sort((a, b) => {
    const aMs = toMillis(a?.updatedAt || a?.createdAt);
    const bMs = toMillis(b?.updatedAt || b?.createdAt);
    return bMs - aMs;
  });

  return rows;
}
