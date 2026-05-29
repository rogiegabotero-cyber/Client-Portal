import React, { useEffect, useRef, useState } from "react";
import "./header.css";
import { Bell, ChevronDown, LogOut, Settings, User } from "lucide-react";
import { getProfileImageUrl, getUserId, toMillis } from "../utils/common";

const Header = ({
  employee,
  viewer,
  clockData = null,
  profileImagesByUserId = {},
  notifications = [],
  onNotificationClick,
  onMarkAllNotificationsRead,
  onOpenNotificationsPage,
  onOpenProfilePage,
  onOpenProfileSettings,
  onRequestLogout,
}) => {
  const [notifOpen, setNotifOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [avatarErrored, setAvatarErrored] = useState(false);
  const [markAllNotificationsLoading, setMarkAllNotificationsLoading] = useState(false);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());

  const notifRef = useRef(null);
  const userMenuRef = useRef(null);

  const unreadCount = notifications.filter((n) => !n?.read).length;
  const unreadIds = notifications
    .filter((n) => !n?.read)
    .map((n) => String(n?.id || "").trim())
    .filter(Boolean);
  const hasNotifications = notifications.length > 0;

  const viewerRole = String(viewer?.role || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  const showViewAllNotifications = viewerRole !== "employee";

  const clockReferenceTimeZone =
    String(clockData?.timeZone || "").trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "America/Chicago";
  const isClockOnBreak = !!clockData?.isOnBreak;
  const clockBreakStartMs = toMillis(clockData?.activeBreakStartedAt);
  const clockBreakMinutesActive =
    isClockOnBreak && Number.isFinite(clockBreakStartMs)
      ? Math.max(0, (clockNowMs - clockBreakStartMs) / 60000)
      : 0;
  const clockDisplayName = String(clockData?.name || "").trim();
  const clockTimeLabel = new Date(clockNowMs).toLocaleTimeString(undefined, {
    timeZone: clockReferenceTimeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const profileSource = viewer || employee || null;
  const profileUserId = String(
    getUserId(profileSource) || profileSource?.uid || viewer?.uid || ""
  ).trim();
  const mappedProfileImage = profileUserId
    ? String(profileImagesByUserId?.[profileUserId] || "").trim()
    : "";
  const sourceProfileImage = getProfileImageUrl(profileSource || {});
  const profileImage = mappedProfileImage || sourceProfileImage;

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

  useEffect(() => {
    setAvatarErrored(false);
  }, [profileImage]);

  useEffect(() => {
    const timerId = setInterval(() => setClockNowMs(Date.now()), 1000);
    return () => clearInterval(timerId);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notifRef.current && !notifRef.current.contains(event.target)) {
        setNotifOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setUserMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const handleEsc = (event) => {
      if (event.key === "Escape") {
        setNotifOpen(false);
        setUserMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, []);

  const handleMarkAllNotificationsRead = async () => {
    if (markAllNotificationsLoading) return;
    if (unreadIds.length === 0) return;
    if (typeof onMarkAllNotificationsRead !== "function") return;

    setMarkAllNotificationsLoading(true);
    try {
      await onMarkAllNotificationsRead(unreadIds);
    } finally {
      setMarkAllNotificationsLoading(false);
    }
  };

  const openProfilePage = () => {
    setUserMenuOpen(false);
    setNotifOpen(false);
    if (typeof onOpenProfilePage === "function") onOpenProfilePage();
  };

  const openProfileSettings = () => {
    setUserMenuOpen(false);
    setNotifOpen(false);
    if (typeof onOpenProfileSettings === "function") onOpenProfileSettings();
  };

  const requestLogout = () => {
    setUserMenuOpen(false);
    setNotifOpen(false);
    if (typeof onRequestLogout === "function") onRequestLogout();
  };

  return (
    <header className="top-header">
      <div className="header-left">
        <div className={`top-header-clock-card ${isClockOnBreak ? "is-on-break" : ""}`}>
          <div className="top-header-clock-title">
            {isClockOnBreak ? "Currently On Break" : "Current Time"}
          </div>
          <div className="top-header-clock-time">{clockTimeLabel}</div>
          <div className="top-header-clock-meta">
            <span>{clockReferenceTimeZone}</span>
            {isClockOnBreak && Number.isFinite(clockBreakStartMs) ? (
              <span className="top-header-clock-break">
                Break {Math.floor(clockBreakMinutesActive)}m{clockDisplayName ? ` | ${clockDisplayName}` : ""}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="header-right">
        <div className="notif-wrapper" ref={notifRef}>
          <button
            type="button"
            className={`icon-btn ${notifOpen ? "active" : ""}`}
            onClick={() => {
              setNotifOpen((prev) => !prev);
              setUserMenuOpen(false);
            }}
            aria-label="Open notifications"
            aria-expanded={notifOpen}
          >
            <Bell size={20} />
            {unreadCount > 0 ? (
              <span className="badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
            ) : null}
          </button>

          <div className="profile-box" ref={userMenuRef}>
            <div className="name">
              <div className="profile-name">{displayName}</div>
              <div className="profile-role">{displayRole}</div>
            </div>

            <button
              type="button"
              className="profile-avatar-trigger"
              onClick={() => {
                setUserMenuOpen((prev) => !prev);
                setNotifOpen(false);
              }}
              aria-label="Open profile actions"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              {profileImage && !avatarErrored ? (
                <img
                  src={profileImage}
                  alt={`${displayName} profile`}
                  className="profile-avatar-img"
                  loading="lazy"
                  onError={() => setAvatarErrored(true)}
                />
              ) : (
                <div className="profile-avatar-initials" aria-label={displayName}>
                  {initials}
                </div>
              )}
              <span className="profile-avatar-chevron" aria-hidden="true">
                <ChevronDown size={14} />
              </span>
            </button>

            {userMenuOpen ? (
              <div className="header-user-menu" role="menu" aria-label="Profile actions">
                <button type="button" className="header-user-menu-item" role="menuitem" onClick={openProfilePage}>
                  <User size={15} />
                  <span>Profile</span>
                </button>
                <button
                  type="button"
                  className="header-user-menu-item"
                  role="menuitem"
                  onClick={openProfileSettings}
                >
                  <Settings size={15} />
                  <span>Settings</span>
                </button>
                <button
                  type="button"
                  className="header-user-menu-item is-danger"
                  role="menuitem"
                  onClick={requestLogout}
                >
                  <LogOut size={15} />
                  <span>Logout</span>
                </button>
              </div>
            ) : null}
          </div>

          {notifOpen && (
            <div className="notif-panel">
              <div className="notif-header">
                <div className="notif-header-left">
                  <span>Notifications</span>
                  {unreadCount > 0 ? (
                    <span className="notif-count">{unreadCount} unread</span>
                  ) : null}
                </div>

                <button
                  type="button"
                  className="notif-read-all-btn"
                  disabled={markAllNotificationsLoading || unreadIds.length === 0}
                  onClick={handleMarkAllNotificationsRead}
                >
                  {markAllNotificationsLoading ? (
                    <>
                      <span className="notif-btn-spinner" aria-hidden="true" />
                      <span>Processing...</span>
                    </>
                  ) : (
                    "Mark all as Read"
                  )}
                </button>
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
                      className={`notif-item notif-button ${notif?.read ? "is-read" : "is-unread"}`}
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

              {showViewAllNotifications ? (
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
              ) : null}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
