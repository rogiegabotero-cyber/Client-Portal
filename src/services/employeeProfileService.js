import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

const COLLECTION_NAME = "employee_profiles";

export async function getEmployeeProfile(userId) {
  if (!userId) throw new Error("Missing userId");

  const ref = doc(db, COLLECTION_NAME, String(userId));
  const snap = await getDoc(ref);

  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

export async function saveEmployeeStartDate({
  userId,
  startDate,
  name = "",
  email = "",
  employeeData = {},
  updatedBy = {},
}) {
  if (!userId) throw new Error("Missing userId");
  if (!startDate) throw new Error("Missing startDate");

  const ref = doc(db, COLLECTION_NAME, String(userId));

  const payload = {
    userId: String(userId),
    startDate: String(startDate),
    name: String(name || ""),
    email: String(email || ""),
    employeeSnapshot: employeeData || {},
    updatedBy: {
      uid: String(updatedBy?.uid || ""),
      email: String(updatedBy?.email || ""),
      role: String(updatedBy?.role || ""),
      name: String(updatedBy?.name || ""),
    },
    updatedAt: serverTimestamp(),
  };

  await setDoc(ref, payload, { merge: true });

  return payload;
}

export async function getEmployeeProfilesByUserIds(userIds = []) {
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map((x) => String(x)).filter(Boolean)));
  if (!ids.length) return {};

  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) {
    chunks.push(ids.slice(i, i + 10));
  }

  const out = {};

  for (const chunk of chunks) {
    const q = query(collection(db, COLLECTION_NAME), where("userId", "in", chunk));
    const snap = await getDocs(q);

    snap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const uid = String(data.userId || docSnap.id || "");
      if (!uid) return;
      out[uid] = { id: docSnap.id, ...data };
    });
  }

  return out;
}