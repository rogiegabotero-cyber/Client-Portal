import React, { useCallback, useEffect, useRef, useState } from "react";
import "./sidebar.css";
import {
  LayoutDashboard,
  CalendarCheck,
  ClipboardList,
  CalendarDays,
  BarChart3,
  CalendarRange,
  Calendar,
  Receipt,
  Users,
  SlidersHorizontal,
  Bell,
  Megaphone,
  RefreshCcw,
  ChevronDown,
} from "lucide-react";
import { canAccessPage } from "../auth/roleUtils";
import HHIUHAI from "../assets/hhi-uhai.png";

export default function Sidebar({
  activePage,
  setActivePage,
  loadingLive = false,
  liveAgents = [],
  userRole = "visitor",
  userAllowedPages = [],
  onSelectLiveAgent,
  onRefreshLiveAgents,
}) {
  const SIDEBAR_GROUP_SESSION_KEY = "portal_sidebar_group_open_state_v1";

  const LIVE_PANEL_DEFAULT_HEIGHT = 175;
  const LIVE_PANEL_MIN_HEIGHT = 120;
  const LIVE_PANEL_BOTTOM_GAP = 14;

  const [livePanelMaxHeight, setLivePanelMaxHeight] = useState(LIVE_PANEL_DEFAULT_HEIGHT);
  const [isResizingLivePanel, setIsResizingLivePanel] = useState(false);
  const dragStateRef = useRef({
    startY: 0,
    startHeight: LIVE_PANEL_DEFAULT_HEIGHT,
    maxAllowedHeight: LIVE_PANEL_DEFAULT_HEIGHT,
  });
  const sidebarRef = useRef(null);
  const navbarRef = useRef(null);
  const liveCardRef = useRef(null);
  const liveListRef = useRef(null);
  const [navbarStickyHeight, setNavbarStickyHeight] = useState(0);

  const getLivePanelMaxAllowedHeight = useCallback(() => {
    const sidebarEl = sidebarRef.current;
    const cardEl = liveCardRef.current;
    const listEl = liveListRef.current;
    const cardStyle = cardEl ? window.getComputedStyle(cardEl) : null;
    const padTop = Number.parseFloat(cardStyle?.paddingTop || "0") || 0;
    const padBottom = Number.parseFloat(cardStyle?.paddingBottom || "0") || 0;
    const listContentHeight = Math.max(0, Number(listEl?.scrollHeight || 0));
    const contentFitHeight = listContentHeight + padTop + padBottom;

    if (!sidebarEl || !cardEl) {
      return Math.max(LIVE_PANEL_MIN_HEIGHT, contentFitHeight || LIVE_PANEL_DEFAULT_HEIGHT);
    }

    const sidebarRect = sidebarEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const availableHeight = Math.max(
      LIVE_PANEL_MIN_HEIGHT,
      sidebarRect.bottom - cardRect.top - LIVE_PANEL_BOTTOM_GAP
    );

    return Math.max(
      LIVE_PANEL_MIN_HEIGHT,
      Math.min(availableHeight, contentFitHeight || availableHeight)
    );
  }, []);

  useEffect(() => {
    const clampLivePanelHeight = () => {
      const maxAllowed = getLivePanelMaxAllowedHeight();
      setLivePanelMaxHeight((prev) =>
        Math.max(LIVE_PANEL_MIN_HEIGHT, Math.min(Number(prev || LIVE_PANEL_DEFAULT_HEIGHT), maxAllowed))
      );
    };

    clampLivePanelHeight();
    window.addEventListener("resize", clampLivePanelHeight);
    return () => window.removeEventListener("resize", clampLivePanelHeight);
  }, [getLivePanelMaxAllowedHeight, liveAgents.length, loadingLive]);

  useEffect(() => {
    if (!isResizingLivePanel) return undefined;

    const handlePointerMove = (event) => {
      const dragState = dragStateRef.current;
      const deltaY = Number(event?.clientY || 0) - dragState.startY;
      const rawHeight = dragState.startHeight + deltaY;
      const nextHeight = Math.min(
        dragState.maxAllowedHeight,
        Math.max(LIVE_PANEL_MIN_HEIGHT, rawHeight)
      );
      setLivePanelMaxHeight(nextHeight);
    };

    const handlePointerStop = () => {
      setIsResizingLivePanel(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerStop);
    window.addEventListener("pointercancel", handlePointerStop);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerStop);
      window.removeEventListener("pointercancel", handlePointerStop);
    };
  }, [isResizingLivePanel]);

  const handleLivePanelResizeStart = useCallback(
    (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      dragStateRef.current = {
        startY: Number(event.clientY || 0),
        startHeight: Number(livePanelMaxHeight || LIVE_PANEL_DEFAULT_HEIGHT),
        maxAllowedHeight: getLivePanelMaxAllowedHeight(),
      };
      setIsResizingLivePanel(true);
    },
    [getLivePanelMaxAllowedHeight, livePanelMaxHeight]
  );

  const navItems = [
    {
      section: "AGENT PROFILE",
      items: [
        { key: "dashboard", label: "DASHBOARD", icon: <LayoutDashboard size={20} /> },
        { key: "employee_dashboard", label: "MY DASHBOARD", icon: <LayoutDashboard size={20} /> },
        { key: "attendance", label: "ATTENDANCE", icon: <CalendarCheck size={20} /> },
        { key: "assignment", label: "ASSIGNMENT", icon: <ClipboardList size={20} /> },
        { key: "schedule", label: "SCHEDULE", icon: <CalendarDays size={20} /> },
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
        { key: "control_panel", label: "CONTROL PANEL", icon: <SlidersHorizontal size={20} /> },
      ],
    },
    {
      section: "BILLING",
      items: [{ key: "invoices", label: "INVOICES", icon: <Receipt size={20} /> }],
    },
  ];

  const [groupOpenState, setGroupOpenState] = useState(() => {
    const allOpen = {};
    for (const group of navItems) {
      allOpen[group.section] = true;
    }
    return allOpen;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = window.sessionStorage.getItem(SIDEBAR_GROUP_SESSION_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return;

      setGroupOpenState((prev) => {
        const next = { ...prev };
        for (const group of navItems) {
          const key = group.section;
          if (typeof parsed[key] === "boolean") {
            next[key] = parsed[key];
          }
        }
        return next;
      });
    } catch {
      // Ignore malformed session payloads.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        SIDEBAR_GROUP_SESSION_KEY,
        JSON.stringify(groupOpenState)
      );
    } catch {
      // Ignore storage write failures.
    }
  }, [groupOpenState]);

  useEffect(() => {
    const updateNavbarHeight = () => {
      const h = Number(navbarRef.current?.getBoundingClientRect?.().height || 0);
      setNavbarStickyHeight(Math.max(0, Math.round(h)));
    };

    updateNavbarHeight();
    window.addEventListener("resize", updateNavbarHeight);

    let observer = null;
    if (typeof ResizeObserver !== "undefined" && navbarRef.current) {
      observer = new ResizeObserver(() => updateNavbarHeight());
      observer.observe(navbarRef.current);
    }

    return () => {
      window.removeEventListener("resize", updateNavbarHeight);
      if (observer) observer.disconnect();
    };
  }, []);

  const toggleGroupOpen = (section) => {
    const key = String(section || "");
    if (!key) return;
    setGroupOpenState((prev) => ({
      ...(prev && typeof prev === "object" ? prev : {}),
      [key]: !prev?.[key],
    }));
  };

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
    <aside className="sidebar" ref={sidebarRef}>
      <div className="anchore" />

      <div className="navbar" ref={navbarRef}>
        <div className="sb-brand">
          <div className="sb-brand-badge">
            <img src={HHIUHAI} alt="" />
          </div>
          <div className="sb-brand-meta">
            <div className="sb-brand-title-wrap">
              <div className="sb-brand-title">UNICORN HAIR</div>
              <span className="sb-brand-beta">BETA</span>
            </div>
          </div>
        </div>

        <div className="sb-card-title">
          <div className="sb-live-title-wrap">
            <Users size={16} />
            <span>LIVE AGENTS ({Array.isArray(liveAgents) ? liveAgents.length : 0})</span>
            {loadingLive && <span className="sb-live-dot" />}
          </div>
          <button
            type="button"
            className={`sb-refresh-btn ${loadingLive ? "isLoading" : ""}`}
            onClick={() => onRefreshLiveAgents?.()}
            title="Refresh live agents"
            disabled={loadingLive}
            aria-busy={loadingLive}
          >
            <RefreshCcw size={15} className="sb-refresh-icon" />
          </button>
        </div>

        <div
          className={`sb-card ${isResizingLivePanel ? "isResizing" : ""}`}
          ref={liveCardRef}
          style={{ maxHeight: `${Math.round(livePanelMaxHeight)}px` }}
        >
          <div className="sb-live-list" ref={liveListRef}>
            {loadingLive ? (
              <div className="sb-live-loading" role="status" aria-live="polite">
                <span className="sb-live-loading-spinner" />
                <span>Loading live agents...</span>
              </div>
            ) : liveAgents.length === 0 ? (
              <div className="sb-live-empty">No present agents today</div>
            ) : (
              liveAgents.map((a) => {
                const isBreak = String(a.status || "").toLowerCase().includes("break");

                return (
                  <button
                    key={a.id}
                    type="button"
                    className="sb-live-item"
                    onClick={() => onSelectLiveAgent?.(a)}
                    title={`View ${a.name} details`}
                  >
                    <span className={`sb-live-dot ${isBreak ? "break" : ""}`} />
                    <span className="sb-live-name">{a.name}</span>
                    <span className={`sb-live-status ${isBreak ? "break" : ""}`}>
                      {a.status || "Live"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div
          className={`sb-card-resize-handle ${isResizingLivePanel ? "isActive" : ""}`}
          onPointerDown={handleLivePanelResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize live agents panel"
          title="Drag to resize live agents list"
        />
      </div>
      <div className="nav-title" style={{ top: `${Math.max(0, navbarStickyHeight)}px` }}>
        Navigation
      </div>

      {navItems.map((group) => {
        const visibleItems = group.items.filter((item) =>
          canAccessPage(userRole, item.key, userAllowedPages)
        );

        if (visibleItems.length === 0) return null;
        const isOpen = groupOpenState?.[group.section] !== false;

        return (
          <div className="sb-group" key={group.section}>
            <button
              type="button"
              className={`sb-group-toggle ${isOpen ? "open" : ""}`}
              onClick={() => toggleGroupOpen(group.section)}
              aria-expanded={isOpen}
              aria-controls={`sb-group-panel-${group.section.replace(/\s+/g, "-").toLowerCase()}`}
            >
              <ChevronDown size={14} className="sb-group-chevron" />
              <span className="sb-group-title">{group.section}</span>
              
            </button>
            {isOpen ? (
              <div
                id={`sb-group-panel-${group.section.replace(/\s+/g, "-").toLowerCase()}`}
                className="sb-nav"
              >
                {visibleItems.map((item) => navBtn(item.key, item.label, item.icon))}
              </div>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}
