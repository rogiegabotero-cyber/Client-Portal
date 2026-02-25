// src/lib/hyacinthTransformers.js

const pick = (obj, keys, fallback = undefined) => {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return fallback
}

const asArray = (v) => {
  if (Array.isArray(v)) return v
  if (Array.isArray(v?.items)) return v.items
  if (Array.isArray(v?.users)) return v.users
  if (Array.isArray(v?.results)) return v.results
  return []
}

const normalizeName = (user) => {
  const full = pick(user, ['fullName', 'displayName', 'name'])
  if (full) return String(full)
  const first = pick(user, ['firstName', 'first_name', 'givenName'])
  const last = pick(user, ['lastName', 'last_name', 'familyName'])
  if (first || last) return `${first || ''} ${last || ''}`.trim()
  return pick(user, ['email', 'username'], 'Unknown')
}

const normalizeSchedule = (rawSchedule) => {
  if (!rawSchedule) return null

  const s = rawSchedule?.schedule || rawSchedule

  const days = pick(s, ['days', 'workDays', 'work_days'], [])
  const start = pick(s, ['start', 'startTime', 'start_time'])
  const end = pick(s, ['end', 'endTime', 'end_time'])
  const timezone = pick(s, ['timezone', 'timeZone', 'tz'], 'Asia/Manila')

  const normalizedDays = Array.isArray(days)
    ? days
        .map((d) => {
          if (typeof d === 'number') return d > 6 ? d - 1 : d
          const dd = String(d).toLowerCase()
          const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
          return map[dd.slice(0, 3)]
        })
        .filter((n) => Number.isFinite(n))
    : []

  return {
    days: normalizedDays,
    start: start ? String(start) : '',
    end: end ? String(end) : '',
    timezone,
  }
}

const normalizeLog = (rawLog) => {
  if (!rawLog) return null
  const clockIn = pick(rawLog, ['clockIn', 'timeIn', 'in', 'clock_in', 'start'])
  const clockOut = pick(rawLog, ['clockOut', 'timeOut', 'out', 'clock_out', 'end'])
  const status = pick(rawLog, ['presence', 'status'], null)
  const absentReason = pick(rawLog, ['absentReason', 'reason', 'note'], '')

  return {
    clockIn: clockIn ? String(clockIn) : '',
    clockOut: clockOut ? String(clockOut) : '',
    status: status ? String(status).toLowerCase() : null,
    absentReason: absentReason ? String(absentReason) : '',
  }
}

export function mapHyacinthDataToEmployees({ users, schedulesByUserId = {}, logsByUserId = {} }) {
  const list = asArray(users)

  return list
    .map((user) => {
      const id = pick(user, ['userId', 'id', 'uid', 'employeeId'])
      if (!id) return null

      const name = normalizeName(user)
      const email = pick(user, ['email'], '')
      const department = pick(user, ['department', 'departmentName', 'dept'], '')
      const role = pick(user, ['role', 'title', 'position'], '')
      const avatar = pick(user, ['avatar', 'photoUrl', 'photoURL', 'profilePhoto'], '')

      const rawSchedule = schedulesByUserId[String(id)] || null
      const schedule = normalizeSchedule(rawSchedule)

      const rawLog = logsByUserId[String(id)] || null
      const log = normalizeLog(rawLog)

      const presence =
        log?.status === 'absent' || log?.status === 'pto' || log?.status === 'leave'
          ? log.status
          : log?.clockIn
            ? 'present'
            : 'absent'

      return {
        id: String(id),
        name,
        email,
        department,
        role,
        avatar,
        timezone: schedule?.timezone || 'Asia/Manila',

        schedule,
        clockIn: log?.clockIn || '',
        clockOut: log?.clockOut || '',
        presence,
        absentReason: log?.absentReason || '',
        isLive: presence !== 'absent' && !!log?.clockIn,

        _rawUser: user,
        _rawSchedule: rawSchedule,
        _rawLog: rawLog,
      }
    })
    .filter(Boolean)
}