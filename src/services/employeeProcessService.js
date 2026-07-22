import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "../firebase";

const COLLECTION_NAME = "employee_process_settings";
const DEFAULT_DOC_ID = "default";
// Client-writable "I'm Ready" override, one doc per userId - lets an
// early-logged-in employee (or an admin) flip that row to available/Live
// before the schedule's start time is reached, without waiting for it.
const READY_OVERRIDE_COLLECTION_NAME = "employee_process_ready_overrides";

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

const removeOneUserIdOccurrence = (userIds = [], targetUserId = "") => {
  const target = String(targetUserId || "").trim();
  let didRemove = false;

  return normalizeUserIdQueue(userIds).filter((userId) => {
    if (!didRemove && userId === target) {
      didRemove = true;
      return false;
    }
    return true;
  });
};

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
const readyOverrideCollectionRef = () => collection(db, READY_OVERRIDE_COLLECTION_NAME);
const readyOverrideRef = (userId) => doc(db, READY_OVERRIDE_COLLECTION_NAME, String(userId || "").trim());

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

// Subscribes to the whole employee_process_ready_overrides collection and
// hands back a { [userId]: overrideDoc } map on every change.
export function subscribeEmployeeProcessReadyOverrides(onChange, onError) {
  return onSnapshot(
    readyOverrideCollectionRef(),
    (snapshot) => {
      const overrideByUserId = {};
      snapshot.forEach((docSnap) => {
        overrideByUserId[docSnap.id] = docSnap.data();
      });
      onChange?.(overrideByUserId);
    },
    onError
  );
}

// Direct client write - same tier as setEmployeeProcessAssignments/Purple IB.
// signature ties the mark to a specific day/schedule window (see
// resolveEmployeeProcessStatus in employee_dashboard.jsx) so a stale ready
// mark from a previous day or shift is ignored automatically instead of
// carrying forward.
export async function setEmployeeProcessReadyOverride({
  userId = "",
  signature = "",
  updatedByUserId = "",
  updatedByName = "",
} = {}) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("Missing userId.");

  await setDoc(readyOverrideRef(uid), {
    ready: true,
    signature: String(signature || "").trim(),
    updatedAt: serverTimestamp(),
    updatedByUserId: String(updatedByUserId || "").trim(),
    updatedByName: String(updatedByName || "").trim(),
  });

  return { success: true };
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

// Direct client write, same tier as setEmployeeProcessAssignments/Purple IB
// above. The caller passes in unavailableUserIds it already computed from the
// live exact-attendance status (see employee_dashboard.jsx), since this
// service module has no attendance data of its own. The transaction still
// re-reads the current holder right before writing, so a second tab that
// already advanced this same turn gets a clear rejection instead of silently
// clobbering it - the one race this needs to guard against locally now that
// there's no server-side transaction doing it.
export async function finishEmployeeProcessTurn({
  type = "ib",
  userId = "",
  unavailableUserIds = [],
  updatedByUserId = "",
  updatedByName = "",
} = {}) {
  const normalizedType = String(type || "ib").toLowerCase() === "nl" ? "nl" : "ib";
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId is required.");

  const key = normalizedType === "nl" ? "nlUserId" : "ibUserId";
  const label = normalizedType === "nl" ? "New Lead" : "Inbound";
  const isInbound = normalizedType === "ib";
  const unavailableSet = normalizeUserIds(unavailableUserIds);

  const nextUserId = await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(settingsRef());
    const current = snap.exists() ? normalizeSettings(snap.data()) : getDefaultEmployeeProcessSettings();
    const currentUserId = String(current[key] || "").trim();

    if (currentUserId !== uid) {
      throw new Error(
        `You are no longer the current ${label} holder - someone else may have already finished this turn.`
      );
    }

    const pendingPurpleIbSkipUserIds = isInbound ? current.purpleIbSkipUserIds : [];
    const { nextUserId: pickedUserId, skippedUserIds } = getNextEmployeeProcessAssignment({
      rotationUserIds: current.rotationUserIds,
      currentUserId,
      unavailableUserIds: unavailableSet,
      skipUserIds: pendingPurpleIbSkipUserIds,
    });

    const updates = {
      [key]: pickedUserId,
      updatedAt: serverTimestamp(),
      updatedByUserId: String(updatedByUserId || "").trim(),
      updatedByName: String(updatedByName || "").trim(),
    };

    if (isInbound) {
      updates.purpleIbSkipUserIds = skippedUserIds.length
        ? skippedUserIds.reduce(
            (ids, skippedId) => removeOneUserIdOccurrence(ids, skippedId),
            pendingPurpleIbSkipUserIds
          )
        : pendingPurpleIbSkipUserIds;
    }

    transaction.set(settingsRef(), updates, { merge: true });
    return pickedUserId;
  });

  return { success: true, nextUserId };
}

// Client-side equivalent of the old scheduled Cloud Function
// (refreshEmployeeProcessStatus -> autoAdvanceEmployeeProcessAssignments):
// moves the IB/NL mark off a holder unavailableUserIds says is no longer
// available (or bootstraps an unset mark) onto the next available employee.
// When nobody in the rotation is available, clears the mark to "" instead of
// leaving it pointing at someone unavailable - that's a deliberate behavior
// change from the old Cloud Function, which just left it stale in that case.
// expectedCurrentUserId is re-verified against a fresh read inside the
// transaction, so a stale/duplicate call (e.g. two tabs both noticing the
// same unavailable holder) is a safe no-op rather than a double-advance.
export async function autoAdvanceEmployeeProcessAssignment({
  type = "ib",
  expectedCurrentUserId = "",
  unavailableUserIds = [],
} = {}) {
  const normalizedType = String(type || "ib").toLowerCase() === "nl" ? "nl" : "ib";
  const key = normalizedType === "nl" ? "nlUserId" : "ibUserId";
  const isInbound = normalizedType === "ib";
  const expectedUserId = String(expectedCurrentUserId || "").trim();
  const unavailableSet = normalizeUserIds(unavailableUserIds);

  return runTransaction(db, async (transaction) => {
    const snap = await transaction.get(settingsRef());
    const current = snap.exists() ? normalizeSettings(snap.data()) : getDefaultEmployeeProcessSettings();
    const freshCurrentUserId = String(current[key] || "").trim();

    if (freshCurrentUserId !== expectedUserId) return null;

    const rotationUserIds = current.rotationUserIds;
    const availableUserIds = rotationUserIds.filter((rowUserId) => !unavailableSet.includes(rowUserId));

    if (!availableUserIds.length) {
      if (!freshCurrentUserId) return null;
      transaction.set(
        settingsRef(),
        {
          [key]: "",
          updatedAt: serverTimestamp(),
          updatedByUserId: "system",
          updatedByName: "Automatic rotation",
        },
        { merge: true }
      );
      return { previousUserId: freshCurrentUserId, nextUserId: "", cleared: true };
    }

    const pendingPurpleIbSkipUserIds = isInbound ? current.purpleIbSkipUserIds : [];
    const { nextUserId, skippedUserIds } = getNextEmployeeProcessAssignment({
      rotationUserIds,
      currentUserId: freshCurrentUserId,
      unavailableUserIds: unavailableSet,
      skipUserIds: pendingPurpleIbSkipUserIds,
    });

    if (!nextUserId || nextUserId === freshCurrentUserId) return null;

    const updates = {
      [key]: nextUserId,
      updatedAt: serverTimestamp(),
      updatedByUserId: "system",
      updatedByName: "Automatic rotation",
    };
    if (isInbound) {
      updates.purpleIbSkipUserIds = skippedUserIds.length
        ? skippedUserIds.reduce(
            (ids, skippedId) => removeOneUserIdOccurrence(ids, skippedId),
            pendingPurpleIbSkipUserIds
          )
        : pendingPurpleIbSkipUserIds;
    }

    transaction.set(settingsRef(), updates, { merge: true });
    return { previousUserId: freshCurrentUserId, nextUserId, bootstrap: !freshCurrentUserId };
  });
}
