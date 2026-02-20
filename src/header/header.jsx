import React, { useState, useRef, useEffect, useMemo } from 'react'
import './header.css'
import { Bell } from 'lucide-react'
import { uiData } from '../data/dummyData'

const Header = () => {
  const [notifOpen, setNotifOpen] = useState(false)
  const notifRef = useRef(null)

  // Defensive: prevents runtime crashes if uiData/notifications isn't available for any reason
  const notifications = useMemo(() => {
    if (!uiData) return []
    if (!uiData.notifications) return []
    if (!Array.isArray(uiData.notifications)) return []
    return uiData.notifications
  }, [])

  const hasNotifications = notifications.length > 0

  // Close panel if clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) {
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