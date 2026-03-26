import HyacinthAttendanceAPI from "../api/hyacinthAttendanceApi";
import { DEFAULT_ROLE_PAGES, ROLES } from "./roleUtils";
import {
  getEmployeePermission,
  loginPortalUser,
  logoutPortalUser,
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

export async function loginUser({ identifier, password }) {
  const normalizedIdentifier = String(identifier || "").trim();
  const normalizedIdentifierLower = normalizedIdentifier.toLowerCase();
  const normalizedPassword = String(password || "").trim();

  if (!normalizedIdentifier) {
    throw new Error("Enter your email or employee ID");
  }

  if (!normalizedPassword) {
    throw new Error("Enter your password");
  }

  if (normalizedIdentifier.includes("@")) {
    try {
      const result = await loginPortalUser({
        email: normalizedIdentifier,
        password: normalizedPassword,
      });

      const profile = result.profile;

      if ([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.VISITOR].includes(profile.role)) {
        const session = {
          isAuthenticated: true,
          user: {
            id: profile.uid,
            userId: profile.uid,
            email: profile.email,
            name: `${profile.firstName || ""} ${profile.lastName || ""}`.trim(),
            role: profile.role || ROLES.VISITOR,
            allowedPages:
              Array.isArray(profile.allowedPages) && profile.allowedPages.length > 0
                ? profile.allowedPages
                : DEFAULT_ROLE_PAGES[profile.role] || [],
            profile,
          },
        };

        saveSession(session);
        return session;
      }
    } catch {
      // continue to employee email fallback
    }
  }

  const apiKey = import.meta.env.VITE_HYACINTH_API_KEY;
  const departmentId = import.meta.env.VITE_HYACINTH_DEPARTMENT_ID;

  if (!apiKey) {
    throw new Error("Missing VITE_HYACINTH_API_KEY in .env");
  }

  if (!departmentId) {
    throw new Error("Missing VITE_HYACINTH_DEPARTMENT_ID in .env");
  }

  const api = new HyacinthAttendanceAPI(apiKey);
  const employees = await api.getUsersByDepartment(departmentId);

  const matchedEmployee = (Array.isArray(employees) ? employees : []).find((emp) => {
    const empId = String(getUserId(emp) || "").trim();
    const empEmail = String(emp?.email || "").trim().toLowerCase();

    return empId === normalizedIdentifier || empEmail === normalizedIdentifierLower;
  });

  if (!matchedEmployee) {
    throw new Error("No matching user found");
  }

  const employeePassword =
    import.meta.env.VITE_EMPLOYEE_PORTAL_PASSWORD || "employee123";

  if (normalizedPassword !== employeePassword) {
    throw new Error("Invalid password");
  }

  const employeeId = getUserId(matchedEmployee);
  const permissionDoc = await getEmployeePermission(employeeId);

  const session = {
    isAuthenticated: true,
    user: {
      id: employeeId,
      userId: employeeId,
      email: matchedEmployee?.email || "",
      name: getUserName(matchedEmployee),
      role: ROLES.EMPLOYEE,
      allowedPages:
        Array.isArray(permissionDoc?.allowedPages) && permissionDoc.allowedPages.length > 0
          ? permissionDoc.allowedPages
          : DEFAULT_ROLE_PAGES[ROLES.EMPLOYEE],
      employee: matchedEmployee,
    },
  };

  saveSession(session);
  return session;
}

export async function logoutUser() {
  try {
    await logoutPortalUser();
  } catch {
    // ignore firebase logout failure for employee-only sessions
  }

  clearSession();
  return true;
}
