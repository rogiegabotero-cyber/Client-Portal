import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import app, { db } from "../firebase";

const COLLECTION_NAME = "employee_process_settings";
const DEFAULT_DOC_ID = "default";
// Computed per-employee status lives in its own collection (one doc per
// userId), written only by Cloud Functions - see functions/index.js
// EMPLOYEE_PROCESS_STATUS_COLLECTION. Keep this name in sync with that.
const STATUS_COLLECTION_NAME = "employee_process_status";

const functions = getFunctions(app, "us-central1");
const finishEmployeeProcessTurnCallable = httpsCallable(functions, "finishEmployeeProcessTurn");
const markEmployeeProcessReadyCallable = httpsCallable(functions, "markEmployeeProcessReady");

export const getDefaultEmployeeProcessSettings = () => ({
  rotationUserIds: [],
  ibUserId: "",
  nlUserId: "",
  purpleIbUserId: "",
  purpleIbSkipUserIds: [],
  updatedAt: null,
  updatedByUserId: "",
  updatedByName: "",
});

const normalizeUserIds = (value = []) =>
  Array.from(
    new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))
  );

const normalizeUserIdQueue = (value = []) =>
  (Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean);

const normalizeSettings = (data = {}) => ({
  ...getDefaultEmployeeProcessSettings(),
  ...data,
  rotationUserIds: normalizeUserIds(data?.rotationUserIds || data?.patternUserIds || []),
  ibUserId: String(data?.ibUserId || data?.ibCurrentUserId || "").trim(),
  nlUserId: String(data?.nlUserId || data?.nlCurrentUserId || "").trim(),
  purpleIbUserId: String(data?.purpleIbUserId || data?.secondaryIbUserId || "").trim(),
  purpleIbSkipUserIds: normalizeUserIdQueue(data?.purpleIbSkipUserIds || data?.secondaryIbSkipUserIds || []),
});

const settingsRef = () => doc(db, COLLECTION_NAME, DEFAULT_DOC_ID);
const statusCollectionRef = () => collection(db, STATUS_COLLECTION_NAME);

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

// Subscribes to the whole employee_process_status collection and hands back a
// { [userId]: statusDoc } map on every change - one Firestore doc per employee,
// written only by Cloud Functions (functions/index.js computeEmployeeProcessStatus
// / markEmployeeProcessReady). onChange receives the full current map each time,
// not a diff, so callers can just replace their local state with it.
export function subscribeEmployeeProcessStatuses(onChange, onError) {
  return onSnapshot(
    statusCollectionRef(),
    (snapshot) => {
      const statusByUserId = {};
      snapshot.forEach((docSnap) => {
        statusByUserId[docSnap.id] = docSnap.data();
      });
      onChange?.(statusByUserId);
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
      purpleIbSkipUserIds: current.purpleIbSkipUserIds.filter((userId) => allowed.has(userId)),
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
    purpleIbSkipUserIds: current.purpleIbSkipUserIds.filter((userId) => allowed.has(userId)),
  };
}

export const getNextEmployeeProcessAssignment = ({
  rotationUserIds = [],
  currentUserId = "",
  unavailableUserIds = [],
  skipUserIds = [],
} = {}) => {
  const orderedIds = normalizeUserIds(rotationUserIds);
  if (!orderedIds.length) return { nextUserId: "", skippedUserIds: [] };

  const unavailable = new Set(normalizeUserIds(unavailableUserIds));
  const pendingSkip = new Set(normalizeUserIdQueue(skipUserIds));
  const availableIds = orderedIds.filter((userId) => !unavailable.has(userId));
  if (!availableIds.length) return { nextUserId: "", skippedUserIds: [] };

  const currentIndex = orderedIds.indexOf(String(currentUserId || "").trim());
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const skippedUserIds = [];

  for (let offset = 0; offset < orderedIds.length; offset += 1) {
    const candidate = orderedIds[(startIndex + offset) % orderedIds.length];
    if (unavailable.has(candidate)) continue;
    if (pendingSkip.has(candidate)) {
      skippedUserIds.push(candidate);
      continue;
    }
    return { nextUserId: candidate, skippedUserIds };
  }

  return { nextUserId: availableIds[0] || "", skippedUserIds };
};

export const getNextEmployeeProcessUserId = (options = {}) => {
  const { nextUserId } = getNextEmployeeProcessAssignment(options);
  return nextUserId;
};

// Still used directly by the client for the Purple IB (secondary IB) mark/remove
// actions - a separate, lower-stakes, manually-triggered feature that was
// deliberately left out of the server-authoritative migration below.
export async function setEmployeeProcessAssignments({
  ibUserId,
  nlUserId,
  purpleIbUserId,
  purpleIbSkipUserIds,
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
  if (typeof purpleIbSkipUserIds !== "undefined") {
    payload.purpleIbSkipUserIds = normalizeUserIdQueue(purpleIbSkipUserIds);
  }

  await setDoc(settingsRef(), payload, { merge: true });
}

// Finishing a turn and marking ready now go through server-validated Cloud
// Functions (functions/index.js) instead of writing employee_process_settings
// directly - the server recomputes fresh status and picks/writes the next
// assignee inside a Firestore transaction, closing the multi-tab race and
// stale-data issues the old direct-write versions of these functions had.
export async function finishEmployeeProcessTurn({
  type = "ib",
  userId = "",
  employeeName = "",
  employeeProfileImageUrl = "",
  actingAsName = "",
} = {}) {
  const response = await finishEmployeeProcessTurnCallable({
    type: String(type || "ib").toLowerCase() === "nl" ? "nl" : "ib",
    userId: String(userId || "").trim(),
    employeeName: String(employeeName || "").trim(),
    employeeProfileImageUrl: String(employeeProfileImageUrl || "").trim(),
    actingAsName: String(actingAsName || "").trim(),
  });

  return response?.data || { success: false, nextUserId: "" };
}

export async function markEmployeeProcessReady({
  userId = "",
  employeeName = "",
  employeeProfileImageUrl = "",
  actingAsName = "",
} = {}) {
  const response = await markEmployeeProcessReadyCallable({
    userId: String(userId || "").trim(),
    employeeName: String(employeeName || "").trim(),
    employeeProfileImageUrl: String(employeeProfileImageUrl || "").trim(),
    actingAsName: String(actingAsName || "").trim(),
  });

  return response?.data || { success: false };
}
