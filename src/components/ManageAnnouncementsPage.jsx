import React, { useEffect, useMemo, useState } from "react";
import { Archive, Clock3, Pencil, PlayCircle, RefreshCw, RotateCcw, Save, Trash2, X } from "lucide-react";
import "./manageAnnouncementsPage.css";

const DAY_MS = 24 * 60 * 60 * 1000;

const toText = (value) => String(value || "").trim();

const toMillis = (value) => {
  if (!value) return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : NaN;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const toDateTimeLocalValue = (ms) => {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
};

const formatDateTime = (ms) => {
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString();
};

const buildFallbackHeadline = (note) => {
  const text = toText(note);
  if (!text) return "Announcement";
  return text.length > 70 ? `${text.slice(0, 70)}...` : text;
};

const normalizeRows = (rows = [], nowMs = Date.now()) => {
  return (Array.isArray(rows) ? rows : [])
    .map((item) => {
      const id = toText(item?.id);
      if (!id) return null;

      const note = toText(item?.note || item?.announcement || item?.message || "");
      const headline = toText(item?.headline) || buildFallbackHeadline(note);
      const createdAtMs = toMillis(item?.createdAt);
      const publishAtMsRaw = toMillis(item?.publishAt);
      const expiresAtMsRaw = toMillis(item?.expiresAt);
      const deletedAtMs = toMillis(item?.deletedAt);

      const publishAtMs = Number.isFinite(publishAtMsRaw)
        ? publishAtMsRaw
        : Number.isFinite(createdAtMs)
          ? createdAtMs
          : 0;
      const expiresAtMs = Number.isFinite(expiresAtMsRaw) ? expiresAtMsRaw : Number.POSITIVE_INFINITY;

      let statusBeforeDelete = "active";
      if (nowMs < publishAtMs) statusBeforeDelete = "scheduled";
      else if (nowMs > expiresAtMs) statusBeforeDelete = "expired";

      const isDeleted = Number.isFinite(deletedAtMs);
      const status = isDeleted ? "recycle" : statusBeforeDelete;

      return {
        raw: item,
        id,
        headline,
        note,
        createdBy: toText(item?.createdByName) || "Portal User",
        deletedBy: toText(item?.deletedByName) || "Unknown",
        createdAtMs,
        publishAtMs,
        expiresAtMs,
        deletedAtMs,
        isDeleted,
        statusBeforeDelete,
        status,
      };
    })
    .filter(Boolean);
};

export default function ManageAnnouncementsPage({
  announcements = [],
  loading = false,
  error = "",
  onReloadAnnouncements,
  onUpdateAnnouncement,
  onDeleteAnnouncement,
  onRestoreAnnouncement,
  onPermanentDeleteAnnouncement,
  onToast,
  pageData = null,
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState({
    headline: "",
    note: "",
    publishAt: "",
    expiresAt: "",
  });
  const [savingId, setSavingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [repostingId, setRepostingId] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const [hardDeletingId, setHardDeletingId] = useState("");

  const announcementRows = useMemo(() => {
    if (Array.isArray(announcements)) return announcements;
    if (Array.isArray(pageData?.announcements)) return pageData.announcements;
    return [];
  }, [announcements, pageData]);

  const isLoading = useMemo(() => {
    if (typeof loading === "boolean") return loading;
    return !!pageData?.loading?.announcements;
  }, [loading, pageData]);

  const loadError = toText(error || pageData?.errors?.announcements || "");

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const allRows = useMemo(() => normalizeRows(announcementRows, nowMs), [announcementRows, nowMs]);

  const scheduledRows = useMemo(
    () =>
      allRows
        .filter((row) => !row.isDeleted && row.statusBeforeDelete === "scheduled")
        .sort((a, b) => a.publishAtMs - b.publishAtMs),
    [allRows]
  );

  const activeRows = useMemo(
    () =>
      allRows
        .filter((row) => !row.isDeleted && row.statusBeforeDelete === "active")
        .sort((a, b) => b.publishAtMs - a.publishAtMs),
    [allRows]
  );

  const expiredRows = useMemo(
    () =>
      allRows
        .filter((row) => !row.isDeleted && row.statusBeforeDelete === "expired")
        .sort((a, b) => b.expiresAtMs - a.expiresAtMs),
    [allRows]
  );

  const recycleRows = useMemo(
    () =>
      allRows
        .filter((row) => row.isDeleted)
        .sort((a, b) => b.deletedAtMs - a.deletedAtMs),
    [allRows]
  );

  const beginEdit = (row) => {
    const publishMs = Number.isFinite(row.publishAtMs) ? row.publishAtMs : Date.now();
    const expiresMs =
      Number.isFinite(row.expiresAtMs) && row.expiresAtMs > publishMs
        ? row.expiresAtMs
        : publishMs + DAY_MS;

    setEditingId(row.id);
    setEditDraft({
      headline: row.headline || "",
      note: row.note || "",
      publishAt: toDateTimeLocalValue(publishMs),
      expiresAt: toDateTimeLocalValue(expiresMs),
    });
  };

  const cancelEdit = () => {
    setEditingId("");
    setEditDraft({
      headline: "",
      note: "",
      publishAt: "",
      expiresAt: "",
    });
  };

  const saveEdit = async (rowId) => {
    const headline = toText(editDraft.headline);
    const note = toText(editDraft.note);
    const publishMs = new Date(editDraft.publishAt).getTime();
    const expireMs = new Date(editDraft.expiresAt).getTime();

    if (!headline) {
      onToast?.({
        type: "warning",
        title: "Headline Required",
        message: "Please enter a headline.",
      });
      return;
    }
    if (!note) {
      onToast?.({
        type: "warning",
        title: "Note Required",
        message: "Please enter a note.",
      });
      return;
    }
    if (!Number.isFinite(publishMs) || !Number.isFinite(expireMs)) {
      onToast?.({
        type: "warning",
        title: "Invalid Time",
        message: "Please set valid publish and expire times.",
      });
      return;
    }
    if (expireMs <= publishMs) {
      onToast?.({
        type: "warning",
        title: "Invalid Time Range",
        message: "Expire time must be later than publish time.",
      });
      return;
    }

    setSavingId(rowId);
    try {
      if (typeof onUpdateAnnouncement !== "function") {
        throw new Error("Update action is unavailable");
      }

      await onUpdateAnnouncement(rowId, {
        headline,
        note,
        publishAt: new Date(publishMs),
        expiresAt: new Date(expireMs),
      });

      onToast?.({
        type: "success",
        title: "Updated",
        message: "Announcement updated successfully.",
      });
      cancelEdit();
    } catch (err) {
      console.error("Failed to update announcement:", err);
      onToast?.({
        type: "error",
        title: "Update Failed",
        message: err?.message || "Could not update announcement.",
      });
    } finally {
      setSavingId("");
    }
  };

  const removeAnnouncement = async (row) => {
    const ok = window.confirm("Move this announcement to recycle bin?");
    if (!ok) return;

    setDeletingId(row.id);
    try {
      if (typeof onDeleteAnnouncement !== "function") {
        throw new Error("Delete action is unavailable");
      }

      await onDeleteAnnouncement(row.id);
      onToast?.({
        type: "success",
        title: "Moved to Recycle Bin",
        message: "Announcement can now be restored from recycle bin.",
      });
      if (editingId === row.id) cancelEdit();
    } catch (err) {
      console.error("Failed to delete announcement:", err);
      onToast?.({
        type: "error",
        title: "Move Failed",
        message: err?.message || "Could not move announcement to recycle bin.",
      });
    } finally {
      setDeletingId("");
    }
  };

  const repostAnnouncement = async (row) => {
    const start = Date.now();
    const end = start + DAY_MS;

    setRepostingId(row.id);
    try {
      if (typeof onUpdateAnnouncement !== "function") {
        throw new Error("Update action is unavailable");
      }

      await onUpdateAnnouncement(row.id, {
        publishAt: new Date(start),
        expiresAt: new Date(end),
      });

      onToast?.({
        type: "success",
        title: "Reposted",
        message: "Expired announcement is now active again.",
      });
    } catch (err) {
      console.error("Failed to repost announcement:", err);
      onToast?.({
        type: "error",
        title: "Repost Failed",
        message: err?.message || "Could not repost announcement.",
      });
    } finally {
      setRepostingId("");
    }
  };

  const restoreFromRecycleBin = async (row) => {
    setRestoringId(row.id);
    try {
      if (typeof onRestoreAnnouncement !== "function") {
        throw new Error("Restore action is unavailable");
      }

      await onRestoreAnnouncement(row.id);
      onToast?.({
        type: "success",
        title: "Restored",
        message: "Announcement moved back from recycle bin.",
      });
    } catch (err) {
      console.error("Failed to restore announcement:", err);
      onToast?.({
        type: "error",
        title: "Restore Failed",
        message: err?.message || "Could not restore announcement.",
      });
    } finally {
      setRestoringId("");
    }
  };

  const deleteForeverFromRecycleBin = async (row) => {
    const ok = window.confirm("Permanently delete this announcement? This cannot be undone.");
    if (!ok) return;

    setHardDeletingId(row.id);
    try {
      if (typeof onPermanentDeleteAnnouncement !== "function") {
        throw new Error("Permanent delete action is unavailable");
      }

      await onPermanentDeleteAnnouncement(row.id);
      onToast?.({
        type: "success",
        title: "Deleted Permanently",
        message: "Announcement removed forever.",
      });
    } catch (err) {
      console.error("Failed to permanently delete announcement:", err);
      onToast?.({
        type: "error",
        title: "Permanent Delete Failed",
        message: err?.message || "Could not permanently delete announcement.",
      });
    } finally {
      setHardDeletingId("");
    }
  };

  const renderSection = (title, icon, rows, emptyMessage) => (
    <section className="ma-section">
      <div className="ma-section-head">
        <div className="ma-section-title">
          {icon}
          <span>{title}</span>
        </div>
        <span className="ma-count">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <div className="ma-empty">{emptyMessage}</div>
      ) : (
        <div className="ma-list">
          {rows.map((row) => {
            const isEditing = editingId === row.id;
            const isSaving = savingId === row.id;
            const isDeleting = deletingId === row.id;
            const isReposting = repostingId === row.id;
            const isRestoring = restoringId === row.id;
            const isHardDeleting = hardDeletingId === row.id;

            return (
              <article key={row.id} className={`ma-card ${row.status}`}>
                <div className="ma-card-top">
                  <div className="ma-card-meta">
                    <span className={`ma-pill ${row.status}`}>{row.status}</span>
                    <span>By {row.createdBy}</span>
                  </div>
                  <div className="ma-card-time">
                    <span>Post: {formatDateTime(row.publishAtMs)}</span>
                    <span>Expire: {formatDateTime(row.expiresAtMs)}</span>
                  </div>
                </div>

                {isEditing ? (
                  <div className="ma-edit-wrap">
                    <input
                      type="text"
                      value={editDraft.headline}
                      onChange={(e) =>
                        setEditDraft((prev) => ({ ...prev, headline: e.target.value }))
                      }
                      placeholder="Headline"
                    />

                    <textarea
                      value={editDraft.note}
                      onChange={(e) =>
                        setEditDraft((prev) => ({ ...prev, note: e.target.value }))
                      }
                      rows={4}
                    />

                    <div className="ma-edit-grid">
                      <label>
                        <span>Post at</span>
                        <input
                          type="datetime-local"
                          value={editDraft.publishAt}
                          onChange={(e) =>
                            setEditDraft((prev) => ({ ...prev, publishAt: e.target.value }))
                          }
                        />
                      </label>
                      <label>
                        <span>Expire at</span>
                        <input
                          type="datetime-local"
                          value={editDraft.expiresAt}
                          onChange={(e) =>
                            setEditDraft((prev) => ({ ...prev, expiresAt: e.target.value }))
                          }
                        />
                      </label>
                    </div>

                    <div className="ma-actions">
                      <button
                        type="button"
                        className="ma-btn primary"
                        onClick={() => saveEdit(row.id)}
                        disabled={isSaving}
                      >
                        <Save size={15} />
                        <span>{isSaving ? "Saving..." : "Save"}</span>
                      </button>
                      <button
                        type="button"
                        className="ma-btn"
                        onClick={cancelEdit}
                        disabled={isSaving}
                      >
                        <X size={15} />
                        <span>Cancel</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="ma-headline">{row.headline || "Announcement"}</div>
                    <div className="ma-note">{row.note || "No note content."}</div>
                    <div className="ma-actions">
                      <button
                        type="button"
                        className="ma-btn"
                        onClick={() => beginEdit(row)}
                        disabled={isDeleting || isReposting || isRestoring || isHardDeleting}
                      >
                        <Pencil size={15} />
                        <span>Edit</span>
                      </button>

                      {row.status === "expired" ? (
                        <button
                          type="button"
                          className="ma-btn primary"
                          onClick={() => repostAnnouncement(row)}
                          disabled={isReposting || isDeleting || isRestoring || isHardDeleting}
                        >
                          <RotateCcw size={15} />
                          <span>{isReposting ? "Reposting..." : "Repost"}</span>
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className="ma-btn danger"
                        onClick={() => removeAnnouncement(row)}
                        disabled={isDeleting || isReposting || isRestoring || isHardDeleting}
                      >
                        <Trash2 size={15} />
                        <span>{isDeleting ? "Moving..." : "Move to Bin"}</span>
                      </button>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  const renderRecycleBinSection = (rows) => (
    <section className="ma-section">
      <div className="ma-section-head">
        <div className="ma-section-title">
          <Trash2 size={16} />
          <span>Recycle Bin</span>
        </div>
        <span className="ma-count">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <div className="ma-empty">Recycle bin is empty.</div>
      ) : (
        <div className="ma-list">
          {rows.map((row) => {
            const isRestoring = restoringId === row.id;
            const isHardDeleting = hardDeletingId === row.id;

            return (
              <article key={row.id} className="ma-card recycle">
                <div className="ma-card-top">
                  <div className="ma-card-meta">
                    <span className="ma-pill recycle">in bin</span>
                    <span>By {row.createdBy}</span>
                  </div>
                  <div className="ma-card-time">
                    <span>Deleted: {formatDateTime(row.deletedAtMs)}</span>
                    <span>Deleted by: {row.deletedBy || "-"}</span>
                  </div>
                </div>

                <div className="ma-headline">{row.headline || "Announcement"}</div>
                <div className="ma-note">{row.note || "No note content."}</div>

                <div className="ma-actions">
                  <button
                    type="button"
                    className="ma-btn primary"
                    onClick={() => restoreFromRecycleBin(row)}
                    disabled={isRestoring || isHardDeleting}
                  >
                    <RotateCcw size={15} />
                    <span>{isRestoring ? "Restoring..." : "Restore"}</span>
                  </button>

                  <button
                    type="button"
                    className="ma-btn danger"
                    onClick={() => deleteForeverFromRecycleBin(row)}
                    disabled={isRestoring || isHardDeleting}
                  >
                    <Trash2 size={15} />
                    <span>{isHardDeleting ? "Deleting..." : "Delete Forever"}</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  return (
    <div className="ma-page">
      <div className="ma-head">
        <div>
          <h1>Manage Announcements</h1>
          <p>Track scheduled, active, and expired announcements for the employee dashboard.</p>
        </div>

        <button
          type="button"
          className="ma-btn"
          onClick={() => onReloadAnnouncements?.()}
          disabled={isLoading}
        >
          <RefreshCw size={15} />
          <span>{isLoading ? "Refreshing..." : "Refresh"}</span>
        </button>
      </div>

      {loadError ? <div className="ma-error">{loadError}</div> : null}

      <div className="ma-summary">
        <div className="ma-summary-card">
          <Clock3 size={16} />
          <span>Scheduled: {scheduledRows.length}</span>
        </div>
        <div className="ma-summary-card">
          <PlayCircle size={16} />
          <span>Posted: {activeRows.length}</span>
        </div>
        <div className="ma-summary-card">
          <Archive size={16} />
          <span>Expired: {expiredRows.length}</span>
        </div>
        <div className="ma-summary-card">
          <Trash2 size={16} />
          <span>Recycle Bin: {recycleRows.length}</span>
        </div>
      </div>

      {renderSection("Scheduled to Post", <Clock3 size={16} />, scheduledRows, "No scheduled announcements.")}
      {renderSection("Posted Announcements", <PlayCircle size={16} />, activeRows, "No active announcements.")}
      {renderSection("Expired Announcements", <Archive size={16} />, expiredRows, "No expired announcements.")}
      {renderRecycleBinSection(recycleRows)}
    </div>
  );
}
