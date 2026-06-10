import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { toText, uniq } from "../utils/common";
import { buildTimeZoneMeta, resolveStorageTimeZone } from "../utils/timeZoneMeta";

const ANNOUNCEMENTS_COLLECTION = "employee_announcements";
const NOTIFICATIONS_COLLECTION = "break_notifications";

const toPreviewText = (value, maxLen = 120) => {
  const cleaned = toText(value).replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLen)).trimEnd()}...`;
};
const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
};

export async function getAnnouncements({ limitCount = 30, includeDeleted = false, onlyDeleted = false } = {}) {
  const safeLimit = Number.isFinite(Number(limitCount)) ? Math.max(1, Number(limitCount)) : 30;
  const q = query(
    collection(db, ANNOUNCEMENTS_COLLECTION),
    orderBy("createdAt", "desc"),
    limit(safeLimit)
  );

  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  const isDeletedRow = (row) => {
    const deletedAt = row?.deletedAt;
    if (!deletedAt) return false;
    if (typeof deletedAt?.toMillis === "function") {
      return Number.isFinite(deletedAt.toMillis());
    }
    const t = new Date(deletedAt).getTime();
    return Number.isFinite(t);
  };

  if (onlyDeleted) return rows.filter(isDeletedRow);
  if (includeDeleted) return rows;
  return rows.filter((row) => !isDeletedRow(row));
}

export async function createAnnouncement(payload = {}) {
  const headline = toText(payload?.headline);
  const note = toText(payload?.note);
  if (!note) throw new Error("Note is required");
  if (!headline) throw new Error("Headline is required");

  const publishAt = toDate(payload?.publishAt) || new Date();
  const fallbackExpiresAt = new Date(publishAt.getTime() + 24 * 60 * 60 * 1000);
  const noExpiration = payload?.noExpiration === true;
  const expiresAt = noExpiration ? null : toDate(payload?.expiresAt) || fallbackExpiresAt;

  if (expiresAt && expiresAt.getTime() <= publishAt.getTime()) {
    throw new Error("Expire time must be after post time.");
  }
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  const announcementPayload = {
    headline,
    note,
    createdByUserId: toText(payload?.createdByUserId),
    createdByName: payload?.createdByName || "",
    createdByRole: toText(payload?.createdByRole),
    publishAt: Timestamp.fromDate(publishAt),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("publishAtClient", publishAt, storageTimeZone),
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  };

  if (expiresAt) {
    announcementPayload.expiresAt = Timestamp.fromDate(expiresAt);
    Object.assign(
      announcementPayload,
      buildTimeZoneMeta("expiresAtClient", expiresAt, storageTimeZone)
    );
  }

  const ref = await addDoc(collection(db, ANNOUNCEMENTS_COLLECTION), announcementPayload);

  const recipientUserIds = uniq(
    (Array.isArray(payload?.recipientUserIds) ? payload.recipientUserIds : [])
      .map((id) => toText(id))
      .filter(Boolean)
  );
  const shouldNotifyRecipients =
    payload?.notifyEmployees !== false &&
    recipientUserIds.length > 0 &&
    publishAt.getTime() <= Date.now();

  if (shouldNotifyRecipients) {
    const previewMessage = toPreviewText(note, 140);

    for (const userId of recipientUserIds) {
      const notifNow = new Date();
      await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
        audience: "employee",
        userId,
        type: "announcement_posted",
        targetPage: "employee_dashboard",
        announcementId: ref.id,
        title: headline,
        message: previewMessage,
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...buildTimeZoneMeta("createdAtClient", notifNow, storageTimeZone),
        ...buildTimeZoneMeta("updatedAtClient", notifNow, storageTimeZone),
      });
    }
  }

  return ref.id;
}

export async function updateAnnouncement(announcementId, updates = {}) {
  const id = toText(announcementId);
  if (!id) throw new Error("Announcement ID is required");
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  const payload = {
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  };

  if ("note" in updates) {
    const note = toText(updates?.note);
    if (!note) throw new Error("Note is required");
    payload.note = note;
  }

  if ("headline" in updates) {
    const headline = toText(updates?.headline);
    if (!headline) throw new Error("Headline is required");
    payload.headline = headline;
  }

  let publishAtDate = null;
  let expiresAtDate = null;

  if ("publishAt" in updates) {
    publishAtDate = toDate(updates?.publishAt);
    if (!publishAtDate) throw new Error("Invalid publish time");
    payload.publishAt = Timestamp.fromDate(publishAtDate);
    Object.assign(payload, buildTimeZoneMeta("publishAtClient", publishAtDate, storageTimeZone));
  }

  if ("expiresAt" in updates) {
    expiresAtDate = toDate(updates?.expiresAt);
    if (!expiresAtDate) throw new Error("Invalid expire time");
    payload.expiresAt = Timestamp.fromDate(expiresAtDate);
    Object.assign(payload, buildTimeZoneMeta("expiresAtClient", expiresAtDate, storageTimeZone));
  }

  if (publishAtDate && expiresAtDate && expiresAtDate.getTime() <= publishAtDate.getTime()) {
    throw new Error("Expire time must be after post time.");
  }

  await updateDoc(doc(db, ANNOUNCEMENTS_COLLECTION, id), payload);
}

export async function deleteAnnouncement(announcementId, actor = {}) {
  const id = toText(announcementId);
  if (!id) throw new Error("Announcement ID is required");
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  await updateDoc(doc(db, ANNOUNCEMENTS_COLLECTION, id), {
    deletedAt: serverTimestamp(),
    deletedByUserId: toText(actor?.userId ?? actor?.uid ?? actor?.id ?? ""),
    deletedByName: toText(actor?.name ?? actor?.displayName ?? actor?.email ?? ""),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("deletedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });
}

export async function restoreAnnouncement(announcementId) {
  const id = toText(announcementId);
  if (!id) throw new Error("Announcement ID is required");
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(doc(db, ANNOUNCEMENTS_COLLECTION, id), {
    deletedAt: null,
    deletedByUserId: "",
    deletedByName: "",
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });
}

export async function permanentlyDeleteAnnouncement(announcementId) {
  const id = toText(announcementId);
  if (!id) throw new Error("Announcement ID is required");
  await deleteDoc(doc(db, ANNOUNCEMENTS_COLLECTION, id));
}
