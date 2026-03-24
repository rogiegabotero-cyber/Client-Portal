import React from "react";
import "./sidebar.css";
import {
  LayoutDashboard,
  CalendarCheck,
  ClipboardList,
  CalendarDays,
  Timer,
  BarChart3,
  CalendarRange,
  Calendar,
  Receipt,
  Users,
  ShieldCheck,
  SlidersHorizontal,
  Bell,
  UserCog,
  Megaphone,
} from "lucide-react";
import { canAccessPage } from "../auth/roleUtils";

export default function Sidebar({
  activePage,
  setActivePage,
  loadingLive = false,
  liveAgents = [],
  userRole = "visitor",
  userAllowedPages = [],
}) {
  const navItems = [
    {
      section: "AGENT PROFILE",
      items: [
        { key: "dashboard", label: "DASHBOARD", icon: <LayoutDashboard size={20} /> },
        { key: "employee_dashboard", label: "MY DASHBOARD", icon: <LayoutDashboard size={20} /> },
        { key: "attendance", label: "ATTENDANCE", icon: <CalendarCheck size={20} /> },
        { key: "assignment", label: "ASSIGNMENT", icon: <ClipboardList size={20} /> },
        { key: "schedule", label: "SCHEDULE", icon: <CalendarDays size={20} /> },
        { key: "hours", label: "HOURS", icon: <Timer size={20} /> },
        { key: "notifications", label: "NOTIFICATIONS", icon: <Bell size={20} /> },
      ],
    },
    {
      section: "PERFORMANCE REPORT",
      items: [
        { key: "perf_daily", label: "DAILY", icon: <BarChart3 size={20} /> },
        { key: "perf_weekly", label: "WEEKLY", icon: <CalendarRange size={20} /> },
        { key: "perf_monthly", label: "MONTHLY", icon: <Calendar size={20} /> },
      ],
    },
    {
      section: "ADMINISTRATION",
      items: [
        { key: "manage_announcements", label: "ANNOUNCEMENTS", icon: <Megaphone size={20} /> },
        { key: "special_users", label: "SPECIAL USERS", icon: <ShieldCheck size={20} /> },
        { key: "control_panel", label: "CONTROL PANEL", icon: <SlidersHorizontal size={20} /> },
        { key: "manage_employee", label: "MANAGE EMPLOYEE", icon: <UserCog size={20} /> },
      ],
    },
    {
      section: "BILLING",
      items: [{ key: "invoices", label: "INVOICES", icon: <Receipt size={20} /> }],
    },
  ];

  const navBtn = (key, label, iconEl) => (
    <button
      key={key}
      type="button"
      className={`sb-item ${activePage === key ? "active" : ""}`}
      onClick={() => setActivePage(key)}
      aria-label={label}
    >
      <span className="sb-icon">{iconEl}</span>
      <span className="sb-text">{label}</span>
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="anchore" />

      <div className="navbar">
        <div className="sb-brand">
          <div className="sb-brand-badge">UH</div>
          <div className="sb-brand-meta">
            <div className="sb-brand-title">UNICORN HAIR</div>
          </div>
        </div>

        <div className="sb-card">
          <div className="sb-card-title">
            <Users size={16} />
            <span>LIVE AGENTS</span>
            {loadingLive && <span className="sb-live-dot" />}
          </div>

          <div className="sb-live-list">
            {liveAgents.length === 0 ? (
              <div className="sb-live-empty">No present agents today</div>
            ) : (
              liveAgents.map((a) => {
                const isBreak = String(a.status || "").toLowerCase().includes("break");

                return (
                  <div key={a.id} className="sb-live-item">
                    <span className={`sb-live-dot ${isBreak ? "break" : ""}`} />
                    <span className="sb-live-name">{a.name}</span>
                    <span className={`sb-live-status ${isBreak ? "break" : ""}`}>
                      {a.status || "Live"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {navItems.map((group) => {
        const visibleItems = group.items.filter((item) =>
          canAccessPage(userRole, item.key, userAllowedPages)
        );

        if (visibleItems.length === 0) return null;

        return (
          <div className="sb-group" key={group.section}>
            <div className="sb-group-title">{group.section}</div>
            <div className="sb-nav" >
              {visibleItems.map((item) => navBtn(item.key, item.label, item.icon))}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
