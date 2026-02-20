import React, { useMemo } from 'react'
import './sidebar.css'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'

const isAgentLive = (e) => e.presence !== 'absent' && e.isLive === true

const Sidebar = ({ collapsed, setCollapsed, activePage, setActivePage, employees = [] }) => {
  const liveAgents = useMemo(() => employees.filter(isAgentLive), [employees])

  const navBtn = (key, label) => (
    <button
      type="button"
      className={`sb-link ${activePage === key ? 'active' : ''}`}
      onClick={() => setActivePage(key)}
      title={label}
    >
      <span className="sb-link-text">{label}</span>
    </button>
  )

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sb-brand">
        <div className="sb-brand-title">UNICORN HAIR</div>
      </div>

      {!collapsed && (
        <div className="sb-section">
          <div className="sb-section-title">LIVE AGENTS</div>
          <div className="sb-live-list">
            {liveAgents.length === 0 ? (
              <div className="sb-live-empty">No live agents</div>
            ) : (
              liveAgents.map((e) => (
                <div key={e.id} className="sb-live-item">
                  <span className="sb-live-dot" />
                  <span className="sb-live-name">{e.name}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="sb-section">
        {!collapsed && <div className="sb-section-title">AGENT PROFILE</div>}
        <div className="sb-nav">
          {navBtn('dashboard', 'Dashboard')}
          {navBtn('attendance', 'ATTENDANCE')}
          {navBtn('assignment', 'ASSIGNMENT')}
          {navBtn('schedule', 'SCHEDULE')}
          {navBtn('hours', 'HOURS')}
        </div>
      </div>

      <div className="sb-section">
        {!collapsed && <div className="sb-section-title">PERFORMANCE REPORT</div>}
        <div className="sb-nav">
          {navBtn('perf_daily', 'DAILY')}
          {navBtn('perf_weekly', 'WEEKLY')}
          {navBtn('perf_monthly', 'MONTHLY')}
        </div>
      </div>

      <div className="sb-section">
        <div className="sb-nav">{navBtn('invoices', 'INVOICES')}</div>
      </div>

      <button
        className="collapse-btn"
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
      </button>
    </aside>
  )
}

export default Sidebar