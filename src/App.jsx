import { useEffect, useState } from 'react'
import Header from './header/header'
import Sidebar from './header/Sidebar'
import Dashboard from './components/dashboard'
import ClockIn from './components/ClockIn'
import AttendancePage from './components/AttendancePage'
import AssignmentPage from './components/AssignmentPage'
import SchedulePage from './components/SchedulePage'
import HoursPage from './components/HoursPage'
import './App.css'

import { GRACE_MINUTES, createInitialEmployees } from './data/dummyData'
import { createHyacinthAttendanceApi } from './api/hyacinthAttendanceApi'
import { mapHyacinthDataToEmployees } from './lib/hyacinthTransformers'

const toArray = (value) => {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.users)) return value.users
  if (Array.isArray(value?.results)) return value.results
  return []
}

function App() {
  const [collapsed, setCollapsed] = useState(false)
  const [activePage, setActivePage] = useState('dashboard')

  // ✅ SINGLE SOURCE OF TRUTH
  const [employees, setEmployees] = useState(() => createInitialEmployees())

  useEffect(() => {
    const apiKey = import.meta.env.VITE_HYACINTH_API_KEY
    const departmentId = import.meta.env.VITE_HYACINTH_DEPARTMENT_ID

    if (!apiKey || !departmentId) {
      return
    }

    const api = createHyacinthAttendanceApi({ apiKey })
    let cancelled = false

    const loadEmployees = async () => {
      try {
        const usersResponse = await api.getUsersByDepartment(departmentId)
        const users = toArray(usersResponse)

        if (users.length === 0) {
          return
        }

        const schedules = await Promise.allSettled(
          users.map(async (user) => {
            const userId = user?.userId || user?.id || user?.uid || user?.employeeId
            if (!userId) return null

            const schedule = await api.getUserSchedule(userId)
            return { userId, schedule }
          })
        )

        const today = new Date().toISOString().slice(0, 10)
        const attendanceLogsResponse = await api.getAttendanceLogs({ startDate: today, endDate: today })
        const attendanceLogs = toArray(attendanceLogsResponse)

        const schedulesByUserId = schedules
          .filter((result) => result.status === 'fulfilled' && result.value)
          .reduce((acc, result) => {
            acc[result.value.userId] = result.value.schedule
            return acc
          }, {})

        const logsByUserId = Array.isArray(attendanceLogs)
          ? attendanceLogs.reduce((acc, log) => {
              const logUserId = log?.userId || log?.id || log?.uid || log?.employeeId
              if (logUserId) acc[logUserId] = log
              return acc
            }, {})
          : {}

        const mappedEmployees = mapHyacinthDataToEmployees({
          users,
          schedulesByUserId,
          logsByUserId
        })

        if (!cancelled && mappedEmployees.length > 0) {
          setEmployees(mappedEmployees)
        }
      } catch (error) {
        console.error('Failed to load Hyacinth Attendance API data:', error)
      }
    }

    loadEmployees()

    return () => {
      cancelled = true
    }
  }, [])

  const renderPage = () => {
    switch (activePage) {
      case 'dashboard':
        return <Dashboard employees={employees} graceMinutes={GRACE_MINUTES} />
      case 'clockin':
        return <ClockIn employees={employees} setEmployees={setEmployees} />
      case 'attendance':
        return <AttendancePage employees={employees} graceMinutes={GRACE_MINUTES} />
      case 'assignment':
        return <AssignmentPage employees={employees} />
      case 'schedule':
        return <SchedulePage employees={employees} />
      case 'hours':
        return <HoursPage employees={employees} graceMinutes={GRACE_MINUTES} />
      default:
        return <Dashboard employees={employees} graceMinutes={GRACE_MINUTES} />
    }
  }

  return (
    <div className={`app-layout ${collapsed ? 'collapsed' : ''}`}>
      <Sidebar
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        activePage={activePage}
        setActivePage={setActivePage}
        employees={employees} // ✅ sidebar must derive live agents from employees
      />

      <div className="app-content">
        <Header collapsed={collapsed} />
        <main className="main-content">{renderPage()}</main>
      </div>
    </div>
  )
}

export default App
