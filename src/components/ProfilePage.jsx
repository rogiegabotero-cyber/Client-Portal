import React, { useEffect, useMemo, useState } from "react";
import {
  Building2,
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  Handshake,
  LockKeyhole,
  Mail,
  Settings,
  UserRound,
} from "lucide-react";
import "./profilePage.css";
import { getProfileImageUrl, getUserId, toMillis } from "../utils/common";

const PROFILE_TABS = [
  { key: "personal", label: "Personal", icon: UserRound },
  { key: "work", label: "Work", icon: BriefcaseBusiness },
  { key: "settings", label: "Settings", icon: Settings },
];

const formatDateTime = (value) => {
  const ms = toMillis(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString();
};

const toInitials = (value = "") =>
  String(value || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "U";

const normalizeRoleValue = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

const toDepartmentList = (...candidates) => {
  const out = [];
  const pushValue = (value) => {
    const text = String(value || "").trim();
    if (!text) return;
    if (!out.includes(text)) out.push(text);
  };

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => pushValue(item));
      continue;
    }
    if (typeof candidate === "string") {
      const parts = candidate
        .split(/[|;,]/g)
        .map((part) => String(part || "").trim())
        .filter(Boolean);
      if (parts.length > 1) {
        parts.forEach((item) => pushValue(item));
      } else {
        pushValue(candidate);
      }
      continue;
    }
    if (typeof candidate === "object") {
      Object.values(candidate).forEach((item) => pushValue(item));
    }
  }
  return out;
};

export default function ProfilePage({
  viewer = {},
  profileImagesByUserId = {},
  employeeProfilesByUserId = {},
  requestedTab = "personal",
  tabRequestId = 0,
  onChangeOwnPassword,
  onChangeOwnEmail,
}) {
  const [activeTab, setActiveTab] = useState("personal");
  const [autoMinimizeSidebar, setAutoMinimizeSidebar] = useState(false);
  const [emailExpanded, setEmailExpanded] = useState(false);
  const [passwordExpanded, setPasswordExpanded] = useState(false);
  const [emailDraft, setEmailDraft] = useState(() => String(viewer?.email || ""));
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    const nextTab = String(requestedTab || "").trim().toLowerCase();
    if (PROFILE_TABS.some((item) => item.key === nextTab)) {
      setActiveTab(nextTab);
    }
  }, [requestedTab, tabRequestId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("portal_profile_auto_min_sidebar");
      setAutoMinimizeSidebar(raw === "1");
    } catch {
      setAutoMinimizeSidebar(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "portal_profile_auto_min_sidebar",
        autoMinimizeSidebar ? "1" : "0"
      );
    } catch {
      // ignore storage write issues
    }
  }, [autoMinimizeSidebar]);

  useEffect(() => {
    setEmailDraft(String(viewer?.email || ""));
  }, [viewer?.email]);

  const profileImage = useMemo(() => {
    const profileUserId = String(getUserId(viewer) || viewer?.uid || "").trim();
    const mapped = profileUserId ? String(profileImagesByUserId?.[profileUserId] || "").trim() : "";
    return mapped || getProfileImageUrl(viewer || {});
  }, [viewer, profileImagesByUserId]);

  const displayName = String(
    viewer?.name || viewer?.displayName || viewer?.fullName || viewer?.email || "Portal User"
  ).trim();
  const displayRole = String(
    viewer?.role || viewer?.position || viewer?.title || viewer?.jobTitle || "User"
  ).trim();
  const userId = String(getUserId(viewer) || viewer?.uid || viewer?.id || "-").trim() || "-";
  const savedProfile = employeeProfilesByUserId?.[userId] || {};
  const createdAt = viewer?.createdAt || viewer?.profile?.createdAt || null;
  const updatedAt = viewer?.updatedAt || viewer?.profile?.updatedAt || null;
  const allowedPagesCount = Array.isArray(viewer?.allowedPages) ? viewer.allowedPages.length : 0;
  const normalizedRole = normalizeRoleValue(viewer?.role);
  const isVisitorRole = normalizedRole === "visitor";
  const isAdminRole = normalizedRole === "admin" || normalizedRole === "super_admin";
  const isWorkBlankRole = isVisitorRole || isAdminRole;
  const isEmployeeRole = normalizedRole === "employee";

  const workPosition = String(
    viewer?.position ||
      viewer?.jobTitle ||
      viewer?.title ||
      savedProfile?.position ||
      savedProfile?.jobTitle ||
      savedProfile?.role ||
      ""
  ).trim();
  const workCompany = String(
    viewer?.company || savedProfile?.company || "Hyacinth Industries LLC"
  ).trim();
  const workDepartments = toDepartmentList(
    viewer?.departments,
    savedProfile?.departments,
    viewer?.department,
    savedProfile?.department,
    viewer?.departmentName,
    savedProfile?.departmentName
  );
  const hiredDate = savedProfile?.startDate || viewer?.startDate || viewer?.profile?.startDate || "";

  const handleSaveEmail = () => {
    setEmailError("");
    setEmailMessage("");

    const nextEmail = String(emailDraft || "").trim().toLowerCase();
    const currentEmail = String(viewer?.email || "").trim().toLowerCase();

    if (!nextEmail) {
      setEmailError("Please enter an email.");
      return;
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(nextEmail)) {
      setEmailError("Please enter a valid email address.");
      return;
    }

    if (nextEmail === currentEmail) {
      setEmailMessage("Your email is already up to date.");
      return;
    }

    if (typeof onChangeOwnEmail !== "function") {
      setEmailError("Email update is unavailable for this account.");
      return;
    }

    setSavingEmail(true);
    Promise.resolve(onChangeOwnEmail(nextEmail))
      .then((result) => {
        setEmailMessage(result?.message || `Email updated to ${nextEmail}.`);
      })
      .catch((err) => {
        setEmailError(err?.message || "Could not update email.");
      })
      .finally(() => {
        setSavingEmail(false);
      });
  };

  const handleChangePassword = async () => {
    setPasswordMessage("");
    setPasswordError("");

    const oldPass = String(oldPassword || "").trim();
    const newPass = String(newPassword || "").trim();
    const confirmPass = String(confirmPassword || "").trim();

    if (!oldPass || !newPass || !confirmPass) {
      setPasswordError("Please fill in old password, new password, and confirm password.");
      return;
    }
    if (newPass.length < 6) {
      setPasswordError("New password must be at least 6 characters.");
      return;
    }
    if (newPass !== confirmPass) {
      setPasswordError("New password and confirm password do not match.");
      return;
    }
    if (typeof onChangeOwnPassword !== "function") {
      setPasswordError("Password update is unavailable for this account.");
      return;
    }

    setSavingPassword(true);
    try {
      const result = await onChangeOwnPassword({
        oldPassword: oldPass,
        newPassword: newPass,
        confirmPassword: confirmPass,
      });
      setPasswordMessage(result?.message || "Password updated successfully.");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(err?.message || "Could not update password.");
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="ppgPage">
      <section className="ppgHero">
        <div className="ppgHeroLeft">
          <div className="ppgHeroAvatarWrap">
            {profileImage ? (
              <img src={profileImage} alt={`${displayName} profile`} className="ppgHeroAvatar" />
            ) : (
              <div className="ppgHeroAvatarFallback">{toInitials(displayName)}</div>
            )}
            <span className="ppgHeroStatus">Active</span>
          </div>
          <div className="ppgHeroMeta">
            <h2>{displayName}</h2>
            <p>{displayRole}</p>
          </div>
        </div>
      </section>

      <section className="ppgTabs">
        {PROFILE_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              className={`ppgTab ${isActive ? "isActive" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </section>

      {activeTab === "personal" ? (
        <section className="ppgSection">
          <div className="ppgSectionHead">Personal Profile</div>
          <div className="ppgInfoGrid">
            <div className="ppgInfoCard">
              <span>Name</span>
              <strong>{displayName}</strong>
            </div>
            <div className="ppgInfoCard">
              <span>Email</span>
              <strong>{String(viewer?.email || "-")}</strong>
            </div>
            <div className="ppgInfoCard">
              <span>User ID</span>
              <strong>{userId}</strong>
            </div>
            <div className="ppgInfoCard">
              <span>Created</span>
              <strong>{formatDateTime(createdAt)}</strong>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "work" ? (
        <section className="ppgSection">
          <div className="ppgSectionHead">Work Information</div>
          {isWorkBlankRole ? (
            <div className="ppgInfoGrid">
              <div className="ppgInfoCard">
                <span>Position</span>
                <strong>--</strong>
              </div>
              <div className="ppgInfoCard">
                <span>Department</span>
                <strong>--</strong>
              </div>
            </div>
          ) : isEmployeeRole ? (
            <div className="ppgWorkLayout">
              <div className="ppgWorkGrid">
                <div className="ppgWorkCard">
                  <div className="ppgWorkCardHead">
                    <span className="ppgWorkCardIcon">
                      <BriefcaseBusiness size={16} />
                    </span>
                    <span>Position</span>
                  </div>
                  <div className="ppgWorkCardValue">{workPosition || "--"}</div>
                </div>

                <div className="ppgWorkCard">
                  <div className="ppgWorkCardHead">
                    <span className="ppgWorkCardIcon">
                      <Building2 size={16} />
                    </span>
                    <span>Company</span>
                  </div>
                  <div className="ppgWorkCardValue">
                    <span className="ppgDeptChip">{workCompany || "--"}</span>
                  </div>
                </div>

                <div className="ppgWorkCard">
                  <div className="ppgWorkCardHead">
                    <span className="ppgWorkCardIcon">
                      <Handshake size={16} />
                    </span>
                    <span>Departments</span>
                  </div>
                  <div className="ppgDeptList">
                    {workDepartments.length ? (
                      workDepartments.map((dept, idx) => (
                        <span key={`dept-${idx}-${dept}`} className="ppgDeptChip">
                          {dept}
                        </span>
                      ))
                    ) : (
                      <span className="ppgDeptChip">--</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="ppgTimelineCard">
                <div className="ppgTimelineTitle">Employment Timeline</div>
                <div className="ppgTimelineSub">
                  Track key milestones from hiring to regularization.
                </div>
                <div className="ppgTimelineItem">
                  <span className="ppgTimelineIcon">
                    <CalendarDays size={15} />
                  </span>
                  <div>
                    <div className="ppgTimelineItemLabel">Date Hired</div>
                    <div className="ppgTimelineItemValue">
                      {hiredDate ? formatDateTime(hiredDate) : "--"}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="ppgInfoGrid">
              <div className="ppgInfoCard">
                <span>Role</span>
                <strong>{displayRole}</strong>
              </div>
              <div className="ppgInfoCard">
                <span>Allowed Pages</span>
                <strong>{allowedPagesCount}</strong>
              </div>
              <div className="ppgInfoCard">
                <span>Last Updated</span>
                <strong>{formatDateTime(updatedAt)}</strong>
              </div>
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "settings" ? (
        <section className="ppgSection">
          <div className="ppgSectionHead">Application Settings</div>

          <div className="ppgSettingsRow">
            <div>
              <div className="ppgSettingsTitle">Auto Minimize Sidebar</div>
              <div className="ppgSettingsSub">Hide sidebar after idle time with no hover.</div>
            </div>
            <button
              type="button"
              className="ppgActionBtn"
              onClick={() => setAutoMinimizeSidebar((prev) => !prev)}
            >
              {autoMinimizeSidebar ? "Disable" : "Enable"}
            </button>
          </div>

          <div className="ppgCollapseCard">
            <button
              type="button"
              className="ppgCollapseHead"
              onClick={() => setEmailExpanded((prev) => !prev)}
            >
              <span>
                <Mail size={15} />
                <span>Change Login Email</span>
              </span>
              <ChevronDown size={16} className={emailExpanded ? "isOpen" : ""} />
            </button>
            {emailExpanded ? (
              <div className="ppgCollapseBody">
                <input
                  type="email"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  className="ppgInput"
                  placeholder="Enter new login email"
                  disabled={savingEmail}
                />
                <button
                  type="button"
                  className="ppgActionBtn"
                  onClick={handleSaveEmail}
                  disabled={savingEmail}
                >
                  {savingEmail ? "Saving..." : "Save Email"}
                </button>
                {emailError ? <div className="ppgHelper isError">{emailError}</div> : null}
                {emailMessage ? <div className="ppgHelper isSuccess">{emailMessage}</div> : null}
              </div>
            ) : null}
          </div>

          <div className="ppgCollapseCard">
            <button
              type="button"
              className="ppgCollapseHead"
              onClick={() => setPasswordExpanded((prev) => !prev)}
            >
              <span>
                <LockKeyhole size={15} />
                <span>Change Password</span>
              </span>
              <ChevronDown size={16} className={passwordExpanded ? "isOpen" : ""} />
            </button>
            {passwordExpanded ? (
              <div className="ppgCollapseBody">
                <input
                  type="password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  className="ppgInput"
                  placeholder="Old password"
                />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="ppgInput"
                  placeholder="New password"
                />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="ppgInput"
                  placeholder="Confirm new password"
                />
                <button
                  type="button"
                  className="ppgActionBtn"
                  onClick={handleChangePassword}
                  disabled={savingPassword}
                >
                  {savingPassword ? "Updating..." : "Update Password"}
                </button>
                {passwordError ? <div className="ppgHelper isError">{passwordError}</div> : null}
                {passwordMessage ? <div className="ppgHelper isSuccess">{passwordMessage}</div> : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
