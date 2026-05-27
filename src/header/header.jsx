import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import "./header.css";
import { Bell, Eye, EyeOff, Settings } from "lucide-react";
import { getProfileImageUrl, getUserId, toMillis } from "../utils/common";

const formatProfileDate = (value) => {
  const ms = toMillis(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString();
};

const Header = ({
  employee,
  viewer,
  clockData = null,
  profileImagesByUserId = {},
  notifications = [],
  onNotificationClick,
  onMarkAllNotificationsRead,
  onOpenNotificationsPage,
  onChangeOwnPassword,
}) => {
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileDrawerOpen, setProfileDrawerOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [profileActionLoading, setProfileActionLoading] = useState(false);
  const [profileActionMessage, setProfileActionMessage] = useState("");
  const [profileActionError, setProfileActionError] = useState("");
  const [oldPasswordDraft, setOldPasswordDraft] = useState("");
  const [newPasswordDraft, setNewPasswordDraft] = useState("");
  const [confirmPasswordDraft, setConfirmPasswordDraft] = useState("");
  const [showOldPassword, setShowOldPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [avatarErrored, setAvatarErrored] = useState(false);
  const [markAllNotificationsLoading, setMarkAllNotificationsLoading] = useState(false);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());
  const notifRef = useRef(null);
  const settingsMenuRef = useRef(null);

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

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notifRef.current && !notifRef.current.contains(event.target)) {
        setNotifOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const timerId = setInterval(() => setClockNowMs(Date.now()), 1000);
    return () => clearInterval(timerId);
  }, []);

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
    if (!profileDrawerOpen) return;

    const handleEsc = (event) => {
      if (event.key === "Escape" && !profileActionLoading) {
        if (passwordModalOpen) {
          setPasswordModalOpen(false);
          return;
        }
        if (settingsMenuOpen) {
          setSettingsMenuOpen(false);
          return;
        }
        setProfileDrawerOpen(false);
      }
    };

    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [profileDrawerOpen, profileActionLoading, passwordModalOpen, settingsMenuOpen]);

  useEffect(() => {
    if (!profileDrawerOpen || !settingsMenuOpen) return;

    const handleOutsideClick = (event) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target)) {
        setSettingsMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handleOutsideClick);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideClick);
    };
  }, [profileDrawerOpen, settingsMenuOpen]);

  const profileUserEmail = String(profileSource?.email || viewer?.email || "").trim();
  const profileCreatedAt = profileSource?.profile?.createdAt || profileSource?.createdAt;
  const profileUpdatedAt = profileSource?.profile?.updatedAt || profileSource?.updatedAt;
  const profileUid =
    String(profileSource?.userId || profileSource?.id || profileSource?.uid || "").trim() || "-";

  const closeProfileDrawer = () => {
    if (profileActionLoading) return;
    setProfileDrawerOpen(false);
    setPasswordModalOpen(false);
    setSettingsMenuOpen(false);
    setProfileActionMessage("");
    setProfileActionError("");
    setOldPasswordDraft("");
    setNewPasswordDraft("");
    setConfirmPasswordDraft("");
    setShowOldPassword(false);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
  };

  const handleOpenProfileDrawer = () => {
    setNotifOpen(false);
    setProfileDrawerOpen(true);
    setPasswordModalOpen(false);
    setSettingsMenuOpen(false);
    setProfileActionMessage("");
    setProfileActionError("");
    setOldPasswordDraft("");
    setNewPasswordDraft("");
    setConfirmPasswordDraft("");
    setShowOldPassword(false);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
  };

  const closePasswordModal = () => {
    if (profileActionLoading) return;
    setPasswordModalOpen(false);
    setProfileActionMessage("");
    setProfileActionError("");
    setOldPasswordDraft("");
    setNewPasswordDraft("");
    setConfirmPasswordDraft("");
    setShowOldPassword(false);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
  };

  const openChangePasswordModal = () => {
    setSettingsMenuOpen(false);
    setPasswordModalOpen(true);
  };

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

  const handleChangePassword = async () => {
    if (typeof onChangeOwnPassword !== "function") {
      setProfileActionError("Password update is not available for this account.");
      return;
    }

    const oldPassword = String(oldPasswordDraft || "").trim();
    const newPassword = String(newPasswordDraft || "").trim();
    const confirmPassword = String(confirmPasswordDraft || "").trim();

    if (!oldPassword) {
      setProfileActionError("Enter your old password.");
      return;
    }
    if (!newPassword) {
      setProfileActionError("Enter your new password.");
      return;
    }
    if (newPassword.length < 6) {
      setProfileActionError("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setProfileActionError("New password and confirm password do not match.");
      return;
    }

    setProfileActionLoading(true);
    setProfileActionError("");
    setProfileActionMessage("");

    try {
      const result = await onChangeOwnPassword({
        oldPassword,
        newPassword,
        confirmPassword,
      });
      setProfileActionMessage(result?.message || "Password updated successfully.");
      setOldPasswordDraft("");
      setNewPasswordDraft("");
      setConfirmPasswordDraft("");
      setShowOldPassword(false);
      setShowNewPassword(false);
      setShowConfirmPassword(false);
    } catch (err) {
      setProfileActionError(err?.message || "Could not update password.");
    } finally {
      setProfileActionLoading(false);
    }
  };

  const passwordModalNode =
    passwordModalOpen && profileDrawerOpen ? (
      <>
        <button
          type="button"
          className="header-profile-security-modal-backdrop"
          aria-label="Close account security modal"
          onClick={closePasswordModal}
        />

        <div className="header-profile-security-modal" role="dialog" aria-modal="true">
          <div className="header-profile-security-modal-head">
            <div className="header-profile-security-modal-title">Manage Your Account Password</div>
            <button
              type="button"
              className="header-profile-security-modal-close"
              onClick={closePasswordModal}
              aria-label="Close account security modal"
              disabled={profileActionLoading}
            >
              x
            </button>
          </div>

          <div className="header-profile-security-modal-body">
            {profileActionError ? (
              <div className="header-profile-alert error">{profileActionError}</div>
            ) : null}
            {profileActionMessage ? (
              <div className="header-profile-alert success">{profileActionMessage}</div>
            ) : null}

            <p className="header-profile-edit-note">
              Enter your old password and choose a new one.
            </p>

            <div className="header-profile-password-grid">
              <div className="header-profile-password-wrap">
                <input
                  type={showOldPassword ? "text" : "password"}
                  value={oldPasswordDraft}
                  onChange={(e) => setOldPasswordDraft(e.target.value)}
                  placeholder="Old password"
                  className="header-profile-password-input"
                  disabled={profileActionLoading}
                />
                <button
                  type="button"
                  className="header-profile-password-toggle"
                  onClick={() => setShowOldPassword((prev) => !prev)}
                  aria-label={showOldPassword ? "Hide old password" : "Show old password"}
                  disabled={profileActionLoading}
                >
                  {showOldPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              <div className="header-profile-password-wrap">
                <input
                  type={showNewPassword ? "text" : "password"}
                  value={newPasswordDraft}
                  onChange={(e) => setNewPasswordDraft(e.target.value)}
                  placeholder="New password"
                  className="header-profile-password-input"
                  disabled={profileActionLoading}
                />
                <button
                  type="button"
                  className="header-profile-password-toggle"
                  onClick={() => setShowNewPassword((prev) => !prev)}
                  aria-label={showNewPassword ? "Hide new password" : "Show new password"}
                  disabled={profileActionLoading}
                >
                  {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              <div className="header-profile-password-wrap">
                <input
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPasswordDraft}
                  onChange={(e) => setConfirmPasswordDraft(e.target.value)}
                  placeholder="Confirm new password"
                  className="header-profile-password-input"
                  disabled={profileActionLoading}
                />
                <button
                  type="button"
                  className="header-profile-password-toggle"
                  onClick={() => setShowConfirmPassword((prev) => !prev)}
                  aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
                  disabled={profileActionLoading}
                >
                  {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="button"
              className="header-profile-reset-btn"
              onClick={handleChangePassword}
              disabled={profileActionLoading}
            >
              {profileActionLoading ? "Updating..." : "Update Password"}
            </button>
          </div>
        </div>
      </>
    ) : null;

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
          </div>
        </div>
      </div>
      <div className="header-right">
        <div className="notif-wrapper" ref={notifRef}>
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

          <div className="profile-box">
            <div className="name">
              <div className="profile-name">{displayName}</div>
              <div className="profile-role">{displayRole}</div>
            </div>

            <button
              type="button"
              className="profile-avatar-trigger"
              onClick={handleOpenProfileDrawer}
              aria-label="Open profile details"
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
            </button>
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

      {profileDrawerOpen ? (
        <>
          <button
            type="button"
            onClick={closeProfileDrawer}
            className=""
            aria-label="Close profile drawer"
          />

          <aside className="header-profile-drawer" role="dialog" aria-modal="true">
            <div className="header-profile-drawer-head">
              <div>
                <div className="header-profile-drawer-title">My Profile</div>
                <div className="header-profile-drawer-subtitle">Account details and security</div>
              </div>

              <button
                type="button"
                onClick={closeProfileDrawer}
                className="header-profile-drawer-close"
                aria-label="Close profile drawer"
              >
                x
              </button>
            </div>

            <div className="header-profile-drawer-body">
              <div className="header-profile-hero">
                <div className="header-profile-hero-left">
                  {profileImage && !avatarErrored ? (
                    <img
                      src={profileImage}
                      alt={`${displayName} profile`}
                      className="header-profile-hero-avatar"
                      loading="lazy"
                      onError={() => setAvatarErrored(true)}
                    />
                  ) : (
                    <div className="header-profile-hero-initials" aria-label={displayName}>
                      {initials}
                    </div>
                  )}
                </div>

                <div className="header-profile-hero-right">
                  <div className="header-profile-hero-name">{displayName}</div>
                  <div className="header-profile-hero-role">{displayRole}</div>
                  <div className="header-profile-hero-email">{profileUserEmail || "-"}</div>
                </div>

                <div className="header-profile-hero-settings" ref={settingsMenuRef}>
                  <button
                    type="button"
                    className={`header-profile-hero-settings-btn ${settingsMenuOpen ? "open" : ""}`}
                    aria-label="Open account settings menu"
                    aria-haspopup="menu"
                    aria-expanded={settingsMenuOpen}
                    onClick={() => setSettingsMenuOpen((prev) => !prev)}
                  >
                    <Settings size={16} />
                  </button>

                  {settingsMenuOpen ? (
                    <div className="header-profile-hero-settings-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="header-profile-hero-settings-menu-item"
                        onClick={openChangePasswordModal}
                      >
                        Change Password
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="header-profile-details-card">
                <div className="header-profile-details">
                  <div className="header-profile-row">
                    <span>User ID</span>
                    <strong>{profileUid}</strong>
                  </div>
                  <div className="header-profile-row">
                    <span>Created</span>
                    <strong>{formatProfileDate(profileCreatedAt)}</strong>
                  </div>
                  <div className="header-profile-row">
                    <span>Updated</span>
                    <strong>{formatProfileDate(profileUpdatedAt)}</strong>
                  </div>
                </div>
              </div>

            </div>
          </aside>

        </>
      ) : null}
      {typeof document !== "undefined" && passwordModalNode
        ? createPortal(passwordModalNode, document.body)
        : null}
    </header>
  );
};

export default Header;
