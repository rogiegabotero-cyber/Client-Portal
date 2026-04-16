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
  "register_portal_user",
  "control_panel",
];

export const DEFAULT_ROLE_PAGES = {
  [ROLES.SUPER_ADMIN]: PAGE_KEYS,
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
  [ROLES.EMPLOYEE]: ["employee_dashboard", "attendance", "assignment", "schedule", "notifications"],
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

  if (normalizedRole === ROLES.SUPER_ADMIN) {
    return DEFAULT_ROLE_PAGES[ROLES.SUPER_ADMIN];
  }

  if (Array.isArray(customAllowedPages) && customAllowedPages.length > 0) {
    return customAllowedPages.filter((page) => PAGE_KEYS.includes(page));
  }

  return DEFAULT_ROLE_PAGES[normalizedRole] || [];
}

export function canAccessPage(role, page, customAllowedPages = null) {
  const targetPage = String(page || "").trim().toLowerCase();
  const allowedPages = getAllowedPages(role, customAllowedPages);
  return allowedPages.includes(targetPage);
}
