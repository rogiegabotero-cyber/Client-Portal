import {
  addDoc,
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

export const CALL_ACTIVITY_COLLECTION = "callActivityLogs";

export const CALL_ACTIVITY_TYPES = [
  "Inbound Call",
  "Outbound Call",
  "Booking",
  "Virtual",
  "UHAI",
  "Admin",
  "Meeting",
  "Training",
  "Research",
  "Other",
];

const toText = (value) => String(value ?? "").trim();

export const normalizeCallActivityType = (value) => {
  const raw = toText(value);
  if (!raw) return "Other";
  const match = CALL_ACTIVITY_TYPES.find((item) => item.toLowerCase() === raw.toLowerCase());
  return match || raw;
};

export const getDateKey = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
};

export const calculateDurationMinutes = (entryDate, startTime, endTime) => {
  const day = toText(entryDate) || getDateKey();
  const start = toText(startTime);
  const end = toText(endTime);
  if (!start || !end) return 0;

  const startMs = new Date(`${day}T${start}:00`).getTime();
  let endMs = new Date(`${day}T${end}:00`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;

  if (endMs < startMs) endMs += 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((endMs - startMs) / 60000));
};

export const formatDuration = (minutes = 0) => {
  const total = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) return `${mins}m`;
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
};

export async function createCallActivityLog(payload = {}) {
  const entryDate = toText(payload.entryDate) || getDateKey();
  const startTime = toText(payload.startTime);
  const endTime = toText(payload.endTime);
  const durationMinutes = calculateDurationMinutes(entryDate, startTime, endTime);
  const count = Math.max(0, Number(payload.count) || 0);

  if (!payload.employeeUserId) throw new Error("Employee is required.");
  if (!startTime || !endTime) throw new Error("Start time and end time are required.");
  if (durationMinutes <= 0) throw new Error("End time must be after start time.");

  const docPayload = {
    employeeUserId: toText(payload.employeeUserId),
    employeeName: toText(payload.employeeName),
    employeeEmail: toText(payload.employeeEmail).toLowerCase(),
    entryDate,
    startTime,
    endTime,
    durationMinutes,
    durationHours: Number((durationMinutes / 60).toFixed(4)),
    activityType: normalizeCallActivityType(payload.activityType),
    count,
    notes: toText(payload.notes),
    direction: toText(payload.direction),
    source: "client_portal",
    createdByUserId: toText(payload.createdByUserId),
    createdByName: toText(payload.createdByName),
    createdByEmail: toText(payload.createdByEmail).toLowerCase(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  return addDoc(collection(db, CALL_ACTIVITY_COLLECTION), docPayload);
}

export function subscribeCallActivityLogs({ startDate = "", endDate = "", employeeUserId = "", maxRows = 1000 } = {}, callback, onError) {
  const clauses = [];
  if (startDate) clauses.push(where("entryDate", ">=", startDate));
  if (endDate) clauses.push(where("entryDate", "<=", endDate));
  if (employeeUserId) clauses.push(where("employeeUserId", "==", employeeUserId));
  clauses.push(orderBy("entryDate", "desc"));
  clauses.push(orderBy("startTime", "desc"));
  clauses.push(limit(Math.max(1, Number(maxRows) || 1000)));

  const q = query(collection(db, CALL_ACTIVITY_COLLECTION), ...clauses);
  return onSnapshot(
    q,
    (snapshot) => {
      callback(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })));
    },
    onError
  );
}

export async function fetchCallActivityLogs({ startDate = "", endDate = "", employeeUserId = "", maxRows = 1000 } = {}) {
  const clauses = [];
  if (startDate) clauses.push(where("entryDate", ">=", startDate));
  if (endDate) clauses.push(where("entryDate", "<=", endDate));
  if (employeeUserId) clauses.push(where("employeeUserId", "==", employeeUserId));
  clauses.push(orderBy("entryDate", "desc"));
  clauses.push(orderBy("startTime", "desc"));
  clauses.push(limit(Math.max(1, Number(maxRows) || 1000)));

  const snapshot = await getDocs(query(collection(db, CALL_ACTIVITY_COLLECTION), ...clauses));
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function bulkImportCallActivityRows(rows = [], createdBy = {}, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const createdByUserId = toText(createdBy.createdByUserId || createdBy.createdByUserId || createdBy.createdByUserId);
  const createdByName = toText(createdBy.createdByName || createdBy.createdByName || createdBy.createdByName);
  const createdByEmail = toText(createdBy.createdByEmail || createdBy.createdByEmail || createdBy.createdByEmail).toLowerCase();
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  let completed = 0;

  const promises = rows.map((raw) => {
    const entryDate = toText(raw.entryDate) || getDateKey(raw.entryDate);
    const startTime = toText(raw.startTime);
    const endTime = toText(raw.endTime);
    const durationMinutes = calculateDurationMinutes(entryDate, startTime, endTime);
    const count = Math.max(0, Number(raw.count) || 0);

    const docPayload = {
      employeeUserId: toText(raw.employeeUserId),
      employeeName: toText(raw.employeeName) || toText(raw.employee),
      employeeEmail: toText(raw.employeeEmail).toLowerCase(),
      entryDate,
      startTime,
      endTime,
      durationMinutes,
      durationHours: Number((durationMinutes / 60).toFixed(4)),
      activityType: normalizeCallActivityType(raw.activityType),
      count,
      notes: toText(raw.notes),
      direction: toText(raw.direction),
      source: "import_google_sheet",
      createdByUserId,
      createdByName,
      createdByEmail,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    return addDoc(collection(db, CALL_ACTIVITY_COLLECTION), docPayload).then((docRef) => {
      completed += 1;
      onProgress?.({ completed, total: rows.length });
      return docRef;
    });
  });

  return Promise.all(promises);
}
