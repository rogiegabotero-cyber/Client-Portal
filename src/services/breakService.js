import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  doc,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { getBusinessDayKey } from "../utils/attendanceDate";
import { toMillis } from "../utils/common";
import { buildTimeZoneMeta, resolveStorageTimeZone } from "../utils/timeZoneMeta";

export const DAILY_BREAK_LIMIT_MINUTES = 60;
export const BREAK_REMINDER_MINUTES = 55;
export const BREAK_LIMIT_REACHED_MINUTES = 60;
export const OVERBREAK_GRACE_MINUTES = 5;
export const OVERBREAK_TRIGGER_MINUTES =
  BREAK_LIMIT_REACHED_MINUTES + OVERBREAK_GRACE_MINUTES;

const BREAK_LOGS_COLLECTION = "break_logs";
const BREAK_NOTIFICATIONS_COLLECTION = "break_notifications";
const OVERBREAK_NOTES_COLLECTION = "over_break_notes";
const USERS_COLLECTION = "users";

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === "function") return value.toDate();

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const normalizeRoleValue = (value) => {
  const role = String(value || "").trim().toLowerCase();
  if (!role) return "";
  if (role === "super admin" || role === "superadmin") return "super_admin";
  return role;
};

const getUserIdentity = (user = {}) => {
  const userId = String(
    user?.userId ?? user?.id ?? user?.uid ?? user?.firebaseUid ?? user?.employeeId ?? ""
  ).trim();

  return {
    userId,
    role: normalizeRoleValue(user?.role),
  };
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

async function getPortalUsers() {
  const snap = await getDocs(collection(db, USERS_COLLECTION));

  return snap.docs
    .map((row) => ({
      id: row.id,
      ...row.data(),
    }))
    .map((row) => {
      const uid = String(row?.userId || row?.uid || row?.id || "").trim();
      const firstName = String(row?.firstName || "").trim();
      const lastName = String(row?.lastName || "").trim();
      const fallbackName = String(row?.name || row?.displayName || "").trim();
      const name = `${firstName} ${lastName}`.trim() || fallbackName || row?.email || uid;

      return {
        userId: uid,
        email: String(row?.email || "").trim(),
        name,
        role: normalizeRoleValue(row?.role),
      };
    })
    .filter((row) => row.userId);
}

async function findExistingOverBreakByBreakLogId(breakLogId) {
  if (!breakLogId) return null;

  const snap = await getDocs(
    query(collection(db, OVERBREAK_NOTES_COLLECTION), where("breakLogId", "==", String(breakLogId)))
  );
  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  return rows.find((row) => String(row?.breakLogId || "") === String(breakLogId)) || null;
}

async function findNotificationByBreakLogIdTypeAndUserId(breakLogId, type, userId = "") {
  if (!breakLogId || !type) return null;

  const snap = await getDocs(
    query(collection(db, BREAK_NOTIFICATIONS_COLLECTION), where("breakLogId", "==", String(breakLogId)))
  );
  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  const normalizedUserId = String(userId || "").trim();

  return (
    rows.find((row) => {
      if (String(row?.breakLogId || "") !== String(breakLogId)) return false;
      if (String(row?.type || "") !== String(type)) return false;
      if (!normalizedUserId) return true;
      return String(row?.userId || "").trim() === normalizedUserId;
    }) || null
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
  targetPage = "notifications",
  minutesUsed = 0,
  minutesRemaining = 0,
  totalBreakMinutes = 0,
  overBreakMinutes = 0,
}) {
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  const ref = await addDoc(collection(db, BREAK_NOTIFICATIONS_COLLECTION), {
    userId: String(userId || "").trim(),
    audience: String(audience || "").trim() || "employee",
    role: String(role || "").trim(),
    name,
    email,
    breakLogId,
    overBreakId,
    type,
    title,
    message,
    targetPage,
    minutesUsed,
    minutesRemaining,
    totalBreakMinutes,
    overBreakMinutes,
    read: false,
    archived: false,
    archivedAt: null,
    archivedByUserId: "",
    archivedByName: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  return ref.id;
}

async function createBroadcastNotifications({
  breakLogId = "",
  overBreakId = "",
  type = "",
  title = "",
  message = "",
  sourceName = "",
  sourceEmail = "",
  minutesUsed = 0,
  minutesRemaining = 0,
  totalBreakMinutes = 0,
  overBreakMinutes = 0,
  skipUserId = "",
}) {
  const portalUsers = await getPortalUsers();
  const normalizedSkipUserId = String(skipUserId || "").trim();

  const createdIds = [];

  for (const portalUser of portalUsers) {
    if (!portalUser?.userId) continue;

    const existing = await findNotificationByBreakLogIdTypeAndUserId(
      breakLogId,
      type,
      portalUser.userId
    );
    if (existing?.id) continue;

    const notificationId = await createNotification({
      userId: portalUser.userId,
      audience: "employee",
      role: portalUser.role,
      name: sourceName,
      email: sourceEmail,
      breakLogId,
      overBreakId,
      type,
      title,
      message,
      minutesUsed,
      minutesRemaining,
      totalBreakMinutes,
      overBreakMinutes,
    });

    createdIds.push(notificationId);
  }

  if (normalizedSkipUserId) {
    const ownCopyExists =
      createdIds.length > 0 ||
      (await findNotificationByBreakLogIdTypeAndUserId(
        breakLogId,
        type,
        normalizedSkipUserId
      ));

    if (!ownCopyExists) {
      const fallbackId = await createNotification({
        userId: normalizedSkipUserId,
        audience: "employee",
        breakLogId,
        overBreakId,
        type,
        title,
        message,
        minutesUsed,
        minutesRemaining,
        totalBreakMinutes,
        overBreakMinutes,
        name: sourceName,
        email: sourceEmail,
      });
      createdIds.push(fallbackId);
    }
  }

  return createdIds;
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

  const overBreakMinutes = Math.max(0, totalBreakMinutes - BREAK_LIMIT_REACHED_MINUTES);

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
    note: `Employee exceeded the 1-hour break limit. Current over-break: ${formatDurationLabel(
      overBreakMinutes
    )}. Total break: ${formatDurationLabel(totalBreakMinutes)}.`,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("startedAtClient", activeBreak.startedAt, storageTimeZone),
    ...(endedAtDate ? buildTimeZoneMeta("endedAtClient", endedAtDate, storageTimeZone) : {}),
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
    archived: false,
    archivedAt: null,
    archivedByUserId: "",
    archivedByName: "",
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

async function ensureBroadcastStageNotification({
  activeBreak,
  type,
  title,
  message,
  name = "",
  email = "",
  userId = "",
  totalBreakMinutes = 0,
  overBreakId = "",
  overBreakMinutes = 0,
}) {
  if (!activeBreak?.id || !type) {
    return { created: false, reason: "missing-data" };
  }

  const portalUsers = await getPortalUsers();
  let createdCount = 0;

  for (const portalUser of portalUsers) {
    if (!portalUser?.userId) continue;

    const existing = await findNotificationByBreakLogIdTypeAndUserId(
      activeBreak.id,
      type,
      portalUser.userId
    );

    if (existing?.id) continue;

    await createNotification({
      userId: portalUser.userId,
      audience: "employee",
      role: portalUser.role,
      name,
      email,
      breakLogId: activeBreak.id,
      overBreakId,
      type,
      title,
      message,
      minutesUsed: totalBreakMinutes,
      minutesRemaining: Math.max(0, DAILY_BREAK_LIMIT_MINUTES - totalBreakMinutes),
      totalBreakMinutes,
      overBreakMinutes,
    });

    createdCount += 1;
  }

  const normalizedUserId = String(userId || "").trim();
  if (normalizedUserId) {
    const existingOwnCopy = await findNotificationByBreakLogIdTypeAndUserId(
      activeBreak.id,
      type,
      normalizedUserId
    );

    if (!existingOwnCopy?.id) {
      await createNotification({
        userId: normalizedUserId,
        audience: "employee",
        role: "employee",
        name,
        email,
        breakLogId: activeBreak.id,
        overBreakId,
        type,
        title,
        message,
        minutesUsed: totalBreakMinutes,
        minutesRemaining: Math.max(0, DAILY_BREAK_LIMIT_MINUTES - totalBreakMinutes),
        totalBreakMinutes,
        overBreakMinutes,
      });

      createdCount += 1;
    }
  }

  return {
    created: createdCount > 0,
    createdCount,
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

    limitReachedAlertSent: false,
    limitReachedAlertSentAt: null,

    overBreakSaved: false,
    overBreakSavedAt: null,

    overBreakAlertSent: false,
    overBreakAlertSentAt: null,

    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("startedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  const displayName = String(name || email || uid).trim();
  await createBroadcastNotifications({
    breakLogId: ref.id,
    type: "break_started",
    title: "Employee on break",
    message: `${displayName} is currently on break.`,
    sourceName: name,
    sourceEmail: email,
    totalBreakMinutes: 0,
    minutesUsed: 0,
    minutesRemaining: DAILY_BREAK_LIMIT_MINUTES,
    skipUserId: uid,
  });

  return {
    id: ref.id,
    userId: uid,
    name,
    email,
    startedAt: now,
    isActive: true,
    reminderSent: false,
    limitReachedAlertSent: false,
    overBreakSaved: false,
    overBreakAlertSent: false,
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
  const overBreakMinutes = Math.max(0, totalBreakMinutes - BREAK_LIMIT_REACHED_MINUTES);

  let overBreakRecord = null;

  if (!activeBreak?.reminderSent && totalBreakMinutes >= BREAK_REMINDER_MINUTES) {
    await ensureBreakReminder({
      userId: uid,
      name: activeBreak?.name || "",
      email: activeBreak?.email || "",
      activeBreak,
    });
  }

  if (!activeBreak?.limitReachedAlertSent && totalBreakMinutes >= BREAK_LIMIT_REACHED_MINUTES) {
    const displayName = String(activeBreak?.name || activeBreak?.email || uid).trim();

    await ensureBroadcastStageNotification({
      activeBreak,
      type: "break_limit_reached",
      title: "Break limit reached",
      message: `${displayName} has reached the 1-hour break limit.`,
      name: activeBreak?.name || "",
      email: activeBreak?.email || "",
      userId: uid,
      totalBreakMinutes,
      overBreakMinutes,
    });

    await updateDoc(doc(db, BREAK_LOGS_COLLECTION, activeBreak.id), {
      limitReachedAlertSent: true,
      limitReachedAlertSentAt: Timestamp.fromDate(now),
      updatedAt: serverTimestamp(),
      ...buildTimeZoneMeta("limitReachedAlertSentAtClient", now, storageTimeZone),
      ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    });
  }

  if (totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES) {
    overBreakRecord = await createOrUpdateOverBreakNote({
      activeBreak,
      userId: uid,
      name: activeBreak?.name || "",
      email: activeBreak?.email || "",
      endedAt: now,
    });

    if (!activeBreak?.overBreakAlertSent) {
      const displayName = String(activeBreak?.name || activeBreak?.email || uid).trim();

      await ensureBroadcastStageNotification({
        activeBreak,
        type: "over_break_broadcast",
        title: "Over break alert",
        message: `${displayName} exceeded the break limit by ${formatDurationLabel(
          Math.max(0, totalBreakMinutes - BREAK_LIMIT_REACHED_MINUTES)
        )}. Total break: ${formatDurationLabel(totalBreakMinutes)}.`,
        name: activeBreak?.name || "",
        email: activeBreak?.email || "",
        userId: uid,
        totalBreakMinutes,
        overBreakId: overBreakRecord?.id || "",
        overBreakMinutes,
      });
    }
  }

  await updateDoc(doc(db, BREAK_LOGS_COLLECTION, activeBreak.id), {
    endedAt: Timestamp.fromDate(now),
    isActive: false,
    totalBreakMinutes,
    overBreakSaved: totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES,
    overBreakSavedAt:
      totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES
        ? Timestamp.fromDate(now)
        : activeBreak?.overBreakSavedAt || null,
    overBreakAlertSent:
      totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES
        ? true
        : activeBreak?.overBreakAlertSent || false,
    overBreakAlertSentAt:
      totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES
        ? Timestamp.fromDate(now)
        : activeBreak?.overBreakAlertSentAt || null,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("endedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    ...(totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES
      ? buildTimeZoneMeta("overBreakSavedAtClient", now, storageTimeZone)
      : {}),
    ...(totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES
      ? buildTimeZoneMeta("overBreakAlertSentAtClient", now, storageTimeZone)
      : {}),
  });

  const displayName = String(activeBreak?.name || activeBreak?.email || uid).trim();
  await createBroadcastNotifications({
    breakLogId: activeBreak.id,
    overBreakId: overBreakRecord?.id || "",
    type: "break_ended",
    title: "Employee back from break",
    message: `${displayName} is back from break. Total break time: ${formatDurationLabel(
      totalBreakMinutes
    )}.`,
    sourceName: activeBreak?.name || "",
    sourceEmail: activeBreak?.email || "",
    totalBreakMinutes,
    minutesUsed: totalBreakMinutes,
    minutesRemaining: Math.max(0, DAILY_BREAK_LIMIT_MINUTES - totalBreakMinutes),
    overBreakMinutes,
    skipUserId: uid,
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

  const snap = await getDocs(
    query(collection(db, BREAK_LOGS_COLLECTION), where("userId", "==", uid))
  );
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

export function subscribeActiveBreakUpdates(onChange, onError) {
  let isInitial = true;

  return onSnapshot(
    query(collection(db, BREAK_LOGS_COLLECTION), where("isActive", "==", true)),
    (snapshot) => {
      const changes = Array.isArray(snapshot?.docChanges?.()) ? snapshot.docChanges() : [];
      const changedUserIds = Array.from(
        new Set(
          changes
            .map((change) => String(change?.doc?.data?.()?.userId || "").trim())
            .filter(Boolean)
        )
      );

      if (typeof onChange === "function") {
        onChange({
          isInitial,
          changeCount: changes.length,
          changedUserIds,
        });
      }

      isInitial = false;
    },
    onError
  );
}

export async function getBreakLogsForUserOnDate(userId, date = new Date()) {
  const uid = String(userId || "").trim();
  if (!uid) return [];

  const start = startOfLocalDay(date).getTime();
  const end = endOfLocalDay(date).getTime();

  const snap = await getDocs(
    query(collection(db, BREAK_LOGS_COLLECTION), where("userId", "==", uid))
  );

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
    return { created: false, reason: "too-early", totalBreakMinutes };
  }

  const displayName = String(name || email || uid).trim();

  const broadcastResult = await ensureBroadcastStageNotification({
    activeBreak,
    type: "break_warning",
    title: "Break limit almost reached",
    message: `${displayName} is 5 minutes away from the 1-hour break limit.`,
    name,
    email,
    userId: uid,
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
    created: broadcastResult?.created || false,
    message: `${displayName} is 5 minutes away from the 1-hour break limit.`,
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

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  const totalBreakMinutes = minutesBetween(activeBreak.startedAt, now);
  const displayName = String(name || email || uid).trim();

  let createdSomething = false;
  let overBreakResult = null;

  if (totalBreakMinutes >= BREAK_LIMIT_REACHED_MINUTES && !activeBreak?.limitReachedAlertSent) {
    const limitReachedResult = await ensureBroadcastStageNotification({
      activeBreak,
      type: "break_limit_reached",
      title: "Break limit reached",
      message: `${displayName} has reached the 1-hour break limit.`,
      name,
      email,
      userId: uid,
      totalBreakMinutes,
      overBreakMinutes: 0,
    });

    await updateDoc(doc(db, BREAK_LOGS_COLLECTION, activeBreak.id), {
      limitReachedAlertSent: true,
      limitReachedAlertSentAt: Timestamp.fromDate(now),
      updatedAt: serverTimestamp(),
      ...buildTimeZoneMeta("limitReachedAlertSentAtClient", now, storageTimeZone),
      ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    });

    createdSomething = createdSomething || !!limitReachedResult?.created;
  }

  if (totalBreakMinutes < OVERBREAK_TRIGGER_MINUTES) {
    return {
      created: createdSomething,
      reason: "waiting-overbreak-grace",
      totalBreakMinutes,
    };
  }

  const overBreakMinutes = Math.max(0, totalBreakMinutes - BREAK_LIMIT_REACHED_MINUTES);

  overBreakResult = await createOrUpdateOverBreakNote({
    activeBreak,
    userId: uid,
    name,
    email,
    endedAt: null,
  });

  if (!activeBreak?.overBreakAlertSent) {
    const overBreakBroadcast = await ensureBroadcastStageNotification({
      activeBreak,
      type: "over_break_broadcast",
      title: "Over break alert",
      message: `${displayName} exceeded the break limit by ${formatDurationLabel(
        overBreakMinutes
      )}. Total break: ${formatDurationLabel(totalBreakMinutes)}.`,
      name,
      email,
      userId: uid,
      totalBreakMinutes,
      overBreakId: overBreakResult?.id || "",
      overBreakMinutes,
    });

    createdSomething = createdSomething || !!overBreakBroadcast?.created;
  }

  const existingEmployeeNotif = await findNotificationByBreakLogIdTypeAndUserId(
    activeBreak.id,
    "over_break_employee",
    uid
  );

  if (!existingEmployeeNotif) {
    await createNotification({
      userId: uid,
      audience: "employee",
      role: "employee",
      name,
      email,
      breakLogId: activeBreak.id,
      overBreakId: overBreakResult?.id || "",
      type: "over_break_employee",
      title: "Over-break recorded",
      message: "Your break exceeded the 1-hour break limit.",
      minutesUsed: totalBreakMinutes,
      minutesRemaining: 0,
      totalBreakMinutes,
      overBreakMinutes,
    });

    createdSomething = true;
  }

  await updateDoc(doc(db, BREAK_LOGS_COLLECTION, activeBreak.id), {
    overBreakSaved: true,
    overBreakSavedAt: Timestamp.fromDate(now),
    overBreakAlertSent: true,
    overBreakAlertSentAt: Timestamp.fromDate(now),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("overBreakSavedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("overBreakAlertSentAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  return {
    created: createdSomething,
    totalBreakMinutes,
    overBreakMinutes,
    overBreakResult,
  };
}

export async function getNotificationsForUser(user, options = {}) {
  const archivedOnly = !!options?.archived;
  const { userId: uid, role: userRole } = getUserIdentity(user);
  if (!uid) return [];
  const visitorBlockedTypes = new Set([
    "break_warning", // Break limit almost reached
    "break_limit_reached", // Break limit reached
    "over_break_broadcast", // Exceeded grace period / over-break alert
  ]);

  const snap = await getDocs(collection(db, BREAK_NOTIFICATIONS_COLLECTION));

  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  const filtered = rows.filter((row) => {
    const audience = String(row?.audience || "").trim().toLowerCase();
    const rowUserId = String(row?.userId || "").trim();
    const rowRole = normalizeRoleValue(row?.role);
    const type = String(row?.type || "").trim().toLowerCase();

    // Additive rule: hide break escalation notices from visitors.
    if (userRole === "visitor" && visitorBlockedTypes.has(type)) {
      return false;
    }

    if (rowUserId) {
      return rowUserId === uid;
    }

    if (audience === "broadcast" || audience === "all" || audience === "everyone") {
      return true;
    }

    if (rowRole && rowRole === userRole) return true;
    if (audience && audience === userRole) return true;

    if (type === "portal_user_request_pending") {
      return userRole === "admin" || userRole === "super_admin";
    }

    return false;
  });

  const archiveFiltered = filtered.filter((row) => !!row?.archived === archivedOnly);

  archiveFiltered.sort((a, b) => {
    const aMs = toMillis(a?.createdAt);
    const bMs = toMillis(b?.createdAt);
    return bMs - aMs;
  });

  return archiveFiltered;
}

export function subscribeBreakNotificationUpdates(onChange, onError) {
  let isInitial = true;

  return onSnapshot(
    collection(db, BREAK_NOTIFICATIONS_COLLECTION),
    (snapshot) => {
      const changes = Array.isArray(snapshot?.docChanges?.()) ? snapshot.docChanges() : [];
      const changedRows = changes.map((change) => {
        const row = change?.doc?.data?.() || {};
        return {
          userId: String(row?.userId || "").trim(),
          audience: String(row?.audience || "").trim().toLowerCase(),
          role: normalizeRoleValue(row?.role),
          type: String(row?.type || "").trim().toLowerCase(),
        };
      });

      if (typeof onChange === "function") {
        onChange({
          isInitial,
          changeCount: changes.length,
          changedRows,
        });
      }

      isInitial = false;
    },
    onError
  );
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

const resolveActorArchiveMeta = (actor = {}) => {
  const userId = String(
    actor?.userId ?? actor?.id ?? actor?.uid ?? actor?.firebaseUid ?? actor?.employeeId ?? ""
  ).trim();
  const name =
    String(actor?.name || actor?.displayName || actor?.email || "Portal User").trim() ||
    "Portal User";
  return { userId, name };
};

export async function archiveNotification(notificationId, actor = {}) {
  const id = String(notificationId || "").trim();
  if (!id) return;

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  const actorMeta = resolveActorArchiveMeta(actor);

  await updateDoc(doc(db, BREAK_NOTIFICATIONS_COLLECTION, id), {
    archived: true,
    archivedAt: serverTimestamp(),
    archivedByUserId: actorMeta.userId,
    archivedByName: actorMeta.name,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("archivedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });
}

export async function archiveAllNotifications(notificationIds = [], actor = {}) {
  const ids = Array.from(
    new Set(
      (Array.isArray(notificationIds) ? notificationIds : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );
  await Promise.all(ids.map((id) => archiveNotification(id, actor)));
}

export async function restoreNotification(notificationId) {
  const id = String(notificationId || "").trim();
  if (!id) return;

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(doc(db, BREAK_NOTIFICATIONS_COLLECTION, id), {
    archived: false,
    archivedAt: null,
    archivedByUserId: "",
    archivedByName: "",
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });
}

export async function deleteNotification(notificationId) {
  const id = String(notificationId || "").trim();
  if (!id) return;
  await deleteDoc(doc(db, BREAK_NOTIFICATIONS_COLLECTION, id));
}

export async function deleteAllNotifications(notificationIds = []) {
  const ids = Array.from(
    new Set(
      (Array.isArray(notificationIds) ? notificationIds : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );
  await Promise.all(ids.map((id) => deleteNotification(id)));
}

export async function archiveOverBreakNote(noteId, actor = {}) {
  const id = String(noteId || "").trim();
  if (!id) return;

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  const actorMeta = resolveActorArchiveMeta(actor);

  await updateDoc(doc(db, OVERBREAK_NOTES_COLLECTION, id), {
    archived: true,
    archivedAt: serverTimestamp(),
    archivedByUserId: actorMeta.userId,
    archivedByName: actorMeta.name,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("archivedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });
}

export async function archiveAllOverBreakNotes(noteIds = [], actor = {}) {
  const ids = Array.from(
    new Set(
      (Array.isArray(noteIds) ? noteIds : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );
  await Promise.all(ids.map((id) => archiveOverBreakNote(id, actor)));
}

export async function restoreOverBreakNote(noteId) {
  const id = String(noteId || "").trim();
  if (!id) return;

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(doc(db, OVERBREAK_NOTES_COLLECTION, id), {
    archived: false,
    archivedAt: null,
    archivedByUserId: "",
    archivedByName: "",
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });
}

export async function deleteOverBreakNote(noteId) {
  const id = String(noteId || "").trim();
  if (!id) return;
  await deleteDoc(doc(db, OVERBREAK_NOTES_COLLECTION, id));
}

export async function deleteAllOverBreakNotes(noteIds = []) {
  const ids = Array.from(
    new Set(
      (Array.isArray(noteIds) ? noteIds : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );
  await Promise.all(ids.map((id) => deleteOverBreakNote(id)));
}

export async function getOverBreakNotes(user = null, options = {}) {
  void user;
  const archivedOnly = !!options?.archived;
  const snap = await getDocs(collection(db, OVERBREAK_NOTES_COLLECTION));

  const rows = snap.docs
    .map((d) => ({
      id: d.id,
      ...d.data(),
    }))
    .filter((row) => !!row?.archived === archivedOnly);

  rows.sort((a, b) => {
    const aMs = toMillis(a?.updatedAt || a?.createdAt);
    const bMs = toMillis(b?.updatedAt || b?.createdAt);
    return bMs - aMs;
  });

  return rows;
}

export async function resetAllNotificationData() {
  const [notificationsSnap, overBreakSnap] = await Promise.all([
    getDocs(collection(db, BREAK_NOTIFICATIONS_COLLECTION)),
    getDocs(collection(db, OVERBREAK_NOTES_COLLECTION)),
  ]);

  const deleteOps = [
    ...notificationsSnap.docs.map((row) => deleteDoc(doc(db, BREAK_NOTIFICATIONS_COLLECTION, row.id))),
    ...overBreakSnap.docs.map((row) => deleteDoc(doc(db, OVERBREAK_NOTES_COLLECTION, row.id))),
  ];

  await Promise.all(deleteOps);
}
