export const ROLES = {
  EMPLOYEE: "employee",
  ADMIN: "admin",
  ACCOUNTING: "accounting",
  VISITOR: "visitor",
  SUPER_ADMIN: "super_admin",
};

export const PAGE_KEYS = [
  "dashboard",
  "employee_dashboard",
  "profile",
  "attendance",
  "assignment",
  "schedule",
  "hours",
  "notifications",
  "manage_announcements",
  "manage_breaks",
  "call_reports",
  "perf_daily",
  "perf_weekly",
  "perf_monthly",
  "invoices",
  "register_portal_user",
  "control_panel",
];

const EMPLOYEE_BLOCKED_PAGES = new Set(["call_reports"]);

export const DEFAULT_ROLE_PAGES = {
  [ROLES.SUPER_ADMIN]: PAGE_KEYS,
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
    "manage_breaks",
    "call_reports",
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
  [ROLES.VISITOR]: [
    "dashboard",
    "profile",
    "attendance",
    "schedule",
    "notifications",
    "perf_daily",
    "perf_weekly",
    "perf_monthly",
    "invoices",
  ],
  [ROLES.EMPLOYEE]: [
    "employee_dashboard", 
    "profile",
    "attendance",
    "schedule",
    "notifications",
    "perf_daily",
    "perf_weekly",
    "perf_monthly",
    "invoices",
  ],
};

export function normalizeRole(role) {
  const value = String(role || "").trim().toLowerCase();

  if (value === "employee") return ROLES.EMPLOYEE;
  if (value === "admin") return ROLES.ADMIN;
  if (value === "accounting") return ROLES.ACCOUNTING;
  if (value === "visitor") return ROLES.VISITOR;
  if (value === "super admin" || value === "super_admin" || value === "superadmin") {
    return ROLES.SUPER_ADMIN;
  }

  return ROLES.VISITOR;
}

export function getAllowedPages(role, customAllowedPages = null) {
  const normalizedRole = normalizeRole(role);
  const applyRolePageRestrictions = (pages = []) => {
    const normalizedPages = Array.isArray(pages) ? pages : [];
    if (normalizedRole !== ROLES.EMPLOYEE) return normalizedPages;
    return normalizedPages.filter((page) => !EMPLOYEE_BLOCKED_PAGES.has(page));
  };
  const includeProfilePage = (pages = []) => {
    const restrictedPages = applyRolePageRestrictions(pages);
    const normalizedPages = Array.isArray(restrictedPages)
      ? restrictedPages.filter((page) => PAGE_KEYS.includes(page))
      : [];

    if (!normalizedPages.includes("profile")) {
      normalizedPages.unshift("profile");
    }
    return normalizedPages;
  };

  if (normalizedRole === ROLES.SUPER_ADMIN) {
    return includeProfilePage(DEFAULT_ROLE_PAGES[ROLES.SUPER_ADMIN]);
  }

  if (Array.isArray(customAllowedPages) && customAllowedPages.length > 0) {
    return includeProfilePage(customAllowedPages);
  }

  return includeProfilePage(DEFAULT_ROLE_PAGES[normalizedRole] || []);
}

export function canAccessPage(role, page, customAllowedPages = null) {
  const targetPage = String(page || "").trim().toLowerCase();
  if (normalizeRole(role) === ROLES.EMPLOYEE && EMPLOYEE_BLOCKED_PAGES.has(targetPage)) {
    return false;
  }
  const allowedPages = getAllowedPages(role, customAllowedPages);
  return allowedPages.includes(targetPage);
}
