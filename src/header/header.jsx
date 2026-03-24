import React, { useState, useRef, useEffect, useMemo } from 'react'
import './header.css'
import { Bell } from 'lucide-react'

const Header = () => {
  const [notifOpen, setNotifOpen] = useState(false)
  const notifRef = useRef(null)

  // Replace uiData with a safe local notifications list
  // Later you can fetch/receive this via props if needed.
  const notifications = useMemo(() => {
    return [] // no notifications for now
  }, [])

  const hasNotifications = notifications.length > 0

  // Close panel if clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notifRef.current && !notifRef.current.contains(event.target)) {
        setNotifOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  return (
    <header className="top-header">
      <div className="header-right">
        <div className="notif-wrapper" ref={notifRef}>
          <button
            type="button"
            className={`icon-btn ${notifOpen ? 'active' : ''}`}
            onClick={() => setNotifOpen((prev) => !prev)}
            aria-label="Open notifications"
            aria-expanded={notifOpen}
          >
            <Bell size={20} />
            {hasNotifications && <span className="badge" />}
          </button>

          {notifOpen && (
            <div className="notif-panel">
              <div className="notif-header">Notifications</div>

              <div className="notif-list">
                {notifications.length === 0 ? (
                  <div className="notif-item">
                    <p>No notifications available</p>
                  </div>
                ) : (
                  notifications.map((notif, index) => (
                    <div className="notif-item" key={index}>
                      <b>{notif?.title ?? 'Notification'}</b>
                      <p>{notif?.message ?? ''}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

export default Header