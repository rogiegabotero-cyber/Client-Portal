import React, { useMemo } from 'react'
import './dashboard.css'

const clamp01 = (n) => Math.max(0, Math.min(1, n))

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const fmtDays = (days) => {
  if (!Array.isArray(days) || days.length === 0) return '—'
  const unique = Array.from(new Set(days)).sort((a, b) => a - b)
  return unique.map((d) => dayNames[d] ?? d).join(', ')
}

// Basic parsing for "HH:mm"
const toMinutes = (hhmm) => {
  if (!hhmm || typeof hhmm !== 'string') return null
  const m = hhmm.match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
  return h * 60 + mm
}

const computePlannedMinutes = (emp) => {
  const s = emp?.schedule
  const start = toMinutes(s?.start)
  const end = toMinutes(s?.end)
  if (start !== null && end !== null && end > start) return end - start
  return 8 * 60
}

const computeWorkedMinutes = (emp) => {
  const cin = toMinutes(emp?.clockIn)
  const cout = toMinutes(emp?.clockOut)
  if (cin !== null && cout !== null && cout > cin) return cout - cin
  // fallback: if clocked in but no out, assume half shift for visuals
  if (cin !== null && (cout === null || cout <= cin)) return Math.floor(computePlannedMinutes(emp) * 0.5)
  return 0
}

const Dashboard = ({ employees = [], loading = false, error = '' }) => {
  const data = useMemo(() => {
    const list = Array.isArray(employees) ? employees : []

    const total = list.length
    const absentList = list.filter((e) => (e?.presence || '').toLowerCase() === 'absent')
    const presentList = list.filter((e) => (e?.presence || '').toLowerCase() !== 'absent')
    const liveList = list.filter((e) => !!e?.isLive)

    const absent = absentList.length
    const present = presentList.length
    const live = liveList.length

    // attendance pie percentages
    const pctAbsent = total ? absent / total : 0
    const pctPresent = total ? present / total : 0

    // performance bars: use top 10 by worked minutes
    const perf = list
      .map((e) => ({
        id: e.id,
        name: e.name || '—',
        role: e.role || '—',
        department: e.department || '—',
        workedMin: computeWorkedMinutes(e),
        plannedMin: computePlannedMinutes(e),
      }))
      .sort((a, b) => b.workedMin - a.workedMin)
      .slice(0, 10)

    const maxWorked = perf.reduce((m, x) => Math.max(m, x.workedMin), 1)

    // heatmap table: use live agents first, else everyone, cap 20 rows
    const heatRows = (liveList.length ? liveList : list).slice(0, 20).map((e) => {
      const worked = computeWorkedMinutes(e)
      const planned = computePlannedMinutes(e)
      const pct = planned ? clamp01(worked / planned) : 0
      return {
        id: e.id,
        role: e.role || e.name || '—',
        department: e.department || '—',
        scheduleDays: fmtDays(e?.schedule?.days),
        time: e?.schedule?.start && e?.schedule?.end ? `${e.schedule.start}-${e.schedule.end}` : '—',
        presence: e?.presence || '—',
        pct,
      }
    })

    // mini bars: totals by department (top 6)
    const byDept = new Map()
    for (const e of list) {
      const dept = e?.department || 'Unassigned'
      byDept.set(dept, (byDept.get(dept) || 0) + 1)
    }
    const deptBars = Array.from(byDept.entries())
      .map(([dept, count]) => ({ dept, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)

    const deptMax = deptBars.reduce((m, x) => Math.max(m, x.count), 1)

    // donutRow: show up to 5 live agents (or first 5 employees)
    const donutPeople = (liveList.length ? liveList : list).slice(0, 5).map((e) => {
      const planned = computePlannedMinutes(e)
      const worked = computeWorkedMinutes(e)
      const pct = planned ? clamp01(worked / planned) : 0
      return {
        id: e.id,
        name: e.name || '—',
        sub: e.role || e.department || '—',
        pct,
        workedMin: worked,
        plannedMin: planned,
      }
    })

    return {
      total,
      present,
      absent,
      live,
      pctAbsent,
      pctPresent,
      perf,
      maxWorked,
      heatRows,
      deptBars,
      deptMax,
      donutPeople,
    }
  }, [employees])

  // Pie gradient: absent red, present blue (using CSS dot colors)
  const pieStyle = useMemo(() => {
    const redDeg = Math.round(data.pctAbsent * 360)
    // order: absent (red) then present (blue)
    return {
      background: `conic-gradient(#ef4444 0deg ${redDeg}deg, #60a5fa ${redDeg}deg 360deg)`,
    }
  }, [data.pctAbsent])

  return (
    <div className="dashX">
      {/* Top title + state */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Dashboard</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {loading && <div style={{ opacity: 0.75 }}>Loading from Hyacinth API…</div>}
          {!loading && error && <div style={{ color: '#ef4444', fontWeight: 800 }}>{error}</div>}
        </div>
      </div>

      <div className="dashLayout">
        <div className="dashMain">
          {/* KPI BAR */}
          <div className="topBar">
            <div className="kpi">
              <div className="kpiLabel">TOTAL EMPLOYEES</div>
              <div className="kpiValue">{data.total}</div>
            </div>
            <div className="kpi">
              <div className="kpiLabel">PRESENT</div>
              <div className="kpiValue">{data.present}</div>
            </div>
            <div className="kpi">
              <div className="kpiLabel">ABSENT</div>
              <div className="kpiValue">{data.absent}</div>
            </div>
            <div className="kpi">
              <div className="kpiLabel">LIVE AGENTS</div>
              <div className="kpiValue">{data.live}</div>
            </div>
          </div>

          {/* MAIN GRID */}
          <div className="grid">
            {/* Attendance Panel */}
            <div className="panel p-att">
              <div className="panelHead">Attendance</div>
              <div className="panelBody">
                <div className="attWrap">
                  <div className="attPie" style={pieStyle}>
                    <div className="attHole" />
                  </div>

                  <div className="attLegend">
                    <div className="attLegendRow">
                      <span className="dot blue" />
                      <span>Present</span>
                      <span className="attNum">{data.present}</span>
                    </div>
                    <div className="attLegendRow">
                      <span className="dot red" />
                      <span>Absent</span>
                      <span className="attNum">{data.absent}</span>
                    </div>
                    <div className="attLegendRow">
                      <span className="dot orange" />
                      <span>Live</span>
                      <span className="attNum">{data.live}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Performance Panel */}
            <div className="panel p-perf">
              <div className="panelHead">Performance</div>
              <div className="panelBody panelBodyFill">
                <div className="perfBars perfBarsFull">
                  {data.perf.length === 0 ? (
                    <div style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 800, fontSize: 12, padding: 12 }}>
                      No data
                    </div>
                  ) : (
                    data.perf.map((p) => {
                      const pct = data.maxWorked ? clamp01(p.workedMin / data.maxWorked) : 0
                      const h = Math.round(pct * 100)
                      return (
                        <div key={p.id} className="perfBar perfBarFull" title={`${p.name} • ${Math.round(p.workedMin / 60)}h`}>
                          <div className="perfBarTick">{Math.round(p.workedMin / 60)}h</div>
                          <div className="perfBarFill" style={{ height: `${h}%` }} />
                          <div className="perfBarLabel">{p.name}</div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Heatmap Panel */}
            <div className="panel p-heat">
              <div className="panelHead">Heatmap</div>
              <div className="panelBody panelBodyFill">
                <div className="heatWrap">
                  <table className="heatTable">
                    <thead>
                      <tr>
                        <th>Role / Name</th>
                        <th>Dept</th>
                        <th>Days</th>
                        <th>Shift</th>
                        <th>Presence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.heatRows.length === 0 ? (
                        <tr>
                          <td className="heatRole" colSpan={5}>
                            No data
                          </td>
                        </tr>
                      ) : (
                        data.heatRows.map((r) => (
                          <tr key={r.id}>
                            <td className="heatRole">{r.role}</td>
                            <td>{r.department}</td>
                            <td>{r.scheduleDays}</td>
                            <td>{r.time}</td>
                            <td>{r.presence}</td>
                          </tr>
                        ))
                      )}
                      {data.heatRows.length > 0 && (
                        <tr>
                          <td className="heatTotal">Total</td>
                          <td className="heatTotal" colSpan={4} style={{ textAlign: 'right' }}>
                            {data.total}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Bottom mini bars */}
            <div className="panel p-mini">
              <div className="panelHead">Departments</div>
              <div className="panelBody">
                <div className="miniBars">
                  {data.deptBars.length === 0 ? (
                    <div style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 800, fontSize: 12 }}>No data</div>
                  ) : (
                    data.deptBars.map((d) => {
                      const pct = data.deptMax ? clamp01(d.count / data.deptMax) : 0
                      return (
                        <div key={d.dept} className="miniBarRow">
                          <div>{d.dept}</div>
                          <div className="miniBarTrack">
                            <div className="miniBarFill" style={{ width: `${Math.round(pct * 100)}%` }} />
                          </div>
                          <div className="miniBarValue">{d.count}</div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Bottom agent stats donuts */}
            <div className="panel p-stats">
              <div className="panelHead center">Agent Stats</div>
              <div className="panelBody">
                <div className="donutRow">
                  {data.donutPeople.length === 0 ? (
                    <div style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 800, fontSize: 12 }}>
                      No data
                    </div>
                  ) : (
                    data.donutPeople.map((p) => {
                      const deg = Math.round(p.pct * 360)
                      const donutStyle = {
                        background: `conic-gradient(#f59e0b 0deg ${deg}deg, rgba(255,255,255,0.10) ${deg}deg 360deg)`,
                      }
                      const label = p.name
                      const sub = p.sub
                      const value = `${Math.round(p.pct * 100)}%`
                      return (
                        <div key={p.id} className="donutCard">
                          <div className="donut" style={donutStyle}>
                            <div className="donutInner">
                              <div className="donutValue">{value}</div>
                            </div>
                          </div>
                          <div className="donutMeta">
                            <div className="donutLabel">{label}</div>
                            <div className="donutSub">{sub}</div>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Update sidebar — keep visible 10% */}
        <aside className="updateSidebar">
          <div className="panelHead center">Updates</div>
          <div className="panelBody">
            <div className="updateBody">
              <div className="updateBox">
                <div className="updateItem">API Status</div>
                <div style={{ fontWeight: 800 }}>
                  {loading ? 'Loading…' : error ? 'Error' : 'Connected'}
                </div>

                <div className="updateItem">Live Agents</div>
                <div style={{ fontWeight: 800 }}>{data.live}</div>

                <div className="updateItem">Last Refresh</div>
                <div style={{ fontWeight: 800 }}>{new Date().toLocaleString()}</div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default Dashboard