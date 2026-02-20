const normalizeArray = (value) => (Array.isArray(value) ? value : [])

const getFirstDefined = (...values) => values.find((value) => value !== undefined && value !== null)

const toClockInDate = (value) => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const getShiftStart = (schedule = {}) => {
  const start = getFirstDefined(schedule.start, schedule.startTime, schedule.shiftStart)
  return typeof start === 'string' ? start : '09:00'
}

const getEmployeePresence = (employee, hasClockIn) => {
  const rawStatus = String(getFirstDefined(employee.presence, employee.status, employee.attendanceStatus, '')).toLowerCase()

  if (rawStatus.includes('pto')) return 'pto'
  if (rawStatus.includes('sick')) return 'sick'
  if (rawStatus.includes('absent')) return 'absent'

  return hasClockIn ? 'present' : 'Clocked Out'
}

const getScheduleDays = (schedule = {}) => {
  const days = normalizeArray(getFirstDefined(schedule.days, schedule.workDays))
  if (days.length > 0) return days
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
}

const mapToEmployee = (user, schedule = {}, log = {}) => {
  const id = String(getFirstDefined(user.id, user.userId, user.uid, user.employeeId, ''))
  const name = String(getFirstDefined(user.name, user.displayName, user.fullName, id || 'Unknown Employee'))
  const role = String(getFirstDefined(user.role, user.position, user.departmentName, 'Employee'))
  const assignedTo = String(getFirstDefined(user.assignedTo, user.assignment, user.team, 'Unassigned'))
  const absentReason = String(getFirstDefined(user.absentReason, user.leaveReason, log.absentReason, ''))

  const rawClockIn = getFirstDefined(log.clockIn, log.clockInTime, log.firstClockIn, user.clockIn)
  const clockIn = toClockInDate(rawClockIn)
  const presence = getEmployeePresence(user, !!clockIn)

  return {
    id,
    name,
    role,
    assignedTo,
    absentReason,
    isLive: presence === 'present',
    onBreak: Boolean(getFirstDefined(user.onBreak, log.onBreak, false)),
    presence,
    shiftStart: getShiftStart(schedule),
    clockIn,
    schedule: {
      timezone: String(getFirstDefined(schedule.timezone, schedule.tz, 'America/New_York')),
      days: getScheduleDays(schedule),
      start: getShiftStart(schedule),
      end: String(getFirstDefined(schedule.end, schedule.endTime, schedule.shiftEnd, '18:00'))
    }
  }
}

const findByUserId = (items, userId) => {
  const id = String(userId)
  return normalizeArray(items).find((item) => String(getFirstDefined(item.userId, item.id, item.uid, item.employeeId)) === id)
}

export const mapHyacinthDataToEmployees = ({ users = [], schedulesByUserId = {}, logsByUserId = {} } = {}) => {
  return normalizeArray(users)
    .map((user) => {
      const userId = getFirstDefined(user.userId, user.id, user.uid, user.employeeId)
      const schedule = schedulesByUserId[userId] || findByUserId(schedulesByUserId.items, userId) || {}
      const log = logsByUserId[userId] || findByUserId(logsByUserId.items, userId) || {}
      return mapToEmployee(user, schedule, log)
    })
    .filter((employee) => employee.id)
}
