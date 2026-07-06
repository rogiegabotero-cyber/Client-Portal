import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

const COLLECTION_NAME = "employee_process_action_logs";

const toText = (value) => String(value ?? "").trim();
const toMs = (value) => {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

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

  return addDoc(collection(db, COLLECTION_NAME), docPayload);
}

export async function resetEmployeeProcessActionLogs() {
  const snapshot = await getDocs(collection(db, COLLECTION_NAME));
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

export async function deleteEmployeeProcessActionLog(logId) {
  const id = toText(logId);
  if (!id) throw new Error("Missing log id.");
  return deleteDoc(doc(db, COLLECTION_NAME, id));
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
