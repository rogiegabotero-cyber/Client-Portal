import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "../firebase";

const COLLECTION_NAME = "employee_process_settings";
const DEFAULT_DOC_ID = "default";

export const getDefaultEmployeeProcessSettings = () => ({
  rotationUserIds: [],
  ibUserId: "",
  nlUserId: "",
  purpleIbUserId: "",
  updatedAt: null,
  updatedByUserId: "",
  updatedByName: "",
});

const normalizeUserIds = (value = []) =>
  Array.from(
    new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))
  );

const normalizeSettings = (data = {}) => ({
  ...getDefaultEmployeeProcessSettings(),
  ...data,
  rotationUserIds: normalizeUserIds(data?.rotationUserIds || data?.patternUserIds || []),
  ibUserId: String(data?.ibUserId || data?.ibCurrentUserId || "").trim(),
  nlUserId: String(data?.nlUserId || data?.nlCurrentUserId || "").trim(),
  purpleIbUserId: String(data?.purpleIbUserId || data?.secondaryIbUserId || "").trim(),
});

const settingsRef = () => doc(db, COLLECTION_NAME, DEFAULT_DOC_ID);

export function subscribeEmployeeProcessSettings(onChange, onError) {
  return onSnapshot(
    settingsRef(),
    (snapshot) => {
      const nextSettings = snapshot.exists()
        ? normalizeSettings(snapshot.data())
        : getDefaultEmployeeProcessSettings();
      onChange?.(nextSettings);
    },
    onError
  );
}

export async function saveEmployeeProcessRotation({
  rotationUserIds = [],
  updatedByUserId = "",
  updatedByName = "",
} = {}) {
  const cleanedIds = normalizeUserIds(rotationUserIds);
  const snapshot = await getDoc(settingsRef());
  const current = snapshot.exists() ? normalizeSettings(snapshot.data()) : getDefaultEmployeeProcessSettings();
  const allowed = new Set(cleanedIds);

  await setDoc(
    settingsRef(),
    {
      rotationUserIds: cleanedIds,
      ibUserId: allowed.has(current.ibUserId) ? current.ibUserId : "",
      nlUserId: allowed.has(current.nlUserId) ? current.nlUserId : "",
      purpleIbUserId: allowed.has(current.purpleIbUserId) ? current.purpleIbUserId : "",
      updatedAt: serverTimestamp(),
      updatedByUserId: String(updatedByUserId || "").trim(),
      updatedByName: String(updatedByName || "").trim(),
    },
    { merge: true }
  );

  return {
    ...current,
    rotationUserIds: cleanedIds,
    ibUserId: allowed.has(current.ibUserId) ? current.ibUserId : "",
    nlUserId: allowed.has(current.nlUserId) ? current.nlUserId : "",
    purpleIbUserId: allowed.has(current.purpleIbUserId) ? current.purpleIbUserId : "",
  };
}

export const getNextEmployeeProcessUserId = ({
  rotationUserIds = [],
  currentUserId = "",
  unavailableUserIds = [],
} = {}) => {
  const orderedIds = normalizeUserIds(rotationUserIds);
  if (!orderedIds.length) return "";

  const unavailable = new Set(normalizeUserIds(unavailableUserIds));
  const availableIds = orderedIds.filter((userId) => !unavailable.has(userId));
  if (!availableIds.length) return "";

  const currentIndex = orderedIds.indexOf(String(currentUserId || "").trim());
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;

  for (let offset = 0; offset < orderedIds.length; offset += 1) {
    const candidate = orderedIds[(startIndex + offset) % orderedIds.length];
    if (!unavailable.has(candidate)) return candidate;
  }

  return availableIds[0] || "";
};

export async function setEmployeeProcessAssignments({
  ibUserId,
  nlUserId,
  purpleIbUserId,
  updatedByUserId = "",
  updatedByName = "",
} = {}) {
  const payload = {
    updatedAt: serverTimestamp(),
    updatedByUserId: String(updatedByUserId || "").trim(),
    updatedByName: String(updatedByName || "").trim(),
  };

  if (typeof ibUserId !== "undefined") payload.ibUserId = String(ibUserId || "").trim();
  if (typeof nlUserId !== "undefined") payload.nlUserId = String(nlUserId || "").trim();
  if (typeof purpleIbUserId !== "undefined") {
    payload.purpleIbUserId = String(purpleIbUserId || "").trim();
  }

  await setDoc(settingsRef(), payload, { merge: true });
}

export async function advanceEmployeeProcessAssignment({
  type = "ib",
  unavailableUserIds = [],
  fallbackRotationUserIds = [],
  updatedByUserId = "",
  updatedByName = "",
} = {}) {
  const snapshot = await getDoc(settingsRef());
  const current = snapshot.exists() ? normalizeSettings(snapshot.data()) : getDefaultEmployeeProcessSettings();
  const rotationUserIds = current.rotationUserIds.length
    ? current.rotationUserIds
    : normalizeUserIds(fallbackRotationUserIds);
  const key = String(type || "").toLowerCase() === "nl" ? "nlUserId" : "ibUserId";
  const nextUserId = getNextEmployeeProcessUserId({
    rotationUserIds,
    currentUserId: current[key],
    unavailableUserIds,
  });

  await setEmployeeProcessAssignments({
    [key]: nextUserId,
    updatedByUserId,
    updatedByName,
  });

  return nextUserId;
}
