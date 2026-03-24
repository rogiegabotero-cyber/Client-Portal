import React, { useMemo, useState } from 'react'
import './hours.css'

const toMinutes = (hhmm) => {
  if (!hhmm || typeof hhmm !== 'string') return null
  const match = hhmm.match(/(\d{1,2}):(\d{2})/)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

const fmtHM = (mins) => {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}

const clamp01 = (n) => Math.max(0, Math.min(1, n))

const computePlannedMinutes = (e) => {
  const s = e?.schedule
  const sIn = toMinutes(s?.start)
  const sOut = toMinutes(s?.end)
  if (sIn !== null && sOut !== null && sOut > sIn) return sOut - sIn
  return 8 * 60
}

const computeWorkedMinutes = (e) => {
  const inMin = toMinutes(e?.clockIn)
  const outMin = toMinutes(e?.clockOut)

  // If both exist, use real worked time.
  if (inMin !== null && outMin !== null && outMin > inMin) return outMin - inMin

  // If clocked in but not out, use "so far" if same day time style; else approximate.
  if (inMin !== null && (outMin === null || outMin <= inMin)) {
    // minutes since midnight now
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    if (nowMin > inMin) return nowMin - inMin
    return Math.floor(computePlannedMinutes(e) * 0.5)
  }

  // no clock
  return 0
}

const statusFor = (e) => {
  const hasIn = !!e?.clockIn
  const hasOut = !!e?.clockOut

  if (hasIn && !hasOut) return { dot: 'working', pill: 'live', label: 'Working' }
  if (hasIn && hasOut) return { dot: 'complete', pill: 'off', label: 'Complete' }

  // If explicitly absent
  if ((e?.presence || '').toLowerCase() === 'absent') return { dot: 'noclock', pill: 'absent', label: 'Absent' }

  return { dot: 'noclock', pill: 'off', label: 'No Clock' }
}

const HoursPage = ({ employees = [], loading = false, error = '' }) => {
  // Filters: all | working | complete | noclock
  const [filter, setFilter] = useState('all')

  const model = useMemo(() => {
    const list = Array.isArray(employees) ? employees : []

    const rows = list.map((e) => {
      const planned = computePlannedMinutes(e)
      const worked = computeWorkedMinutes(e)
      const pct = planned ? clamp01(worked / planned) : 0

      const s = statusFor(e)

      return {
        id: e.id,
        name: e.name || '—',
        role: e.role || '—',
        department: e.department || '—',
        clockIn: e.clockIn || '',
        clockOut: e.clockOut || '',
        planned,
        worked,
        pct,
        status: s,
        note: e.absentReason || '',
      }
    })

    const working = rows.filter((r) => r.status.dot === 'working')
    const complete = rows.filter((r) => r.status.dot === 'complete')
    const noclock = rows.filter((r) => r.status.dot === 'noclock')

    const filtered =
      filter === 'working'
        ? working
        : filter === 'complete'
          ? complete
          : filter === 'noclock'
            ? noclock
            : rows

    const totalWorked = rows.reduce((sum, r) => sum + r.worked, 0)
    const totalPlanned = rows.reduce((sum, r) => sum + r.planned, 0)
    const avgPct = totalPlanned ? Math.round((totalWorked / totalPlanned) * 100) : 0

    return {
      rows,
      filtered,
      counts: {
        all: rows.length,
        working: working.length,
        complete: complete.length,
        noclock: noclock.length,
      },
      totals: {
        totalWorked,
        totalPlanned,
        avgPct,
      },
    }
  }, [employees, filter])

  return (
    <div className="hrPage">
      {/* Header */}
      <div className="hrHeader">
        <div>
          <div className="hrTitle">Hours</div>
          <div className="hrSub">
            {loading ? 'Loading from Hyacinth API…' : error ? `Error: ${error}` : 'Live from Hyacinth API'}
          </div>
        </div>

        <div className="hrFilters">
          <button
            type="button"
            className={`hrChip ${filter === 'all' ? 'on' : ''}`}
            onClick={() => setFilter('all')}
          >
            All <span className="num">{model.counts.all}</span>
          </button>

          <button
            type="button"
            className={`hrChip ${filter === 'working' ? 'on' : ''}`}
            onClick={() => setFilter('working')}
          >
            Working <span className="num">{model.counts.working}</span>
          </button>

          <button
            type="button"
            className={`hrChip ${filter === 'complete' ? 'on' : ''}`}
            onClick={() => setFilter('complete')}
          >
            Complete <span className="num">{model.counts.complete}</span>
          </button>

          <button
            type="button"
            className={`hrChip ${filter === 'noclock' ? 'on' : ''}`}
            onClick={() => setFilter('noclock')}
          >
            No Clock <span className="num">{model.counts.noclock}</span>
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="hrSummary">
        <div className="hrCard">
          <div className="hrCardLabel">Total Worked</div>
          <div className="hrCardValue">{fmtHM(model.totals.totalWorked)}</div>
          <div className="hrCardHint">Sum of worked time (based on clocks)</div>
        </div>

        <div className="hrCard">
          <div className="hrCardLabel">Planned</div>
          <div className="hrCardValue">{fmtHM(model.totals.totalPlanned)}</div>
          <div className="hrCardHint">Sum of scheduled shift durations</div>
        </div>

        <div className="hrCard">
          <div className="hrCardLabel">Utilization</div>
          <div className="hrCardValue">{model.totals.avgPct}%</div>
          <div className="hrCardHint">Worked ÷ Planned (approx)</div>
        </div>
      </div>

      {/* 3 Panels */}
      <div className="hrGrid">
        {/* Working */}
        <div className="hrPanel">
          <div className="hrPanelHead">
            <span>Working</span>
            <span className="count">{model.counts.working}</span>
          </div>
          <div className="hrPanelBody">
            {model.rows.filter((r) => r.status.dot === 'working').length === 0 ? (
              <div className="hrEmpty">No one currently working</div>
            ) : (
              model.rows
                .filter((r) => r.status.dot === 'working')
                .map((r) => (
                  <div className="hrRow" key={r.id}>
                    <span className="dot working" />
                    <div>
                      <div className="hrRowName">{r.name}</div>
                      <div className="hrRowMeta">
                        {r.role} • {r.department}
                      </div>
                      <div className="hrRowKpi">
                        Clocked in: <b>{r.clockIn || '—'}</b>
                      </div>
                    </div>
                    <div className="hrRowRight">
                      <span className="pill live">Working</span>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>

        {/* Complete */}
        <div className="hrPanel">
          <div className="hrPanelHead">
            <span>Complete</span>
            <span className="count">{model.counts.complete}</span>
          </div>
          <div className="hrPanelBody">
            {model.rows.filter((r) => r.status.dot === 'complete').length === 0 ? (
              <div className="hrEmpty">No completed shifts</div>
            ) : (
              model.rows
                .filter((r) => r.status.dot === 'complete')
                .map((r) => (
                  <div className="hrRow" key={r.id}>
                    <span className="dot complete" />
                    <div>
                      <div className="hrRowName">{r.name}</div>
                      <div className="hrRowMeta">
                        {r.clockIn || '—'} → {r.clockOut || '—'}
                      </div>
                      <div className="hrRowKpi">
                        Worked: <b>{fmtHM(r.worked)}</b>
                      </div>
                    </div>
                    <div className="hrRowRight">
                      <span className="pill off">Complete</span>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>

        {/* No Clock */}
        <div className="hrPanel">
          <div className="hrPanelHead">
            <span>No Clock</span>
            <span className="count">{model.counts.noclock}</span>
          </div>
          <div className="hrPanelBody">
            {model.rows.filter((r) => r.status.dot === 'noclock').length === 0 ? (
              <div className="hrEmpty">Everyone has time logs</div>
            ) : (
              model.rows
                .filter((r) => r.status.dot === 'noclock')
                .map((r) => (
                  <div className="hrRow" key={r.id}>
                    <span className="dot noclock" />
                    <div>
                      <div className="hrRowName">{r.name}</div>
                      <div className="hrRowMeta">
                        {r.role} • {r.department}
                      </div>
                      <div className="hrRowKpi">
                        Planned: <b>{fmtHM(r.planned)}</b>
                      </div>
                    </div>
                    <div className="hrRowRight">
                      <span className={`pill ${(r.note || '').trim() ? 'absent' : 'off'}`}>
                        {(r.note || '').trim() ? 'Absent' : 'No Clock'}
                      </span>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="hrTableWrap">
        <div className="hrTableHead">All Hours</div>

        {model.filtered.length === 0 ? (
          <div className="hrNoRows">{loading ? 'Loading…' : 'No rows match this filter.'}</div>
        ) : (
          <table className="hrTable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Department</th>
                <th>Status</th>
                <th>Clock In</th>
                <th>Clock Out</th>
                <th>Worked</th>
                <th>Planned</th>
              </tr>
            </thead>
            <tbody>
              {model.filtered.map((r) => (
                <tr key={r.id}>
                  <td className="tdName">{r.name}</td>
                  <td>{r.role}</td>
                  <td>{r.department}</td>
                  <td>
                    <span className={`pill ${r.status.pill}`}>{r.status.label}</span>
                  </td>
                  <td>{r.clockIn || '—'}</td>
                  <td>{r.clockOut || '—'}</td>
                  <td>{fmtHM(r.worked)}</td>
                  <td>{fmtHM(r.planned)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default HoursPage