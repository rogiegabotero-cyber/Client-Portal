import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

const ASSIGNMENTS_COLLECTION = "employeeAssignments";
const NOTIFICATIONS_COLLECTION = "break_notifications";

const normalizeDateOnly = (value) => {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

const toText = (value) => String(value || "").trim();
const uniq = (arr = []) => Array.from(new Set(arr));

const isAdminLikeRole = (role) => {
  const r = toText(role).toLowerCase();
  return r === "admin" || r === "super_admin" || r === "super admin";
};

const canUserCompleteAssignment = (assignment, actorUserId, actorRole) => {
  if (!assignment || !actorUserId) return false;
  if (isAdminLikeRole(actorRole)) return true;

  const assignedUserIds = Array.isArray(assignment.employeeUserIds)
    ? assignment.employeeUserIds.map((id) => toText(id)).filter(Boolean)
    : [];
  const assignedUserId = toText(assignment.employeeUserId);
  if (assignedUserId) assignedUserIds.push(assignedUserId);

  if (uniq(assignedUserIds).includes(actorUserId)) return true;

  const approvedUsers = Array.isArray(assignment.accessApprovedUserIds)
    ? assignment.accessApprovedUserIds.map((id) => toText(id))
    : [];

  return approvedUsers.includes(actorUserId);
};

const addAssignmentNotification = async ({
  audience = "employee",
  userId = "",
  assignmentId = "",
  type = "",
  title = "",
  message = "",
  actorUserId = "",
  actorName = "",
  extra = {},
} = {}) => {
  await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
    audience: toText(audience) || "employee",
    userId: toText(userId),
    assignmentId: toText(assignmentId),
    targetPage: "assignment",
    type: toText(type) || "assignment_update",
    title: title || "Assignment update",
    message: message || "",
    actorUserId: toText(actorUserId),
    actorName: actorName || "",
    read: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...extra,
  });
};

export async function getAssignments() {
  const q = query(
    collection(db, ASSIGNMENTS_COLLECTION),
    orderBy("deadlineDate", "asc")
  );

  const snap = await getDocs(q);

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
}

export async function getAssignmentsByUserId(userId) {
  const uid = String(userId || "");
  if (!uid) return [];

  const [arraySnap, legacySnap] = await Promise.all([
    getDocs(
      query(
        collection(db, ASSIGNMENTS_COLLECTION),
        where("employeeUserIds", "array-contains", uid)
      )
    ),
    getDocs(
      query(
        collection(db, ASSIGNMENTS_COLLECTION),
        where("employeeUserId", "==", uid)
      )
    ),
  ]);

  const map = new Map();
  for (const d of [...arraySnap.docs, ...legacySnap.docs]) {
    map.set(d.id, { id: d.id, ...d.data() });
  }

  return Array.from(map.values());
}

export async function createAssignment(payload) {
  const deadlineDate = normalizeDateOnly(payload?.deadlineDate);
  const assigneeInput = Array.isArray(payload?.assignees) ? payload.assignees : [];
  const normalizedAssignees = assigneeInput
    .map((row) => ({
      userId: toText(row?.userId),
      name: row?.name || "",
      position: row?.position || "",
    }))
    .filter((row) => row.userId);

  const fallbackUserId = toText(payload.employeeUserId);
  if (!normalizedAssignees.length && fallbackUserId) {
    normalizedAssignees.push({
      userId: fallbackUserId,
      name: payload.employeeName || "",
      position: payload.employeePosition || "",
    });
  }

  const assignees = normalizedAssignees;
  const employeeUserIds = uniq(assignees.map((row) => row.userId));
  const employeeNames = uniq(assignees.map((row) => row.name).filter(Boolean));
  const employeePositions = uniq(assignees.map((row) => row.position).filter(Boolean));
  const primaryAssignee = assignees[0] || {
    userId: "",
    name: "",
    position: "",
  };

  const docRef = await addDoc(collection(db, ASSIGNMENTS_COLLECTION), {
    employeeUserId: String(primaryAssignee.userId || ""),
    employeeName: employeeNames.join(", "),
    employeePosition: employeePositions.join(", "),
    employeeUserIds,
    employeeNames,
    employeePositions,
    assignees,
    title: payload.title || "",
    instructions: payload.instructions || "",
    priority: payload.priority || "medium",
    status: payload.status || "pending",
    deadlineDate,
    deadlineTime: payload.deadlineTime || "",
    createdByUserId: String(payload.createdByUserId || ""),
    createdByName: payload.createdByName || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    completedAt: null,
    completedByUserId: "",
    completedByName: "",
    accessRequestedByUserIds: [],
    accessApprovedUserIds: [],
    notificationSent24h: false,
    notificationSentSameDay: false,
  });

  const assignmentId = docRef.id;
  const creatorName = toText(payload.createdByName) || "Manager";
  const title = toText(payload.title) || "New task";
  const deadlineText = deadlineDate || "No deadline";

  for (const recipientId of employeeUserIds) {
    await addAssignmentNotification({
      audience: "employee",
      userId: recipientId,
      assignmentId,
      type: "assignment_assigned",
      title: "New assignment",
      message: `${creatorName} assigned "${title}" to you. Deadline: ${deadlineText}.`,
      actorUserId: toText(payload.createdByUserId),
      actorName: creatorName,
      extra: {
        priority: payload.priority || "medium",
        deadlineDate,
      },
    });
  }

  return assignmentId;
}

export async function updateAssignment(assignmentId, updates = {}) {
  const ref = doc(db, ASSIGNMENTS_COLLECTION, assignmentId);

  const payload = {
    ...updates,
    updatedAt: serverTimestamp(),
  };

  if ("deadlineDate" in payload) {
    const normalized = payload.deadlineDate
      ? normalizeDateOnly(payload.deadlineDate)
      : "";

    if (normalized) {
      payload.deadlineDate = normalized;
    } else {
      delete payload.deadlineDate;
    }
  }

  await updateDoc(ref, payload);
}

export async function deleteAssignment(assignmentId) {
  await deleteDoc(doc(db, ASSIGNMENTS_COLLECTION, assignmentId));
}

export async function markAssignmentCompleted(assignmentId, actor = {}) {
  const aid = toText(assignmentId);
  if (!aid) throw new Error("Missing assignment id");

  const ref = doc(db, ASSIGNMENTS_COLLECTION, aid);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Assignment not found");

  const current = snap.data() || {};

  const actorUserId = toText(
    actor.userId ?? actor.uid ?? actor.id ?? actor.employeeId ?? ""
  );
  const actorRole = toText(actor.role).toLowerCase();
  const actorName =
    toText(actor.name) || toText(actor.displayName) || toText(actor.email) || "Unknown user";

  if (!canUserCompleteAssignment(current, actorUserId, actorRole)) {
    throw new Error("You do not have access to complete this task.");
  }

  await updateDoc(ref, {
    status: "completed",
    completedAt: serverTimestamp(),
    completedByUserId: actorUserId,
    completedByName: actorName,
    updatedAt: serverTimestamp(),
  });

  await addAssignmentNotification({
    audience: "admin",
    userId: "",
    assignmentId: aid,
    type: "assignment_completed",
    title: "Assignment completed",
    message: `${actorName} completed "${current.title || "an assignment"}".`,
    actorUserId,
    actorName,
    extra: {
      employeeUserId: toText(current.employeeUserId),
      employeeName: current.employeeName || "",
    },
  });
}

export async function requestAssignmentAccess(assignmentId, payload = {}) {
  const aid = toText(assignmentId);
  if (!aid) throw new Error("Missing assignment id");

  const requesterUserId = toText(
    payload.requesterUserId ?? payload.userId ?? payload.uid ?? payload.id ?? ""
  );
  const requesterName =
    toText(payload.requesterName) || toText(payload.name) || toText(payload.email) || "Employee";
  const requesterRole = toText(payload.requesterRole || payload.role).toLowerCase();

  if (!requesterUserId) throw new Error("Missing requester user id");

  const ref = doc(db, ASSIGNMENTS_COLLECTION, aid);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Assignment not found");

  const current = snap.data() || {};

  if (canUserCompleteAssignment(current, requesterUserId, requesterRole)) {
    return { requested: false, reason: "already-authorized" };
  }

  await updateDoc(ref, {
    accessRequestedByUserIds: arrayUnion(requesterUserId),
    updatedAt: serverTimestamp(),
  });

  await addAssignmentNotification({
    audience: "admin",
    userId: "",
    assignmentId: aid,
    type: "assignment_access_request",
    title: "Assignment access request",
    message: `${requesterName} requested access to "${current.title || "an assignment"}".`,
    actorUserId: requesterUserId,
    actorName: requesterName,
    extra: {
      requesterUserId,
      requesterName,
      employeeUserId: toText(current.employeeUserId),
      employeeName: current.employeeName || "",
    },
  });

  return { requested: true };
}

export async function approveAssignmentAccess(assignmentId, requesterUserId, approver = {}) {
  const aid = toText(assignmentId);
  const requesterId = toText(requesterUserId);
  if (!aid) throw new Error("Missing assignment id");
  if (!requesterId) throw new Error("Missing requester user id");

  const ref = doc(db, ASSIGNMENTS_COLLECTION, aid);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Assignment not found");

  const current = snap.data() || {};

  await updateDoc(ref, {
    accessApprovedUserIds: arrayUnion(requesterId),
    accessRequestedByUserIds: arrayRemove(requesterId),
    updatedAt: serverTimestamp(),
  });

  const approverName =
    toText(approver.name) || toText(approver.displayName) || toText(approver.email) || "Manager";
  const approverUserId = toText(
    approver.userId ?? approver.uid ?? approver.id ?? approver.employeeId ?? ""
  );

  await addAssignmentNotification({
    audience: "employee",
    userId: requesterId,
    assignmentId: aid,
    type: "assignment_access_approved",
    title: "Assignment access approved",
    message: `${approverName} approved your access request for "${current.title || "an assignment"}".`,
    actorUserId: approverUserId,
    actorName: approverName,
    extra: {
      requesterUserId: requesterId,
    },
  });

  return { approved: true };
}

export function getDaysUntilDeadline(deadlineDate) {
  const ymd = normalizeDateOnly(deadlineDate);
  if (!ymd) return null;

  const today = new Date();
  const todayYmd = today.toISOString().slice(0, 10);

  const a = new Date(`${todayYmd}T00:00:00`);
  const b = new Date(`${ymd}T00:00:00`);

  const diffMs = b.getTime() - a.getTime();
  return Math.floor(diffMs / 86400000);
}

export async function createDeadlineAlertsForAssignments(assignments = []) {
  const tasks = Array.isArray(assignments) ? assignments : [];

  for (const item of tasks) {
    if (!item?.id || item?.status === "completed") continue;

    const recipientIds = uniq(
      (Array.isArray(item?.employeeUserIds) ? item.employeeUserIds : [])
        .map((id) => toText(id))
        .concat(toText(item?.employeeUserId))
        .filter(Boolean)
    );

    if (!recipientIds.length) continue;

    const daysLeft = getDaysUntilDeadline(item.deadlineDate);
    if (daysLeft === null) continue;

    const shouldSend24h = daysLeft === 1 && item.notificationSent24h !== true;
    const shouldSendSameDay = daysLeft === 0 && item.notificationSentSameDay !== true;

    if (!shouldSend24h && !shouldSendSameDay) continue;

    let title = "Task deadline reminder";
    let message = "";

    if (shouldSend24h) {
      message = `Your task "${item.title}" is due tomorrow (${item.deadlineDate}).`;
    } else if (shouldSendSameDay) {
      message = `Your task "${item.title}" is due today (${item.deadlineDate}).`;
    }

    for (const recipientId of recipientIds) {
      await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
        audience: "employee",
        userId: recipientId,
        title,
        message,
        read: false,
        type: "assignment_deadline",
        assignmentId: item.id,
        targetPage: "assignment",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const nextFlags = {};
    if (shouldSend24h) nextFlags.notificationSent24h = true;
    if (shouldSendSameDay) nextFlags.notificationSentSameDay = true;

    await updateAssignment(item.id, nextFlags);
  }
}
