const nodeCrypto = require("node:crypto");
const admin = require("firebase-admin");
const { setGlobalOptions } = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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
