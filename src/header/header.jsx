import React, { useState, useRef, useEffect } from "react";
import "./header.css";
import { Bell } from "lucide-react";

const Header = ({
  employee,
  viewer,
  notifications = [],
  onNotificationClick,
  onOpenNotificationsPage,
}) => {
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);

  const unreadCount = notifications.filter((n) => !n?.read).length;
  const hasNotifications = notifications.length > 0;

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notifRef.current && !notifRef.current.contains(event.target)) {
        setNotifOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const profileSource = viewer || employee || null;

  const displayName =
    profileSource?.name ||
    profileSource?.fullName ||
    profileSource?.displayName ||
    profileSource?.email ||
    "-";

  const displayRole =
    profileSource?.role ||
    profileSource?.position ||
    profileSource?.title ||
    profileSource?.jobTitle ||
    "-";

  const initials =
    String(displayName)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "U";

  return (
    <header className="top-header">
      <div className="header-right">
        <div className="notif-wrapper" ref={notifRef}>
          <div className="profile-box">
            <div className="name">
              <div className="profile-name">{displayName}</div>
              <div className="profile-role">{displayRole}</div>
            </div>

            <div className="profile-avatar-initials" aria-label={displayName}>
              {initials}
            </div>
          </div>

          <button
            type="button"
            className={`icon-btn ${notifOpen ? "active" : ""}`}
            onClick={() => setNotifOpen((prev) => !prev)}
            aria-label="Open notifications"
            aria-expanded={notifOpen}
          >
            <Bell size={20} />
            {unreadCount > 0 ? (
              <span className="badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
            ) : null}
          </button>

          {notifOpen && (
            <div className="notif-panel">
              <div className="notif-header">
                <span>Notifications</span>
                {unreadCount > 0 ? (
                  <span className="notif-count">{unreadCount} unread</span>
                ) : null}
              </div>

              <div className="notif-list">
                {!hasNotifications ? (
                  <div className="notif-item">
                    <p>No notifications available</p>
                  </div>
                ) : (
                  notifications.slice(0, 8).map((notif) => (
                    <button
                      type="button"
                      className={`notif-item notif-button ${
                        notif?.read ? "is-read" : "is-unread"
                      }`}
                      key={notif.id}
                      onClick={() => {
                        if (typeof onNotificationClick === "function") {
                          onNotificationClick(notif);
                        }
                      }}
                    >
                      <div className="notif-item-top">
                        <b>{notif?.title ?? "Notification"}</b>
                      </div>
                      {String(notif?.message || "").trim() ? <p>{notif.message}</p> : null}
                    </button>
                  ))
                )}
              </div>

              <div className="notif-footer">
                <button
                  type="button"
                  className="notif-view-all-btn"
                  onClick={() => {
                    setNotifOpen(false);
                    if (typeof onOpenNotificationsPage === "function") {
                      onOpenNotificationsPage();
                    }
                  }}
                >
                  View all notifications
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
