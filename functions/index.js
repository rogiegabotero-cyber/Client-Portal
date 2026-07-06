const nodeCrypto = require("node:crypto");
const admin = require("firebase-admin");
const { setGlobalOptions } = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { getFunctions } = require("firebase-admin/functions");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// Mirrors the client's VITE_HYACINTH_API_KEY (src/App.jsx) - set with:
//   firebase functions:secrets:set HYACINTH_API_KEY
// using the same value, so the server can poll the external attendance system
// on its own schedule instead of only in response to a client request.
const HYACINTH_API_KEY = defineSecret("HYACINTH_API_KEY");

setGlobalOptions({ maxInstances: 10, region: "us-central1" });
admin.initializeApp();

const db = admin.firestore();

const callableRuntimeOptions = {
  region: "us-central1",
  invoker: "public",
  cors: true,
};

const USERS_COLLECTION = "users";
const USER_PERMISSIONS_COLLECTION = "user_permissions";
const EMPLOYEE_CREDENTIALS_COLLECTION = "employee_credentials";
const ACTIVE_SESSIONS_COLLECTION = "portal_active_sessions";

const PASSWORD_HASH_PREFIX = "portal_v1";

const ROLES = {
  EMPLOYEE: "employee",
  ADMIN: "admin",
  ACCOUNTING: "accounting",
  VISITOR: "visitor",
  SUPER_ADMIN: "super_admin",
};

const DEFAULT_ROLE_PAGES = {
  [ROLES.SUPER_ADMIN]: [
    "dashboard",
    "employee_dashboard",
    "profile",
    "attendance",
    "assignment",
    "schedule",
    "hours",
    "notifications",
    "manage_announcements",
    "perf_daily",
    "perf_weekly",
    "perf_monthly",
    "invoices",
    "special_users",
    "register_portal_user",
    "manage_employee",
    "control_panel",
  ],
  [ROLES.ADMIN]: [
    "dashboard",
    "employee_dashboard",
    "profile",
    "attendance",
    "assignment",
    "schedule",
    "hours",
    "notifications",
    "manage_announcements",
    "perf_daily",
    "perf_weekly",
    "perf_monthly",
    "invoices",
  ],
  [ROLES.ACCOUNTING]: [
    "dashboard",
    "profile",
    "attendance",
    "schedule",
    "hours",
    "notifications",
    "perf_daily",
    "perf_weekly",
    "perf_monthly",
    "invoices",
  ],
  [ROLES.VISITOR]: ["employee_dashboard", "profile", "notifications", "manage_announcements"],
  [ROLES.EMPLOYEE]: [
    "employee_dashboard",
    "profile",
    "attendance",
    "assignment",
    "schedule",
    "notifications",
  ],
};

const PORTAL_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.ACCOUNTING,
  ROLES.VISITOR,
]);

const toText = (value) => String(value || "").trim();
const normalizeEmail = (value) => toText(value).toLowerCase();
const normalizeRole = (value) => toText(value).toLowerCase().replace(/\s+/g, "_");
const toDocToken = (value, fallback = "na") => {
  const cleaned = toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
};

const BREAK_LOGS_COLLECTION = "break_logs";
const BREAK_NOTIFICATIONS_COLLECTION = "break_notifications";
const OVERBREAK_NOTES_COLLECTION = "over_break_notes";
const BREAK_LIMIT_MINUTES = 60;
const BREAK_WARNING_MINUTES = 55;
const OVERBREAK_GRACE_MINUTES = 5;
const OVERBREAK_TRIGGER_MINUTES = BREAK_LIMIT_MINUTES + OVERBREAK_GRACE_MINUTES;
const BREAK_SCAN_LIMIT = 100;

const BREAK_BROADCAST_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.ACCOUNTING,
  ROLES.VISITOR,
];

const broadcastUsersCache = {
  expiresAt: 0,
  rows: [],
};

const toMillis = (value) => {
  if (!value && value !== 0) return NaN;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof value?.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof value?.toDate === "function") {
    const ms = value.toDate().getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof value?.seconds === "number") {
    const nanos = Number(value?.nanoseconds || 0);
    const ms = Math.round(value.seconds * 1000 + nanos / 1000000);
    return Number.isFinite(ms) ? ms : NaN;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
};

const minutesBetween = (startValue, endValue) => {
  const startMs = toMillis(startValue);
  const endMs = toMillis(endValue);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
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

const buildBreakNotificationDocId = ({ userId = "", type = "", breakLogId = "" }) =>
  [
    toDocToken(userId, "user"),
    toDocToken(type, "type"),
    toDocToken(breakLogId, "event"),
  ].join("__");

const getBreakDisplayName = (row = {}, fallbackUserId = "") =>
  toText(row?.name || row?.displayName || row?.email || fallbackUserId) || "Employee";

const buildBreakMeta = (row = {}) => ({
  userId: toText(row?.userId),
  name: toText(row?.name),
  email: normalizeEmail(row?.email),
});

const toBreakState = (row = {}) => ({
  isActive: !!row?.isActive,
  reminderSent: !!row?.reminderSent,
  limitReachedAlertSent: !!row?.limitReachedAlertSent,
  overBreakAlertSent: !!row?.overBreakAlertSent,
  overBreakSaved: !!row?.overBreakSaved,
});

const getBroadcastUsers = async () => {
  const now = Date.now();
  if (Array.isArray(broadcastUsersCache.rows) && Number(broadcastUsersCache.expiresAt || 0) > now) {
    return broadcastUsersCache.rows;
  }

  const snap = await db
    .collection(USERS_COLLECTION)
    .where("role", "in", BREAK_BROADCAST_ROLES)
    .get();

  const rows = snap.docs
    .map((docSnap) => docSnap.data() || {})
    .map((row) => ({
      userId: toText(row?.userId || row?.uid),
      role: normalizeRole(row?.role),
    }))
    .filter((row) => !!row.userId);

  broadcastUsersCache.rows = rows;
  broadcastUsersCache.expiresAt = now + 60 * 1000;
  return rows;
};

const createBreakNotificationIfMissing = async ({
  recipientUserId,
  recipientRole = "",
  breakLogId = "",
  actorName = "",
  actorEmail = "",
  type = "",
  title = "",
  message = "",
  minutesUsed = 0,
  minutesRemaining = 0,
  totalBreakMinutes = 0,
  overBreakMinutes = 0,
  overBreakId = "",
}) => {
  const userId = toText(recipientUserId);
  const normalizedType = toText(type).toLowerCase();
  const normalizedBreakLogId = toText(breakLogId);
  if (!userId || !normalizedType || !normalizedBreakLogId) return false;

  const notificationId = buildBreakNotificationDocId({
    userId,
    type: normalizedType,
    breakLogId: normalizedBreakLogId,
  });
  const ref = db.collection(BREAK_NOTIFICATIONS_COLLECTION).doc(notificationId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  try {
    await ref.create({
      userId,
      audience: "employee",
      role: normalizeRole(recipientRole) || ROLES.EMPLOYEE,
      name: toText(actorName),
      email: normalizeEmail(actorEmail),
      breakLogId: normalizedBreakLogId,
      overBreakId: toText(overBreakId),
      type: normalizedType,
      title: toText(title),
      message: toText(message),
      targetPage: "notifications",
      minutesUsed: Math.max(0, Number(minutesUsed) || 0),
      minutesRemaining: Math.max(0, Number(minutesRemaining) || 0),
      totalBreakMinutes: Math.max(0, Number(totalBreakMinutes) || 0),
      overBreakMinutes: Math.max(0, Number(overBreakMinutes) || 0),
      read: false,
      archived: false,
      archivedAt: null,
      archivedByUserId: "",
      archivedByName: "",
      createdAt: now,
      updatedAt: now,
    });
    return true;
  } catch (err) {
    const code = Number(err?.code);
    const strCode = toText(err?.code || err?.status).toLowerCase();
    if (code === 6 || strCode === "already-exists") {
      return false;
    }
    throw err;
  }
};

const broadcastBreakNotification = async ({
  breakLogId = "",
  actorUserId = "",
  actorName = "",
  actorEmail = "",
  type = "",
  title = "",
  message = "",
  minutesUsed = 0,
  minutesRemaining = 0,
  totalBreakMinutes = 0,
  overBreakMinutes = 0,
  overBreakId = "",
}) => {
  const normalizedBreakLogId = toText(breakLogId);
  if (!normalizedBreakLogId || !toText(type)) return 0;

  const recipients = new Map();
  const portalUsers = await getBroadcastUsers();

  for (const user of portalUsers) {
    if (!toText(user?.userId)) continue;
    recipients.set(toText(user.userId), {
      userId: toText(user.userId),
      role: normalizeRole(user?.role),
    });
  }

  const normalizedActorUserId = toText(actorUserId);
  if (normalizedActorUserId) {
    recipients.set(normalizedActorUserId, {
      userId: normalizedActorUserId,
      role: ROLES.EMPLOYEE,
    });
  }

  let createdCount = 0;
  for (const recipient of recipients.values()) {
    const created = await createBreakNotificationIfMissing({
      recipientUserId: recipient.userId,
      recipientRole: recipient.role,
      breakLogId: normalizedBreakLogId,
      actorName,
      actorEmail,
      type,
      title,
      message,
      minutesUsed,
      minutesRemaining,
      totalBreakMinutes,
      overBreakMinutes,
      overBreakId,
    });
    if (created) createdCount += 1;
  }

  return createdCount;
};

const saveOverBreakNote = async ({ breakLogId = "", row = {}, totalBreakMinutes = 0 }) => {
  const normalizedBreakLogId = toText(breakLogId);
  const userId = toText(row?.userId);
  if (!normalizedBreakLogId || !userId) return "";

  const overBreakMinutes = Math.max(0, totalBreakMinutes - BREAK_LIMIT_MINUTES);
  const now = admin.firestore.Timestamp.now();
  const startedAtMs = toMillis(row?.startedAt);
  const overBreakStartMs = Number.isFinite(startedAtMs)
    ? startedAtMs + OVERBREAK_TRIGGER_MINUTES * 60 * 1000
    : Date.now();
  const overBreakStartedAt = admin.firestore.Timestamp.fromMillis(overBreakStartMs);

  await db.collection(OVERBREAK_NOTES_COLLECTION).doc(normalizedBreakLogId).set(
    {
      userId,
      name: toText(row?.name),
      email: normalizeEmail(row?.email),
      breakLogId: normalizedBreakLogId,
      startedAt: row?.startedAt || null,
      endedAt: row?.endedAt || null,
      overBreakStartedAt,
      totalBreakMinutes: Math.max(0, Number(totalBreakMinutes) || 0),
      overBreakMinutes,
      overBreakDurationLabel: formatDurationLabel(overBreakMinutes),
      graceMinutes: OVERBREAK_GRACE_MINUTES,
      limitMinutes: BREAK_LIMIT_MINUTES,
      triggerMinutes: OVERBREAK_TRIGGER_MINUTES,
      note: `Employee exceeded the 1-hour break limit. Current over-break: ${formatDurationLabel(
        overBreakMinutes
      )}. Total break: ${formatDurationLabel(totalBreakMinutes)}.`,
      archived: false,
      archivedAt: null,
      archivedByUserId: "",
      archivedByName: "",
      updatedAt: now,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return normalizedBreakLogId;
};

const processBreakThresholds = async ({
  breakLogId = "",
  beforeRow = {},
  afterRow = {},
  nowMs = Date.now(),
}) => {
  const normalizedBreakLogId = toText(breakLogId);
  const userId = toText(afterRow?.userId || beforeRow?.userId);
  if (!normalizedBreakLogId || !userId) return { updates: {} };

  const startedAt = afterRow?.startedAt || beforeRow?.startedAt;
  const totalBreakMinutes = minutesBetween(startedAt, nowMs);
  const overBreakMinutes = Math.max(0, totalBreakMinutes - BREAK_LIMIT_MINUTES);
  const displayName = getBreakDisplayName(afterRow, userId);
  const actorMeta = buildBreakMeta(afterRow);
  const beforeState = toBreakState(beforeRow);
  const afterState = toBreakState(afterRow);
  const updates = {};

  if (totalBreakMinutes >= BREAK_WARNING_MINUTES && !afterState.reminderSent && !beforeState.reminderSent) {
    await broadcastBreakNotification({
      breakLogId: normalizedBreakLogId,
      actorUserId: userId,
      actorName: actorMeta.name || displayName,
      actorEmail: actorMeta.email,
      type: "break_warning",
      title: "Break limit almost reached",
      message: `${displayName} is 5 minutes away from the 1-hour break limit.`,
      minutesUsed: totalBreakMinutes,
      minutesRemaining: Math.max(0, BREAK_LIMIT_MINUTES - totalBreakMinutes),
      totalBreakMinutes,
      overBreakMinutes,
    });
    updates.reminderSent = true;
    updates.reminderSentAt = admin.firestore.FieldValue.serverTimestamp();
  }

  if (
    totalBreakMinutes >= BREAK_LIMIT_MINUTES &&
    !afterState.limitReachedAlertSent &&
    !beforeState.limitReachedAlertSent
  ) {
    await broadcastBreakNotification({
      breakLogId: normalizedBreakLogId,
      actorUserId: userId,
      actorName: actorMeta.name || displayName,
      actorEmail: actorMeta.email,
      type: "break_limit_reached",
      title: "Break limit reached",
      message: `${displayName} has reached the 1-hour break limit.`,
      minutesUsed: totalBreakMinutes,
      minutesRemaining: 0,
      totalBreakMinutes,
      overBreakMinutes,
    });
    updates.limitReachedAlertSent = true;
    updates.limitReachedAlertSentAt = admin.firestore.FieldValue.serverTimestamp();
  }

  if (
    totalBreakMinutes >= OVERBREAK_TRIGGER_MINUTES &&
    (!afterState.overBreakAlertSent || !afterState.overBreakSaved) &&
    (!beforeState.overBreakAlertSent || !beforeState.overBreakSaved)
  ) {
    const overBreakId = await saveOverBreakNote({
      breakLogId: normalizedBreakLogId,
      row: afterRow,
      totalBreakMinutes,
    });

    await broadcastBreakNotification({
      breakLogId: normalizedBreakLogId,
      actorUserId: userId,
      actorName: actorMeta.name || displayName,
      actorEmail: actorMeta.email,
      type: "over_break_broadcast",
      title: "Over break alert",
      message: `${displayName} exceeded the break limit by ${formatDurationLabel(
        overBreakMinutes
      )}. Total break: ${formatDurationLabel(totalBreakMinutes)}.`,
      minutesUsed: totalBreakMinutes,
      minutesRemaining: 0,
      totalBreakMinutes,
      overBreakMinutes,
      overBreakId,
    });

    await createBreakNotificationIfMissing({
      recipientUserId: userId,
      recipientRole: ROLES.EMPLOYEE,
      breakLogId: normalizedBreakLogId,
      actorName: actorMeta.name || displayName,
      actorEmail: actorMeta.email,
      type: "over_break_employee",
      title: "Over-break recorded",
      message: "Your break exceeded the 1-hour break limit.",
      minutesUsed: totalBreakMinutes,
      minutesRemaining: 0,
      totalBreakMinutes,
      overBreakMinutes,
      overBreakId,
    });

    updates.overBreakSaved = true;
    updates.overBreakSavedAt = admin.firestore.FieldValue.serverTimestamp();
    updates.overBreakAlertSent = true;
    updates.overBreakAlertSentAt = admin.firestore.FieldValue.serverTimestamp();
  }

  return {
    updates,
    totalBreakMinutes,
    overBreakMinutes,
  };
};

const BREAK_THRESHOLD_TASK_QUEUE = "checkBreakThreshold";

// Schedules a one-off Cloud Task that fires exactly at the target threshold instant
// (startedAt + thresholdMinutes), instead of relying on a recurring poll to notice it.
// Cost is now proportional to breaks actually taken (a handful of tasks per break)
// rather than a fixed cost that runs 24/7 regardless of usage. If enqueueing fails
// (rare, e.g. a transient error), the low-frequency processActiveBreakThresholds
// safety-net sweep still catches the threshold on its next pass.
const enqueueBreakThresholdCheck = async (breakLogId, thresholdMinutes, startedAtMs) => {
  try {
    const nowMs = Date.now();
    const targetMs = Number(startedAtMs) + thresholdMinutes * 60 * 1000;
    const scheduleDelaySeconds = Math.max(0, Math.round((targetMs - nowMs) / 1000));
    const queue = getFunctions().taskQueue(BREAK_THRESHOLD_TASK_QUEUE);
    await queue.enqueue({ breakLogId, thresholdMinutes }, { scheduleDelaySeconds });
  } catch (err) {
    logger.error("Failed to enqueue break threshold check task.", {
      breakLogId,
      thresholdMinutes,
      message: toText(err?.message),
    });
  }
};

const listFromValue = (value) => (Array.isArray(value) ? value : []);

const normalizeAllowedPages = (allowedPages, role) => {
  const defaults = listFromValue(DEFAULT_ROLE_PAGES[role]);
  const custom = listFromValue(allowedPages)
    .map((page) => toText(page).toLowerCase())
    .filter(Boolean);

  return custom.length > 0 ? custom : defaults;
};

const hashPassword = (password, salt) =>
  nodeCrypto
    .createHash("sha256")
    .update(`${PASSWORD_HASH_PREFIX}:${String(salt || "")}:${String(password || "")}`)
    .digest("hex");

const createRandomHex = (byteLength = 16) => nodeCrypto.randomBytes(byteLength).toString("hex");

const buildPasswordSecret = (password) => {
  const salt = createRandomHex(16);
  const hash = hashPassword(password, salt);
  return {
    salt,
    hash,
  };
};

const verifyPasswordHash = (password, salt, expectedHash) => {
  const normalizedSalt = toText(salt);
  const normalizedExpected = toText(expectedHash).toLowerCase();
  if (!normalizedSalt || !normalizedExpected) return false;
  const actual = hashPassword(password, normalizedSalt);
  return actual.toLowerCase() === normalizedExpected;
};

const verifyFirebaseEmailPassword = async ({ email, password }) => {
  const apiKey = toText(process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY);
  if (!apiKey) return false;

  const endpoint =
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + apiKey;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: normalizeEmail(email),
        password: String(password || ""),
        returnSecureToken: true,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const buildDisplayName = (row = {}, fallbackEmail = "") => {
  const firstName = toText(row?.firstName);
  const lastName = toText(row?.lastName);
  const joined = `${firstName} ${lastName}`.trim();
  if (joined) return joined;
  const explicitName = toText(row?.name || row?.displayName);
  if (explicitName) return explicitName;
  return fallbackEmail || "Portal User";
};

const upsertEmployeeCredentialsRecord = async ({
  userId = "",
  employeeId = "",
  email = "",
  name = "",
  role = ROLES.EMPLOYEE,
  allowedPages = [],
  passwordSecret = null,
} = {}) => {
  const normalizedUserId = toText(userId);
  if (!normalizedUserId) return;

  const normalizedEmail = normalizeEmail(email);
  const normalizedName = toText(name) || normalizedEmail || normalizedUserId;
  const normalizedEmployeeId = toText(employeeId);
  const cleanAllowedPages = normalizeAllowedPages(allowedPages, ROLES.EMPLOYEE);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const payload = {
    userId: normalizedUserId,
    role: normalizeRole(role) || ROLES.EMPLOYEE,
    email: normalizedEmail,
    name: normalizedName,
    allowedPages: cleanAllowedPages,
    updatedAt: now,
  };

  if (normalizedEmployeeId) {
    payload.employeeId = normalizedEmployeeId;
  }

  if (passwordSecret?.salt && passwordSecret?.hash) {
    payload.portalPasswordSalt = toText(passwordSecret.salt);
    payload.portalPasswordHash = toText(passwordSecret.hash);
    payload.portalPasswordUpdatedAt = now;
  }

  await db.collection(EMPLOYEE_CREDENTIALS_COLLECTION).doc(normalizedUserId).set(
    payload,
    { merge: true }
  );
};

const validatePasswordPayload = (payload = {}) => {
  const oldPassword = toText(payload?.oldPassword || payload?.currentPassword);
  const newPassword = toText(payload?.newPassword);
  const confirmPassword = toText(payload?.confirmPassword);

  if (!oldPassword) {
    throw new HttpsError("invalid-argument", "Old password is required.");
  }
  if (!newPassword) {
    throw new HttpsError("invalid-argument", "New password is required.");
  }
  if (newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "New password must be at least 6 characters.");
  }
  if (confirmPassword && confirmPassword !== newPassword) {
    throw new HttpsError("invalid-argument", "New password and confirm password do not match.");
  }

  return {
    oldPassword,
    newPassword,
  };
};

exports.checkEmployeeCredentialsEmail = onCall(callableRuntimeOptions, async (request) => {
  const rawEmail = toText(request?.data?.email);
  const normalizedEmail = normalizeEmail(rawEmail);

  if (!normalizedEmail) {
    throw new HttpsError("invalid-argument", "Email is required.");
  }

  const candidates = Array.from(new Set([normalizedEmail, rawEmail].filter(Boolean)));

  for (const candidateEmail of candidates) {
    const snap = await db
      .collection(EMPLOYEE_CREDENTIALS_COLLECTION)
      .where("email", "==", candidateEmail)
      .limit(1)
      .get();

    if (!snap.empty) {
      const row = snap.docs[0];
      return {
        exists: true,
        email: normalizedEmail,
        match: {
          docId: row.id,
          email: normalizeEmail(row.data()?.email || candidateEmail),
        },
      };
    }
  }

  return {
    exists: false,
    email: normalizedEmail,
  };
});

const verifyEmployeePassword = async ({ userId, oldPassword, row = {} }) => {
  const storedSalt = toText(row?.portalPasswordSalt);
  const storedHash = toText(row?.portalPasswordHash);

  if (storedSalt && storedHash) {
    return verifyPasswordHash(oldPassword, storedSalt, storedHash);
  }

  const legacyPassword = toText(process.env.EMPLOYEE_PORTAL_PASSWORD);
  const isLegacyMatch = !!legacyPassword && oldPassword === legacyPassword;

  if (isLegacyMatch && userId) {
    const passwordSecret = buildPasswordSecret(oldPassword);
    const now = admin.firestore.FieldValue.serverTimestamp();

    await db.collection(USER_PERMISSIONS_COLLECTION).doc(userId).set(
      {
        portalPasswordSalt: passwordSecret.salt,
        portalPasswordHash: passwordSecret.hash,
        portalPasswordUpdatedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    await upsertEmployeeCredentialsRecord({
      userId,
      employeeId: row?.employeeId,
      email: row?.email,
      name: buildDisplayName(row, normalizeEmail(row?.email)),
      role: ROLES.EMPLOYEE,
      allowedPages: row?.allowedPages,
      passwordSecret,
    });
  }

  return isLegacyMatch;
};

exports.issueSessionToken = onCall(callableRuntimeOptions, async (request) => {
  const mode = toText(request?.data?.mode || request?.data?.action).toLowerCase();
  if (mode === "check_employee_credentials_email") {
    const rawEmail = toText(request?.data?.email || request?.data?.identifier);
    const normalizedEmail = normalizeEmail(rawEmail);

    if (!normalizedEmail) {
      throw new HttpsError("invalid-argument", "Email is required.");
    }

    const candidates = Array.from(new Set([normalizedEmail, rawEmail].filter(Boolean)));

    for (const candidateEmail of candidates) {
      const snap = await db
        .collection(EMPLOYEE_CREDENTIALS_COLLECTION)
        .where("email", "==", candidateEmail)
        .limit(1)
        .get();

      if (!snap.empty) {
        return {
          exists: true,
          email: normalizedEmail,
        };
      }
    }

    return {
      exists: false,
      email: normalizedEmail,
    };
  }

  const identifier = toText(request?.data?.identifier);
  const password = toText(request?.data?.password);
  let stage = "input-validation";

  if (!identifier) {
    throw new HttpsError("invalid-argument", "Enter your email or employee ID.");
  }
  if (!password) {
    throw new HttpsError("invalid-argument", "Enter your password.");
  }

  const normalizedIdentifier = identifier.toLowerCase();
  const looksLikeEmail = normalizedIdentifier.includes("@");

  try {
    if (looksLikeEmail) {
      stage = "portal-user-query";
      const portalQuerySnap = await db
        .collection(USERS_COLLECTION)
        .where("email", "==", normalizedIdentifier)
        .limit(1)
        .get();

      if (!portalQuerySnap.empty) {
        const portalDoc = portalQuerySnap.docs[0];
        const portalData = portalDoc.data() || {};
        const role = normalizeRole(portalData?.role);

        if (PORTAL_ROLES.has(role)) {
          stage = "portal-password-verify";
          let valid = verifyPasswordHash(
            password,
            portalData?.portalPasswordSalt,
            portalData?.portalPasswordHash
          );

          if (!valid) {
            stage = "portal-firebase-password-verify";
            valid = await verifyFirebaseEmailPassword({
              email: normalizedIdentifier,
              password,
            });

            if (valid) {
              stage = "portal-password-migrate";
              const migrated = buildPasswordSecret(password);
              await portalDoc.ref.set(
                {
                  portalPasswordSalt: migrated.salt,
                  portalPasswordHash: migrated.hash,
                  portalPasswordUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            }
          }

          if (!valid) {
            throw new HttpsError("permission-denied", "Invalid credentials.");
          }

          const uid = toText(portalData?.uid || portalDoc.id);
          if (!uid) {
            throw new HttpsError("failed-precondition", "Portal user is missing uid.");
          }

          const email = normalizeEmail(portalData?.email || normalizedIdentifier);
          stage = "portal-create-custom-token";
          const token = await admin.auth().createCustomToken(uid, {
            role,
            userId: uid,
          });

          return {
            customToken: token,
            user: {
              id: uid,
              uid,
              userId: uid,
              email,
              name: buildDisplayName(portalData, email),
              role,
              allowedPages: normalizeAllowedPages(portalData?.allowedPages, role),
              profile: {
                uid,
                email,
                role,
                firstName: toText(portalData?.firstName),
                lastName: toText(portalData?.lastName),
                allowedPages: normalizeAllowedPages(portalData?.allowedPages, role),
              },
            },
          };
        }
      }
    }

    let permissionDoc = null;

    if (looksLikeEmail) {
      stage = "employee-permission-query-by-email";
      const permissionSnap = await db
        .collection(USER_PERMISSIONS_COLLECTION)
        .where("email", "==", normalizedIdentifier)
        .limit(1)
        .get();

      if (!permissionSnap.empty) {
        permissionDoc = permissionSnap.docs[0];
      }
    } else {
      stage = "employee-permission-query-by-id";
      const directSnap = await db.collection(USER_PERMISSIONS_COLLECTION).doc(identifier).get();
      if (directSnap.exists) {
        permissionDoc = directSnap;
      }
    }

    if (!permissionDoc || !permissionDoc.exists) {
      throw new HttpsError("permission-denied", "No matching user found.");
    }

    const permissionData = permissionDoc.data() || {};
    const employeeUserId = toText(permissionData?.userId || permissionDoc.id);

    if (!employeeUserId) {
      throw new HttpsError("failed-precondition", "Employee permission record is missing userId.");
    }

    const validEmployeePassword = await verifyEmployeePassword({
      userId: employeeUserId,
      oldPassword: password,
      row: permissionData,
    });

    if (!validEmployeePassword) {
      throw new HttpsError("permission-denied", "Invalid credentials.");
    }

    const role = ROLES.EMPLOYEE;
    stage = "employee-create-custom-token";
    const token = await admin.auth().createCustomToken(employeeUserId, {
      role,
      userId: employeeUserId,
    });

    const email = normalizeEmail(permissionData?.email || "");

    return {
      customToken: token,
      user: {
        id: employeeUserId,
        uid: employeeUserId,
        userId: employeeUserId,
        email,
        name: buildDisplayName(permissionData, email || employeeUserId),
        role,
        allowedPages: normalizeAllowedPages(permissionData?.allowedPages, role),
      },
    };
  } catch (err) {
    if (err instanceof HttpsError) {
      throw err;
    }

    const errMsg = toText(err?.message).toLowerCase();
    const errCode = toText(err?.code);

    logger.error("issueSessionToken failed", {
      stage,
      looksLikeEmail,
      identifier: looksLikeEmail ? normalizedIdentifier : "[employee-id]",
      errorCode: errCode,
      errorMessage: toText(err?.message),
      stack: toText(err?.stack),
    });

    if (errMsg.includes("iam.serviceaccounts.signblob")) {
      throw new HttpsError(
        "failed-precondition",
        "Token signing is not configured for this Cloud Function service account."
      );
    }

    if (
      errMsg.includes("deadline exceeded") ||
      errMsg.includes("service unavailable") ||
      errMsg.includes("timed out")
    ) {
      throw new HttpsError("unavailable", "Login service is temporarily unavailable. Try again.");
    }

    throw new HttpsError("internal", `Could not sign in right now. Stage: ${stage}`);
  }
});

exports.changeOwnPassword = onCall(callableRuntimeOptions, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const uid = toText(request.auth.uid);
  const tokenRole = normalizeRole(request.auth.token?.role);
  const { oldPassword, newPassword } = validatePasswordPayload(request?.data || {});

  const isEmployee = tokenRole === ROLES.EMPLOYEE;
  const targetCollection = isEmployee ? USER_PERMISSIONS_COLLECTION : USERS_COLLECTION;

  try {
    const ref = db.collection(targetCollection).doc(uid);
    const snap = await ref.get();

    if (!snap.exists) {
      throw new HttpsError("not-found", "Account profile not found.");
    }

    const current = snap.data() || {};
    let validOldPassword = false;

    if (isEmployee) {
      validOldPassword = await verifyEmployeePassword({
        userId: uid,
        oldPassword,
        row: current,
      });
    } else {
      validOldPassword = verifyPasswordHash(
        oldPassword,
        current?.portalPasswordSalt,
        current?.portalPasswordHash
      );
    }

    if (!validOldPassword) {
      return {
        success: false,
        message: "Old password is incorrect.",
      };
    }

    const passwordSecret = buildPasswordSecret(newPassword);
    await ref.set(
      {
        portalPasswordSalt: passwordSecret.salt,
        portalPasswordHash: passwordSecret.hash,
        portalPasswordUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (isEmployee) {
      await upsertEmployeeCredentialsRecord({
        userId: uid,
        employeeId: current?.employeeId,
        email: current?.email,
        name: buildDisplayName(current, normalizeEmail(current?.email)),
        role: ROLES.EMPLOYEE,
        allowedPages: current?.allowedPages,
        passwordSecret,
      });
    }

    return {
      success: true,
      message: "Portal password updated successfully.",
    };
  } catch (err) {
    if (err instanceof HttpsError) {
      throw err;
    }

    logger.error("changeOwnPassword failed", err);
    throw new HttpsError("internal", "Could not update password.");
  }
});

exports.adminResetEmployeePassword = onCall(callableRuntimeOptions, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const actorUid = toText(request.auth.uid);
  const actorTokenRole = normalizeRole(request.auth.token?.role);
  let actorRole = actorTokenRole;

  if (!actorRole) {
    const actorSnap = await db.collection(USERS_COLLECTION).doc(actorUid).get();
    const actorData = actorSnap.exists ? actorSnap.data() || {} : {};
    actorRole = normalizeRole(actorData?.role);
  }

  if (actorRole !== ROLES.SUPER_ADMIN) {
    throw new HttpsError(
      "permission-denied",
      "Only Super Admin can update employee password."
    );
  }

  const userId = toText(request?.data?.userId);
  const incomingEmail = normalizeEmail(request?.data?.email);
  const incomingName = toText(request?.data?.name);
  const incomingEmployeeId = toText(request?.data?.employeeId);
  const newPassword = toText(request?.data?.newPassword);

  if (!userId) {
    throw new HttpsError("invalid-argument", "Employee user id is required.");
  }
  if (!newPassword) {
    throw new HttpsError("invalid-argument", "New password is required.");
  }
  if (newPassword.length < 6) {
    throw new HttpsError(
      "invalid-argument",
      "New password must be at least 6 characters."
    );
  }

  const targetRef = db.collection(USERS_COLLECTION).doc(userId);
  const targetSnap = await targetRef.get();
  const targetData = targetSnap.exists ? targetSnap.data() || {} : {};
  const targetRole = normalizeRole(targetData?.role);

  if (targetRole && targetRole !== ROLES.EMPLOYEE) {
    throw new HttpsError("failed-precondition", "Selected user is not an employee.");
  }

  const resolvedEmail = normalizeEmail(incomingEmail || targetData?.email);
  if (!resolvedEmail) {
    throw new HttpsError(
      "invalid-argument",
      "Employee email is required to create Firebase Authentication account."
    );
  }

  const resolvedName =
    incomingName ||
    buildDisplayName(targetData, resolvedEmail || userId) ||
    resolvedEmail ||
    userId;
  const resolvedEmployeeId = incomingEmployeeId || toText(targetData?.employeeId) || userId;
  const allowedPages = normalizeAllowedPages(targetData?.allowedPages, ROLES.EMPLOYEE);

  let authUserCreated = false;
  let authUserUpdated = false;

  try {
    const authUser = await admin.auth().getUser(userId);
    const updatePayload = {
      password: newPassword,
    };

    if (resolvedEmail && normalizeEmail(authUser?.email) !== resolvedEmail) {
      updatePayload.email = resolvedEmail;
    }
    if (resolvedName && toText(authUser?.displayName) !== resolvedName) {
      updatePayload.displayName = resolvedName;
    }

    await admin.auth().updateUser(userId, updatePayload);
    authUserUpdated = true;
  } catch (error) {
    const code = toText(error?.code);
    if (code !== "auth/user-not-found") {
      if (code === "auth/email-already-exists") {
        throw new HttpsError(
          "already-exists",
          "This email already belongs to another Authentication user."
        );
      }
      logger.error("adminResetEmployeePassword auth lookup/update failed", {
        userId,
        code,
        message: toText(error?.message),
      });
      throw new HttpsError("internal", "Could not update Authentication user.");
    }

    try {
      await admin.auth().createUser({
        uid: userId,
        email: resolvedEmail,
        password: newPassword,
        displayName: resolvedName || undefined,
      });
      authUserCreated = true;
    } catch (createError) {
      const createCode = toText(createError?.code);
      if (createCode === "auth/email-already-exists") {
        throw new HttpsError(
          "already-exists",
          "This email already belongs to another Authentication user."
        );
      }
      logger.error("adminResetEmployeePassword auth create failed", {
        userId,
        code: createCode,
        message: toText(createError?.message),
      });
      throw new HttpsError("internal", "Could not create Authentication user.");
    }
  }

  const passwordSecret = buildPasswordSecret(newPassword);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await targetRef.set(
    {
      uid: userId,
      userId,
      employeeId: resolvedEmployeeId,
      email: resolvedEmail,
      name: resolvedName,
      role: ROLES.EMPLOYEE,
      allowedPages,
      portalPasswordSalt: passwordSecret.salt,
      portalPasswordHash: passwordSecret.hash,
      portalPasswordUpdatedAt: now,
      updatedAt: now,
      ...(targetSnap.exists ? {} : { createdAt: now }),
    },
    { merge: true }
  );

  await db.collection(USER_PERMISSIONS_COLLECTION).doc(userId).set(
    {
      userId,
      employeeId: resolvedEmployeeId,
      email: resolvedEmail,
      name: resolvedName,
      role: ROLES.EMPLOYEE,
      allowedPages,
      portalPasswordSalt: passwordSecret.salt,
      portalPasswordHash: passwordSecret.hash,
      portalPasswordUpdatedAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  await upsertEmployeeCredentialsRecord({
    userId,
    employeeId: resolvedEmployeeId,
    email: resolvedEmail,
    name: resolvedName,
    role: ROLES.EMPLOYEE,
    allowedPages,
    passwordSecret,
  });

  return {
    success: true,
    userId,
    authUserCreated,
    authUserUpdated,
  };
});

exports.adminDeletePortalUserAccount = onCall(callableRuntimeOptions, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const actorUid = toText(request.auth.uid);
  const actorTokenRole = normalizeRole(request.auth.token?.role);
  let actorRole = actorTokenRole;

  if (!actorRole) {
    const actorSnap = await db.collection(USERS_COLLECTION).doc(actorUid).get();
    const actorData = actorSnap.exists ? actorSnap.data() || {} : {};
    actorRole = normalizeRole(actorData?.role);
  }

  if (actorRole !== ROLES.SUPER_ADMIN) {
    throw new HttpsError(
      "permission-denied",
      "Only Super Admin can delete portal user accounts."
    );
  }

  const userId = toText(request?.data?.userId);
  if (!userId) {
    throw new HttpsError("invalid-argument", "User id is required.");
  }
  if (userId === actorUid) {
    throw new HttpsError("failed-precondition", "You cannot delete your own account.");
  }

  const targetRef = db.collection(USERS_COLLECTION).doc(userId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "User profile not found.");
  }

  const targetData = targetSnap.data() || {};
  const targetRole = normalizeRole(targetData?.role);
  const deletablePortalRoles = [ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR];

  if (targetRole === ROLES.SUPER_ADMIN) {
    throw new HttpsError("failed-precondition", "Super Admin cannot be deleted from this action.");
  }
  if (!deletablePortalRoles.includes(targetRole)) {
    throw new HttpsError(
      "failed-precondition",
      "Only special portal users can be deleted from this action."
    );
  }

  let authDeleted = false;
  try {
    await admin.auth().deleteUser(userId);
    authDeleted = true;
  } catch (error) {
    const code = toText(error?.code);
    if (code !== "auth/user-not-found") {
      logger.error("adminDeletePortalUserAccount auth delete failed", {
        userId,
        code,
        message: toText(error?.message),
      });
      throw new HttpsError("internal", "Could not delete Authentication user.");
    }
  }

  await Promise.all([
    db.collection(USERS_COLLECTION).doc(userId).delete(),
    db.collection(USER_PERMISSIONS_COLLECTION).doc(userId).delete(),
    db.collection(ACTIVE_SESSIONS_COLLECTION).doc(userId).delete(),
    db.collection(EMPLOYEE_CREDENTIALS_COLLECTION).doc(userId).delete(),
  ]);

  return {
    success: true,
    userId,
    role: targetRole,
    email: normalizeEmail(targetData?.email),
    authDeleted,
  };
});

exports.fetchAttendanceLogsBatch = onCall(callableRuntimeOptions, async (request) => {
  const data = request?.data || {};
  const apiKey = toText(data?.apiKey);
  const baseUrl = toText(data?.baseUrl || "https://us-central1-hyacinthattendance.cloudfunctions.net");
  const startDate = toText(data?.startDate);
  const endDate = toText(data?.endDate);
  const userIds = Array.isArray(data?.userIds)
    ? data.userIds.map((value) => toText(value)).filter(Boolean)
    : [];

  if (!apiKey) {
    throw new HttpsError("invalid-argument", "apiKey is required.");
  }
  if (!baseUrl) {
    throw new HttpsError("invalid-argument", "baseUrl is required.");
  }
  if (userIds.length === 0) {
    return {
      success: true,
      logsByUserId: {},
      errorsByUserId: {},
    };
  }

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const endpoint = `${normalizedBase}/getAttendanceLogs`;
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
  };

  const logsByUserId = {};
  const errorsByUserId = {};

  const fetchOneUser = async (userId) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        apiKey,
        userId,
        startDate,
        endDate,
      }),
    });

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (!response.ok || parsed?.success === false) {
      throw new Error(parsed?.message || `Failed to load attendance for ${userId}`);
    }

    const payload = parsed && Object.prototype.hasOwnProperty.call(parsed, "data")
      ? parsed.data
      : parsed;
    logsByUserId[userId] = Array.isArray(payload) ? payload : [];
  };

  const MAX_CONCURRENCY = 8;
  let index = 0;

  const runners = new Array(Math.min(MAX_CONCURRENCY, userIds.length))
    .fill(0)
    .map(async () => {
      while (index < userIds.length) {
        const idx = index++;
        const userId = userIds[idx];
        try {
          await fetchOneUser(userId);
        } catch (error) {
          errorsByUserId[userId] = toText(error?.message || "Failed to load attendance logs");
          logsByUserId[userId] = [];
        }
      }
    });

  await Promise.all(runners);

  return {
    success: true,
    logsByUserId,
    errorsByUserId,
  };
});

exports.processBreakLogWrite = onDocumentWritten(
  {
    region: "us-central1",
    document: `${BREAK_LOGS_COLLECTION}/{breakLogId}`,
    retry: false,
    secrets: [HYACINTH_API_KEY],
  },
  async (event) => {
    const breakLogId = toText(event?.params?.breakLogId);
    const beforeRow = event?.data?.before?.exists ? event.data.before.data() || {} : {};
    const afterExists = !!event?.data?.after?.exists;
    const afterRow = afterExists ? event.data.after.data() || {} : {};
    if (!afterExists || !breakLogId) return;

    const beforeActive = !!beforeRow?.isActive;
    const afterActive = !!afterRow?.isActive;
    const userId = toText(afterRow?.userId || beforeRow?.userId);
    const displayName = getBreakDisplayName(afterRow, userId);

    if (!event?.data?.before?.exists && afterActive) {
      await broadcastBreakNotification({
        breakLogId,
        actorUserId: userId,
        actorName: toText(afterRow?.name || displayName),
        actorEmail: normalizeEmail(afterRow?.email),
        type: "break_started",
        title: "Employee on break",
        message: `${displayName} is currently on break.`,
        minutesUsed: 0,
        minutesRemaining: BREAK_LIMIT_MINUTES,
        totalBreakMinutes: 0,
        overBreakMinutes: 0,
      });

      const startedAtMs = toMillis(afterRow?.startedAt) || Date.now();
      await Promise.all([
        enqueueBreakThresholdCheck(breakLogId, BREAK_WARNING_MINUTES, startedAtMs),
        enqueueBreakThresholdCheck(breakLogId, BREAK_LIMIT_MINUTES, startedAtMs),
        enqueueBreakThresholdCheck(breakLogId, OVERBREAK_TRIGGER_MINUTES, startedAtMs),
      ]);

      try {
        await refreshEmployeeProcessStatusForUsers([userId]);
      } catch (err) {
        logger.error("Failed to refresh employee process status after break start.", {
          userId,
          message: toText(err?.message),
        });
      }
      return;
    }

    if (beforeActive && !afterActive) {
      const endedAtMs = toMillis(afterRow?.endedAt) || Date.now();
      const { updates, totalBreakMinutes, overBreakMinutes } = await processBreakThresholds({
        breakLogId,
        beforeRow,
        afterRow,
        nowMs: endedAtMs,
      });

      if (Object.keys(updates).length > 0) {
        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        await db.collection(BREAK_LOGS_COLLECTION).doc(breakLogId).set(updates, { merge: true });
      }

      await broadcastBreakNotification({
        breakLogId,
        actorUserId: userId,
        actorName: toText(afterRow?.name || displayName),
        actorEmail: normalizeEmail(afterRow?.email),
        type: "break_ended",
        title: "Employee back from break",
        message: `${displayName} is back from break. Total break time: ${formatDurationLabel(
          totalBreakMinutes
        )}.`,
        minutesUsed: totalBreakMinutes,
        minutesRemaining: Math.max(0, BREAK_LIMIT_MINUTES - totalBreakMinutes),
        totalBreakMinutes,
        overBreakMinutes,
      });

      try {
        await refreshEmployeeProcessStatusForUsers([userId]);
      } catch (err) {
        logger.error("Failed to refresh employee process status after break end.", {
          userId,
          message: toText(err?.message),
        });
      }
    }
  }
);

// Fired by the one-off Cloud Task scheduled in enqueueBreakThresholdCheck, exactly at
// the instant a break crosses one of the warning/limit/over-break thresholds. Reuses
// processBreakThresholds (already idempotent via the reminderSent/limitReachedAlertSent/
// overBreakAlertSent/overBreakSaved flags), so this fires whichever thresholds are
// actually due as of right now - it does not need to trust which specific threshold it
// was originally scheduled for. If the break already ended, this is a harmless no-op.
exports.checkBreakThreshold = onTaskDispatched(
  {
    region: "us-central1",
    memory: "128MiB",
    timeoutSeconds: 30,
    retryConfig: {
      maxAttempts: 3,
      minBackoffSeconds: 30,
    },
    rateLimits: {
      maxConcurrentDispatches: 6,
    },
  },
  async (req) => {
    const breakLogId = toText(req?.data?.breakLogId);
    if (!breakLogId) return;

    const ref = db.collection(BREAK_LOGS_COLLECTION).doc(breakLogId);
    const snap = await ref.get();
    if (!snap.exists) return;

    const row = snap.data() || {};
    if (!row?.isActive) return;

    const { updates } = await processBreakThresholds({
      breakLogId,
      beforeRow: row,
      afterRow: row,
      nowMs: Date.now(),
    });

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      await ref.set(updates, { merge: true });
    }
  }
);

// Cloud Tasks (enqueued at break-start, see enqueueBreakThresholdCheck) is now the
// primary mechanism for catching the warning/limit/over-break thresholds, at a cost
// proportional to breaks actually taken instead of a fixed 24/7 cost. This sweep only
// exists as an infrequent safety net for the rare case a task failed to enqueue or
// fire (e.g. a transient error) - it is not the main path anymore.
exports.processActiveBreakThresholds = onSchedule(
  {
    region: "us-central1",
    schedule: "every 30 minutes",
    timeZone: "America/Chicago",
    retryCount: 0,
    maxInstances: 1,
    memory: "128MiB",
    timeoutSeconds: 30,
  },
  async () => {
    const nowMs = Date.now();

    const warningThreshold = admin.firestore.Timestamp.fromMillis(
      nowMs - BREAK_WARNING_MINUTES * 60 * 1000
    );

    const activeBreakSnap = await db
      .collection(BREAK_LOGS_COLLECTION)
      .where("isActive", "==", true)
      .where("startedAt", "<=", warningThreshold)
      .limit(BREAK_SCAN_LIMIT)
      .get();

    if (activeBreakSnap.empty) {
      logger.info("No active breaks at or past warning threshold.");
      return;
    }

    logger.info(`Processing ${activeBreakSnap.size} active break threshold checks.`);

    for (const docSnap of activeBreakSnap.docs) {
      const breakLogId = toText(docSnap.id);
      const row = docSnap.data() || {};

      const { updates } = await processBreakThresholds({
        breakLogId,
        beforeRow: row,
        afterRow: row,
        nowMs,
      });

      if (Object.keys(updates).length > 0) {
        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        await db.collection(BREAK_LOGS_COLLECTION).doc(breakLogId).set(updates, { merge: true });
      }
    }
  }
);

/* ============================================================================
 * Employee Process (Inbound / New Lead rotation) - server-authoritative status
 *
 * Previously, each browser tab independently computed "who's available" from a
 * mix of live-subscribed and periodically-polled data, and independently wrote
 * rotation decisions. Different tabs could disagree (a backgrounded tab's poll
 * is paused; a timezone edge case resolves a few seconds apart) and two tabs
 * could race to write conflicting decisions with no transaction protecting it.
 *
 * This section makes the server the single source of truth: it periodically
 * (and on break start/end) computes each rotation employee's status and writes
 * it to employee_process_settings/default.statusByUserId, and owns the actual
 * "who becomes IB/NL next" decision inside Firestore transactions. Clients
 * subscribe to the result and call finishEmployeeProcessTurn/
 * markEmployeeProcessReady instead of writing assignments directly.
 *
 * The logic below is intentionally duplicated (not shared as a module) from
 * its client-side counterparts, per a deliberate choice to avoid restructuring
 * the Vite/Firebase Functions build split. Each ported block below names the
 * client file/function it mirrors - keep them in sync when editing either.
 * ============================================================================ */

const EMPLOYEE_PROCESS_SETTINGS_COLLECTION = "employee_process_settings";
const EMPLOYEE_PROCESS_SETTINGS_DOC_ID = "default";
const EMPLOYEE_PROCESS_ACTION_LOGS_COLLECTION = "employee_process_action_logs";
// Per-employee computed status now lives in its own collection (one doc per
// userId) instead of a single statusByUserId map field on the settings doc -
// each employee's status updates independently, and readyOverrideSignature
// (the persisted "I'm Ready" confirmation) lives alongside it on the same doc.
const EMPLOYEE_PROCESS_STATUS_COLLECTION = "employee_process_status";

const pick = (obj, keys, fallback = "") => {
  for (const key of Array.isArray(keys) ? keys : []) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).length) return value;
  }
  return fallback;
};

/* ---- schedule timezone resolution (ported from src/utils/scheduleTime.js) ---- */

const DEFAULT_SCHEDULE_TIME_ZONE = "America/Chicago";

const SCHEDULE_START_UTC_KEYS = [
  "utcTimeIn", "utcStart", "startUtc", "utcTimeStart",
  "utc_time_in", "utc_start", "timeInUtc", "timeInUTC",
];
const SCHEDULE_END_UTC_KEYS = [
  "utcTimeOut", "utcEnd", "endUtc", "utcTimeEnd",
  "utc_time_out", "utc_end", "timeOutUtc", "timeOutUTC",
];
const SCHEDULE_START_LOCAL_KEYS = ["timeIn", "time_in", "startTime", "shiftStart", "start"];
const SCHEDULE_END_LOCAL_KEYS = ["timeOut", "time_out", "endTime", "shiftEnd", "end"];
const SCHEDULE_TIME_ZONE_KEYS = [
  "timeRegion", "timezone", "timeZone", "tz", "scheduleTimezone", "scheduleTimeZone",
];

const isValidDayKey = (dayKey) => /^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ""));

const parseHhMm = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const match24 = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match24) {
    const hour = Number(match24[1]);
    const minute = Number(match24[2]);
    const second = Number(match24[3] || 0);
    if (
      !Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second) ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59
    ) {
      return null;
    }
    return { hour, minute, second };
  }

  const match12 = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (!match12) return null;

  let hour = Number(match12[1]);
  const minute = Number(match12[2]);
  const second = Number(match12[3] || 0);
  const ampm = String(match12[4] || "").toUpperCase();

  if (
    !Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second) ||
    hour < 1 || hour > 12 || minute < 0 || minute > 59 || second < 0 || second > 59
  ) {
    return null;
  }

  if (ampm === "AM") {
    if (hour === 12) hour = 0;
  } else if (ampm === "PM") {
    if (hour < 12) hour += 12;
  } else {
    return null;
  }

  return { hour, minute, second };
};

const parseUtcMsValue = (value) => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

const partsFromUtcMs = (ms) => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
};

const parseEpochToMs = (value) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return NaN;
    return Math.abs(value) < 1e11 ? value * 1000 : value;
  }
  const n = Number(String(value || "").trim());
  if (!Number.isFinite(n)) return NaN;
  return Math.abs(n) < 1e11 ? n * 1000 : n;
};

const parseUtcClockParts = (value) => {
  if (value == null) return null;

  if (typeof value?.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? partsFromUtcMs(ms) : null;
  }
  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? partsFromUtcMs(d.getTime()) : null;
  }
  if (value instanceof Date) return partsFromUtcMs(value.getTime());

  if (typeof value === "object") {
    const seconds = Number(value.seconds ?? value._seconds);
    const nanos = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
    if (Number.isFinite(seconds)) {
      const ms = seconds * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1e6);
      return partsFromUtcMs(ms);
    }
  }

  const epochMs = parseEpochToMs(value);
  if (Number.isFinite(epochMs)) {
    const epochParts = partsFromUtcMs(epochMs);
    if (epochParts) return epochParts;
  }

  const raw = String(value || "").trim();
  if (!raw) return null;

  const clock = parseHhMm(raw);
  if (clock) return clock;

  const dateTimeNoTz = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dateTimeNoTz) {
    const hour = Number(dateTimeNoTz[4]);
    const minute = Number(dateTimeNoTz[5]);
    const second = Number(dateTimeNoTz[6] || 0);
    if (
      Number.isFinite(hour) && Number.isFinite(minute) && Number.isFinite(second) &&
      hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59
    ) {
      return { hour, minute, second };
    }
  }

  const parsed = parseUtcMsValue(raw);
  return Number.isFinite(parsed) ? partsFromUtcMs(parsed) : null;
};

const normalizeTimeZoneValue = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  if (upper === "UTC" || upper === "GMT" || upper === "Z") return "UTC";
  if (raw.includes("/")) return raw;
  return "";
};

const getSafeTimeZone = (timeZone, fallback = DEFAULT_SCHEDULE_TIME_ZONE) => {
  const preferred =
    normalizeTimeZoneValue(timeZone) ||
    normalizeTimeZoneValue(fallback) ||
    DEFAULT_SCHEDULE_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: preferred }).format(new Date(0));
    return preferred;
  } catch {
    return DEFAULT_SCHEDULE_TIME_ZONE;
  }
};

const getScheduleTimeZoneOffsetMs = (utcMs, timeZone) => {
  const safeTimeZone = getSafeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, hourCycle: "h23",
  }).formatToParts(new Date(utcMs));

  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  const pseudoUtcMs = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second)
  );

  return pseudoUtcMs - utcMs;
};

const rebaseUtcIsoToDay = (utcIso, dayKey) => {
  if (!isValidDayKey(dayKey)) return NaN;
  const parts = parseUtcClockParts(utcIso);
  if (!parts) return NaN;
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  const ss = String(parts.second).padStart(2, "0");
  return parseUtcMsValue(`${dayKey}T${hh}:${mm}:${ss}.000Z`);
};

const clockInZoneToUtcMs = (dayKey, hhmm, timeZone) => {
  if (!isValidDayKey(dayKey)) return NaN;
  const parsed = parseHhMm(hhmm);
  if (!parsed) return NaN;

  const [year, month, day] = String(dayKey).split("-").map((n) => Number(n));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;

  const approxUtcMs = Date.UTC(year, month - 1, day, parsed.hour, parsed.minute, parsed.second);
  const offsetMs = getScheduleTimeZoneOffsetMs(approxUtcMs, timeZone);
  return approxUtcMs - offsetMs;
};

const getScheduleTimeZone = (scheduleItem, fallback = DEFAULT_SCHEDULE_TIME_ZONE) => {
  const raw = pick(scheduleItem || {}, SCHEDULE_TIME_ZONE_KEYS, fallback);
  return getSafeTimeZone(raw, fallback);
};

// Local timeIn+timeRegion is checked FIRST and re-derives the UTC instant for
// the ACTUAL target day (DST-aware, via clockInZoneToUtcMs's Intl-based zone
// math). The stored absolute UTC fields (utcTimeIn etc.) are a frozen
// snapshot from whenever the schedule was last saved - reapplying their raw
// UTC clock time to a different day ignores any DST shift between then and
// now, silently drifting duty-start by up to an hour across a DST boundary.
// They're now only a fallback for schedule items with no local time/timezone
// at all.
const resolveScheduledStartUtcMsForDayKey = (scheduleItem, dayKey) => {
  if (!scheduleItem || !isValidDayKey(dayKey)) return NaN;

  const localClock = pick(scheduleItem, SCHEDULE_START_LOCAL_KEYS, "");
  if (localClock) {
    const tz = getScheduleTimeZone(scheduleItem, DEFAULT_SCHEDULE_TIME_ZONE);
    const convertedUtc = clockInZoneToUtcMs(dayKey, localClock, tz);
    if (Number.isFinite(convertedUtc)) return convertedUtc;
  }

  for (const key of SCHEDULE_START_UTC_KEYS) {
    const raw = scheduleItem?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const rebasedUtc = rebaseUtcIsoToDay(raw, dayKey);
    if (Number.isFinite(rebasedUtc)) return rebasedUtc;
  }

  return NaN;
};

const resolveScheduledDurationMinutes = (scheduleItem, defaultMinutes = 600) => {
  const rawHours = Number(pick(scheduleItem || {}, ["shiftDuration", "hours", "durationHours"], NaN));
  if (Number.isFinite(rawHours) && rawHours > 0) return Math.round(rawHours * 60);
  return Math.max(1, Math.round(Number(defaultMinutes) || 600));
};

const resolveScheduledEndUtcMsForDayKey = (scheduleItem, dayKey) => {
  if (!scheduleItem || !isValidDayKey(dayKey)) return NaN;

  const startMs = resolveScheduledStartUtcMsForDayKey(scheduleItem, dayKey);
  if (!Number.isFinite(startMs)) return NaN;

  // Same DST-safety reordering as resolveScheduledStartUtcMsForDayKey: local
  // timeOut+timeRegion first, stale absolute UTC fields only as a fallback.
  const localClock = pick(scheduleItem, SCHEDULE_END_LOCAL_KEYS, "");
  if (localClock) {
    const tz = getScheduleTimeZone(scheduleItem, DEFAULT_SCHEDULE_TIME_ZONE);
    const convertedUtc = clockInZoneToUtcMs(dayKey, localClock, tz);
    if (Number.isFinite(convertedUtc)) {
      return convertedUtc >= startMs ? convertedUtc : convertedUtc + 24 * 60 * 60 * 1000;
    }
  }

  for (const key of SCHEDULE_END_UTC_KEYS) {
    const raw = scheduleItem?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const rebasedUtc = rebaseUtcIsoToDay(raw, dayKey);
    if (Number.isFinite(rebasedUtc)) {
      return rebasedUtc >= startMs ? rebasedUtc : rebasedUtc + 24 * 60 * 60 * 1000;
    }
  }

  const durationMinutes = resolveScheduledDurationMinutes(scheduleItem, 600);
  return startMs + durationMinutes * 60000;
};

const getZonedDateKeyAndWeekday = (nowMs, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: getSafeTimeZone(timeZone),
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
  }).formatToParts(new Date(nowMs));

  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    dayKey: `${map.year}-${map.month}-${map.day}`,
    weekday: String(map.weekday || "").toLowerCase(),
  };
};

// Mirrors src/utils/scheduleTime.js resolveScheduleItemForInstant exactly.
const resolveScheduleItemForInstant = (scheduleList, nowMs = Date.now()) => {
  const list = Array.isArray(scheduleList) ? scheduleList : [];
  if (!list.length || !Number.isFinite(nowMs)) return null;

  const findMatch = (referenceMs) => {
    for (const item of list) {
      const tz = getScheduleTimeZone(item);
      const { dayKey, weekday } = getZonedDateKeyAndWeekday(referenceMs, tz);
      const itemWeekday = String(pick(item, ["dayOfWeek", "day", "weekday"], "")).toLowerCase();
      if (!itemWeekday || itemWeekday !== weekday) continue;

      const startMs = resolveScheduledStartUtcMsForDayKey(item, dayKey);
      const endMs = resolveScheduledEndUtcMsForDayKey(item, dayKey);
      return { scheduleItem: item, dayKey, startMs, endMs };
    }
    return null;
  };

  const yesterday = findMatch(nowMs - 24 * 60 * 60 * 1000);
  if (yesterday && Number.isFinite(yesterday.endMs) && nowMs <= yesterday.endMs) return yesterday;

  return findMatch(nowMs);
};

/* ---- business-day boundary (ported from src/utils/attendanceDate.js) ----
 * The client's resetTime/businessTimeZone settings live only in each browser's
 * localStorage (never Firestore), so there is no single canonical value to
 * read here. Per a deliberate scope decision, the server always uses these
 * fixed defaults - if an admin has customized this locally, the server won't
 * match it until that setting is migrated to Firestore in a follow-up. */
const DEFAULT_ATTENDANCE_RESET_TIME = "05:00";
const DEFAULT_BUSINESS_TIME_ZONE = "America/Chicago";

const normalizeResetTime = (value) => {
  if (typeof value !== "string") return DEFAULT_ATTENDANCE_RESET_TIME;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_ATTENDANCE_RESET_TIME;
  const hh = Math.min(23, Math.max(0, Number(match[1])));
  const mm = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

const parseResetTime = (value) => {
  const normalized = normalizeResetTime(value);
  const [hours, minutes] = normalized.split(":").map(Number);
  return { hours, minutes, totalMinutes: hours * 60 + minutes };
};

const getBusinessDayKey = (
  dateLike = Date.now(),
  resetTime = DEFAULT_ATTENDANCE_RESET_TIME,
  businessTimeZone = DEFAULT_BUSINESS_TIME_ZONE
) => {
  const { totalMinutes } = parseResetTime(resetTime);
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;

  const resolvedTimeZone = String(businessTimeZone || "").trim() || DEFAULT_BUSINESS_TIME_ZONE;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: resolvedTimeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, hourCycle: "h23",
    }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_BUSINESS_TIME_ZONE,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, hourCycle: "h23",
    }).formatToParts(d);
  }

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);

  if (
    !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) ||
    !Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)
  ) {
    return null;
  }

  const zonedPseudoUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const shifted = new Date(zonedPseudoUtcMs - totalMinutes * 60000);

  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

const dayKeyFromMsInZone = (ms, timeZone) => {
  if (!Number.isFinite(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: String(timeZone || "").trim() || DEFAULT_BUSINESS_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  if (!map.year || !map.month || !map.day) return "";
  return `${map.year}-${map.month}-${map.day}`;
};

/* ---- attendance log parsing (ported from src/utils/attendanceLog.js and the
 * normalization pipeline in src/App.jsx) ---- */

const ATN_IN_TS_KEYS = ["timestamp", "createdAt", "time", "timeIn", "clockIn", "timestampIn"];
const ATN_OUT_TS_KEYS = [
  "timeOut", "time_out", "clockOut", "clock_out", "timestampOut", "outTimestamp",
  "timeout", "outTime", "endTime", "checkedOutAt", "timeEnd", "clockedOutAt",
];

const pickAttendanceInTs = (log) => pick(log, ATN_IN_TS_KEYS, "");
const pickAttendanceOutTs = (log) => pick(log, ATN_OUT_TS_KEYS, "");

// Distinct from the file-level toMillis() above: raw attendance log timestamps
// can arrive as unix SECONDS, which toMillis() would not convert.
const attendanceTsMs = (ts) => {
  if (ts == null || ts === "") return NaN;
  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return NaN;
    return ts > 1e12 ? ts : ts * 1000;
  }
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof ts === "object") {
    if (typeof ts.toMillis === "function") {
      const ms = ts.toMillis();
      return Number.isFinite(ms) ? ms : NaN;
    }
    if (typeof ts.toDate === "function") {
      const d = ts.toDate();
      const ms = d instanceof Date ? d.getTime() : NaN;
      return Number.isFinite(ms) ? ms : NaN;
    }
    const sec = Number(pick(ts, ["seconds", "_seconds", "sec", "unix"], NaN));
    const nanos = Number(pick(ts, ["nanoseconds", "_nanoseconds", "nanos"], 0));
    if (Number.isFinite(sec)) {
      const ms = sec * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0);
      return Number.isFinite(ms) ? ms : NaN;
    }
  }
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

const isInLog = (log) => {
  const type = String(pick(log, ["type", "logType", "eventType"], "")).toLowerCase();
  return type.includes("in") || type.includes("clockin") || type.includes("timein");
};

const isOutLog = (log) => {
  const type = String(pick(log, ["type", "logType", "eventType"], "")).toLowerCase();
  return (
    type.includes("out") || type.includes("clockout") ||
    type.includes("timeout") || type.includes("checkout")
  );
};

const hasRealAttendanceTimeOut = (raw) => {
  const outValue = pickAttendanceOutTs(raw || {});
  if (!outValue) return false;
  return Number.isFinite(attendanceTsMs(outValue));
};

const isClockedOutLog = (log) => isOutLog(log) || hasRealAttendanceTimeOut(log);

const getLogEventTs = (log) => {
  if (isClockedOutLog(log)) return pickAttendanceOutTs(log) || pickAttendanceInTs(log) || "";
  return pickAttendanceInTs(log) || pickAttendanceOutTs(log) || "";
};

const ATTENDANCE_STATUS_FIELD_CANDIDATES = [
  "status", "attendanceStatus", "dailyStatus", "remark",
  "managerStatus", "assignedStatus", "attendanceType", "state",
];
const ATTENDANCE_DAY_FIELD_CANDIDATES = [
  "dayKey", "businessDay", "businessDate", "attendanceDate", "logDate", "date", "workDate",
];
const ATTENDANCE_USER_FIELD_CANDIDATES = ["userId", "employeeUserId", "uid", "employeeId", "id"];
const ATTENDANCE_TIMESTAMP_FIELD_CANDIDATES = [
  "timestamp", "createdAt", "time", "timeIn", "clockIn", "timestampIn", "updatedAt",
];
const ATTENDANCE_LOG_ARRAY_KEYS = ["logs", "attendanceLogs", "attendance", "records", "entries", "items"];
const ATTENDANCE_MANAGER_ARRAY_KEYS = [
  "noShowProfiles", "no_show_profiles", "noShowProfile", "no_show_profile",
  "absentProfiles", "attendanceProfiles", "statusProfiles", "manualStatuses", "manual_attendance",
];

const isValidYmd = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());

const resolveAttendanceDayKeyFromRecord = (record = {}, businessTimeZone = DEFAULT_BUSINESS_TIME_ZONE) => {
  const explicit = String(pick(record || {}, ATTENDANCE_DAY_FIELD_CANDIDATES, "") || "").trim();
  if (isValidYmd(explicit)) return explicit;

  const tsCandidate = pick(record || {}, ATTENDANCE_TIMESTAMP_FIELD_CANDIDATES, null);
  const ms = toMillis(tsCandidate);
  if (!Number.isFinite(ms)) return "";
  return dayKeyFromMsInZone(ms, businessTimeZone);
};

const looksLikeManagerStatusRecord = (record = {}) => {
  const statusText = String(pick(record || {}, ATTENDANCE_STATUS_FIELD_CANDIDATES, "") || "").trim();
  if (!statusText) return false;
  const s = statusText.toLowerCase();
  return (
    s.includes("no show") || s.includes("ncns") || s.includes("absent") ||
    s.includes("pto") || s.includes("leave") || s.includes("vacation") || s.includes("no log")
  );
};

const coerceManagerStatusToAttendanceLog = (
  rawRecord = {},
  fallbackUserId = "",
  businessTimeZone = DEFAULT_BUSINESS_TIME_ZONE
) => {
  if (!rawRecord || typeof rawRecord !== "object") return null;

  const statusText = String(pick(rawRecord, ATTENDANCE_STATUS_FIELD_CANDIDATES, "") || "").trim();
  if (!statusText) return null;

  const userId = String(
    pick(rawRecord, ATTENDANCE_USER_FIELD_CANDIDATES, String(fallbackUserId || "").trim())
  ).trim();
  if (!userId) return null;

  const dayKey = resolveAttendanceDayKeyFromRecord(rawRecord, businessTimeZone);
  const tsValue = pick(rawRecord, ATTENDANCE_TIMESTAMP_FIELD_CANDIDATES, "");
  const resolvedTimestamp = tsValue || (dayKey ? `${dayKey}T12:00:00.000Z` : "");
  if (!resolvedTimestamp && !dayKey) return null;

  return {
    ...rawRecord,
    userId,
    status: statusText,
    attendanceStatus: String(rawRecord.attendanceStatus || statusText),
    dailyStatus: String(rawRecord.dailyStatus || statusText),
    remark: String(rawRecord.remark || rawRecord.note || rawRecord.reason || statusText),
    type: String(pick(rawRecord, ["type", "logType", "eventType"], "manager_status")),
    timestamp: resolvedTimestamp,
    attendanceDate: dayKey || String(pick(rawRecord, ATTENDANCE_DAY_FIELD_CANDIDATES, "")),
    source: String(rawRecord.source || "manager_status_profile"),
    __managerAssigned: true,
  };
};

const normalizeAttendanceLogsPayload = (
  payload,
  fallbackUserId = "",
  businessTimeZone = DEFAULT_BUSINESS_TIME_ZONE
) => {
  const flatLogs = [];
  const managerRecords = [];
  const fallbackUid = String(fallbackUserId || "").trim();

  const pushObjectArray = (target, value) => {
    if (!Array.isArray(value)) return;
    for (const row of value) {
      if (row && typeof row === "object") target.push(row);
    }
  };

  const collectArraysByKeys = (container, keys = []) => {
    const out = [];
    if (!container || typeof container !== "object") return out;
    for (const key of keys) {
      pushObjectArray(out, container?.[key]);
    }
    return out;
  };

  if (Array.isArray(payload)) {
    pushObjectArray(flatLogs, payload);
  } else if (payload && typeof payload === "object") {
    const containers = [payload, payload.data, payload.result, payload.response, payload.payload];
    for (const container of containers) {
      if (!container) continue;
      if (Array.isArray(container)) {
        pushObjectArray(flatLogs, container);
        continue;
      }
      if (typeof container !== "object") continue;
      pushObjectArray(flatLogs, collectArraysByKeys(container, ATTENDANCE_LOG_ARRAY_KEYS));
      pushObjectArray(managerRecords, collectArraysByKeys(container, ATTENDANCE_MANAGER_ARRAY_KEYS));
    }

    if (looksLikeManagerStatusRecord(payload)) {
      managerRecords.push(payload);
    }
  }

  const mappedManagerLogs = managerRecords
    .map((row) => coerceManagerStatusToAttendanceLog(row, fallbackUid, businessTimeZone))
    .filter(Boolean);

  const combined = [...flatLogs, ...mappedManagerLogs];
  if (!combined.length) return [];

  const seen = new Set();
  const deduped = [];

  for (const raw of combined) {
    const record = raw && typeof raw === "object" ? raw : null;
    if (!record) continue;

    const userId = String(pick(record, ATTENDANCE_USER_FIELD_CANDIDATES, fallbackUid)).trim();
    const enrichedRecord = userId ? { ...record, userId } : { ...record };
    const statusText = String(pick(enrichedRecord, ATTENDANCE_STATUS_FIELD_CANDIDATES, "") || "").trim();
    const tsText = String(pick(enrichedRecord, ATTENDANCE_TIMESTAMP_FIELD_CANDIDATES, "") || "").trim();
    const dayKey = resolveAttendanceDayKeyFromRecord(enrichedRecord, businessTimeZone);
    const typeText = String(pick(enrichedRecord, ["type", "logType", "eventType"], "") || "").trim().toLowerCase();
    const idText = String(pick(enrichedRecord, ["id", "_id", "logId", "attendanceLogId"], "") || "").trim();

    const dedupeKey = `${userId}|${statusText.toLowerCase()}|${dayKey}|${tsText}|${typeText}|${idText}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(enrichedRecord);
  }

  return deduped;
};

const getBusinessDayLogsFromList = (logs, businessDayKey, resetTime, businessTimeZone) => {
  return (Array.isArray(logs) ? logs : []).filter((log) => {
    const explicitDayKey = resolveAttendanceDayKeyFromRecord(log, businessTimeZone);
    if (explicitDayKey) return explicitDayKey === businessDayKey;

    const ts = getLogEventTs(log);
    if (!ts) return false;
    return getBusinessDayKey(ts, resetTime, businessTimeZone) === businessDayKey;
  });
};

/* ---- internal Hyacinth attendance API client (server-side, mirrors
 * src/api/hyacinthAttendanceApi.js, using the server-held secret instead of a
 * client-supplied key) ---- */

const HYACINTH_ATTENDANCE_BASE_URL = "https://us-central1-hyacinthattendance.cloudfunctions.net";
const HYACINTH_API_RETRY_DELAYS_MS = [300, 800];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const callHyacinthApiOnce = async (path, body) => {
  const apiKey = HYACINTH_API_KEY.value();
  const response = await fetch(`${HYACINTH_ATTENDANCE_BASE_URL}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ apiKey, ...body }),
  });

  const result = await response.json();
  if (!result?.success) {
    throw new Error(result?.message || `Request failed: ${path}`);
  }
  return result.data;
};

// Hyacinth's API has been observed to intermittently reject a genuinely valid
// key (transient "Invalid API Key" blips, most likely rate-limit-adjacent
// flakiness on their end) - a single blip used to read as "this employee has
// no schedule/logs today," which cascaded into misreporting their status (a
// false "Day Off", or a break status that never lifts). Retrying a couple of
// times before giving up resolves most of these before they ever reach that
// fallback logic.
const callHyacinthApiInternal = async (path, body) => {
  let lastErr;
  for (let attempt = 0; attempt <= HYACINTH_API_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await callHyacinthApiOnce(path, body);
    } catch (err) {
      lastErr = err;
      if (attempt < HYACINTH_API_RETRY_DELAYS_MS.length) {
        await sleep(HYACINTH_API_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastErr;
};

const mapWithConcurrencyInternal = async (items, limit, mapper) => {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let index = 0;

  const runners = new Array(Math.min(Math.max(1, limit), list.length || 1))
    .fill(0)
    .map(async () => {
      while (index < list.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = { ok: true, value: await mapper(list[currentIndex], currentIndex) };
        } catch (error) {
          results[currentIndex] = { ok: false, error };
        }
      }
    });

  await Promise.all(runners);
  return results;
};

// Fetches each user's schedule from the external system. Internal use only
// (mirrors src/App.jsx reloadSchedules, which calls api.getUserSchedule per user).
// Returns failedUserIds alongside the data so callers can tell "genuinely has
// no schedule/logs" apart from "the external API call failed" - conflating the
// two used to make a transient Hyacinth API hiccup during a status refresh
// render as a false "Day Off" (an empty schedule makes resolveScheduleItemForInstant
// return null, which computeEmployeeProcessStatusForUser reads as no-shift-today).
const fetchUserSchedulesForUsers = async (userIds) => {
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map((v) => toText(v)).filter(Boolean)));
  const schedulesByUserId = {};
  const failedUserIds = new Set();
  if (!ids.length) return { schedulesByUserId, failedUserIds };

  const results = await mapWithConcurrencyInternal(ids, 8, async (userId) => {
    const sched = await callHyacinthApiInternal("getUserSchedule", { userId });
    return { userId, sched: Array.isArray(sched) ? sched : [] };
  });

  for (let idx = 0; idx < results.length; idx++) {
    const userId = ids[idx];
    schedulesByUserId[userId] = results[idx].ok ? results[idx].value.sched : [];
    if (!results[idx].ok) {
      failedUserIds.add(userId);
      logger.error(
        `Failed to fetch schedule for employee process status. userId=${userId} error=${toText(
          results[idx].error?.message
        )} name=${toText(results[idx].error?.name)} stack=${toText(results[idx].error?.stack).slice(0, 500)}`
      );
    }
  }

  return { schedulesByUserId, failedUserIds };
};

// Fetches and normalizes each user's attendance logs, scoped to today's business
// day (see getBusinessDayLogsFromList above). Internal use only - mirrors
// src/App.jsx reloadTodayLogs, minus the client-side caching/abort-controller
// concerns that don't apply to a short-lived server invocation.
const fetchTodayAttendanceLogsForUsers = async (userIds, { nowMs = Date.now() } = {}) => {
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map((v) => toText(v)).filter(Boolean)));
  const logsByUserId = {};
  const failedUserIds = new Set();
  if (!ids.length) return { logsByUserId, failedUserIds };

  const todayBusinessKey = getBusinessDayKey(nowMs, DEFAULT_ATTENDANCE_RESET_TIME, DEFAULT_BUSINESS_TIME_ZONE);
  const fetchStart = getBusinessDayKey(
    nowMs - 24 * 60 * 60 * 1000,
    DEFAULT_ATTENDANCE_RESET_TIME,
    DEFAULT_BUSINESS_TIME_ZONE
  );
  const fetchEnd = getBusinessDayKey(
    nowMs + 24 * 60 * 60 * 1000,
    DEFAULT_ATTENDANCE_RESET_TIME,
    DEFAULT_BUSINESS_TIME_ZONE
  );

  const results = await mapWithConcurrencyInternal(ids, 8, async (userId) => {
    const payload = await callHyacinthApiInternal("getAttendanceLogs", {
      userId,
      startDate: fetchStart,
      endDate: fetchEnd,
    });
    const normalized = normalizeAttendanceLogsPayload(payload, userId, DEFAULT_BUSINESS_TIME_ZONE);
    const todayOnly = getBusinessDayLogsFromList(
      normalized,
      todayBusinessKey,
      DEFAULT_ATTENDANCE_RESET_TIME,
      DEFAULT_BUSINESS_TIME_ZONE
    );
    return todayOnly;
  });

  for (let idx = 0; idx < results.length; idx++) {
    const userId = ids[idx];
    logsByUserId[userId] = results[idx].ok ? results[idx].value : [];
    if (!results[idx].ok) {
      failedUserIds.add(userId);
      logger.error(
        `Failed to fetch attendance logs for employee process status. userId=${userId} error=${toText(
          results[idx].error?.message
        )} name=${toText(results[idx].error?.name)} stack=${toText(results[idx].error?.stack).slice(0, 500)}`
      );
    }
  }

  return { logsByUserId, failedUserIds };
};

const getActiveBreakUserIdSet = async (userIds) => {
  const ids = new Set((Array.isArray(userIds) ? userIds : []).map(toText).filter(Boolean));
  const activeSet = new Set();
  if (!ids.size) return activeSet;

  const snap = await db.collection(BREAK_LOGS_COLLECTION).where("isActive", "==", true).get();
  for (const docSnap of snap.docs) {
    const uid = toText((docSnap.data() || {}).userId);
    if (uid && ids.has(uid)) activeSet.add(uid);
  }
  return activeSet;
};

/* ---- employee process status (ported from resolveEmployeeProcessStatus in
 * src/components/employee_dashboard.jsx) ---- */

const normalizeStatusText = (value = "") => toText(value).toLowerCase();

// Deliberately the narrow 4-key candidate list (matches the client's
// getAttendanceStatusText), distinct from the broader
// ATTENDANCE_STATUS_FIELD_CANDIDATES used only during payload normalization.
const getAttendanceStatusTextNarrow = (log = {}) =>
  toText(pick(log || {}, ["status", "attendanceStatus", "dailyStatus", "remark"], ""));

const isEmployeeProcessLoggedInStatus = (status = "") => {
  const s = normalizeStatusText(status).replace(/[_-]+/g, " ");
  if (!s || s.includes("no log")) return false;
  return (
    s.includes("early in") || s.includes("logged in") || s === "logged" || s.includes("clocked in early")
  );
};

const buildEmployeeProcessReadySignature = (userId, scheduledItem, logs = [], dayKey = "") => {
  const uid = toText(userId);
  const startMs = resolveScheduledStartUtcMsForDayKey(scheduledItem, dayKey);
  const logSignature = (Array.isArray(logs) ? logs : [])
    .map((log) => {
      const inMs = toMillis(pick(log || {}, ["timeIn", "clockIn", "startedAt", "createdAt", "inAt"], null));
      const outMs = toMillis(
        pick(log || {}, ["timeOut", "clockOut", "endedAt", "completedAt", "updatedAt", "outAt"], null)
      );
      return [
        normalizeStatusText(getAttendanceStatusTextNarrow(log)),
        isInLog(log) ? "in" : "",
        isClockedOutLog(log) ? "out" : "",
        Number.isFinite(inMs) ? inMs : "",
        Number.isFinite(outMs) ? outMs : "",
      ].join(":");
    })
    .join("|");

  return `${uid}|${dayKey}|${Number.isFinite(startMs) ? startMs : "no-start"}|${logSignature}`;
};

// Mirrors resolveEmployeeProcessStatus's branching, with one deliberate
// deviation: "currently logged in" is decided from attendance logs ALONE
// (an in-log with no later out-log), the same minimal signal the Sidebar's
// live-agents badge and the Attendance page's "Live" status already use
// (src/App.jsx isUserLiveNow) and have proven reliable on. The schedule fetch
// (a second, independent external call) is only consulted for the Scheduled/
// Day Off distinction and for the early-clock-in/duty-start comparison that
// upgrades Logged in -> Available - if THAT call fails, we still know the
// employee is live from logs and report Logged in, instead of losing the
// signal entirely or misreporting Day Off/Unavailable.
// activeBreakUserIds is intentionally NOT consulted here - the caller checks
// it first and short-circuits, since it's a local Firestore query unaffected
// by external API fetch outcomes.
const computeEmployeeProcessStatusForUser = (
  userId,
  { schedulesByUserId, scheduleFetchFailed = false, logsByUserId, readyOverrides, nowMs }
) => {
  const uid = toText(userId);
  if (!uid) return { available: false, label: "Unavailable", tone: "unavailable" };

  const logs = Array.isArray(logsByUserId?.[uid]) ? logsByUserId[uid] : [];
  const statusTexts = logs.map((log) => normalizeStatusText(getAttendanceStatusTextNarrow(log))).filter(Boolean);
  const hasDayOffStatus = statusTexts.some(
    (status) =>
      status.includes("day off") ||
      status.includes("rest day") ||
      status.includes("holiday") ||
      status.includes("pto") ||
      status.includes("leave") ||
      status.includes("vacation") ||
      status.includes("no schedule")
  );
  if (hasDayOffStatus) {
    return { available: false, autoAdvanceUnavailable: true, label: "Day Off", tone: "dayoff" };
  }

  const hasCompletedStatus = statusTexts.some(
    (status) => status.includes("completed") || status.includes("complete")
  );
  if (hasCompletedStatus || logs.some((log) => isClockedOutLog(log))) {
    return { available: false, autoAdvanceUnavailable: true, label: "Completed", tone: "completed" };
  }

  const scheduleMatch = scheduleFetchFailed ? null : resolveScheduleItemForInstant(schedulesByUserId?.[uid], nowMs);
  const scheduledItem = scheduleMatch?.scheduleItem || null;
  const clockInLog = logs.find((log) => isInLog(log));

  if (!clockInLog) {
    // Not logged in per attendance logs - Scheduled vs Day Off needs the
    // schedule to decide. If that fetch failed, we have no signal either way;
    // return null so the caller skips (preserves last known status) instead
    // of guessing.
    if (scheduleFetchFailed) return null;
    if (!scheduledItem) {
      return { available: false, autoAdvanceUnavailable: true, label: "Day Off", tone: "dayoff" };
    }
    return {
      available: false,
      label: "Scheduled",
      tone: "scheduled",
      startMs: scheduleMatch?.startMs,
      endMs: scheduleMatch?.endMs,
    };
  }

  // Logged in per attendance logs (mirrors isUserLiveNow). Without a
  // successful schedule fetch we can't compare against duty-start or
  // validate a ready-override signature, so report the plain logged-in state
  // rather than guessing Available.
  if (scheduleFetchFailed || !scheduledItem) {
    return { available: false, label: "Logged in", tone: "loggedin", canReady: false };
  }

  const readySignature = buildEmployeeProcessReadySignature(
    uid,
    scheduledItem,
    logs,
    scheduleMatch?.dayKey || ""
  );
  if (readyOverrides?.[uid] === readySignature) {
    return {
      available: true,
      label: "Available",
      tone: "available",
      readySignature,
      isReadyOverride: true,
      startMs: scheduleMatch?.startMs,
      endMs: scheduleMatch?.endMs,
    };
  }

  const dutyStartMs = scheduleMatch?.startMs;
  const clockInMs = toMillis(
    pick(clockInLog, ["timeIn", "clockIn", "startedAt", "createdAt", "inAt"], null)
  );
  const clockedInEarly =
    Number.isFinite(dutyStartMs) && Number.isFinite(clockInMs) && clockInMs < dutyStartMs;
  const hasLoggedInStatus = statusTexts.some(isEmployeeProcessLoggedInStatus);
  if (clockedInEarly || hasLoggedInStatus) {
    return {
      available: false,
      label: "Logged in",
      tone: "loggedin",
      canReady: true,
      readySignature,
      startMs: scheduleMatch?.startMs,
      endMs: scheduleMatch?.endMs,
    };
  }

  return {
    available: true,
    label: "Available",
    tone: "available",
    startMs: scheduleMatch?.startMs,
    endMs: scheduleMatch?.endMs,
  };
};

// Fetches everything needed (breaks, schedules, today's attendance logs, ready
// overrides) and computes a status entry for every rotation employee. This is
// the single canonical computation - all clients now just read its output from
// employee_process_settings/default.statusByUserId instead of each computing
// their own answer from a mix of live and locally-polled data.
const computeEmployeeProcessStatus = async (rotationUserIds, { nowMs = Date.now() } = {}) => {
  const ids = Array.from(new Set((Array.isArray(rotationUserIds) ? rotationUserIds : []).map(toText).filter(Boolean)));
  if (!ids.length) return {};

  const statusRefs = ids.map((uid) => db.collection(EMPLOYEE_PROCESS_STATUS_COLLECTION).doc(uid));
  const [activeBreakUserIds, scheduleResult, logsResult, statusDocs] = await Promise.all([
    getActiveBreakUserIdSet(ids),
    fetchUserSchedulesForUsers(ids),
    fetchTodayAttendanceLogsForUsers(ids, { nowMs }),
    db.getAll(...statusRefs),
  ]);
  const { schedulesByUserId, failedUserIds: scheduleFailedUserIds } = scheduleResult;
  const { logsByUserId, failedUserIds: logsFailedUserIds } = logsResult;

  const readyOverrides = {};
  const previousToneByUserId = {};
  statusDocs.forEach((snap, idx) => {
    const data = snap.exists ? snap.data() || {} : {};
    const signature = toText(data.readyOverrideSignature);
    if (signature) readyOverrides[ids[idx]] = signature;
    previousToneByUserId[ids[idx]] = toText(data.tone);
  });

  const statusByUserId = {};
  for (const uid of ids) {
    // "On break" comes solely from activeBreakUserIds (our own Firestore
    // break_logs query, not the external API), so it's decided here,
    // unconditionally, before either fetch outcome is consulted.
    if (activeBreakUserIds.has(uid)) {
      statusByUserId[uid] = {
        available: false,
        label: "On break",
        tone: "break",
        canReady: false,
        autoAdvanceUnavailable: true,
        readySignature: "",
        isReadyOverride: false,
        startMs: null,
        endMs: null,
        computedAtMs: nowMs,
      };
      continue;
    }

    // Attendance logs fetch failed - this is now the primary signal (mirrors
    // the Sidebar/Attendance "Live" check, which needs only logs, not
    // schedule), so without it we have nothing reliable to compute from.
    // Skip them entirely so persistEmployeeProcessStatus leaves their last
    // known-good status untouched, EXCEPT when their break just ended (we
    // know that for certain via activeBreakUserIds above) - in that one case
    // leaving the stale "On break" label would stick forever, so fall back to
    // a neutral Unavailable instead of guessing.
    if (logsFailedUserIds.has(uid)) {
      if (previousToneByUserId[uid] === "break") {
        statusByUserId[uid] = {
          available: false,
          label: "Unavailable",
          tone: "unavailable",
          canReady: false,
          autoAdvanceUnavailable: true,
          readySignature: "",
          isReadyOverride: false,
          startMs: null,
          endMs: null,
          computedAtMs: nowMs,
        };
      }
      continue;
    }

    const status = computeEmployeeProcessStatusForUser(uid, {
      schedulesByUserId,
      scheduleFetchFailed: scheduleFailedUserIds.has(uid),
      logsByUserId,
      readyOverrides,
      nowMs,
    });
    // null means "not logged in, and schedule fetch also failed" - no signal
    // either way, so skip and preserve their last known-good status.
    if (!status) continue;

    statusByUserId[uid] = {
      available: !!status.available,
      label: status.label || "Unavailable",
      tone: status.tone || "unavailable",
      canReady: !!status.canReady,
      autoAdvanceUnavailable: !!status.autoAdvanceUnavailable,
      readySignature: status.readySignature || "",
      isReadyOverride: !!status.isReadyOverride,
      startMs: Number.isFinite(status.startMs) ? status.startMs : null,
      endMs: Number.isFinite(status.endMs) ? status.endMs : null,
      computedAtMs: nowMs,
    };
  }

  return statusByUserId;
};

// Writes computed status entries to their own per-user documents in
// EMPLOYEE_PROCESS_STATUS_COLLECTION. Deliberately omits readyOverrideSignature
// from the write payload - merge: true leaves that field untouched here, since
// it's persisted business state owned by markEmployeeProcessReady, not part of
// what computeEmployeeProcessStatus recomputes each tick. Chunked at 400 writes
// per batch to stay under Firestore's 500-write batch limit.
const persistEmployeeProcessStatus = async (statusByUserId) => {
  const entries = Object.entries(statusByUserId || {}).filter(([, status]) => status);
  if (!entries.length) return;

  const CHUNK_SIZE = 400;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const batch = db.batch();
    for (const [uid, status] of entries.slice(i, i + CHUNK_SIZE)) {
      batch.set(
        db.collection(EMPLOYEE_PROCESS_STATUS_COLLECTION).doc(uid),
        { ...status, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    await batch.commit();
  }
};

// Recomputes and merges status for just the given users (if they're part of the
// rotation), without touching everyone else's already-computed entries. Used for
// fast reaction to specific events (break start/end, a ready confirmation) so
// those don't have to wait for the next refreshEmployeeProcessStatus tick.
const refreshEmployeeProcessStatusForUsers = async (userIds, { nowMs = Date.now() } = {}) => {
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map(toText).filter(Boolean)));
  if (!ids.length) return {};

  const settingsRef = db
    .collection(EMPLOYEE_PROCESS_SETTINGS_COLLECTION)
    .doc(EMPLOYEE_PROCESS_SETTINGS_DOC_ID);
  const settingsSnap = await settingsRef.get();
  const settings = settingsSnap.exists ? settingsSnap.data() || {} : {};
  const rotationUserIdSet = new Set(
    (Array.isArray(settings.rotationUserIds) ? settings.rotationUserIds : []).map(toText)
  );

  const relevantIds = ids.filter((uid) => rotationUserIdSet.has(uid));
  if (!relevantIds.length) return {};

  const patch = await computeEmployeeProcessStatus(relevantIds, { nowMs });
  const statusPatch = {};
  for (const uid of relevantIds) {
    statusPatch[uid] = patch[uid];
  }

  await persistEmployeeProcessStatus(statusPatch);
  return statusPatch;
};

/* ---- rotation "next" picker (ported from getNextEmployeeProcessAssignment in
 * src/services/employeeProcessService.js) - keep both in sync. ---- */

const normalizeEmployeeProcessUserIds = (value = []) =>
  Array.from(
    new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))
  );

const normalizeEmployeeProcessUserIdQueue = (value = []) =>
  (Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean);

const removeOneEmployeeProcessUserIdOccurrence = (userIds = [], targetUserId = "") => {
  const target = String(targetUserId || "").trim();
  let didRemove = false;

  return normalizeEmployeeProcessUserIdQueue(userIds).filter((userId) => {
    if (!didRemove && userId === target) {
      didRemove = true;
      return false;
    }
    return true;
  });
};

const getNextEmployeeProcessAssignment = ({
  rotationUserIds = [],
  currentUserId = "",
  unavailableUserIds = [],
  skipUserIds = [],
} = {}) => {
  const orderedIds = normalizeEmployeeProcessUserIds(rotationUserIds);
  if (!orderedIds.length) return { nextUserId: "", skippedUserIds: [] };

  const unavailable = new Set(normalizeEmployeeProcessUserIds(unavailableUserIds));
  const pendingSkip = new Set(normalizeEmployeeProcessUserIdQueue(skipUserIds));
  const availableIds = orderedIds.filter((userId) => !unavailable.has(userId));
  if (!availableIds.length) return { nextUserId: "", skippedUserIds: [] };

  const currentIndex = orderedIds.indexOf(String(currentUserId || "").trim());
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const skippedUserIds = [];

  for (let offset = 0; offset < orderedIds.length; offset += 1) {
    const candidate = orderedIds[(startIndex + offset) % orderedIds.length];
    if (unavailable.has(candidate)) continue;
    if (pendingSkip.has(candidate)) {
      skippedUserIds.push(candidate);
      continue;
    }
    return { nextUserId: candidate, skippedUserIds };
  }

  return { nextUserId: availableIds[0] || "", skippedUserIds };
};

/* ---- authorization (mirrors canAdvanceEmployeeProcessForRow in
 * src/components/employee_dashboard.jsx, enforced server-side for real this
 * time - Firestore rules currently allow any signed-in user to write
 * employee_process_settings directly) ---- */

const EMPLOYEE_PROCESS_ADMIN_ROLES = new Set([ROLES.ADMIN, ROLES.SUPER_ADMIN]);

const resolveEmployeeProcessCaller = async (request) => {
  if (!request?.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const uid = toText(request.auth.uid);
  let role = normalizeRole(request.auth.token?.role);
  if (!role) {
    const snap = await db.collection(USERS_COLLECTION).doc(uid).get();
    role = normalizeRole(snap.exists ? snap.data()?.role : "");
  }

  return { uid, role };
};

// Admins may act on any rotation employee (mirrors the client check, which only
// restricted admins to their currently-selected employee as a UI nicety, not a
// real security boundary). Employees may only act on their own turn.
const assertCanActOnEmployeeProcessUser = (caller, targetUserId) => {
  if (EMPLOYEE_PROCESS_ADMIN_ROLES.has(caller.role)) return;
  if (caller.role === ROLES.EMPLOYEE && caller.uid === toText(targetUserId)) return;
  throw new HttpsError("permission-denied", "You are not authorized to perform this action.");
};

const REFRESH_EMPLOYEE_PROCESS_KEY_ORDER = [
  { key: "ibUserId", type: "ib", label: "Inbound", scope: "inbound" },
  { key: "nlUserId", type: "nl", label: "New Lead", scope: "new_lead" },
];

// Primary path for catching a now-unavailable IB/NL holder and advancing the
// rotation - replaces the old client-side auto-reassignment useEffect. Runs on
// a schedule (rather than only reacting to writes) because some transitions
// are purely time-based (e.g. a duty-start boundary passing) with no Firestore
// write to trigger off of. Runs at :00/:05/:30/:55 past each hour instead of
// every minute - cuts the external attendance API polling (and its cost) by
// ~93% while still catching duty-start/clock-out/day-off changes within 5-25
// minutes. Break start/end, Finish IB/NL, and Mark Ready all still refresh
// their own status immediately and don't wait on this schedule at all.
exports.refreshEmployeeProcessStatus = onSchedule(
  {
    region: "us-central1",
    schedule: "0,5,30,55 * * * *",
    timeZone: "America/Chicago",
    retryCount: 0,
    maxInstances: 1,
    memory: "256MiB",
    timeoutSeconds: 120,
    secrets: [HYACINTH_API_KEY],
  },
  async () => {
    const settingsRef = db
      .collection(EMPLOYEE_PROCESS_SETTINGS_COLLECTION)
      .doc(EMPLOYEE_PROCESS_SETTINGS_DOC_ID);
    const settingsSnap = await settingsRef.get();
    const settings = settingsSnap.exists ? settingsSnap.data() || {} : {};
    const rotationUserIds = Array.isArray(settings.rotationUserIds) ? settings.rotationUserIds : [];
    if (!rotationUserIds.length) return;

    const nowMs = Date.now();
    const statusByUserId = await computeEmployeeProcessStatus(rotationUserIds, { nowMs });
    await persistEmployeeProcessStatus(statusByUserId);

    for (const { key, type, label, scope } of REFRESH_EMPLOYEE_PROCESS_KEY_ORDER) {
      const currentUserId = toText(settings[key]);
      // Bootstrap: nobody assigned yet (brand new rotation, or everyone was
      // unavailable and this was cleared) - assign the first available employee,
      // mirroring the old client-side "!hasSavedIbUser" initial-assignment case.
      const needsBootstrap = !currentUserId;
      if (!needsBootstrap && statusByUserId?.[currentUserId]?.available !== false) continue;

      try {
        const result = await db.runTransaction(async (transaction) => {
          const freshSnap = await transaction.get(settingsRef);
          const fresh = freshSnap.exists ? freshSnap.data() || {} : {};
          const freshCurrentUserId = toText(fresh[key]);
          const freshRotationUserIds = Array.isArray(fresh.rotationUserIds)
            ? fresh.rotationUserIds
            : rotationUserIds;
          const isInbound = key === "ibUserId";
          const pendingPurpleIbSkipUserIds =
            isInbound && Array.isArray(fresh.purpleIbSkipUserIds) ? fresh.purpleIbSkipUserIds : [];

          if (needsBootstrap) {
            if (freshCurrentUserId) return null; // someone else already assigned it
            const firstAvailable = freshRotationUserIds.find(
              (rowUserId) => statusByUserId?.[toText(rowUserId)]?.available === true
            );
            if (!firstAvailable) return null;

            const updates = {
              [key]: firstAvailable,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedByUserId: "system",
              updatedByName: "Automatic rotation",
            };
            if (isInbound) {
              updates.purpleIbSkipUserIds = removeOneEmployeeProcessUserIdOccurrence(
                pendingPurpleIbSkipUserIds,
                firstAvailable
              );
            }
            transaction.set(settingsRef, updates, { merge: true });
            return { previousUserId: "", nextUserId: firstAvailable, bootstrap: true };
          }

          // Someone else (a manual finish, or a previous tick) already moved this
          // on - don't act on data that's no longer current.
          if (freshCurrentUserId !== currentUserId) return null;

          const unavailableUserIds = freshRotationUserIds.filter(
            (rowUserId) => statusByUserId?.[toText(rowUserId)]?.available !== true
          );

          const { nextUserId, skippedUserIds } = getNextEmployeeProcessAssignment({
            rotationUserIds: freshRotationUserIds,
            currentUserId: freshCurrentUserId,
            unavailableUserIds,
            skipUserIds: pendingPurpleIbSkipUserIds,
          });
          if (!nextUserId || nextUserId === freshCurrentUserId) return null;

          const updates = {
            [key]: nextUserId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedByUserId: "system",
            updatedByName: "Automatic rotation",
          };
          if (isInbound) {
            updates.purpleIbSkipUserIds = skippedUserIds.length
              ? skippedUserIds.reduce(
                  (ids, skippedId) => removeOneEmployeeProcessUserIdOccurrence(ids, skippedId),
                  pendingPurpleIbSkipUserIds
                )
              : pendingPurpleIbSkipUserIds;
          }

          transaction.set(settingsRef, updates, { merge: true });
          return { previousUserId: freshCurrentUserId, nextUserId };
        });

        if (result) {
          await db.collection(EMPLOYEE_PROCESS_ACTION_LOGS_COLLECTION).add({
            employeeUserId: result.previousUserId,
            employeeName: "",
            employeeProfileImageUrl: "",
            actionType: `auto_${type}`,
            actionLabel: result.bootstrap
              ? `Auto-assigned ${label} (initial)`
              : `Auto-advanced ${label} (unavailable)`,
            actionScope: scope,
            relatedUserId: result.nextUserId,
            relatedUserName: "",
            createdByUserId: "system",
            createdByName: "Automatic rotation",
            source: "refreshEmployeeProcessStatus",
            createdAtMs: Date.now(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } catch (err) {
        logger.error(`Failed to auto-advance ${type} rotation.`, { message: toText(err?.message) });
      }
    }

    // Mirrors the old client-side auto-clear: drop a stale Purple IB mark if
    // that employee is no longer available, no longer in the rotation, or has
    // since become the primary IB.
    try {
      await db.runTransaction(async (transaction) => {
        const freshSnap = await transaction.get(settingsRef);
        const fresh = freshSnap.exists ? freshSnap.data() || {} : {};
        const purpleIbUserId = toText(fresh.purpleIbUserId);
        if (!purpleIbUserId) return;

        const freshRotationUserIds = Array.isArray(fresh.rotationUserIds) ? fresh.rotationUserIds : [];
        const freshIbUserId = toText(fresh.ibUserId);
        const isInRotation = freshRotationUserIds.map(toText).includes(purpleIbUserId);
        const isAvailable = statusByUserId?.[purpleIbUserId]?.available === true;

        if (!isInRotation || !isAvailable || purpleIbUserId === freshIbUserId) {
          transaction.set(
            settingsRef,
            {
              purpleIbUserId: "",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedByUserId: "system",
              updatedByName: "Automatic rotation",
            },
            { merge: true }
          );
        }
      });
    } catch (err) {
      logger.error("Failed to clear stale Purple IB mark.", { message: toText(err?.message) });
    }
  }
);

// Replaces the client's direct Firestore write in handleAdvanceEmployeeProcess.
// Recomputes fresh status for the whole rotation before deciding "next" (so a
// stale statusByUserId snapshot can never be the basis for the decision), then
// picks and writes the next assignee inside a transaction, closing the
// multi-tab race that the old client-side write had no protection against.
exports.finishEmployeeProcessTurn = onCall(
  { region: "us-central1", invoker: "public", cors: true, secrets: [HYACINTH_API_KEY] },
  async (request) => {
    const caller = await resolveEmployeeProcessCaller(request);
    const type = String(request?.data?.type || "").toLowerCase() === "nl" ? "nl" : "ib";
    const userId = toText(request?.data?.userId);
    if (!userId) {
      throw new HttpsError("invalid-argument", "userId is required.");
    }

    assertCanActOnEmployeeProcessUser(caller, userId);

    const key = type === "nl" ? "nlUserId" : "ibUserId";
    const scope = type === "nl" ? "new_lead" : "inbound";
    const label = type === "nl" ? "New Lead" : "Inbound";
    const actingAsName = toText(request?.data?.actingAsName) || caller.uid;
    const settingsRef = db
      .collection(EMPLOYEE_PROCESS_SETTINGS_COLLECTION)
      .doc(EMPLOYEE_PROCESS_SETTINGS_DOC_ID);

    const preSnap = await settingsRef.get();
    const preSettings = preSnap.exists ? preSnap.data() || {} : {};
    const rotationUserIds = Array.isArray(preSettings.rotationUserIds) ? preSettings.rotationUserIds : [];
    if (!rotationUserIds.map(toText).includes(userId)) {
      throw new HttpsError("failed-precondition", "You are not part of the IB/NL rotation.");
    }

    const nowMs = Date.now();
    const statusByUserId = await computeEmployeeProcessStatus(rotationUserIds, { nowMs });
    await persistEmployeeProcessStatus(statusByUserId);

    let nextUserId = "";
    try {
      const result = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(settingsRef);
        const current = snap.exists ? snap.data() || {} : {};
        const currentUserId = toText(current[key]);
        if (currentUserId !== userId) {
          throw new HttpsError(
            "failed-precondition",
            `You are no longer the current ${label} holder - someone else may have already finished this turn.`
          );
        }

        const freshRotationUserIds = Array.isArray(current.rotationUserIds)
          ? current.rotationUserIds
          : rotationUserIds;
        const isInbound = type === "ib";
        const pendingPurpleIbSkipUserIds =
          isInbound && Array.isArray(current.purpleIbSkipUserIds) ? current.purpleIbSkipUserIds : [];
        const unavailableUserIds = freshRotationUserIds.filter(
          (rowUserId) => statusByUserId?.[toText(rowUserId)]?.available !== true
        );

        const { nextUserId: pickedUserId, skippedUserIds } = getNextEmployeeProcessAssignment({
          rotationUserIds: freshRotationUserIds,
          currentUserId,
          unavailableUserIds,
          skipUserIds: pendingPurpleIbSkipUserIds,
        });

        const updates = {
          [key]: pickedUserId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedByUserId: caller.uid,
          updatedByName: actingAsName,
        };
        if (isInbound) {
          updates.purpleIbSkipUserIds = skippedUserIds.length
            ? skippedUserIds.reduce(
                (ids, skippedId) => removeOneEmployeeProcessUserIdOccurrence(ids, skippedId),
                pendingPurpleIbSkipUserIds
              )
            : pendingPurpleIbSkipUserIds;
        }

        transaction.set(settingsRef, updates, { merge: true });
        return { nextUserId: pickedUserId };
      });
      nextUserId = result.nextUserId;
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("finishEmployeeProcessTurn transaction failed.", { message: toText(err?.message) });
      throw new HttpsError("internal", `Could not finish ${label.toLowerCase()}.`);
    }

    try {
      await db.collection(EMPLOYEE_PROCESS_ACTION_LOGS_COLLECTION).add({
        employeeUserId: userId,
        employeeName: toText(request?.data?.employeeName),
        employeeProfileImageUrl: toText(request?.data?.employeeProfileImageUrl),
        actionType: type === "nl" ? "finish_nl" : "finish_ib",
        actionLabel: type === "nl" ? "Finished New Lead" : "Finished Inbound",
        actionScope: scope,
        relatedUserId: nextUserId,
        relatedUserName: "",
        createdByUserId: caller.uid,
        createdByName: actingAsName,
        source: "finishEmployeeProcessTurn",
        createdAtMs: Date.now(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (logErr) {
      logger.error("Failed to write employee process action log.", { message: toText(logErr?.message) });
    }

    return { success: true, nextUserId };
  }
);

// Replaces requestEmployeeProcessReady's direct client writes. Recomputes the
// caller's eligibility (canReady + readySignature) server-side rather than
// trusting whatever the client last computed, before persisting the override.
exports.markEmployeeProcessReady = onCall(
  { region: "us-central1", invoker: "public", cors: true, secrets: [HYACINTH_API_KEY] },
  async (request) => {
    const caller = await resolveEmployeeProcessCaller(request);
    const userId = toText(request?.data?.userId);
    if (!userId) {
      throw new HttpsError("invalid-argument", "userId is required.");
    }

    assertCanActOnEmployeeProcessUser(caller, userId);

    const actingAsName = toText(request?.data?.actingAsName) || caller.uid;
    const settingsRef = db
      .collection(EMPLOYEE_PROCESS_SETTINGS_COLLECTION)
      .doc(EMPLOYEE_PROCESS_SETTINGS_DOC_ID);
    const settingsSnap = await settingsRef.get();
    const settings = settingsSnap.exists ? settingsSnap.data() || {} : {};
    const rotationUserIds = Array.isArray(settings.rotationUserIds) ? settings.rotationUserIds : [];
    if (!rotationUserIds.map(toText).includes(userId)) {
      throw new HttpsError("failed-precondition", "You are not part of the IB/NL rotation.");
    }

    const nowMs = Date.now();
    const statusPatch = await computeEmployeeProcessStatus([userId], { nowMs });
    const status = statusPatch[userId];

    if (!status?.canReady || !status?.readySignature) {
      throw new HttpsError("failed-precondition", "You are not currently eligible to mark ready.");
    }

    await db
      .collection(EMPLOYEE_PROCESS_STATUS_COLLECTION)
      .doc(userId)
      .set(
        {
          readyOverrideSignature: status.readySignature,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    // Recompute now that the override is persisted, so statusByUserId reflects
    // Available immediately instead of waiting for the next scheduled tick.
    try {
      await refreshEmployeeProcessStatusForUsers([userId], { nowMs });
    } catch (err) {
      logger.error("Failed to refresh status after marking ready.", { userId, message: toText(err?.message) });
    }

    try {
      await db.collection(EMPLOYEE_PROCESS_ACTION_LOGS_COLLECTION).add({
        employeeUserId: userId,
        employeeName: toText(request?.data?.employeeName),
        employeeProfileImageUrl: toText(request?.data?.employeeProfileImageUrl),
        actionType: "ready",
        actionLabel: "Marked Ready",
        actionScope: "ready",
        relatedUserId: "",
        relatedUserName: "",
        createdByUserId: caller.uid,
        createdByName: actingAsName,
        source: "markEmployeeProcessReady",
        createdAtMs: Date.now(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (logErr) {
      logger.error("Failed to write employee process ready action log.", { message: toText(logErr?.message) });
    }

    return { success: true };
  }
);
