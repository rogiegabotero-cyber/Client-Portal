import HyacinthAttendanceAPI from "../api/hyacinthAttendanceApi";

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

export function getHyacinthEnvConfig() {
  return {
    apiKey: String(import.meta.env.VITE_HYACINTH_API_KEY || "").trim(),
    departmentId: String(import.meta.env.VITE_HYACINTH_DEPARTMENT_ID || "").trim(),
    baseUrl: String(import.meta.env.VITE_HYACINTH_BASE_URL || "").trim(),
  };
}

export function assertHyacinthEnvConfig() {
  const cfg = getHyacinthEnvConfig();
  if (!cfg.apiKey || !cfg.departmentId || !cfg.baseUrl) {
    throw new Error(
      "Missing Hyacinth env config. Ensure VITE_HYACINTH_API_KEY, VITE_HYACINTH_DEPARTMENT_ID, and VITE_HYACINTH_BASE_URL are set."
    );
  }
  return cfg;
}

export function getUsersFromDepartmentResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const candidates = [payload.users, payload.items, payload.results, payload.data];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

export function collectEmployeeEmailCandidates(employee = {}) {
  const directCandidates = [
    employee?.email,
    employee?.workEmail,
    employee?.companyEmail,
    employee?.emailAddress,
    employee?.primaryEmail,
    employee?.contactEmail,
    employee?.userEmail,
    employee?.profile?.email,
    employee?.user?.email,
  ];

  const found = [];
  const pushCandidate = (value) => {
    const normalized = normalizeEmail(value || "");
    if (normalized && !found.includes(normalized)) {
      found.push(normalized);
    }
  };

  directCandidates.forEach(pushCandidate);

  Object.entries(employee || {}).forEach(([key, value]) => {
    if (!/email/i.test(String(key || ""))) return;
    if (typeof value === "string") {
      pushCandidate(value);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach((nested) => {
        if (typeof nested === "string") pushCandidate(nested);
      });
    }
  });

  return found;
}

export async function fetchHyacinthDepartmentUsersRaw() {
  const cfg = assertHyacinthEnvConfig();
  const api = new HyacinthAttendanceAPI(cfg.apiKey);
  return api.getUsersByDepartment(cfg.departmentId);
}

export async function verifyEmailInHyacinthDepartment(emailValue) {
  const normalizedEmail = normalizeEmail(emailValue || "");
  if (!normalizedEmail) throw new Error("Email is required.");

  const rawPayload = await fetchHyacinthDepartmentUsersRaw();
  const users = getUsersFromDepartmentResponse(rawPayload);
  const matchedEmployee =
    users.find((emp) => collectEmployeeEmailCandidates(emp).includes(normalizedEmail)) || null;

  return {
    email: normalizedEmail,
    matchedEmployee,
    users,
    rawPayload,
  };
}

