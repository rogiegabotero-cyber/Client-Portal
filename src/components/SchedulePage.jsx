import React, { useMemo } from 'react'
import './schedule.css'
import { GRACE_MINUTES, NO_SHOW_MINUTES, createInitialEmployees } from '../data/dummyData.js'

/* ---------- Time helpers ---------- */
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number)
  return h * 60 + m
}

const fmtFromMinutes = (mins) => {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const getNowInTZ = (tz) => {
  // Returns current weekday + minutes in that timezone
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit'
    })

    const parts = dtf.formatToParts(new Date())
    const get = (t) => parts.find((p) => p.type === t)?.value

    const weekday = get('weekday')
    const hour = Number(get('hour'))
    const minute = Number(get('minute'))

    return { weekday, minutes: hour * 60 + minute }
  } catch {
    const d = new Date()
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' })
    return { weekday, minutes: d.getHours() * 60 + d.getMinutes() }
  }
}

const weekdayLong = (s) =>
  ({
    Mon: 'Monday',
    Tue: 'Tuesday',
    Wed: 'Wednesday',
    Thu: 'Thursday',
    Fri: 'Friday',
    Sat: 'Saturday',
    Sun: 'Sunday'
  }[s] || s)

const formatScheduledDays = (days) => {
  if (!Array.isArray(days) || days.length === 0) return '—'
  const joined = days.join(',')
  if (joined === 'Mon,Tue,Wed,Thu,Fri') return 'Monday–Friday'
  if (joined === 'Sat,Sun') return 'Saturday–Sunday'
  return days.map(weekdayLong).join(', ')
}

/* ---------- Trending attendance/shift logic ---------- */
/**
 * Modern dashboards usually compute:
 * - Scheduled? (based on weekday + tz)
 * - Shift window (start/end)
 * - Punch state (clockIn/clockOut)
 * - Overlays (break/live)
 */
const getShiftStatus = (e) => {
  // hard overrides
  if (e.presence === 'pto') return { label: 'On PTO', tone: 'pto' }
  if (e.presence === 'sick') return { label: 'Sick / Emergency Leave', tone: 'sick' }
  if (!e.schedule) return { label: 'Off', tone: 'off' }

  const { timezone, days, start, end } = e.schedule
  const { weekday, minutes: now } = getNowInTZ(timezone)

  const scheduledToday = Array.isArray(days) && days.includes(weekday)
  if (!scheduledToday) return { label: 'Off', tone: 'off' }

  const startM = toMinutes(start)
  const endM = toMinutes(end)

  const hasIn = !!e.clockIn
  const hasOut = !!e.clockOut

  // ended shift (clocked out)
  if (hasIn && hasOut) return { label: 'Shift Ended', tone: 'off' }

  // before shift
  if (now < startM) return { label: 'Upcoming', tone: 'clockedout' }

  // during shift window
  if (now >= startM && now <= endM) {
    // clocked in
    if (hasIn) {
      // break overlay
      if (e.onBreak) return { label: 'On Break', tone: 'break' }

      // late check (compare clock-in time to start + grace)
      const clockInM =
        e.clockIn instanceof Date
          ? e.clockIn.getHours() * 60 + e.clockIn.getMinutes()
          : null

      if (clockInM != null && clockInM > startM + GRACE_MINUTES) {
        return { label: 'On Shift (Late)', tone: 'late' }
      }

      return { label: 'On Shift', tone: 'onShift' }
    }

    // not clocked in yet
    if (now <= startM + GRACE_MINUTES) return { label: 'Scheduled', tone: 'clockedout' }
    if (now >= startM + NO_SHOW_MINUTES) return { label: 'No-show', tone: 'absent' }
    return { label: 'Late (No clock-in)', tone: 'late' }
  }

  // after scheduled end
  if (now > endM) {
    if (hasIn) return { label: 'Overtime', tone: 'onShift' }
    return { label: 'Missed Shift', tone: 'absent' }
  }

  return { label: 'Off', tone: 'off' }
}

const statusClass = (tone) => {
  // Uses your existing CSS classes when possible:
  // onShift, absent, pto, sick, clockedout, off
  // plus adds "late" and "break" (if not styled, it will still render)
  switch (tone) {
    case 'onShift':
      return 'onShift'
    case 'absent':
      return 'absent'
    case 'pto':
      return 'pto'
    case 'sick':
      return 'sick'
    case 'clockedout':
      return 'clockedout'
    case 'late':
      return 'late'
    case 'break':
      return 'break'
    default:
      return 'off'
  }
}

const SchedulePage = ({ employees }) => {
  // ✅ fallback: if no prop passed, use dummy data
  const data = employees?.length ? employees : createInitialEmployees()

  const rows = useMemo(() => {
    return data.map((e) => {
      const status = getShiftStatus(e)

      return {
        ...e,
        _statusLabel: status.label,
        _statusTone: status.tone,
        _scheduledDays: formatScheduledDays(e.schedule?.days)
      }
    })
  }, [data])

  return (
    <div className="scPage">
      <div className="scHeader">
        <div>
          <div className="scTitle">Schedule</div>
          <div className="scSub">Modern shift + attendance view (timezone-aware)</div>
        </div>
      </div>

      <div className="scTableWrap">
        <div className="scTableHead">All Agents Schedule</div>

        <table className="scTable">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Role</th>
              <th>Scheduled Days</th>
              <th>Shift</th>
              <th>Status</th>
              <th>Live</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((e) => {
              const shiftLabel = e.schedule
                ? `${fmtFromMinutes(toMinutes(e.schedule.start))} - ${fmtFromMinutes(
                    toMinutes(e.schedule.end)
                  )}`
                : '—'

              return (
                <tr key={e.id}>
                  <td className="tdName">{e.name}</td>
                  <td>{e.role}</td>
                  <td>{e._scheduledDays}</td>
                  <td>{shiftLabel}</td>
                  <td>
                    <span className={`pill ${statusClass(e._statusTone)}`}>
                      {e._statusLabel}
                    </span>
                  </td>
                  <td>{e.isLive ? '🟢' : '⚪️'}</td>
                </tr>
              )
            })}

            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="scEmpty">
                  No agents found.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Optional hint if you want to add CSS */}
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
          Tip: Add CSS for <code>.pill.late</code> and <code>.pill.break</code> if you want custom colors.
        </div>
      </div>
    </div>
  )
}

export default SchedulePage