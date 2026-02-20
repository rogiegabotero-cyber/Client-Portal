import React, { useMemo, useState } from 'react'
import './hours.css'
import { DUMMY_SHIFT_HOURS } from '../data/dummyData'

/** ---------- helpers ---------- */
const toMinutes = (hhmm) => {
  const [h, m] = (hhmm || '00:00').split(':').map(Number)
  return h * 60 + m
}

const nowMinutes = () => {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

const minutesToHHMM = (mins) => {
  const safe = Math.max(0, mins || 0)
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Dummy shift end = start + DUMMY_SHIFT_HOURS
const shiftEndFromStart = (startHHMM) => {
  const start = toMinutes(startHHMM || '09:00')
  const end = start + DUMMY_SHIFT_HOURS * 60
  const h = Math.floor((end % (24 * 60)) / 60)
  const m = end % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// display HH:MM like Schedule
const fmtHHMM = (hhmm) => {
  const [h, m] = (hhmm || '00:00').split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const fmtTime = (d) => {
  if (!d) return '—'
  const dd = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dd.getTime())) return '—'
  return dd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, n))

const isAgentLive = (e) => e.presence !== 'absent' && e.isLive === true
const isAgentOnBreak = (e) => isAgentLive(e) && e.onBreak === true

/** ---------- period helpers (UI only; data is still "today") ---------- */
const PERIODS = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' }
]

// since we only have today data in `employees`, we can only "project" totals.
// If later you add real historical logs, replace these multipliers with real aggregation.
const periodMultiplier = (periodKey) => {
  if (periodKey === 'week') return 5 // assume 5 workdays
  if (periodKey === 'month') return 22 // rough workdays/month
  if (periodKey === 'year') return 260 // rough workdays/year
  return 1
}

const statusLabel = (b) => {
  if (b === 'onShift') return 'On Shift'
  if (b === 'later') return 'Later Today'
  return 'Off'
}

const HoursPage = ({ employees = [], graceMinutes = 10 }) => {
  // emphasize time period
  const [period, setPeriod] = useState('day') // day | week | month | year
  // keep Schedule-like bucket filter
  const [bucketFilter, setBucketFilter] = useState('all') // all | onShift | later | off

  /**
   * rows: focus on worked minutes TODAY.
   * - If agent is LIVE => worked = now - clockIn
   * - If agent is NOT live (clocked out) => worked = shiftEnd - clockIn (dummy end)
   * - If later or no clock-in => 0
   *
   * Bucket logic:
   * - ABSENT => off
   * - LIVE => onShift (always)
   * - else => schedule-time based (onShift / later / off)
   */
  const rows = useMemo(() => {
    const now = nowMinutes()

    return employees.map((e) => {
      const startHHMM = e.shiftStart || '09:00'
      const start = toMinutes(startHHMM)
      const endHHMM = shiftEndFromStart(startHHMM)
      const end = toMinutes(endHHMM)
      const isOvernight = end < start

      // --- bucket logic (with LIVE override) ---
      let bucket = 'off'

      if (e.presence === 'absent') {
        bucket = 'off'
      } else if (isAgentLive(e)) {
        bucket = 'onShift'
      } else {
        let isOn = false
        if (!isOvernight) isOn = now >= start && now <= end
        else isOn = now >= start || now <= end

        if (isOn) bucket = 'onShift'
        else if (now < start) bucket = 'later'
        else bucket = 'off'
      }

      // clock-in mins (supports Date or ISO string)
      const clockInDate = e.clockIn instanceof Date ? e.clockIn : e.clockIn ? new Date(e.clockIn) : null
      const clockInM =
        clockInDate && !Number.isNaN(clockInDate.getTime())
          ? clockInDate.getHours() * 60 + clockInDate.getMinutes()
          : null

      // late minutes (only if not absent + has clock-in)
      const lateMins =
        e.presence !== 'absent' && clockInM !== null ? clamp(clockInM - (start + graceMinutes), 0, 24 * 60) : 0

      // WORKED TODAY (the main KPI)
      let workedMins = 0
      if (e.presence !== 'absent' && clockInM !== null) {
        if (isAgentLive(e)) {
          // still working now
          workedMins = clamp(now - clockInM, 0, 24 * 60)
        } else {
          // not live anymore: show final total (dummy shift end)
          // NOTE: if overnight, this simplistic model will be imperfect; keep for now.
          workedMins = clamp(end - clockInM, 0, 24 * 60)
        }
      }

      const nominalShiftMins = DUMMY_SHIFT_HOURS * 60
      const overtimeMins = clamp(workedMins - nominalShiftMins, 0, 24 * 60)

      // "final total after client clocked out"
      const isClockedOut = e.presence !== 'absent' && !isAgentLive(e) && clockInM !== null
      const finalWorkedMins = isClockedOut ? workedMins : workedMins // kept explicit for clarity

      return {
        ...e,
        _bucket: bucket,
        _shiftEnd: endHHMM,
        _clockInM: clockInM,
        _workedMins: workedMins,
        _finalWorkedMins: finalWorkedMins,
        _lateMins: lateMins,
        _overtimeMins: overtimeMins,
        _clockedOut: isClockedOut
      }
    })
  }, [employees, graceMinutes])

  const grouped = useMemo(() => {
    const g = { onShift: [], later: [], off: [] }
    for (const r of rows) g[r._bucket].push(r)
    return g
  }, [rows])

  const filtered = useMemo(() => {
    if (bucketFilter === 'all') return rows
    return rows.filter((r) => r._bucket === bucketFilter)
  }, [rows, bucketFilter])

  // totals based on selected period (projected)
  const totals = useMemo(() => {
    const mult = periodMultiplier(period)
    const totalWorked = rows.reduce((sum, r) => sum + r._workedMins, 0) * mult
    const totalLate = rows.reduce((sum, r) => sum + r._lateMins, 0) * mult
    const totalOT = rows.reduce((sum, r) => sum + r._overtimeMins, 0) * mult
    return { totalWorked, totalLate, totalOT }
  }, [rows, period])

  // show per-agent value based on selected period (projected)
  const rowWorkedForPeriod = (r) => r._workedMins * periodMultiplier(period)
  const rowLateForPeriod = (r) => r._lateMins * periodMultiplier(period)
  const rowOTForPeriod = (r) => r._overtimeMins * periodMultiplier(period)

  return (
    <div className="hrPage">
      {/* Header */}
      <div className="hrHeader">
        <div>
          <div className="hrTitle">Hours</div>
          <div className="hrSub">
            Emphasis: hours worked {period === 'day' ? 'today' : `this ${period}`} • Shift end is dummy (start + {DUMMY_SHIFT_HOURS} hrs)
          </div>
        </div>

        {/* Period filter */}
        <div className="hrFilters">
          {PERIODS.map((p) => (
            <button key={p.key} className={`hrChip ${period === p.key ? 'on' : ''}`} onClick={() => setPeriod(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bucket filters */}
      <div className="hrHeader" style={{ marginTop: 10 }}>
        <div className="hrFilters">
          <button className={`hrChip ${bucketFilter === 'all' ? 'on' : ''}`} onClick={() => setBucketFilter('all')}>
            All <span className="num">{rows.length}</span>
          </button>
          <button className={`hrChip ${bucketFilter === 'onShift' ? 'on' : ''}`} onClick={() => setBucketFilter('onShift')}>
            On Shift <span className="num">{grouped.onShift.length}</span>
          </button>
          <button className={`hrChip ${bucketFilter === 'later' ? 'on' : ''}`} onClick={() => setBucketFilter('later')}>
            Later <span className="num">{grouped.later.length}</span>
          </button>
          <button className={`hrChip ${bucketFilter === 'off' ? 'on' : ''}`} onClick={() => setBucketFilter('off')}>
            Off <span className="num">{grouped.off.length}</span>
          </button>
        </div>
      </div>

      {/* Summary (HH:MM) */}
      <div className="hrSummary">
        <div className="hrCard">
          <div className="hrCardLabel">Total Worked</div>
          <div className="hrCardValue">{minutesToHHMM(totals.totalWorked)}</div>
          <div className="hrCardHint">Projected from today (no historical logs yet)</div>
        </div>
        <div className="hrCard">
          <div className="hrCardLabel">Total Late</div>
          <div className="hrCardValue">{minutesToHHMM(totals.totalLate)}</div>
          <div className="hrCardHint">Beyond {graceMinutes}-minute grace</div>
        </div>
        <div className="hrCard">
          <div className="hrCardLabel">Total Overtime</div>
          <div className="hrCardValue">{minutesToHHMM(totals.totalOT)}</div>
          <div className="hrCardHint">Beyond {DUMMY_SHIFT_HOURS}-hour nominal shift</div>
        </div>
      </div>

      {/* Lists */}
      <div className="hrGrid">
        {/* On Shift */}
        <section className="hrPanel">
          <div className="hrPanelHead">
            On Shift <span className="count">{grouped.onShift.length}</span>
          </div>
          <div className="hrPanelBody">
            {grouped.onShift.map((r) => (
              <div key={r.id} className="hrRow">
                <span className="dot working" />
                <div className="hrRowMain">
                  <div className="hrRowName">{r.name}</div>
                  <div className="hrRowMeta">
                    {r.role} • {fmtHHMM(r.shiftStart)} - {fmtHHMM(r._shiftEnd)}
                  </div>
                  <div className="hrRowKpi">
                    Worked {period === 'day' ? 'today' : `(${period})`}:{' '}
                    <b>{minutesToHHMM(rowWorkedForPeriod(r))}</b> • Late: <b>{minutesToHHMM(rowLateForPeriod(r))}</b> • OT:{' '}
                    <b>{minutesToHHMM(rowOTForPeriod(r))}</b>
                  </div>
                </div>
                <div className="hrRowRight">
                  <span className={`pill ${isAgentLive(r) ? 'live' : 'off'}`}>{isAgentLive(r) ? 'Live' : 'Offline'}</span>
                  {isAgentOnBreak(r) && <span className="pill break">Break</span>}
                </div>
              </div>
            ))}
            {grouped.onShift.length === 0 && <div className="hrEmpty">No agents currently on shift.</div>}
          </div>
        </section>

        {/* Later */}
        <section className="hrPanel">
          <div className="hrPanelHead">
            Later Today <span className="count">{grouped.later.length}</span>
          </div>
          <div className="hrPanelBody">
            {grouped.later.map((r) => (
              <div key={r.id} className="hrRow">
                <span className="dot later" />
                <div className="hrRowMain">
                  <div className="hrRowName">{r.name}</div>
                  <div className="hrRowMeta">
                    {r.role} • {fmtHHMM(r.shiftStart)} - {fmtHHMM(r._shiftEnd)}
                  </div>
                  <div className="hrRowKpi">
                    Starts: <b>{fmtHHMM(r.shiftStart)}</b> • Worked today: <b>{minutesToHHMM(r._workedMins)}</b>
                  </div>
                </div>
                <div className="hrRowRight">
                  <span className="pill later">Later</span>
                </div>
              </div>
            ))}
            {grouped.later.length === 0 && <div className="hrEmpty">No upcoming shifts.</div>}
          </div>
        </section>

        {/* Off */}
        <section className="hrPanel">
          <div className="hrPanelHead">
            Off <span className="count">{grouped.off.length}</span>
          </div>
          <div className="hrPanelBody">
            {grouped.off.map((r) => (
              <div key={r.id} className="hrRow">
                <span className="dot complete" />
                <div className="hrRowMain">
                  <div className="hrRowName">{r.name}</div>
                  <div className="hrRowMeta">
                    {r.role} • {fmtHHMM(r.shiftStart)} - {fmtHHMM(r._shiftEnd)}
                    {r.presence === 'absent' && r.absentReason ? ` • ${r.absentReason}` : ''}
                  </div>
                  <div className="hrRowKpi">
                    {/* ✅ show final total clearly after clocked out */}
                    {r._clockedOut ? (
                      <>
                        Final total today: <b>{minutesToHHMM(r._finalWorkedMins)}</b> • Clock-in: <b>{fmtTime(r.clockIn)}</b>
                      </>
                    ) : (
                      <>
                        Worked today: <b>{minutesToHHMM(r._workedMins)}</b> • Clock-in: <b>{fmtTime(r.clockIn)}</b>
                      </>
                    )}
                  </div>
                </div>
                <div className="hrRowRight">
                  <span className={`pill ${r.presence === 'absent' ? 'absent' : 'off'}`}>{r.presence === 'absent' ? 'Absent' : 'Off'}</span>
                </div>
              </div>
            ))}
            {grouped.off.length === 0 && <div className="hrEmpty">No off agents.</div>}
          </div>
        </section>
      </div>

      {/* Table */}
      <div className="hrTableWrap">
        <div className="hrTableHead">
          Hours ({period === 'day' ? 'Today' : period.charAt(0).toUpperCase() + period.slice(1)} • Filtered)
        </div>
        <table className="hrTable">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Role</th>
              <th>Shift</th>
              <th>Clock-in</th>
              <th>Worked</th>
              <th>Final Total</th>
              <th>Late</th>
              <th>OT</th>
              <th>Status</th>
              <th>Live</th>
              <th>Break</th>
              <th>Presence</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td className="tdName">{r.name}</td>
                <td>{r.role}</td>
                <td>
                  {fmtHHMM(r.shiftStart)} - {fmtHHMM(r._shiftEnd)}
                </td>
                <td>{fmtTime(r.clockIn)}</td>

                {/* Emphasize hours for chosen period */}
                <td>
                  <b>{minutesToHHMM(rowWorkedForPeriod(r))}</b>
                </td>

                {/* ✅ after clocked out show "final" total; otherwise show dash */}
                <td>{r._clockedOut ? <b>{minutesToHHMM(r._finalWorkedMins)}</b> : '—'}</td>

                <td>{minutesToHHMM(rowLateForPeriod(r))}</td>
                <td>{minutesToHHMM(rowOTForPeriod(r))}</td>

                <td>
                  <span className={`pill ${r._bucket}`}>{statusLabel(r._bucket)}</span>
                </td>
                <td>{isAgentLive(r) ? 'Yes' : 'No'}</td>
                <td>{isAgentOnBreak(r) ? 'Yes' : 'No'}</td>
                <td>{r.presence}</td>
              </tr>
            ))}

            {filtered.length === 0 && (
              <tr>
                <td colSpan={12} className="hrNoRows">
                  No results.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* footer note (important!) */}
        <div className="hrFootNote" style={{ marginTop: 10, opacity: 0.8 }}>
          Note: Week/Month/Year are <b>projected</b> from today’s data. To make them accurate, you’ll need historical time logs per agent.
        </div>
      </div>
    </div>
  )
}

export default HoursPage