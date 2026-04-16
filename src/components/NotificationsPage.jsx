import React, { useEffect, useMemo, useRef, useState } from "react";
import { MoreVertical, RotateCcw, Trash2 } from "lucide-react";
import "./NotificationsPage.css";
import { toMillis } from "../utils/common";
import ConfirmModal from "./ConfirmModal";

const formatDateTime = (value, timeZone = "America/Chicago") => {
  const ms = toMillis(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString(undefined, {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
  });
};

export default function NotificationsPage({
  notifications = [],
  archivedNotifications = [],
  overBreakNotes = [],
  archivedOverBreakNotes = [],
  onMarkNotificationRead,
  onMarkAllRead,
  onResetAllNotificationData,
  onArchiveNotification,
  onArchiveAllNotifications,
  onArchiveOverBreakNote,
  onArchiveAllOverBreakNotes,
  onRestoreArchivedNotification,
  onDeleteArchivedNotification,
  onDeleteAllArchivedNotifications,
  onRestoreArchivedOverBreakNote,
  onDeleteArchivedOverBreakNote,
  onDeleteAllArchivedOverBreakNotes,
  canAccessNotificationArchive = false,
  canManageNotificationArchive = false,
  businessTimeZone = "America/Chicago",
}) {
  const [showArchive, setShowArchive] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [confirmState, setConfirmState] = useState({
    open: false,
    mode: "",
    targetId: "",
  });
  const [confirmBusy, setConfirmBusy] = useState(false);
  const actionMenuRef = useRef(null);

  const unreadIds = useMemo(
    () =>
      notifications
        .filter((n) => !n?.read)
        .map((n) => n.id)
        .filter(Boolean),
    [notifications]
  );
  const inboxIds = useMemo(
    () =>
      notifications
        .map((n) => String(n?.id || "").trim())
        .filter(Boolean),
    [notifications]
  );
  const overBreakIds = useMemo(
    () =>
      overBreakNotes
        .map((n) => String(n?.id || "").trim())
        .filter(Boolean),
    [overBreakNotes]
  );
  const archivedInboxIds = useMemo(
    () =>
      archivedNotifications
        .map((n) => String(n?.id || "").trim())
        .filter(Boolean),
    [archivedNotifications]
  );
  const archivedOverBreakIds = useMemo(
    () =>
      archivedOverBreakNotes
        .map((n) => String(n?.id || "").trim())
        .filter(Boolean),
    [archivedOverBreakNotes]
  );
  const isArchiveView = !!showArchive;
  const visibleNotifications = isArchiveView ? archivedNotifications : notifications;
  const visibleOverBreakNotes = isArchiveView ? archivedOverBreakNotes : overBreakNotes;
  const canArchiveActions = canAccessNotificationArchive && !isArchiveView;
  const canArchivedItemActions = canAccessNotificationArchive && isArchiveView;
  const canPermanentDeleteActions = canManageNotificationArchive && isArchiveView;

  useEffect(() => {
    if (!actionMenuOpen) return undefined;

    const handleMouseDown = (event) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target)) {
        setActionMenuOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setActionMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionMenuOpen]);

  const openConfirm = (mode, payload = {}) => {
    setConfirmState({
      open: true,
      mode,
      targetId: String(payload?.targetId || "").trim(),
    });
  };

  const closeConfirm = () => {
    if (confirmBusy) return;
    setConfirmState({
      open: false,
      mode: "",
      targetId: "",
    });
  };

  const confirmDialogConfig = useMemo(() => {
    if (confirmState.mode === "archive_inbox_all") {
      return {
        title: "Move All Inbox Items To Archive?",
        message: "This will move all inbox notifications to Notification Archive.",
        confirmText: "Proceed",
      };
    }

    if (confirmState.mode === "archive_overbreak_all") {
      return {
        title: "Move All Over-break Records To Archive?",
        message: "This will move all over-break records to Notification Archive.",
        confirmText: "Proceed",
      };
    }

    if (confirmState.mode === "archive_single_notification") {
      return {
        title: "Move Notification To Archive?",
        message: "This notification will be moved to Notification Archive.",
        confirmText: "Proceed",
      };
    }

    if (confirmState.mode === "delete_archived_notification") {
      return {
        title: "Delete Archived Notification?",
        message: "This will permanently delete the archived notification.",
        confirmText: "Delete",
      };
    }

    if (confirmState.mode === "delete_archived_inbox_all") {
      return {
        title: "Delete All Archived Inbox Notifications?",
        message: "This will permanently delete all archived inbox notifications.",
        confirmText: "Delete All",
      };
    }

    if (confirmState.mode === "delete_archived_overbreak") {
      return {
        title: "Delete Archived Over-break Record?",
        message: "This will permanently delete the archived over-break record.",
        confirmText: "Delete",
      };
    }

    if (confirmState.mode === "delete_archived_overbreak_all") {
      return {
        title: "Delete All Archived Over-break Records?",
        message: "This will permanently delete all archived over-break records.",
        confirmText: "Delete All",
      };
    }

    if (confirmState.mode === "reset_all_notification_data") {
      return {
        title: "Reset Notifications For All Users?",
        message:
          "This will permanently delete all notification and over-break records for all users.",
        confirmText: "Reset All",
      };
    }

    return {
      title: "Confirm Action",
      message: "Are you sure you want to continue?",
      confirmText: "Proceed",
    };
  }, [confirmState.mode]);

  const handleConfirm = async () => {
    setConfirmBusy(true);
    try {
      if (confirmState.mode === "archive_inbox_all") {
        await onArchiveAllNotifications?.(inboxIds);
      }
      if (confirmState.mode === "archive_overbreak_all") {
        await onArchiveAllOverBreakNotes?.(overBreakIds);
      }
      if (confirmState.mode === "archive_single_notification" && confirmState.targetId) {
        await onArchiveNotification?.(confirmState.targetId);
      }
      if (confirmState.mode === "delete_archived_notification" && confirmState.targetId) {
        await onDeleteArchivedNotification?.(confirmState.targetId);
      }
      if (confirmState.mode === "delete_archived_inbox_all") {
        await onDeleteAllArchivedNotifications?.(archivedInboxIds);
      }
      if (confirmState.mode === "delete_archived_overbreak" && confirmState.targetId) {
        await onDeleteArchivedOverBreakNote?.(confirmState.targetId);
      }
      if (confirmState.mode === "delete_archived_overbreak_all") {
        await onDeleteAllArchivedOverBreakNotes?.(archivedOverBreakIds);
      }
      if (confirmState.mode === "reset_all_notification_data") {
        await onResetAllNotificationData?.();
      }
      setConfirmState({
        open: false,
        mode: "",
        targetId: "",
      });
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <div className="notif-page">
      <div className="notif-page-head">
        <div className="notif-page-head-actions" ref={actionMenuRef}>
          <button
            type="button"
            className="notif-page-menu-trigger"
            onClick={() => setActionMenuOpen((prev) => !prev)}
            aria-label="Notification actions"
            aria-haspopup="menu"
            aria-expanded={actionMenuOpen}
          >
            <MoreVertical size={16} />
          </button>

          {actionMenuOpen ? (
            <div className="notif-page-menu" role="menu" aria-label="Notification actions">
              <button
                type="button"
                role="menuitem"
                className="notif-page-menu-item"
                disabled={isArchiveView || unreadIds.length === 0}
                onClick={() => {
                  setActionMenuOpen(false);
                  onMarkAllRead?.(unreadIds);
                }}
              >
                Mark all as read
              </button>

              {canAccessNotificationArchive ? (
                <button
                  type="button"
                  role="menuitem"
                  className="notif-page-menu-item"
                  onClick={() => {
                    setActionMenuOpen(false);
                    setShowArchive((prev) => !prev);
                  }}
                >
                  {isArchiveView ? "Back to Notifications" : "Notification Archive"}
                </button>
              ) : null}

              {canManageNotificationArchive ? (
                <button
                  type="button"
                  role="menuitem"
                  className="notif-page-menu-item danger"
                  onClick={() => {
                    setActionMenuOpen(false);
                    openConfirm("reset_all_notification_data");
                  }}
                >
                  Reset Notifications (All Users)
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="notif-page-grid">
        <div className="notif-page-card">
          <div className="notif-page-card-head">
            <span>{isArchiveView ? "Inbox Archive" : "Inbox"}</span>
            <div className="notif-page-card-head-actions">
              {canArchiveActions ? (
                <button
                  type="button"
                  className="notif-page-icon-btn"
                  onClick={() => openConfirm("archive_inbox_all")}
                  disabled={inboxIds.length === 0}
                  aria-label="Move all inbox notifications to archive"
                  title="Move all to archive"
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
              {canArchivedItemActions ? (
                <button
                  type="button"
                  className="notif-page-delete-all-btn"
                  onClick={() => openConfirm("delete_archived_inbox_all")}
                  disabled={!canPermanentDeleteActions || archivedInboxIds.length === 0}
                >
                  Delete All Permanently
                </button>
              ) : null}
            </div>
          </div>

          <div className="notif-page-list">
            {visibleNotifications.length === 0 ? (
              <div className="notif-page-empty">
                {isArchiveView
                  ? "No archived notifications available"
                  : "No notifications available"}
              </div>
            ) : (
              visibleNotifications.map((notif) => (
                <div key={notif.id} className="notif-page-row">
                  {canArchiveActions || canArchivedItemActions ? (
                    <div
                      className={`notif-page-side-actions ${
                        canArchivedItemActions && canPermanentDeleteActions ? "double" : ""
                      }`}
                    >
                      {canArchiveActions ? (
                        <button
                          type="button"
                          className="notif-page-side-btn"
                          onClick={() =>
                            openConfirm("archive_single_notification", {
                              targetId: notif?.id,
                            })
                          }
                          aria-label="Move notification to archive"
                          title="Move to archive"
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                      {canArchivedItemActions && canPermanentDeleteActions ? (
                        <button
                          type="button"
                          className="notif-page-side-btn"
                          onClick={() =>
                            openConfirm("delete_archived_notification", {
                              targetId: notif?.id,
                            })
                          }
                          aria-label="Delete archived notification"
                          title="Delete permanently"
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                      {canArchivedItemActions ? (
                        <button
                          type="button"
                          className="notif-page-side-btn restore"
                          onClick={() => onRestoreArchivedNotification?.(notif?.id)}
                          aria-label="Restore notification"
                          title="Restore"
                        >
                          <RotateCcw size={14} />
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  <button
                    key={notif.id}
                    type="button"
                    className={`notif-page-item ${notif?.read ? "is-read" : "is-unread"} ${
                      canArchiveActions || canArchivedItemActions ? "has-side-btn" : ""
                    }`}
                    onClick={() => onMarkNotificationRead?.(notif)}
                  >
                    <div className="notif-page-item-top">
                      <div className="notif-page-item-title">
                        {notif?.title || "Notification"}
                      </div>
                      <div className="notif-page-item-date">
                        {formatDateTime(notif?.createdAt, businessTimeZone)}
                      </div>
                    </div>

                    {String(notif?.message || "").trim() ? (
                      <div className="notif-page-item-message">
                        {notif.message}
                      </div>
                    ) : null}

                    <div className="notif-page-item-meta">
                      <span>Type: {notif?.type || "-"}</span>
                      {!notif?.read ? <span className="notif-page-pill">Unread</span> : null}
                    </div>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="notif-page-card">
          <div className="notif-page-card-head">
            <span>{isArchiveView ? "Over-break Archive" : "Over-break records"}</span>
            <div className="notif-page-card-head-actions">
              {canArchiveActions ? (
                <button
                  type="button"
                  className="notif-page-icon-btn"
                  onClick={() => openConfirm("archive_overbreak_all")}
                  disabled={overBreakIds.length === 0}
                  aria-label="Move all over-break records to archive"
                  title="Move all to archive"
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
              {canArchivedItemActions ? (
                <button
                  type="button"
                  className="notif-page-delete-all-btn"
                  onClick={() => openConfirm("delete_archived_overbreak_all")}
                  disabled={!canPermanentDeleteActions || archivedOverBreakIds.length === 0}
                >
                  Delete All Permanently
                </button>
              ) : null}
            </div>
          </div>

          <div className="notif-page-list">
            {visibleOverBreakNotes.length === 0 ? (
              <div className="notif-page-empty">
                {isArchiveView
                  ? "No archived over-break records yet"
                  : "No over-break records yet"}
              </div>
            ) : (
              visibleOverBreakNotes.map((note) => (
                <div key={note.id} className="notif-page-row">
                  {canArchiveActions || canArchivedItemActions ? (
                    <div
                      className={`notif-page-side-actions ${
                        canArchivedItemActions && canPermanentDeleteActions ? "double" : ""
                      }`}
                    >
                      {canArchiveActions ? (
                        <button
                          type="button"
                          className="notif-page-side-btn"
                          onClick={() => onArchiveOverBreakNote?.(note?.id)}
                          aria-label="Move over-break record to archive"
                          title="Move to archive"
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                      {canArchivedItemActions && canPermanentDeleteActions ? (
                        <button
                          type="button"
                          className="notif-page-side-btn"
                          onClick={() =>
                            openConfirm("delete_archived_overbreak", {
                              targetId: note?.id,
                            })
                          }
                          aria-label="Delete archived over-break record"
                          title="Delete permanently"
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                      {canArchivedItemActions ? (
                        <button
                          type="button"
                          className="notif-page-side-btn restore"
                          onClick={() => onRestoreArchivedOverBreakNote?.(note?.id)}
                          aria-label="Restore over-break record"
                          title="Restore"
                        >
                          <RotateCcw size={14} />
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  <div
                    className={`notif-page-overbreak ${
                      canArchiveActions || canArchivedItemActions ? "has-side-btn" : ""
                    }`}
                  >
                    <div className="notif-page-item-top">
                      <div className="notif-page-item-title">
                        {note?.name || note?.email || note?.userId || "Employee"}
                      </div>
                      <div className="notif-page-item-date">
                        {formatDateTime(note?.updatedAt || note?.createdAt, businessTimeZone)}
                      </div>
                    </div>

                    <div className="notif-page-overbreak-meta">
                      <span>Total break: {note?.totalBreakMinutes ?? 0} min</span>
                      <span>Over-break: {note?.overBreakMinutes ?? 0} min</span>
                    </div>

                    <div className="notif-page-item-message">
                      {note?.note || "Over-break saved."}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        open={confirmState.open}
        title={confirmDialogConfig.title}
        message={confirmDialogConfig.message}
        confirmText={confirmDialogConfig.confirmText}
        cancelText="Cancel"
        tone="danger"
        busy={confirmBusy}
        onCancel={closeConfirm}
        onConfirm={handleConfirm}
      />
    </div>
  );
}


