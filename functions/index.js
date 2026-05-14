const nodeCrypto = require("node:crypto");
const admin = require("firebase-admin");
const { setGlobalOptions } = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

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
    "attendance",
    "schedule",
    "hours",
    "notifications",
    "perf_daily",
    "perf_weekly",
    "perf_monthly",
    "invoices",
  ],
  [ROLES.VISITOR]: ["employee_dashboard", "notifications", "manage_announcements"],
  [ROLES.EMPLOYEE]: [
    "employee_dashboard",
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
  }

  return isLegacyMatch;
};

exports.issueSessionToken = onCall(callableRuntimeOptions, async (request) => {
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

  return {
    success: true,
    userId,
    authUserCreated,
    authUserUpdated,
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
    }
  }
);

exports.processActiveBreakThresholds = onSchedule(
  {
    region: "us-central1",
    schedule: "every 5 minutes",
    timeZone: "America/Chicago",
    retryCount: 0,
    maxInstances: 1,
    memory: "256MiB",
    timeoutSeconds: 60,
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
