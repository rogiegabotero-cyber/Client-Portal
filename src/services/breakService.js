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
  limit,
  setDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { getBusinessDayKey } from "../utils/attendanceDate";
import { toMillis } from "../utils/common";
import { buildTimeZoneMeta, resolveStorageTimeZone } from "../utils/timeZoneMeta";
import {
  recordFirestoreGetDocsRead,
  recordFirestoreSnapshotRead,
} from "../utils/firestoreReadMetrics";

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
const NOTIFICATION_BROADCAST_AUDIENCES = ["broadcast", "all", "everyone"];
const IN_QUERY_CHUNK_SIZE = 10;
const BREAK_RANGE_CACHE_TTL_MS = 30 * 1000;
const NOTIFICATION_VIEW_CACHE_TTL_MS = 20 * 1000;
const NOTIFICATION_QUERY_LIMIT = 180;
const OVERBREAK_QUERY_LIMIT = 240;
const PORTAL_USERS_CACHE_TTL_MS = 60 * 1000;

const breakRangeCache = new Map();
const notificationsViewCache = new Map();
const portalUsersCache = {
  expiresAt: 0,
  rows: [],
};

const trackedGetDocs = async (label, sourceQuery) => {
  const snapshot = await getDocs(sourceQuery);
  recordFirestoreGetDocsRead(label, snapshot);
  return snapshot;
};

const estimateSnapshotReadCount = (snapshot, { isInitial = false } = {}) => {
  const fullCount = Array.isArray(snapshot?.docs)
    ? snapshot.docs.length
    : Number(snapshot?.size || 0);
  if (isInitial) return Math.max(0, Number(fullCount || 0));

  const changes = Array.isArray(snapshot?.docChanges?.()) ? snapshot.docChanges() : [];
  return Math.max(0, Number(changes.length || 0));
};

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

const chunkArray = (arr = [], size = IN_QUERY_CHUNK_SIZE) => {
  const list = Array.isArray(arr) ? arr : [];
  const chunkSize = Math.max(1, Number(size) || IN_QUERY_CHUNK_SIZE);
  const out = [];

  for (let idx = 0; idx < list.length; idx += chunkSize) {
    out.push(list.slice(idx, idx + chunkSize));
  }

  return out;
};

const toCacheKeyUserIds = (userIds = []) =>
  Array.from(
    new Set((Array.isArray(userIds) ? userIds : []).map((v) => String(v || "").trim()).filter(Boolean))
  )
    .sort()
    .join(",");

const buildBreakRangeCacheKey = (userIds = [], options = {}) => {
  const idsKey = toCacheKeyUserIds(userIds);
  const start = normalizeYmd(options?.startDayKey || "");
  const end = normalizeYmd(options?.endDayKey || "");
  const resetTime = String(options?.attendanceResetTime || "05:00").trim() || "05:00";
  const timeZone = String(options?.businessTimeZone || "America/Chicago").trim() || "America/Chicago";
  return [idsKey, start || "__all__", end || "__all__", resetTime, timeZone].join("|");
};

const cloneBreakLogsByUserId = (payload = {}) => {
  const out = {};
  for (const [userId, rows] of Object.entries(payload && typeof payload === "object" ? payload : {})) {
    out[userId] = Array.isArray(rows) ? [...rows] : [];
  }
  return out;
};

const getCachedBreakRange = (cacheKey) => {
  const hit = breakRangeCache.get(String(cacheKey || ""));
  if (!hit) return null;
  if (Date.now() > Number(hit?.expiresAt || 0)) {
    breakRangeCache.delete(String(cacheKey || ""));
    return null;
  }
  return cloneBreakLogsByUserId(hit.data || {});
};

const setCachedBreakRange = (cacheKey, data) => {
  breakRangeCache.set(String(cacheKey || ""), {
    expiresAt: Date.now() + BREAK_RANGE_CACHE_TTL_MS,
    data: cloneBreakLogsByUserId(data || {}),
  });
};

const invalidateBreakRangeCache = () => {
  breakRangeCache.clear();
};

const buildNotificationViewerCacheKey = ({ uid = "", userRole = "" } = {}) =>
  `${String(uid || "").trim()}|${normalizeRoleValue(userRole || "")}`;

const invalidateNotificationViewCache = () => {
  notificationsViewCache.clear();
};

const loadVisibleNotificationRowsForViewer = async ({ uid = "", userRole = "" } = {}) => {
  const normalizedUid = String(uid || "").trim();
  if (!normalizedUid) return [];

  const cacheKey = buildNotificationViewerCacheKey({ uid: normalizedUid, userRole });
  const now = Date.now();
  const hit = notificationsViewCache.get(cacheKey);
  if (hit) {
    if (hit.pendingPromise) {
      return hit.pendingPromise;
    }
    if (Number(hit.expiresAt || 0) > now && Array.isArray(hit.rows)) {
      return hit.rows;
    }
  }

  const pendingPromise = (async () => {
    let rows = [];

    try {
      const queries = buildNotificationQueriesForViewer(normalizedUid, userRole, {});
      if (!queries.length) return [];

      const snapshots = await Promise.all(
        queries.map((q, idx) => trackedGetDocs(`notifications.viewer.${idx}`, q))
      );
      rows = dedupeRowsById(
        snapshots.flatMap((snap) => snap.docs.map((d) => notificationRowFromDoc(d)))
      );
    } catch {
      // Fallback for environments that don't have all required compound indexes yet.
      const snap = await trackedGetDocs(
        "notifications.viewer.fallbackAll",
        collection(db, BREAK_NOTIFICATIONS_COLLECTION)
      );
      rows = snap.docs.map((d) => notificationRowFromDoc(d));
    }

    const visibleRows = rows.filter((row) =>
      isNotificationVisibleToUser(row, { uid: normalizedUid, userRole })
    );

    visibleRows.sort((a, b) => {
      const aMs = toMillis(a?.createdAt);
      const bMs = toMillis(b?.createdAt);
      return bMs - aMs;
    });

    notificationsViewCache.set(cacheKey, {
      expiresAt: Date.now() + NOTIFICATION_VIEW_CACHE_TTL_MS,
      rows: visibleRows,
      pendingPromise: null,
    });

    return visibleRows;
  })();

  notificationsViewCache.set(cacheKey, {
    expiresAt: now + NOTIFICATION_VIEW_CACHE_TTL_MS,
    rows: [],
    pendingPromise,
  });

  return pendingPromise;
};

const notificationRowFromDoc = (d) => ({
  id: d.id,
  ...d.data(),
});

const dedupeRowsById = (rows = []) => {
  const map = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || "").trim();
    if (!id || map.has(id)) continue;
    map.set(id, row);
  }

  return Array.from(map.values());
};

const isPortalRequestPendingNotificationVisible = (userRole = "") =>
  userRole === "admin" || userRole === "super_admin";

const isNotificationVisibleToUser = (row = {}, { uid = "", userRole = "" } = {}) => {
  const audience = String(row?.audience || "").trim().toLowerCase();
  const rowUserId = String(row?.userId || "").trim();
  const rowRole = normalizeRoleValue(row?.role);
  const type = String(row?.type || "").trim().toLowerCase();
  const visitorBlockedTypes = new Set([
    "break_warning",
    "break_limit_reached",
    "over_break_broadcast",
  ]);

  if (userRole === "visitor" && visitorBlockedTypes.has(type)) {
    return false;
  }

  if (rowUserId) {
    return rowUserId === uid;
  }

  if (NOTIFICATION_BROADCAST_AUDIENCES.includes(audience)) {
    return true;
  }

  if (rowRole && rowRole === userRole) return true;
  if (audience && audience === userRole) return true;

  if (type === "portal_user_request_pending") {
    return isPortalRequestPendingNotificationVisible(userRole);
  }

  return false;
};

const buildNotificationQueriesForViewer = (uid, userRole, { archived } = {}) => {
  const normalizedUid = String(uid || "").trim();
  const normalizedRole = normalizeRoleValue(userRole || "");
  if (!normalizedUid) return [];

  const coll = collection(db, BREAK_NOTIFICATIONS_COLLECTION);
  const includeArchivedFilter = typeof archived === "boolean";
  const maybeArchivedWhere = includeArchivedFilter ? [where("archived", "==", archived)] : [];
  const out = [];

  out.push(query(coll, where("userId", "==", normalizedUid), ...maybeArchivedWhere, limit(NOTIFICATION_QUERY_LIMIT)));
  for (const audience of NOTIFICATION_BROADCAST_AUDIENCES) {
    out.push(query(coll, where("audience", "==", audience), ...maybeArchivedWhere, limit(NOTIFICATION_QUERY_LIMIT)));
  }

  if (normalizedRole) {
    out.push(query(coll, where("role", "==", normalizedRole), ...maybeArchivedWhere, limit(NOTIFICATION_QUERY_LIMIT)));
    out.push(
      query(coll, where("audience", "==", normalizedRole), ...maybeArchivedWhere, limit(NOTIFICATION_QUERY_LIMIT))
    );
  }

  if (isPortalRequestPendingNotificationVisible(normalizedRole)) {
    out.push(
      query(
        coll,
        where("type", "==", "portal_user_request_pending"),
        ...maybeArchivedWhere,
        limit(NOTIFICATION_QUERY_LIMIT)
      )
    );
  }

  return out;
};

async function getPortalUsers() {
  const now = Date.now();
  if (Array.isArray(portalUsersCache.rows) && Number(portalUsersCache.expiresAt || 0) > now) {
    return portalUsersCache.rows;
  }

  const snap = await trackedGetDocs("users.portalUsers", collection(db, USERS_COLLECTION));

  const rows = snap.docs
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

  portalUsersCache.rows = rows;
  portalUsersCache.expiresAt = now + PORTAL_USERS_CACHE_TTL_MS;
  return rows;
}

async function findExistingOverBreakByBreakLogId(breakLogId) {
  if (!breakLogId) return null;

  const snap = await trackedGetDocs(
    "overBreak.findByBreakLogId",
    query(collection(db, OVERBREAK_NOTES_COLLECTION), where("breakLogId", "==", String(breakLogId)))
  );
  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  return rows.find((row) => String(row?.breakLogId || "") === String(breakLogId)) || null;
}

const toDocToken = (value, fallback = "na") => {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
};

const buildNotificationDocId = ({
  userId = "",
  type = "",
  breakLogId = "",
  overBreakId = "",
  audience = "",
}) => {
  const eventToken = breakLogId || overBreakId || audience || "event";
  return [
    toDocToken(userId, "user"),
    toDocToken(type, "type"),
    toDocToken(eventToken, "event"),
  ].join("__");
};

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
  const normalizedUserId = String(userId || "").trim();
  const normalizedAudience = String(audience || "").trim() || "employee";
  const normalizedType = String(type || "").trim();
  const notificationId = buildNotificationDocId({
    userId: normalizedUserId,
    type: normalizedType,
    breakLogId,
    overBreakId,
    audience: normalizedAudience,
  });

  await setDoc(doc(db, BREAK_NOTIFICATIONS_COLLECTION, notificationId), {
    userId: normalizedUserId,
    audience: normalizedAudience,
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
  invalidateNotificationViewCache();

  return notificationId;
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

  invalidateBreakRangeCache();

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

  await updateDoc(doc(db, BREAK_LOGS_COLLECTION, activeBreak.id), {
    endedAt: Timestamp.fromDate(now),
    isActive: false,
    totalBreakMinutes,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("endedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });
  invalidateBreakRangeCache();

  return {
    id: activeBreak.id,
    userId: uid,
    endedAt: now,
    totalBreakMinutes,
    overBreakMinutes: Math.max(0, totalBreakMinutes - BREAK_LIMIT_REACHED_MINUTES),
    overBreakRecord: null,
  };
}

export async function getActiveBreakForUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return null;

  try {
    const snap = await trackedGetDocs(
      "breakLogs.activeByUser",
      query(
        collection(db, BREAK_LOGS_COLLECTION),
        where("userId", "==", uid),
        where("isActive", "==", true)
      )
    );
    const rows = snap.docs.map((row) => ({
      id: row.id,
      ...row.data(),
    }));

    rows.sort((a, b) => toMillis(b.startedAt) - toMillis(a.startedAt));
    return rows[0] || null;
  } catch {
    const snap = await trackedGetDocs(
      "breakLogs.byUser.fallbackAll",
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
}

export async function getActiveBreaks() {
  const snap = await trackedGetDocs(
    "breakLogs.activeAll",
    query(collection(db, BREAK_LOGS_COLLECTION), where("isActive", "==", true))
  );

  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  rows.sort((a, b) => toMillis(b.startedAt) - toMillis(a.startedAt));
  return rows;
}

export function subscribeActiveBreakUpdates(onChange, onError) {
  let isInitial = true;

  return onSnapshot(
    query(collection(db, BREAK_LOGS_COLLECTION), where("isActive", "==", true)),
    (snapshot) => {
      recordFirestoreSnapshotRead(
        "breakLogs.activeAll",
        estimateSnapshotReadCount(snapshot, { isInitial })
      );
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

  const ymd = normalizeYmd(date);
  const rowsByUserId = await getBreakLogsByUserIdsInRange([uid], {
    startDayKey: ymd,
    endDayKey: ymd,
    attendanceResetTime: "00:00",
    businessTimeZone: "UTC",
  });
  return Array.isArray(rowsByUserId?.[uid]) ? rowsByUserId[uid] : [];
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

  const cacheKey = buildBreakRangeCacheKey(normalizedIds, {
    startDayKey,
    endDayKey,
    attendanceResetTime,
    businessTimeZone,
  });
  const cached = getCachedBreakRange(cacheKey);
  if (cached) return cached;

  const start = normalizeYmd(startDayKey);
  const end = normalizeYmd(endDayKey);
  const includeAll = !start || !end;
  const out = normalizedIds.reduce((acc, uid) => {
    acc[uid] = [];
    return acc;
  }, {});

  const idChunks = chunkArray(normalizedIds, IN_QUERY_CHUNK_SIZE);
  const rows = [];

  try {
    for (const chunk of idChunks) {
      if (!chunk.length) continue;

      const queryParts = [where("userId", "in", chunk)];
      if (!includeAll) {
        // Expand one day on both edges to avoid false negatives around timezone boundaries.
        const startUtc = new Date(`${start}T00:00:00.000Z`);
        startUtc.setUTCDate(startUtc.getUTCDate() - 1);

        const endUtc = new Date(`${end}T23:59:59.999Z`);
        endUtc.setUTCDate(endUtc.getUTCDate() + 1);

        queryParts.push(where("startedAt", ">=", Timestamp.fromDate(startUtc)));
        queryParts.push(where("startedAt", "<=", Timestamp.fromDate(endUtc)));
      }

      const snap = await trackedGetDocs(
        "breakLogs.rangeByUserChunk",
        query(collection(db, BREAK_LOGS_COLLECTION), ...queryParts)
      );
      rows.push(
        ...snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }))
      );
    }
  } catch {
    for (const uid of normalizedIds) {
      const userRows = await trackedGetDocs(
        "breakLogs.rangeByUserFallback",
        query(collection(db, BREAK_LOGS_COLLECTION), where("userId", "==", uid))
      );
      rows.push(
        ...userRows.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }))
      );
    }
  }

  const allowedIds = new Set(normalizedIds);
  for (const row of rows) {
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

  setCachedBreakRange(cacheKey, out);
  return cloneBreakLogsByUserId(out);
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
  invalidateBreakRangeCache();

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
  invalidateBreakRangeCache();

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
  const visibleRows = await loadVisibleNotificationRowsForViewer({ uid, userRole });
  return visibleRows.filter((row) => !!row?.archived === archivedOnly);
}

export function subscribeBreakNotificationUpdates(
  viewerOrOnChange,
  onChangeOrOnError,
  maybeOnError
) {
  const hasViewerContext =
    !!viewerOrOnChange && typeof viewerOrOnChange === "object" && !Array.isArray(viewerOrOnChange);
  const viewer = hasViewerContext ? viewerOrOnChange : null;
  const onChange = hasViewerContext ? onChangeOrOnError : viewerOrOnChange;
  const onError = hasViewerContext ? maybeOnError : onChangeOrOnError;

  const { userId: uid, role: userRole } = getUserIdentity(viewer || {});

  const mapChangeRow = (change) => {
    const row = change?.doc?.data?.() || {};
    return {
      userId: String(row?.userId || "").trim(),
      audience: String(row?.audience || "").trim().toLowerCase(),
      role: normalizeRoleValue(row?.role),
      type: String(row?.type || "").trim().toLowerCase(),
    };
  };
  const mapChangeDoc = (change) => {
    const row = change?.doc?.data?.() || {};
    return {
      id: String(change?.doc?.id || row?.id || "").trim(),
      changeType: String(change?.type || "").trim().toLowerCase(),
      row: {
        id: String(change?.doc?.id || row?.id || "").trim(),
        ...row,
      },
    };
  };

  const notify = (isInitial, changes = []) => {
    if (!isInitial && Array.isArray(changes) && changes.length) {
      invalidateNotificationViewCache();
    }
    if (typeof onChange !== "function") return;
    onChange({
      isInitial,
      changeCount: changes.length,
      changedRows: changes.map((item) => mapChangeRow(item)),
      changedDocs: changes.map((item) => mapChangeDoc(item)).filter((item) => !!item.id),
    });
  };

  if (!uid) {
    let isInitial = true;
    return onSnapshot(
      query(collection(db, BREAK_NOTIFICATIONS_COLLECTION), limit(NOTIFICATION_QUERY_LIMIT)),
      (snapshot) => {
        recordFirestoreSnapshotRead(
          "notifications.all",
          estimateSnapshotReadCount(snapshot, { isInitial })
        );
        const changes = Array.isArray(snapshot?.docChanges?.()) ? snapshot.docChanges() : [];
        notify(isInitial, changes);
        isInitial = false;
      },
      onError
    );
  }

  const relevantQueries = buildNotificationQueriesForViewer(uid, userRole, {});
  if (!relevantQueries.length) return () => {};

  const unsubscribes = [];
  for (const q of relevantQueries) {
    let isInitial = true;
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        recordFirestoreSnapshotRead(
          "notifications.viewer",
          estimateSnapshotReadCount(snapshot, { isInitial })
        );
        const changes = Array.isArray(snapshot?.docChanges?.()) ? snapshot.docChanges() : [];
        notify(isInitial, changes);
        isInitial = false;
      },
      onError
    );
    unsubscribes.push(unsubscribe);
  }

  return () => {
    for (const unsubscribe of unsubscribes) {
      if (typeof unsubscribe === "function") unsubscribe();
    }
  };
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
  invalidateNotificationViewCache();
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
  invalidateNotificationViewCache();
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
  invalidateNotificationViewCache();
}

export async function deleteNotification(notificationId) {
  const id = String(notificationId || "").trim();
  if (!id) return;
  await deleteDoc(doc(db, BREAK_NOTIFICATIONS_COLLECTION, id));
  invalidateNotificationViewCache();
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
  let rows = [];

  try {
    const snap = await trackedGetDocs(
      "overBreak.listByArchived",
      query(
        collection(db, OVERBREAK_NOTES_COLLECTION),
        where("archived", "==", archivedOnly),
        limit(OVERBREAK_QUERY_LIMIT)
      )
    );
    rows = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));
  } catch {
    const snap = await trackedGetDocs(
      "overBreak.listFallbackAll",
      query(collection(db, OVERBREAK_NOTES_COLLECTION), limit(OVERBREAK_QUERY_LIMIT))
    );
    rows = snap.docs
      .map((d) => ({
        id: d.id,
        ...d.data(),
      }))
      .filter((row) => !!row?.archived === archivedOnly);
  }

  rows.sort((a, b) => {
    const aMs = toMillis(a?.updatedAt || a?.createdAt);
    const bMs = toMillis(b?.updatedAt || b?.createdAt);
    return bMs - aMs;
  });

  return rows;
}

export async function resetAllNotificationData() {
  const [notificationsSnap, overBreakSnap] = await Promise.all([
    trackedGetDocs("notifications.resetAll", collection(db, BREAK_NOTIFICATIONS_COLLECTION)),
    trackedGetDocs("overBreak.resetAll", collection(db, OVERBREAK_NOTES_COLLECTION)),
  ]);

  const deleteOps = [
    ...notificationsSnap.docs.map((row) => deleteDoc(doc(db, BREAK_NOTIFICATIONS_COLLECTION, row.id))),
    ...overBreakSnap.docs.map((row) => deleteDoc(doc(db, OVERBREAK_NOTES_COLLECTION, row.id))),
  ];

  await Promise.all(deleteOps);
  invalidateNotificationViewCache();
}
