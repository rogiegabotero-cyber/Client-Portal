const STORAGE_KEY = "hyacinth_attendance_settings_v2";

const DEFAULT_SETTINGS = {
  resetTime: "05:00",
  businessTimeZone: "America/Chicago",
};

function normalizeSettings(input = {}) {
  return {
    resetTime:
      typeof input?.resetTime === "string" && input.resetTime.trim()
        ? input.resetTime.trim()
        : DEFAULT_SETTINGS.resetTime,
    businessTimeZone:
      typeof input?.businessTimeZone === "string" && input.businessTimeZone.trim()
        ? input.businessTimeZone.trim()
        : DEFAULT_SETTINGS.businessTimeZone,
  };
}

export async function getAttendanceSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveAttendanceSettings(settings = {}, audit = {}) {
  const next = normalizeSettings(settings);

  const payload = {
    ...next,
    updatedAt: new Date().toISOString(),
    updatedBy: {
      uid: audit?.uid || "",
      email: audit?.email || "",
      role: audit?.role || "",
      name: audit?.name || "",
    },
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return next;
}

/* backward-compatible alias if old code still calls this */
export async function saveAttendanceResetTime(arg1, audit = {}) {
  if (typeof arg1 === "string") {
    return saveAttendanceSettings(
      {
        resetTime: arg1,
        businessTimeZone: DEFAULT_SETTINGS.businessTimeZone,
      },
      audit
    );
  }

  return saveAttendanceSettings(arg1, audit);
}