import { normalizeResetTime } from "../utils/attendanceDate";
import { getDeviceTimeZone, toText } from "../utils/common";

const STORAGE_KEY = "hyacinth_attendance_settings_v2";

export const DISPLAY_TIME_ZONE_MODE_DEVICE = "device";
export const DISPLAY_TIME_ZONE_MODE_FIXED = "fixed";
export const DEFAULT_STORAGE_TIME_ZONE = "America/New_York";
export const DEFAULT_DISPLAY_TIME_ZONE_FALLBACK = "America/Chicago";

const DEFAULT_SETTINGS = {
  resetTime: "05:00",
  displayTimeZoneMode: DISPLAY_TIME_ZONE_MODE_DEVICE,
  displayTimeZone: "",
  storageTimeZone: DEFAULT_STORAGE_TIME_ZONE,
};

const isValidTimeZone = (value) => {
  const tz = toText(value);
  if (!tz) return false;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

export const sanitizeTimeZone = (value, fallback = "") => {
  const tz = toText(value);
  if (!tz) return fallback;
  return isValidTimeZone(tz) ? tz : fallback;
};

const normalizeDisplayMode = (value, fallback = DISPLAY_TIME_ZONE_MODE_DEVICE) => {
  const mode = toText(value).toLowerCase();
  if (mode === DISPLAY_TIME_ZONE_MODE_FIXED) return DISPLAY_TIME_ZONE_MODE_FIXED;
  if (mode === DISPLAY_TIME_ZONE_MODE_DEVICE) return DISPLAY_TIME_ZONE_MODE_DEVICE;
  return fallback;
};

const resolveDisplayFromValues = (
  displayMode = DISPLAY_TIME_ZONE_MODE_DEVICE,
  displayTimeZone = "",
  deviceTimeZone = getDeviceTimeZone(DEFAULT_DISPLAY_TIME_ZONE_FALLBACK)
) => {
  if (displayMode === DISPLAY_TIME_ZONE_MODE_FIXED && displayTimeZone) {
    return displayTimeZone;
  }

  return sanitizeTimeZone(deviceTimeZone, DEFAULT_DISPLAY_TIME_ZONE_FALLBACK);
};

export const resolveAttendanceDisplayTimeZone = (
  settings = {},
  deviceTimeZone = getDeviceTimeZone(DEFAULT_DISPLAY_TIME_ZONE_FALLBACK)
) => {
  const mode = normalizeDisplayMode(
    settings?.displayTimeZoneMode,
    DISPLAY_TIME_ZONE_MODE_DEVICE
  );
  const fixedTimeZone = sanitizeTimeZone(settings?.displayTimeZone, "");
  return resolveDisplayFromValues(mode, fixedTimeZone, deviceTimeZone);
};

function normalizeSettings(input = {}) {
  const legacyBusinessTimeZone = sanitizeTimeZone(input?.businessTimeZone, "");
  const displayModeFromInput = toText(input?.displayTimeZoneMode);
  const displayTimeZoneFromInput = sanitizeTimeZone(input?.displayTimeZone, "");

  const normalizedDisplayMode = normalizeDisplayMode(
    displayModeFromInput,
    displayTimeZoneFromInput
      ? DISPLAY_TIME_ZONE_MODE_FIXED
      : DISPLAY_TIME_ZONE_MODE_DEVICE
  );

  const normalizedDisplayTimeZone =
    displayTimeZoneFromInput ||
    (normalizedDisplayMode === DISPLAY_TIME_ZONE_MODE_FIXED ? legacyBusinessTimeZone : "");

  const safeDisplayTimeZone =
    normalizedDisplayMode === DISPLAY_TIME_ZONE_MODE_FIXED
      ? sanitizeTimeZone(
          normalizedDisplayTimeZone,
          getDeviceTimeZone(DEFAULT_DISPLAY_TIME_ZONE_FALLBACK)
        )
      : "";

  const storageTimeZone = sanitizeTimeZone(
    input?.storageTimeZone,
    DEFAULT_STORAGE_TIME_ZONE
  );

  const resolvedBusinessTimeZone = resolveDisplayFromValues(
    normalizedDisplayMode,
    safeDisplayTimeZone,
    getDeviceTimeZone(DEFAULT_DISPLAY_TIME_ZONE_FALLBACK)
  );

  return {
    resetTime: normalizeResetTime(input?.resetTime || DEFAULT_SETTINGS.resetTime),
    displayTimeZoneMode: normalizedDisplayMode,
    displayTimeZone: safeDisplayTimeZone,
    storageTimeZone,
    businessTimeZone: resolvedBusinessTimeZone,
    resolvedBusinessTimeZone,
  };
}

export function getAttendanceSettingsSync() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalizeSettings(DEFAULT_SETTINGS);

    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

export async function getAttendanceSettings() {
  return getAttendanceSettingsSync();
}

export async function saveAttendanceSettings(settings = {}, audit = {}) {
  const current = getAttendanceSettingsSync();
  const next = normalizeSettings({ ...current, ...(settings || {}) });

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
      },
      audit
    );
  }

  return saveAttendanceSettings(arg1, audit);
}
