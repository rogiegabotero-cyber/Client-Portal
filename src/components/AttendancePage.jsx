import React, { useMemo } from 'react'
import './attendance.css'

// ✅ same dummyData source as SchedulePage
import { GRACE_MINUTES, createInitialEmployees } from '../data/dummyData.js'

/**
 * AttendancePage.jsx (COPY-PASTE)
 *
 * Rules:
 * - Uses each employee.schedule (days/start/end/timezone) if available
 * - Status priority:
 *   1) On PTO
 *   2) Sick / Emergency Leave
 *   3) Off (not scheduled today)
 *   4) Later Today (before shift start OR within absent window)
 *   5) Absent (no clock-in after ABSENT_AFTER minutes from start)
 *   6) If clocked-in:
 *        - In Early
 *        - On Time
 *        - In Late
 */

/** ---------- constants ---------- */
const DEFAULT_TZ = 'America/New_York'
const DEFAULT_START = '08:00'
const DEFAULT_END = '18:00'

const ONTIME_GRACE = 5 // minutes after shift start
const LATE_THRESHOLD = 15 // minutes after shift start for note
const ABSENT_AFTER = 60 // minutes after shift start => absent

/** ---------- helpers ---------- */
const asDate = (v) => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

const formatTime = (v) => {
  const d = asDate(v)
  if (!d) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number)
  return h * 60 + m
}

const getNowInTZ = (tz) => {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })

  const parts = dtf.formatToParts(new Date())
  const get = (t) => parts.find((p) => p.type === t)?.value

  const weekday = get('weekday') // Mon, Tue, ...
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))

  return { weekday, minutes: hour * 60 + minute }
}

const getClockInMinutesLocal = (clockIn) => {
  const d = asDate(clockIn)
  if (!d) return null
  return d.getHours() * 60 + d.getMinutes()
}

/** Live/Break helpers */
const isAgentLive = (e) => e.presence !== 'absent' && e.isLive === true
const isAgentOnBreak = (e) => isAgentLive(e) && e.onBreak === true

/**
 * ✅ Schedule-aware status engine (modern)
 * Uses each employee.schedule if present (days/start/end/timezone).
 */
const getAttendanceStatus = (e) => {
  // 1) PTO
  if (e.presence === 'pto') return 'On PTO'

  // 2) Sick/Emergency
  if (e.presence === 'sick') return 'Sick / Emergency Leave'

  const sched = e.schedule || {}
  const tz = sched.timezone || DEFAULT_TZ
  const days = Array.isArray(sched.days) ? sched.days : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
  const startStr = sched.start || DEFAULT_START
  const endStr = sched.end || DEFAULT_END

  const startM = toMinutes(startStr)
  const endM = toMinutes(endStr)

  const { weekday, minutes: now } = getNowInTZ(tz)
  const clockInMins = getClockInMinutesLocal(e.clockIn)

  // 3) Off (not scheduled today)
  if (!days.includes(weekday)) return 'Off'

  // Before shift start
  if (now < startM) return 'Later Today'

  // During shift window
  if (now >= startM && now <= endM) {
    if (clockInMins == null) {
      // Absent after threshold (default 60 mins)
      if (now >= startM + ABSENT_AFTER) return 'Absent'

      // still within grace/late window
      return 'Later Today'
    }

    // has clock-in
    if (clockInMins < startM) return 'In Early'

    const delta = clockInMins - startM
    if (delta <= ONTIME_GRACE) return 'On Time'
    return 'In Late'
  }

  // After shift end
  if (now > endM) {
    // If no clock-in at all, mark as missed/absent
    if (clockInMins == null) return 'Absent'
    return 'Off'
  }

  return 'Off'
}

const statusPillClass = (status) => {
  switch (status) {
    case 'In Early':
      return 'early'
    case 'On Time':
      return 'ontime'
    case 'In Late':
      return 'late'
    case 'Absent':
      return 'absent'
    case 'Off':
      return 'off'
    case 'On PTO':
      return 'pto'
    case 'Sick / Emergency Leave':
      return 'sick'
    default:
      return 'later'
  }
}

/** ---------- UI panels ---------- */
const PANELS = [
  { key: 'In Early', title: 'In Early', dotClass: 'early', hint: 'Clocked in before shift start', emptyText: 'No early clock-ins.' },
  { key: 'On Time', title: 'On Time', dotClass: 'ontime', hint: 'Clocked in on time', emptyText: 'No on-time clock-ins.' },
  { key: 'In Late', title: 'In Late', dotClass: 'late', hint: `Clocked in after start (grace=${GRACE_MINUTES}m)`, emptyText: 'No late clock-ins.' },
  { key: 'Later Today', title: 'Later Today', dotClass: 'later', hint: 'Before shift start or still within absent threshold', emptyText: 'No one is marked as later.' },
  { key: 'Absent', title: 'Absent', dotClass: 'absent', hint: 'No clock-in after absent threshold', emptyText: 'No absent agents.' },
  { key: 'Off', title: 'Off', dotClass: 'off', hint: 'Not scheduled today / shift ended', emptyText: 'No off agents.' },
  { key: 'On PTO', title: 'On PTO', dotClass: 'pto', hint: 'PTO listed', emptyText: 'No PTO agents.' },
  { key: 'Sick / Emergency Leave', title: 'Sick / Emergency Leave', dotClass: 'sick', hint: 'Sick/Emergency leave listed', emptyText: 'No sick/emergency leave agents.' }
]

/** ---------- component ---------- */
const AttendancePage = ({ employees }) => {
  // ✅ Use dummy employees automatically if none passed
  const data = employees?.length ? employees : createInitialEmployees()

  const derived = useMemo(() => {
    const rows = data.map((e) => {
      const status = getAttendanceStatus(e)

      const sched = e.schedule || {}
      const startM = toMinutes(sched.start || DEFAULT_START)

      const clockInMins = getClockInMinutesLocal(e.clockIn)
      const is15Late =
        status === 'In Late' && clockInMins != null && clockInMins - startM >= LATE_THRESHOLD

      return {
        ...e,
        _status: status,
        _note: is15Late ? '15+ mins late' : ''
      }
    })

    const buckets = rows.reduce((acc, r) => {
      ;(acc[r._status] ||= []).push(r)
      return acc
    }, {})

    return { rows, buckets }
  }, [data])

  return (
    <div className="attPage">
      <div className="attHeader">
        <div>
          <div className="attTitle">Attendance</div>
          <div className="attSub">
            Showing {data.length} agents • Schedule-aware (uses each agent’s schedule + timezone)
          </div>
        </div>
      </div>

      {/* SUMMARY */}
      <div className="attSummary">
        {PANELS.map((p) => {
          const count = (derived.buckets[p.key] || []).length
          return (
            <div key={p.key} className={`attCard ${p.dotClass}`}>
              <div className="attCardLabel">{p.title}</div>
              <div className="attCardValue">{count}</div>
              <div className="attCardHint">{p.hint}</div>
            </div>
          )
        })}
      </div>

      {/* PANELS */}
      <div className="attGrid">
        {PANELS.map((p) => {
          const list = derived.buckets[p.key] || []
          return (
            <section key={p.key} className="attPanel">
              <div className="attPanelHead">
                {p.title} <span className="count">{list.length}</span>
              </div>

              <div className="attPanelBody">
                {list.map((e) => (
                  <div key={e.id} className="attRow">
                    <span className={`dot ${p.dotClass}`} />
                    <div className="attRowMain">
                      <div className="attRowName">{e.name}</div>
                      <div className="attRowMeta">
                        {e.role} •{' '}
                        {isAgentOnBreak(e) ? 'On break' : isAgentLive(e) ? 'Live' : 'Offline'}
                        {e._note ? ` • ${e._note}` : ''}
                      </div>
                    </div>
                    <div className="attRowRight">{formatTime(e.clockIn)}</div>
                  </div>
                ))}

                {list.length === 0 && <div className="empty">{p.emptyText}</div>}
              </div>
            </section>
          )
        })}
      </div>

      {/* TABLE */}
      <div className="attTableWrap">
        <div className="attTableHead">All Agents</div>
        <table className="attTable">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Role</th>
              <th>Clock-in</th>
              <th>Status</th>
              <th>Live</th>
              <th>Break</th>
              <th>Presence</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {derived.rows.map((e) => (
              <tr key={e.id}>
                <td className="tdName">{e.name}</td>
                <td>{e.role}</td>
                <td>{formatTime(e.clockIn)}</td>
                <td>
                  <span className={`pill ${statusPillClass(e._status)}`}>{e._status}</span>
                </td>
                <td>{isAgentLive(e) ? 'Yes' : 'No'}</td>
                <td>{isAgentOnBreak(e) ? 'Yes' : 'No'}</td>
                <td>{e.presence || '—'}</td>
                <td className="tdNotes">
                  {e._note ||
                    (e._status === 'Absent' ? e.absentReason || '—' : isAgentLive(e) ? 'Live' : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default AttendancePage