import React, { useMemo } from "react";
import "./NotificationsPage.css";
import { toMillis } from "../utils/common";

const formatDateTime = (value, timeZone = "America/Chicago") => {
  const ms = toMillis(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString(undefined, {
    timeZone: String(timeZone || "").trim() || "America/Chicago",
  });
};

export default function NotificationsPage({
  notifications = [],
  overBreakNotes = [],
  onMarkNotificationRead,
  onMarkAllRead,
  businessTimeZone = "America/Chicago",
}) {
  const unreadIds = useMemo(
    () =>
      notifications
        .filter((n) => !n?.read)
        .map((n) => n.id)
        .filter(Boolean),
    [notifications]
  );

  return (
    <div className="notif-page">
      <div className="notif-page-head">
        <div>
          <h2 className="notif-page-title">Notifications</h2>
          <p className="notif-page-subtitle">
            Assignment updates, break reminders, over-break alerts, and recorded escalations
          </p>
        </div>

        <button
          type="button"
          className="notif-page-btn"
          disabled={unreadIds.length === 0}
          onClick={() => onMarkAllRead?.(unreadIds)}
        >
          Mark all as read
        </button>
      </div>

      <div className="notif-page-grid">
        <div className="notif-page-card">
          <div className="notif-page-card-head">Inbox</div>

          <div className="notif-page-list">
            {notifications.length === 0 ? (
              <div className="notif-page-empty">No notifications available</div>
            ) : (
              notifications.map((notif) => (
                <button
                  key={notif.id}
                  type="button"
                  className={`notif-page-item ${notif?.read ? "is-read" : "is-unread"}`}
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
              ))
            )}
          </div>
        </div>

        <div className="notif-page-card">
          <div className="notif-page-card-head">Over-break records</div>

          <div className="notif-page-list">
            {overBreakNotes.length === 0 ? (
              <div className="notif-page-empty">No over-break records yet</div>
            ) : (
              overBreakNotes.map((note) => (
                <div key={note.id} className="notif-page-overbreak">
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
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


