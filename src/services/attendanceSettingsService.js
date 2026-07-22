import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { normalizeResetTime } from "../utils/attendanceDate";
import { getDeviceTimeZone, toText } from "../utils/common";

const STORAGE_KEY = "hyacinth_attendance_settings_v2";
// Same direct-client-write pattern as employee_process_settings (no Cloud
// Function involved) - one shared doc so every admin's browser and the
// backend's own hardcoded default (functions/index.js) agree on the same
// business timezone, instead of each browser defaulting to its own device tz.
const COLLECTION_NAME = "attendance_settings";
const DOC_ID = "global";
const settingsRef = () => doc(db, COLLECTION_NAME, DOC_ID);

export const DISPLAY_TIME_ZONE_MODE_DEVICE = "device";
export const DISPLAY_TIME_ZONE_MODE_FIXED = "fixed";
export const DEFAULT_STORAGE_TIME_ZONE = "America/New_York";
export const DEFAULT_DISPLAY_TIME_ZONE_FALLBACK = "America/Chicago";

// Business day boundaries (schedule matching, IB/NL availability, "today" bucketing)
// must be computed against one shared clock, not whichever timezone the viewing
// admin's device happens to be in - a device-tz default causes IB/NL misbehavior
// specifically near shift end times, when the viewer's local day has already
// rolled over while the schedule (authored in the business's own zone) hasn't.
const DEFAULT_SETTINGS = {
  resetTime: "05:00",
  displayTimeZoneMode: DISPLAY_TIME_ZONE_MODE_FIXED,
  displayTimeZone: DEFAULT_DISPLAY_TIME_ZONE_FALLBACK,
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

// Mirrors the last-known-good settings into localStorage, which is what
// getAttendanceSettingsSync (and every resolveStorageTimeZone() caller that
// needs a synchronous read) falls back to when Firestore is unreachable.
function cacheSettingsLocally(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors (e.g. private browsing)
  }
}

export async function getAttendanceSettings() {
  try {
    const snap = await getDoc(settingsRef());
    if (snap.exists()) {
      const next = normalizeSettings(snap.data());
      cacheSettingsLocally(next);
      return next;
    }
  } catch {
    // offline / permission error - fall back to the local cache below
  }

  return getAttendanceSettingsSync();
}

// Live equivalent of getAttendanceSettings - every open session picks up a
// change the moment it's saved, instead of only on next load.
export function subscribeAttendanceSettings(onChange, onError) {
  return onSnapshot(
    settingsRef(),
    (snapshot) => {
      const next = snapshot.exists() ? normalizeSettings(snapshot.data()) : normalizeSettings(DEFAULT_SETTINGS);
      cacheSettingsLocally(next);
      onChange?.(next);
    },
    (err) => {
      onChange?.(getAttendanceSettingsSync());
      onError?.(err);
    }
  );
}

export async function saveAttendanceSettings(settings = {}, audit = {}) {
  const current = getAttendanceSettingsSync();
  const next = normalizeSettings({ ...current, ...(settings || {}) });

  const payload = {
    ...next,
    updatedAt: serverTimestamp(),
    updatedAtClientIso: new Date().toISOString(),
    updatedBy: {
      uid: audit?.uid || "",
      email: audit?.email || "",
      role: audit?.role || "",
      name: audit?.name || "",
    },
  };

  await setDoc(settingsRef(), payload, { merge: true });
  cacheSettingsLocally(next);
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
