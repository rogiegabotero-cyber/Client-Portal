import { useState } from 'react'
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

function App() {
  const [collapsed, setCollapsed] = useState(false)
  const [activePage, setActivePage] = useState('dashboard')

  // ✅ SINGLE SOURCE OF TRUTH
  const [employees, setEmployees] = useState(() => createInitialEmployees())

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