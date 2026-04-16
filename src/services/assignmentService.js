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
import { toText, uniq } from "../utils/common";
import { buildTimeZoneMeta, resolveStorageTimeZone } from "../utils/timeZoneMeta";

const ASSIGNMENTS_COLLECTION = "employeeAssignments";
const NOTIFICATIONS_COLLECTION = "break_notifications";

const normalizeDateOnly = (value) => {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

const isAdminLikeRole = (role) => {
  const r = toText(role).toLowerCase();
  return !!r;
};

const isArchiveAllowedRole = (role) => {
  const r = toText(role).toLowerCase();
  return !!r;
};

const normalizeStatusKey = (status) =>
  toText(status).toLowerCase().replace(/\s+/g, "_");

const isToBeCheckStatus = (status) => normalizeStatusKey(status) === "to_be_check";

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
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

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
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    ...extra,
  });
};

export async function getAssignments(options = {}) {
  const includeArchived = !!options?.includeArchived;
  const q = query(
    collection(db, ASSIGNMENTS_COLLECTION),
    orderBy("deadlineDate", "asc")
  );

  const snap = await getDocs(q);

  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  if (includeArchived) return rows;
  return rows.filter((row) => !row?.archived);
}

export async function getAssignmentsByUserId(userId, options = {}) {
  const includeArchived = !!options?.includeArchived;
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

  const rows = Array.from(map.values());
  if (includeArchived) return rows;
  return rows.filter((row) => !row?.archived);
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
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

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
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    completedAt: null,
    completedByUserId: "",
    completedByName: "",
    completionRequestedAt: null,
    completionRequestedByUserId: "",
    completionRequestedByName: "",
    completionReviewedAt: null,
    completionReviewedByUserId: "",
    completionReviewedByName: "",
    completionReviewDecision: "",
    accessRequestedByUserIds: [],
    accessApprovedUserIds: [],
    notificationSent24h: false,
    notificationSentSameDay: false,
    archived: false,
    archivedAt: null,
    archivedByUserId: "",
    archivedByName: "",
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
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  const payload = {
    ...updates,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
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

export async function archiveAssignment(assignmentId, actor = {}) {
  const aid = toText(assignmentId);
  if (!aid) throw new Error("Missing assignment id");

  const actorRole = toText(actor?.role).toLowerCase();
  if (!isArchiveAllowedRole(actorRole)) {
    throw new Error("You do not have permission to archive assignments.");
  }

  const ref = doc(db, ASSIGNMENTS_COLLECTION, aid);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Assignment not found");

  const current = snap.data() || {};
  if (current?.archived) {
    return { archived: false, reason: "already-archived" };
  }

  const archivedNow = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  const actorUserId = toText(
    actor?.userId ?? actor?.uid ?? actor?.id ?? actor?.employeeId ?? ""
  );
  const actorName =
    toText(actor?.name) || toText(actor?.displayName) || toText(actor?.email) || "Super Admin";

  await updateDoc(ref, {
    archived: true,
    archivedAt: serverTimestamp(),
    archivedByUserId: actorUserId,
    archivedByName: actorName,
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("archivedAtClient", archivedNow, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", archivedNow, storageTimeZone),
  });

  return { archived: true };
}

export async function repostAssignment(assignmentId, updates = {}, actor = {}) {
  const aid = toText(assignmentId);
  if (!aid) throw new Error("Missing assignment id");

  const actorRole = toText(actor?.role).toLowerCase();
  if (!isArchiveAllowedRole(actorRole)) {
    throw new Error("You do not have permission to repost archived assignments.");
  }

  const ref = doc(db, ASSIGNMENTS_COLLECTION, aid);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Assignment not found");

  const current = snap.data() || {};
  if (!current?.archived) {
    return { reposted: false, reason: "not-archived" };
  }

  const repostNow = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  const actorUserId = toText(
    actor?.userId ?? actor?.uid ?? actor?.id ?? actor?.employeeId ?? ""
  );
  const actorName =
    toText(actor?.name) || toText(actor?.displayName) || toText(actor?.email) || "Manager";

  const nextDeadlineDate = normalizeDateOnly(updates?.deadlineDate || current?.deadlineDate);

  await updateDoc(ref, {
    title: toText(updates?.title) || toText(current?.title),
    instructions: toText(updates?.instructions) || toText(current?.instructions),
    deadlineDate: nextDeadlineDate || "",
    deadlineTime: toText(updates?.deadlineTime || current?.deadlineTime),
    priority: toText(updates?.priority || current?.priority || "medium"),
    status: toText(updates?.status || "pending"),
    archived: false,
    archivedAt: null,
    archivedByUserId: "",
    archivedByName: "",
    notificationSent24h: false,
    notificationSentSameDay: false,
    completionRequestedAt: null,
    completionRequestedByUserId: "",
    completionRequestedByName: "",
    completionReviewedAt: null,
    completionReviewedByUserId: "",
    completionReviewedByName: "",
    completionReviewDecision: "",
    completedAt: null,
    completedByUserId: "",
    completedByName: "",
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("updatedAtClient", repostNow, storageTimeZone),
  });

  const recipientIds = Array.isArray(current?.employeeUserIds)
    ? current.employeeUserIds.map((id) => toText(id)).filter(Boolean)
    : [toText(current?.employeeUserId)].filter(Boolean);

  const taskTitle = toText(updates?.title) || toText(current?.title) || "an assignment";
  const deadlineText = nextDeadlineDate || "No deadline";

  for (const recipientId of uniq(recipientIds)) {
    await addAssignmentNotification({
      audience: "employee",
      userId: recipientId,
      assignmentId: aid,
      type: "assignment_reposted",
      title: "Assignment reposted",
      message: `${actorName} reposted "${taskTitle}". Deadline: ${deadlineText}.`,
      actorUserId,
      actorName,
      extra: {
        priority: toText(updates?.priority || current?.priority || "medium"),
        deadlineDate: nextDeadlineDate || "",
      },
    });
  }

  return { reposted: true };
}

export async function deleteAssignment(assignmentId, actor = {}) {
  const aid = toText(assignmentId);
  if (!aid) throw new Error("Missing assignment id");

  const actorRole = toText(actor?.role).toLowerCase();
  if (!isAdminLikeRole(actorRole)) {
    throw new Error("You do not have permission to permanently delete archived assignments.");
  }

  const ref = doc(db, ASSIGNMENTS_COLLECTION, aid);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Assignment not found");
  if (!snap.data()?.archived) {
    throw new Error("Only archived assignments can be permanently deleted.");
  }

  await deleteDoc(ref);
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
  if (current.status === "completed") {
    return { requested: false, reason: "already-completed" };
  }
  if (isToBeCheckStatus(current.status)) {
    return { requested: false, reason: "already-pending-review" };
  }

  const requestNow = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(ref, {
    status: "to_be_check",
    completionRequestedAt: serverTimestamp(),
    completionRequestedByUserId: actorUserId,
    completionRequestedByName: actorName,
    completionReviewedAt: null,
    completionReviewedByUserId: "",
    completionReviewedByName: "",
    completionReviewDecision: "",
    completedAt: null,
    completedByUserId: "",
    completedByName: "",
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("completionRequestedAtClient", requestNow, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", requestNow, storageTimeZone),
  });

  await addAssignmentNotification({
    audience: "admin",
    userId: "",
    assignmentId: aid,
    type: "assignment_completion_submitted",
    title: "Completion request submitted",
    message: `${actorName} marked "${current.title || "an assignment"}" as To Be Check.`,
    actorUserId,
    actorName,
    extra: {
      employeeUserId: toText(current.employeeUserId),
      employeeName: current.employeeName || "",
    },
  });

  return { requested: true, status: "to_be_check" };
}

export async function reviewAssignmentCompletion(assignmentId, decision = "", reviewer = {}) {
  const aid = toText(assignmentId);
  if (!aid) throw new Error("Missing assignment id");

  const reviewDecision = normalizeStatusKey(decision);
  if (reviewDecision !== "approve" && reviewDecision !== "reject") {
    throw new Error("Invalid completion review decision");
  }

  const reviewerRole = toText(reviewer?.role).toLowerCase();
  if (!isAdminLikeRole(reviewerRole)) {
    throw new Error("You do not have permission to review completion requests.");
  }

  const reviewerUserId = toText(
    reviewer?.userId ?? reviewer?.uid ?? reviewer?.id ?? reviewer?.employeeId ?? ""
  );
  const reviewerName =
    toText(reviewer?.name) || toText(reviewer?.displayName) || toText(reviewer?.email) || "Manager";

  const ref = doc(db, ASSIGNMENTS_COLLECTION, aid);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Assignment not found");

  const current = snap.data() || {};
  if (!isToBeCheckStatus(current.status)) {
    throw new Error("This assignment is not awaiting completion review.");
  }

  const requesterUserId = toText(
    current.completionRequestedByUserId || current.employeeUserId
  );
  const requesterName =
    toText(current.completionRequestedByName) || toText(current.employeeName) || "Employee";
  const reviewNow = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  if (reviewDecision === "approve") {
    await updateDoc(ref, {
      status: "completed",
      completedAt: serverTimestamp(),
      completedByUserId: requesterUserId,
      completedByName: requesterName,
      completionReviewedAt: serverTimestamp(),
      completionReviewedByUserId: reviewerUserId,
      completionReviewedByName: reviewerName,
      completionReviewDecision: "approved",
      updatedAt: serverTimestamp(),
      ...buildTimeZoneMeta("completedAtClient", reviewNow, storageTimeZone),
      ...buildTimeZoneMeta("completionReviewedAtClient", reviewNow, storageTimeZone),
      ...buildTimeZoneMeta("updatedAtClient", reviewNow, storageTimeZone),
    });

    if (requesterUserId) {
      await addAssignmentNotification({
        audience: "employee",
        userId: requesterUserId,
        assignmentId: aid,
        type: "assignment_completion_approved",
        title: "Task completion approved",
        message: `${reviewerName} approved your completion request for "${current.title || "an assignment"}".`,
        actorUserId: reviewerUserId,
        actorName: reviewerName,
      });
    }

    return { reviewed: true, status: "completed" };
  }

  await updateDoc(ref, {
    status: "in_progress",
    completionRequestedAt: null,
    completionRequestedByUserId: "",
    completionRequestedByName: "",
    completionReviewedAt: serverTimestamp(),
    completionReviewedByUserId: reviewerUserId,
    completionReviewedByName: reviewerName,
    completionReviewDecision: "rejected",
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("completionReviewedAtClient", reviewNow, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", reviewNow, storageTimeZone),
  });

  if (requesterUserId) {
    await addAssignmentNotification({
      audience: "employee",
      userId: requesterUserId,
      assignmentId: aid,
      type: "assignment_completion_rejected",
      title: "Task completion rejected",
      message: `${reviewerName} requested more updates before completing "${current.title || "this assignment"}".`,
      actorUserId: reviewerUserId,
      actorName: reviewerName,
    });
  }

  return { reviewed: true, status: "in_progress" };
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
  const requestNow = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(ref, {
    accessRequestedByUserIds: arrayUnion(requesterUserId),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("updatedAtClient", requestNow, storageTimeZone),
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
  const approveNow = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(ref, {
    accessApprovedUserIds: arrayUnion(requesterId),
    accessRequestedByUserIds: arrayRemove(requesterId),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("updatedAtClient", approveNow, storageTimeZone),
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
    const statusKey = normalizeStatusKey(item?.status);
    if (!item?.id || statusKey === "completed" || statusKey === "to_be_check") continue;

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
    const reminderNow = new Date();
    const storageTimeZone = resolveStorageTimeZone();

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
        ...buildTimeZoneMeta("createdAtClient", reminderNow, storageTimeZone),
        ...buildTimeZoneMeta("updatedAtClient", reminderNow, storageTimeZone),
      });
    }

    const nextFlags = {};
    if (shouldSend24h) nextFlags.notificationSent24h = true;
    if (shouldSendSameDay) nextFlags.notificationSentSameDay = true;

    await updateAssignment(item.id, nextFlags);
  }
}
