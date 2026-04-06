import HyacinthAttendanceAPI from "../api/hyacinthAttendanceApi";
import { DEFAULT_ROLE_PAGES, ROLES } from "./roleUtils";
import {
  claimPortalActiveSession,
  isPortalActiveSessionValid,
  loginPortalUser,
  logoutPortalUser,
  releasePortalActiveSession,
  subscribeToPortalActiveSession,
} from "./firebaseAuthService";
import { getDisplayName as getUserName, getUserId } from "../utils/common";

const STORAGE_KEY = "hyacinth_portal_auth";

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function getStoredSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return safeJsonParse(raw, null);
}

export function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

const normalizeSessionUser = (value = {}) => ({
  userId: String(value?.userId || value?.id || "").trim(),
  role: String(value?.role || "").trim().toLowerCase(),
  email: String(value?.email || "").trim().toLowerCase(),
  name: String(value?.name || "").trim(),
  sessionKey: String(value?.sessionKey || "").trim(),
});

async function attachSessionKey(session = null) {
  if (!session?.isAuthenticated || !session?.user) {
    throw new Error("Could not start session");
  }

  const user = normalizeSessionUser(session.user);
  if (!user.userId) {
    throw new Error("Missing user id");
  }

  const claimed = await claimPortalActiveSession({
    userId: user.userId,
    role: user.role,
    email: user.email,
    name: user.name,
  });

  return {
    ...session,
    user: {
      ...session.user,
      sessionKey: claimed.sessionKey,
    },
  };
}

export async function loginUser({ identifier, password }) {
  const normalizedIdentifier = String(identifier || "").trim();
  const normalizedPassword = String(password || "").trim();

  if (!normalizedIdentifier) {
    throw new Error("Enter your email or employee ID");
  }

  if (!normalizedPassword) {
    throw new Error("Enter your password");
  }

  const loginResult = await loginPortalUser({
    identifier: normalizedIdentifier,
    password: normalizedPassword,
  });

  const profile = loginResult?.profile || {};
  const role = String(profile?.role || "").trim().toLowerCase() || ROLES.VISITOR;
  const profileUid = String(profile?.uid || profile?.userId || profile?.id || "").trim();
  const profileEmail = String(profile?.email || "").trim().toLowerCase();
  const profileAllowedPages =
    Array.isArray(profile?.allowedPages) && profile.allowedPages.length > 0
      ? profile.allowedPages
      : DEFAULT_ROLE_PAGES[role] || [];
  const profileName =
    String(profile?.name || "").trim() ||
    `${profile?.firstName || ""} ${profile?.lastName || ""}`.trim() ||
    profileEmail ||
    profileUid ||
    "Portal User";

  if (!profileUid) {
    throw new Error("Could not load account profile.");
  }

  const apiKey = import.meta.env.VITE_HYACINTH_API_KEY;
  const departmentId = import.meta.env.VITE_HYACINTH_DEPARTMENT_ID;

  let matchedEmployee = null;

  if (role === ROLES.EMPLOYEE && (!apiKey || !departmentId)) {
    throw new Error("Missing VITE_HYACINTH_API_KEY or VITE_HYACINTH_DEPARTMENT_ID in .env");
  }

  if (role === ROLES.EMPLOYEE && apiKey && departmentId) {
    const api = new HyacinthAttendanceAPI(apiKey);
    const employees = await api.getUsersByDepartment(departmentId);

    matchedEmployee =
      (Array.isArray(employees) ? employees : []).find((emp) => {
        const empId = String(getUserId(emp) || "").trim();
        const empEmail = String(emp?.email || "").trim().toLowerCase();

        return empId === profileUid || (profileEmail && empEmail === profileEmail);
      }) || null;
  }

  const session = {
    isAuthenticated: true,
    user: {
      id: profileUid,
      userId: profileUid,
      email: matchedEmployee?.email || profileEmail || "",
      name: matchedEmployee ? getUserName(matchedEmployee) : profileName,
      role,
      allowedPages: profileAllowedPages,
      employee: role === ROLES.EMPLOYEE ? matchedEmployee : undefined,
      profile,
    },
  };

  const sessionWithKey = await attachSessionKey(session);
  saveSession(sessionWithKey);
  return sessionWithKey;
}

export async function logoutUser(user = null) {
  const normalizedUser = normalizeSessionUser(user || {});

  if (normalizedUser.userId && normalizedUser.sessionKey) {
    try {
      await releasePortalActiveSession({
        userId: normalizedUser.userId,
        sessionKey: normalizedUser.sessionKey,
      });
    } catch {
      // ignore session release failure
    }
  }

  try {
    await logoutPortalUser();
  } catch {
    // ignore firebase logout failure for employee-only sessions
  }

  clearSession();
  return true;
}

export async function isStoredSessionStillValid(session = null) {
  const normalizedUser = normalizeSessionUser(session?.user || session || {});
  if (!normalizedUser.userId || !normalizedUser.sessionKey) return false;

  try {
    return await isPortalActiveSessionValid({
      userId: normalizedUser.userId,
      sessionKey: normalizedUser.sessionKey,
    });
  } catch {
    return false;
  }
}

export function subscribeToSessionValidity(session = null, onInvalid = null) {
  const normalizedUser = normalizeSessionUser(session?.user || session || {});
  if (!normalizedUser.userId || !normalizedUser.sessionKey) {
    return () => {};
  }

  return subscribeToPortalActiveSession({
    userId: normalizedUser.userId,
    sessionKey: normalizedUser.sessionKey,
    onInvalid,
  });
}
