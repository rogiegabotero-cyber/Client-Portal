import React, { useMemo, useState } from 'react'
import './dashboard.css'

const ClockIn = ({ employees, setEmployees }) => {
  const [selectedId, setSelectedId] = useState(employees?.[0]?.id || '')
  const [absentReason, setAbsentReason] = useState('')

  const selected = useMemo(() => employees.find((e) => e.id === selectedId), [employees, selectedId])

  const updateEmp = (id, patch) => {
    setEmployees((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }

  const handleClockIn = () => {
    if (!selected) return
    updateEmp(selected.id, {
      presence: 'present',
      absentReason: '',
      isLive: true,
      onBreak: false,
      clockIn: new Date()
    })
  }

  const handleGoOffline = () => {
    if (!selected) return
    updateEmp(selected.id, {
      // still present, but not live
      presence: 'present',
      absentReason: '',
      isLive: false,
      onBreak: false
    })
  }

  const handleMarkAbsent = () => {
    if (!selected) return
    updateEmp(selected.id, {
      presence: 'absent',
      absentReason: absentReason.trim() || 'No reason provided',
      isLive: false,
      onBreak: false,
      clockIn: null
    })
  }

  const handleMarkPresent = () => {
    if (!selected) return
    // IMPORTANT: when switching from absent -> present, keep them offline and not on break
    updateEmp(selected.id, {
      presence: 'present',
      absentReason: '',
      isLive: false,
      onBreak: false,
      clockIn: null
    })
  }

  const handleToggleBreak = () => {
    if (!selected) return
    if (selected.presence === 'absent') return
    if (!selected.isLive) return
    updateEmp(selected.id, { onBreak: !selected.onBreak })
  }

  const liveLabel = selected?.presence !== 'absent' && selected?.isLive ? 'Yes' : 'No'
  const breakLabel = selected?.presence !== 'absent' && selected?.isLive && selected?.onBreak ? 'Yes' : 'No'

  return (
    <div className="dash">
      <div className="dash-top">
        <div>
          <h1 className="dash-title">Clock In</h1>
          <p className="dash-subtitle">Set Live status, mark absent/present, and toggle break.</p>
        </div>
      </div>

      <div className="dash-table-card">
        <div className="dash-table-header" style={{ alignItems: 'center' }}>
          <h2 className="dash-table-title">Employee Controls</h2>
        </div>

        <div style={{ padding: '18px', display: 'grid', gap: '14px' }}>
          <div style={{ display: 'grid', gap: '8px' }}>
            <div style={{ fontWeight: 800, color: '#0f172a' }}>Select Employee</div>
            <select className="status-filter" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.id})
                </option>
              ))}
            </select>
          </div>

          {selected && (
            <>
              <div
                style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 14,
                  padding: 14,
                  display: 'grid',
                  gap: 6
                }}
              >
                <div style={{ fontWeight: 900, color: '#0f172a' }}>
                  {selected.name} • {selected.role}
                </div>
                <div style={{ color: '#64748b', fontSize: 13 }}>
                  Presence: <b>{selected.presence}</b> • Live: <b>{liveLabel}</b> • Break: <b>{breakLabel}</b>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button className="tf-btn tf-primary" onClick={handleClockIn}>
                  Clock In (Live)
                </button>

                <button className="tf-btn tf-ghost" onClick={handleGoOffline}>
                  Go Offline
                </button>

                <button
                  className="tf-btn tf-break"
                  onClick={handleToggleBreak}
                  disabled={selected.presence === 'absent' || !selected.isLive}
                  title={
                    selected.presence === 'absent' || !selected.isLive
                      ? 'You must be Live and Present to go on break.'
                      : 'Toggle break'
                  }
                >
                  {selected.onBreak ? 'End Break' : 'Start Break'}
                </button>

                <button className="tf-btn tf-danger" onClick={handleMarkAbsent}>
                  Mark Absent
                </button>

                <button className="tf-btn tf-ghost" onClick={handleMarkPresent}>
                  Mark Present
                </button>
              </div>

              <div style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
                <div style={{ fontWeight: 800, color: '#0f172a' }}>Absent Reason</div>
                <input
                  className="tf-input"
                  value={absentReason}
                  onChange={(e) => setAbsentReason(e.target.value)}
                  placeholder="e.g. Sick leave / PTO / Emergency"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default ClockIn