import React, { useEffect, useMemo, useState } from "react";
import { ROLES } from "../auth/roleUtils";
import { toMillis } from "../utils/common";
import "./specialUsersPage.css";

const toStatus = (value) => String(value || "").trim().toLowerCase();
const PORTAL_SPECIAL_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR];
const EDITABLE_ROLE_OPTIONS = [
  { value: ROLES.SUPER_ADMIN, label: "Super Admin" },
  { value: ROLES.ADMIN, label: "Admin" },
  { value: ROLES.ACCOUNTING, label: "Accounting" },
  { value: ROLES.VISITOR, label: "Visitor" },
];
const getPortalUserDocId = (value) => String(value?.uid || value?.id || "").trim();

const formatDateTime = (value, timeZone = "America/New_York") => {
  const ms = toMillis(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString(undefined, {
    timeZone: String(timeZone || "").trim() || "America/New_York",
  });
};

const getRoleLabel = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === ROLES.ADMIN) return "Admin";
  if (normalized === ROLES.ACCOUNTING) return "Accounting";
  if (normalized === ROLES.VISITOR) return "Visitor";
  if (normalized === ROLES.SUPER_ADMIN) return "Super Admin";
  return normalized || "User";
};

export default function SpecialUsersPage({
  users = [],
  loading = false,
  error = "",
  userRequests = [],
  loadingRequests = false,
  requestsError = "",
  processingRequestId = "",
  processingRequestAction = "",
  onApproveRequest,
  onRejectRequest,
  onUpdateUserProfile,
  onChangeUserEmail,
  onSendPasswordReset,
  onReloadRequests,
  onOpenControlPanel,
}) {
  const [approvalPasswordById, setApprovalPasswordById] = useState({});
  const [rejectionReasonById, setRejectionReasonById] = useState({});
  const [requestActionErrorById, setRequestActionErrorById] = useState({});
  const [selectedSpecialUserId, setSelectedSpecialUserId] = useState("");
  const [drawerEditMode, setDrawerEditMode] = useState(false);
  const [drawerProfileDraft, setDrawerProfileDraft] = useState({
    firstName: "",
    lastName: "",
    role: ROLES.VISITOR,
  });
  const [drawerEmailDraft, setDrawerEmailDraft] = useState("");
  const [drawerSavingProfile, setDrawerSavingProfile] = useState(false);
  const [drawerSavingEmail, setDrawerSavingEmail] = useState(false);
  const [drawerSendingReset, setDrawerSendingReset] = useState(false);
  const [drawerError, setDrawerError] = useState("");
  const [drawerMessage, setDrawerMessage] = useState("");

  const groupedUsers = useMemo(() => {
    const groups = {
      [ROLES.SUPER_ADMIN]: [],
      [ROLES.ADMIN]: [],
      [ROLES.ACCOUNTING]: [],
      [ROLES.VISITOR]: [],
    };

    for (const user of users) {
      const role = String(user?.role || "").toLowerCase();
      if (groups[role]) {
        groups[role].push(user);
      }
    }

    return groups;
  }, [users]);

  const allSpecialUsers = useMemo(
    () =>
      (Array.isArray(users) ? users : []).filter((row) =>
        PORTAL_SPECIAL_ROLES.includes(String(row?.role || "").toLowerCase())
      ),
    [users]
  );

  const selectedSpecialUser = useMemo(
    () => allSpecialUsers.find((row) => getPortalUserDocId(row) === selectedSpecialUserId) || null,
    [allSpecialUsers, selectedSpecialUserId]
  );

  const pendingRequests = useMemo(
    () =>
      (Array.isArray(userRequests) ? userRequests : []).filter(
        (row) => toStatus(row?.status) === "pending"
      ),
    [userRequests]
  );

  const resolvedRequests = useMemo(
    () =>
      (Array.isArray(userRequests) ? userRequests : [])
        .filter((row) => {
          const status = toStatus(row?.status);
          return status === "approved" || status === "rejected";
        })
        .slice(0, 8),
    [userRequests]
  );

  useEffect(() => {
    if (!selectedSpecialUserId) return;
    if (!selectedSpecialUser) {
      setSelectedSpecialUserId("");
      setDrawerEditMode(false);
    }
  }, [selectedSpecialUserId, selectedSpecialUser]);

  useEffect(() => {
    if (!selectedSpecialUser) return;

    setDrawerProfileDraft({
      firstName: String(selectedSpecialUser?.firstName || "").trim(),
      lastName: String(selectedSpecialUser?.lastName || "").trim(),
      role: String(selectedSpecialUser?.role || "").trim().toLowerCase() || ROLES.VISITOR,
    });
    setDrawerEmailDraft(String(selectedSpecialUser?.email || "").trim());
    setDrawerError("");
    setDrawerMessage("");
    setDrawerEditMode(false);
  }, [selectedSpecialUser]);

  const renderUserCard = (user) => {
    const userId = getPortalUserDocId(user);
    const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
    const isActive = selectedSpecialUserId && selectedSpecialUserId === userId;

    return (
      <button
        type="button"
        className={`special-user-card special-user-card-btn ${isActive ? "is-active" : ""}`}
        key={user.id || user.uid || user.email}
        onClick={() => {
          setSelectedSpecialUserId(userId);
          setDrawerError("");
          setDrawerMessage("");
        }}
      >
        <div className="special-user-avatar">
          {String(fullName || user?.email || "U").charAt(0).toUpperCase()}
        </div>

        <div className="special-user-content">
          <h4>{fullName || "Unnamed User"}</h4>
          <p>{user?.email || "No email"}</p>
          <span className="special-user-badge">{getRoleLabel(user?.role)}</span>
        </div>
      </button>
    );
  };

  const handleApprove = async (requestRow) => {
    const requestId = String(requestRow?.id || "").trim();
    const password = String(approvalPasswordById?.[requestId] || "").trim();

    if (!requestId) return;
    if (!password) {
      setRequestActionErrorById((prev) => ({
        ...prev,
        [requestId]: "Enter a temporary password before approving.",
      }));
      return;
    }

    setRequestActionErrorById((prev) => ({ ...prev, [requestId]: "" }));

    try {
      await onApproveRequest?.(requestId, { password });
      setApprovalPasswordById((prev) => ({ ...prev, [requestId]: "" }));
      setRejectionReasonById((prev) => ({ ...prev, [requestId]: "" }));
    } catch (err) {
      setRequestActionErrorById((prev) => ({
        ...prev,
        [requestId]: err?.message || "Could not approve request.",
      }));
    }
  };

  const handleReject = async (requestRow) => {
    const requestId = String(requestRow?.id || "").trim();
    if (!requestId) return;

    setRequestActionErrorById((prev) => ({ ...prev, [requestId]: "" }));

    try {
      await onRejectRequest?.(requestId, {
        reason: String(rejectionReasonById?.[requestId] || "").trim(),
      });
      setApprovalPasswordById((prev) => ({ ...prev, [requestId]: "" }));
      setRejectionReasonById((prev) => ({ ...prev, [requestId]: "" }));
    } catch (err) {
      setRequestActionErrorById((prev) => ({
        ...prev,
        [requestId]: err?.message || "Could not reject request.",
      }));
    }
  };

  const closeSpecialUserDrawer = () => {
    if (drawerSavingProfile || drawerSavingEmail || drawerSendingReset) return;
    setSelectedSpecialUserId("");
    setDrawerEditMode(false);
    setDrawerError("");
    setDrawerMessage("");
  };

  const handleSaveDrawerProfile = async () => {
    const targetUser = selectedSpecialUser;
    const targetUserId = getPortalUserDocId(targetUser);
    if (!targetUser || !targetUserId) return;

    setDrawerSavingProfile(true);
    setDrawerError("");
    setDrawerMessage("");

    try {
      const result = await onUpdateUserProfile?.(targetUserId, {
        firstName: drawerProfileDraft.firstName,
        lastName: drawerProfileDraft.lastName,
        role: drawerProfileDraft.role,
      });

      const fullName = `${result?.firstName || drawerProfileDraft.firstName || ""} ${
        result?.lastName || drawerProfileDraft.lastName || ""
      }`.trim();
      setDrawerMessage(`${fullName || "Profile"} details updated.`);
      setDrawerEditMode(false);
    } catch (err) {
      setDrawerError(err?.message || "Could not update profile details.");
    } finally {
      setDrawerSavingProfile(false);
    }
  };

  const handleSaveDrawerEmail = async () => {
    const targetUser = selectedSpecialUser;
    const targetUserId = getPortalUserDocId(targetUser);
    if (!targetUser || !targetUserId) return;

    setDrawerSavingEmail(true);
    setDrawerError("");
    setDrawerMessage("");

    try {
      const result = await onChangeUserEmail?.(targetUserId, drawerEmailDraft);
      const nextEmail = String(result?.email || drawerEmailDraft || "").trim();
      if (nextEmail) {
        setDrawerEmailDraft(nextEmail);
      }
      setDrawerMessage(result?.message || `Email updated to ${nextEmail || drawerEmailDraft}.`);
    } catch (err) {
      setDrawerError(err?.message || "Could not update email.");
    } finally {
      setDrawerSavingEmail(false);
    }
  };

  const handleSendDrawerPasswordReset = async () => {
    const fallbackEmail = String(selectedSpecialUser?.email || "").trim();
    const targetEmail = String(drawerEmailDraft || fallbackEmail).trim();
    if (!targetEmail) {
      setDrawerError("Email is required to send password reset.");
      return;
    }

    setDrawerSendingReset(true);
    setDrawerError("");
    setDrawerMessage("");

    try {
      const result = await onSendPasswordReset?.(targetEmail);
      setDrawerMessage(
        result?.message || `Password reset email sent to ${result?.email || targetEmail}.`
      );
    } catch (err) {
      setDrawerError(err?.message || "Could not send password reset email.");
    } finally {
      setDrawerSendingReset(false);
    }
  };

  return (
    <div className="special-users-page">
      <div className="special-users-header">

        {onOpenControlPanel ? (
          <div className="special-users-action-row">
            {onReloadRequests ? (
              <button
                type="button"
                className="special-users-control-btn"
                onClick={onReloadRequests}
              >
                Reload Requests
              </button>
            ) : null}

            <button
              type="button"
              className="special-users-control-btn"
              onClick={onOpenControlPanel}
            >
              Open Control Panel
            </button>
          </div>
        ) : null}
      </div>

      <section className="special-users-requests">
        <div className="special-users-requests-head">
          <h2>Pending User Requests</h2>
          <span>{pendingRequests.length}</span>
        </div>

        {loadingRequests ? (
          <div className="special-users-state">Loading user requests...</div>
        ) : null}
        {requestsError ? <div className="special-users-error">{requestsError}</div> : null}

        {!loadingRequests && !requestsError && pendingRequests.length === 0 ? (
          <div className="special-users-empty">
            No pending requests. New admin requests will appear here.
          </div>
        ) : null}

        {!loadingRequests && !requestsError && pendingRequests.length > 0 ? (
          <div className="special-users-requests-list">
            {pendingRequests.map((requestRow) => {
              const requestId = String(requestRow?.id || "").trim();
              const requestedName = `${requestRow?.firstName || ""} ${
                requestRow?.lastName || ""
              }`.trim();
              const requester =
                requestRow?.requestedByName ||
                requestRow?.requestedByEmail ||
                requestRow?.requestedByUserId ||
                "Admin";
              const isApproving =
                processingRequestId === requestId &&
                toStatus(processingRequestAction) === "approve";
              const isRejecting =
                processingRequestId === requestId &&
                toStatus(processingRequestAction) === "reject";
              const isProcessing = isApproving || isRejecting;

              return (
                <article key={requestId} className="special-users-request-card">
                  <div className="special-users-request-top">
                    <div>
                      <h3>{requestedName || requestRow?.email || "Requested User"}</h3>
                      <p>{requestRow?.email || "No email"}</p>
                    </div>
                    <span className="special-users-request-role">
                      {getRoleLabel(requestRow?.role)}
                    </span>
                  </div>

                  <div className="special-users-request-meta">
                    <span>Requested by: {requester}</span>
                    <span>{formatDateTime(requestRow?.createdAt)}</span>
                  </div>

                  {String(requestRow?.note || "").trim() ? (
                    <div className="special-users-request-note">{requestRow.note}</div>
                  ) : null}

                  <div className="special-users-request-actions">
                    <input
                      type="password"
                      className="special-users-request-input"
                      placeholder="Temporary password (required to approve)"
                      value={approvalPasswordById?.[requestId] || ""}
                      onChange={(e) =>
                        setApprovalPasswordById((prev) => ({
                          ...prev,
                          [requestId]: e.target.value,
                        }))
                      }
                      disabled={isProcessing}
                    />

                    <input
                      type="text"
                      className="special-users-request-input"
                      placeholder="Reject reason (optional)"
                      value={rejectionReasonById?.[requestId] || ""}
                      onChange={(e) =>
                        setRejectionReasonById((prev) => ({
                          ...prev,
                          [requestId]: e.target.value,
                        }))
                      }
                      disabled={isProcessing}
                    />
                  </div>

                  <div className="special-users-request-button-row">
                    <button
                      type="button"
                      className="special-users-request-btn approve"
                      onClick={() => handleApprove(requestRow)}
                      disabled={isProcessing}
                    >
                      {isApproving ? "Approving..." : "Approve & Create User"}
                    </button>

                    <button
                      type="button"
                      className="special-users-request-btn reject"
                      onClick={() => handleReject(requestRow)}
                      disabled={isProcessing}
                    >
                      {isRejecting ? "Rejecting..." : "Reject Request"}
                    </button>
                  </div>

                  {requestActionErrorById?.[requestId] ? (
                    <div className="special-users-request-error">
                      {requestActionErrorById[requestId]}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      {resolvedRequests.length > 0 ? (
        <section className="special-users-requests special-users-requests-history">
          <div className="special-users-requests-head">
            <h2>Recent Request Decisions</h2>
            <span>{resolvedRequests.length}</span>
          </div>

          <div className="special-users-request-history-list">
            {resolvedRequests.map((row) => {
              const status = toStatus(row?.status);
              const requestedName = `${row?.firstName || ""} ${row?.lastName || ""}`.trim();
              const resolvedBy =
                status === "approved"
                  ? row?.approvedByName || row?.approvedByEmail || row?.approvedByUserId || "-"
                  : row?.rejectedByName || row?.rejectedByEmail || row?.rejectedByUserId || "-";
              const resolvedAt = status === "approved" ? row?.approvedAt : row?.rejectedAt;

              return (
                <div key={row.id} className="special-users-request-history-item">
                  <div>
                    <div className="special-users-request-history-title">
                      {requestedName || row?.email || "Requested User"}
                    </div>
                    <div className="special-users-request-history-meta">
                      {getRoleLabel(row?.role)} | {row?.email || "-"}
                    </div>
                  </div>
                  <div className="special-users-request-history-meta">
                    <span className={`special-users-history-pill ${status}`}>
                      {status || "-"}
                    </span>
                    <span>By: {resolvedBy}</span>
                    <span>{formatDateTime(resolvedAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {loading ? <div className="special-users-state">Loading special users...</div> : null}
      {error ? <div className="special-users-error">{error}</div> : null}

      {!loading && !error ? (
        <div className="special-users-grid">
          <section className="special-users-section">
            <div className="special-users-section-head">
              <h2>Super Admin</h2>
              <span>{groupedUsers[ROLES.SUPER_ADMIN].length}</span>
            </div>

            <div className="special-users-list">
              {groupedUsers[ROLES.SUPER_ADMIN].length > 0 ? (
                groupedUsers[ROLES.SUPER_ADMIN].map(renderUserCard)
              ) : (
                <div className="special-users-empty">No Super Admin accounts found.</div>
              )}
            </div>
          </section>

          <section className="special-users-section">
            <div className="special-users-section-head">
              <h2>Admins</h2>
              <span>{groupedUsers[ROLES.ADMIN].length}</span>
            </div>

            <div className="special-users-list">
              {groupedUsers[ROLES.ADMIN].length > 0 ? (
                groupedUsers[ROLES.ADMIN].map(renderUserCard)
              ) : (
                <div className="special-users-empty">No Admin accounts found.</div>
              )}
            </div>
          </section>

          <section className="special-users-section">
            <div className="special-users-section-head">
              <h2>Visitors</h2>
              <span>{groupedUsers[ROLES.VISITOR].length}</span>
            </div>

            <div className="special-users-list">
              {groupedUsers[ROLES.VISITOR].length > 0 ? (
                groupedUsers[ROLES.VISITOR].map(renderUserCard)
              ) : (
                <div className="special-users-empty">No Visitor accounts found.</div>
              )}
            </div>
          </section>

          <section className="special-users-section">
            <div className="special-users-section-head">
              <h2>Accounting</h2>
              <span>{groupedUsers[ROLES.ACCOUNTING].length}</span>
            </div>

            <div className="special-users-list">
              {groupedUsers[ROLES.ACCOUNTING].length > 0 ? (
                groupedUsers[ROLES.ACCOUNTING].map(renderUserCard)
              ) : (
                <div className="special-users-empty">No Accounting accounts found.</div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {selectedSpecialUser ? (
        <>
          <button
            type="button"
            className="special-user-drawer-backdrop"
            onClick={closeSpecialUserDrawer}
            aria-label="Close user details"
          />

          <aside
            className="special-user-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Special user profile details"
          >
            <div className="special-user-drawer-head">
              <div>
                <div className="special-user-drawer-title">
                  {`${selectedSpecialUser?.firstName || ""} ${
                    selectedSpecialUser?.lastName || ""
                  }`.trim() || selectedSpecialUser?.email || "User Profile"}
                </div>
                <div className="special-user-drawer-subtitle">
                  {getRoleLabel(selectedSpecialUser?.role)} profile details
                </div>
              </div>

              <button
                type="button"
                className="special-user-drawer-close"
                onClick={closeSpecialUserDrawer}
                aria-label="Close user drawer"
              >
                x
              </button>
            </div>

            {drawerError ? <div className="special-user-drawer-alert error">{drawerError}</div> : null}
            {drawerMessage ? (
              <div className="special-user-drawer-alert success">{drawerMessage}</div>
            ) : null}

            <div className="special-user-drawer-body">
              <div className="special-user-profile-grid">
                <div className="special-user-profile-row">
                  <span>User ID</span>
                  <strong>{getPortalUserDocId(selectedSpecialUser) || "-"}</strong>
                </div>
                <div className="special-user-profile-row">
                  <span>Created</span>
                  <strong>{formatDateTime(selectedSpecialUser?.createdAt)}</strong>
                </div>
                <div className="special-user-profile-row">
                  <span>Updated</span>
                  <strong>{formatDateTime(selectedSpecialUser?.updatedAt)}</strong>
                </div>
              </div>

              <section className="special-user-drawer-section">
                <div className="special-user-drawer-section-head">
                  <h3>Profile Details</h3>

                  {!drawerEditMode ? (
                    <button
                      type="button"
                      className="special-user-action-btn"
                      onClick={() => {
                        setDrawerEditMode(true);
                        setDrawerError("");
                        setDrawerMessage("");
                      }}
                    >
                      Edit Details
                    </button>
                  ) : null}
                </div>

                {drawerEditMode ? (
                  <div className="special-user-drawer-form">
                    <label>
                      <span>First name</span>
                      <input
                        type="text"
                        value={drawerProfileDraft.firstName}
                        onChange={(e) =>
                          setDrawerProfileDraft((prev) => ({
                            ...prev,
                            firstName: e.target.value,
                          }))
                        }
                        disabled={drawerSavingProfile}
                      />
                    </label>

                    <label>
                      <span>Last name</span>
                      <input
                        type="text"
                        value={drawerProfileDraft.lastName}
                        onChange={(e) =>
                          setDrawerProfileDraft((prev) => ({
                            ...prev,
                            lastName: e.target.value,
                          }))
                        }
                        disabled={drawerSavingProfile}
                      />
                    </label>

                    <label>
                      <span>Role</span>
                      <select
                        value={drawerProfileDraft.role}
                        onChange={(e) =>
                          setDrawerProfileDraft((prev) => ({
                            ...prev,
                            role: e.target.value,
                          }))
                        }
                        disabled={drawerSavingProfile}
                      >
                        {EDITABLE_ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="special-user-drawer-actions">
                      <button
                        type="button"
                        className="special-user-action-btn"
                        onClick={handleSaveDrawerProfile}
                        disabled={drawerSavingProfile}
                      >
                        {drawerSavingProfile ? "Saving..." : "Save Details"}
                      </button>

                      <button
                        type="button"
                        className="special-user-action-btn ghost"
                        onClick={() => {
                          setDrawerEditMode(false);
                          setDrawerProfileDraft({
                            firstName: String(selectedSpecialUser?.firstName || "").trim(),
                            lastName: String(selectedSpecialUser?.lastName || "").trim(),
                            role:
                              String(selectedSpecialUser?.role || "").trim().toLowerCase() ||
                              ROLES.VISITOR,
                          });
                        }}
                        disabled={drawerSavingProfile}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="special-user-profile-grid">
                    <div className="special-user-profile-row">
                      <span>First name</span>
                      <strong>{selectedSpecialUser?.firstName || "-"}</strong>
                    </div>
                    <div className="special-user-profile-row">
                      <span>Last name</span>
                      <strong>{selectedSpecialUser?.lastName || "-"}</strong>
                    </div>
                    <div className="special-user-profile-row">
                      <span>Role</span>
                      <strong>{getRoleLabel(selectedSpecialUser?.role)}</strong>
                    </div>
                  </div>
                )}
              </section>

              <section className="special-user-drawer-section">
                <div className="special-user-drawer-section-head">
                  <h3>Change Email Address</h3>
                </div>

                <div className="special-user-drawer-form">
                  <label>
                    <span>Email</span>
                    <input
                      type="email"
                      value={drawerEmailDraft}
                      onChange={(e) => setDrawerEmailDraft(e.target.value)}
                      disabled={drawerSavingEmail}
                    />
                  </label>

                  <div className="special-user-drawer-actions">
                    <button
                      type="button"
                      className="special-user-action-btn"
                      onClick={handleSaveDrawerEmail}
                      disabled={drawerSavingEmail}
                    >
                      {drawerSavingEmail ? "Saving..." : "Save Email"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="special-user-drawer-section">
                <div className="special-user-drawer-section-head">
                  <h3>Reset Password</h3>
                </div>

                <p className="special-user-drawer-note">
                  Send a password reset email to the current account email.
                </p>

                <div className="special-user-drawer-actions">
                  <button
                    type="button"
                    className="special-user-action-btn warning"
                    onClick={handleSendDrawerPasswordReset}
                    disabled={drawerSendingReset}
                  >
                    {drawerSendingReset ? "Sending..." : "Send Reset Email"}
                  </button>
                </div>
              </section>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
