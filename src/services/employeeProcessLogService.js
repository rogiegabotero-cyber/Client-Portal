import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

const COLLECTION_NAME = "employee_process_action_logs";
// Archived entries live in their own collection with the same document id as
// the original (so a log's identity survives the move) plus archivedAt/
// archivedAtMs/archivedByUserId/archivedByName metadata. Archiving is meant
// to be non-destructive - only clearEmployeeProcessActionLogArchive and
// deleteEmployeeProcessActionLogArchiveEntries actually delete data.
const ARCHIVE_COLLECTION_NAME = "employee_process_action_log_archive";

const LOG_FIELD_KEYS = [
  "employeeUserId",
  "employeeName",
  "employeeProfileImageUrl",
  "actionType",
  "actionLabel",
  "actionScope",
  "relatedUserId",
  "relatedUserName",
  "createdByUserId",
  "createdByName",
  "source",
  "createdAtMs",
  "createdAt",
];

const toText = (value) => String(value ?? "").trim();
const toMs = (value) => {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

// dedupeKey is for events that get detected passively by every open session
// watching the same live data (break start/end, shift completion) rather
// than fired once by a single user's button click - without it, two open
// tabs/admins can each independently notice the same transition and each
// write their own duplicate entry. Passing a dedupeKey (stable across every
// session that could observe the same event, e.g. the break_logs doc id, or
// `${userId}:${dayKey}` for a once-per-day event) targets a fixed document
// id instead of creating a new one, so every session's write collapses onto
// the same doc no matter how many of them fire.
export async function createEmployeeProcessActionLog(payload = {}) {
  const employeeUserId = toText(payload.employeeUserId);
  if (!employeeUserId) throw new Error("Missing employeeUserId.");

  const actionLabel = toText(payload.actionLabel);
  if (!actionLabel) throw new Error("Missing action label.");

  const docPayload = {
    employeeUserId,
    employeeName: toText(payload.employeeName),
    employeeProfileImageUrl: toText(payload.employeeProfileImageUrl),
    actionType: toText(payload.actionType),
    actionLabel,
    actionScope: toText(payload.actionScope),
    relatedUserId: toText(payload.relatedUserId),
    relatedUserName: toText(payload.relatedUserName),
    createdByUserId: toText(payload.createdByUserId),
    createdByName: toText(payload.createdByName),
    source: toText(payload.source) || "employee_dashboard",
    createdAtMs: Date.now(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const dedupeKey = toText(payload.dedupeKey);
  if (dedupeKey) {
    const safeId = dedupeKey.replace(/\//g, "_");
    await setDoc(doc(db, COLLECTION_NAME, safeId), docPayload);
    return { id: safeId };
  }

  return addDoc(collection(db, COLLECTION_NAME), docPayload);
}

export function subscribeEmployeeProcessActionLogs(
  { employeeUserId = "", maxRows = 0 } = {},
  onChange,
  onError
) {
  const safeLimit = Math.max(0, Number(maxRows) || 0);
  const clauses = [];
  const uid = toText(employeeUserId);
  if (uid) clauses.push(where("employeeUserId", "==", uid));
  clauses.push(orderBy("createdAtMs", "desc"));
  if (safeLimit > 0) clauses.push(limit(safeLimit));

  return onSnapshot(
    query(collection(db, COLLECTION_NAME), ...clauses),
    (snapshot) => {
      const rows = snapshot.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => toMs(b.createdAtMs || b.createdAt) - toMs(a.createdAtMs || a.createdAt))
        .slice(0, safeLimit > 0 ? safeLimit : undefined);
      onChange?.(rows, snapshot);
    },
    onError
  );
}

// Moves the given logs (full row objects from the subscribed list, not just
// ids - the original fields are copied over so the archive is a real record,
// not just a pointer) from the active collection to the archive collection,
// reusing the same document id. Chunked at 200 logs per batch since each one
// is 2 writes (archive set + active delete), staying under Firestore's
// 500-write batch limit.
export async function archiveEmployeeProcessActionLogs(logs, { archivedByUserId = "", archivedByName = "" } = {}) {
  const entries = (Array.isArray(logs) ? logs : []).filter((log) => toText(log?.id));
  if (!entries.length) return 0;

  const CHUNK_SIZE = 200;
  let archivedCount = 0;

  for (let index = 0; index < entries.length; index += CHUNK_SIZE) {
    const batch = writeBatch(db);
    const chunk = entries.slice(index, index + CHUNK_SIZE);

    for (const log of chunk) {
      const id = toText(log.id);
      const archiveData = {};
      for (const key of LOG_FIELD_KEYS) {
        if (typeof log[key] !== "undefined") archiveData[key] = log[key];
      }
      archiveData.archivedAtMs = Date.now();
      archiveData.archivedAt = serverTimestamp();
      archiveData.archivedByUserId = toText(archivedByUserId);
      archiveData.archivedByName = toText(archivedByName);

      batch.set(doc(db, ARCHIVE_COLLECTION_NAME, id), archiveData);
      batch.delete(doc(db, COLLECTION_NAME, id));
    }

    await batch.commit();
    archivedCount += chunk.length;
  }

  return archivedCount;
}

export function subscribeEmployeeProcessActionLogArchive({ maxRows = 0 } = {}, onChange, onError) {
  const safeLimit = Math.max(0, Number(maxRows) || 0);
  const clauses = [orderBy("createdAtMs", "desc")];
  if (safeLimit > 0) clauses.push(limit(safeLimit));

  return onSnapshot(
    query(collection(db, ARCHIVE_COLLECTION_NAME), ...clauses),
    (snapshot) => {
      const rows = snapshot.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => toMs(b.createdAtMs || b.createdAt) - toMs(a.createdAtMs || a.createdAt))
        .slice(0, safeLimit > 0 ? safeLimit : undefined);
      onChange?.(rows, snapshot);
    },
    onError
  );
}

// Permanently deletes the given ids from the archive collection - this is
// the one truly destructive action for archived rows, alongside
// clearEmployeeProcessActionLogArchive below. Accepts a single id or an
// array so it covers both "delete this one archived row" and "delete this
// selected range" with the same function.
export async function deleteEmployeeProcessActionLogArchiveEntries(logIds) {
  const ids = Array.from(
    new Set((Array.isArray(logIds) ? logIds : [logIds]).map(toText).filter(Boolean))
  );
  if (!ids.length) return 0;

  const CHUNK_SIZE = 400;
  let deletedCount = 0;

  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    const batch = writeBatch(db);
    const chunk = ids.slice(index, index + CHUNK_SIZE);
    chunk.forEach((id) => batch.delete(doc(db, ARCHIVE_COLLECTION_NAME, id)));
    await batch.commit();
    deletedCount += chunk.length;
  }

  return deletedCount;
}

export async function clearEmployeeProcessActionLogArchive() {
  const snapshot = await getDocs(collection(db, ARCHIVE_COLLECTION_NAME));
  const docs = snapshot.docs || [];
  let deletedCount = 0;

  for (let index = 0; index < docs.length; index += 400) {
    const batch = writeBatch(db);
    const chunk = docs.slice(index, index + 400);
    chunk.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
    deletedCount += chunk.length;
  }

  return deletedCount;
}
