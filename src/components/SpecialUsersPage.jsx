import React, { useMemo } from "react";
import { ROLES } from "../auth/roleUtils";
import "./specialUsersPage.css";

export default function SpecialUsersPage({
  users = [],
  loading = false,
  error = "",
  onOpenControlPanel,
}) {

  const groupedUsers = useMemo(() => {
    const groups = {
      [ROLES.SUPER_ADMIN]: [],
      [ROLES.ADMIN]: [],
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

  const renderUserCard = (user) => {
    const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();

    return (
      <div className="special-user-card" key={user.id || user.uid || user.email}>
        <div className="special-user-avatar">
          {String(fullName || user?.email || "U").charAt(0).toUpperCase()}
        </div>

        <div className="special-user-content">
          <h4>{fullName || "Unnamed User"}</h4>
          <p>{user?.email || "No email"}</p>
          <span className="special-user-badge">{user?.role || "unknown"}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="special-users-page">
      <div className="special-users-header">
        <div>
          <h1>Special Users</h1>
          <p>Manage and review all Super Admin, Admin, and Visitor accounts.</p>
        </div>

        {onOpenControlPanel ? (
          <button
            type="button"
            className="special-users-control-btn"
            onClick={onOpenControlPanel}
          >
            Open Control Panel
          </button>
        ) : null}
      </div>

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
        </div>
      ) : null}
    </div>
  );
}
