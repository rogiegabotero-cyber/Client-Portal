import React, { useMemo, useState } from 'react'
import './assignment.css'

const normalize = (s) => (s || '').toLowerCase().trim()
const isAgentLive = (e) => e.presence !== 'absent' && e.isLive === true
const isAgentOnBreak = (e) => isAgentLive(e) && e.onBreak === true

const AssignmentPage = ({ employees = [] }) => {
  const [q, setQ] = useState('')

  const { assigned, unassigned } = useMemo(() => {
    const a = []
    const u = []
    for (const e of employees) {
      const hasAssignment = !!(e.assignedTo && e.assignedTo.trim())
      if (hasAssignment) a.push(e)
      else u.push(e)
    }
    return { assigned: a, unassigned: u }
  }, [employees])

  const filtered = useMemo(() => {
    const query = normalize(q)
    if (!query) return employees
    return employees.filter((e) => {
      return (
        normalize(e.name).includes(query) ||
        normalize(e.role).includes(query) ||
        normalize(e.assignedTo).includes(query)
      )
    })
  }, [employees, q])

  const topAssignments = useMemo(() => {
    const map = new Map()
    for (const e of employees) {
      const key = (e.assignedTo || '').trim()
      if (!key) continue
      map.set(key, (map.get(key) || 0) + 1)
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
  }, [employees])

  return (
    <div className="asPage">
      <div className="asHeader">
        <div>
          <div className="asTitle">Assignment</div>
          <div className="asSub">View each agent’s current assigned task / queue</div>
        </div>

        <div className="asSearchWrap">
          <input
            className="asSearch"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search agent, role, assignment..."
          />
        </div>
      </div>

      <div className="asSummary">
        <div className="asCard">
          <div className="asCardLabel">Total Agents</div>
          <div className="asCardValue">{employees.length}</div>
          <div className="asCardHint">All tracked agents</div>
        </div>
        <div className="asCard">
          <div className="asCardLabel">Assigned</div>
          <div className="asCardValue">{assigned.length}</div>
          <div className="asCardHint">Has an active assignment</div>
        </div>
        <div className="asCard">
          <div className="asCardLabel">Unassigned</div>
          <div className="asCardValue">{unassigned.length}</div>
          <div className="asCardHint">No assignment set</div>
        </div>
      </div>

      <div className="asGrid">
        <section className="asPanel">
          <div className="asPanelHead">
            Assigned <span className="count">{assigned.length}</span>
          </div>
          <div className="asPanelBody">
            {assigned.map((e) => (
              <div key={e.id} className="asRow">
                <div className="asAvatar">{e.name?.[0] || '?'}</div>
                <div className="asRowMain">
                  <div className="asRowName">{e.name}</div>
                  <div className="asRowMeta">{e.role}</div>
                  <div className="asRowAssign">{e.assignedTo}</div>
                </div>
                <div className="asRowRight">
                  <span className={`asPill ${isAgentLive(e) ? 'live' : 'off'}`}>{isAgentLive(e) ? 'Live' : 'Offline'}</span>
                  {isAgentOnBreak(e) && <span className="asPill break">Break</span>}
                </div>
              </div>
            ))}
            {assigned.length === 0 && <div className="asEmpty">No assigned agents.</div>}
          </div>
        </section>

        <section className="asPanel">
          <div className="asPanelHead">
            Unassigned <span className="count">{unassigned.length}</span>
          </div>
          <div className="asPanelBody">
            {unassigned.map((e) => (
              <div key={e.id} className="asRow">
                <div className="asAvatar">{e.name?.[0] || '?'}</div>
                <div className="asRowMain">
                  <div className="asRowName">{e.name}</div>
                  <div className="asRowMeta">{e.role}</div>
                  <div className="asRowAssign muted">No assignment</div>
                </div>
                <div className="asRowRight">
                  <span className={`asPill ${isAgentLive(e) ? 'live' : 'off'}`}>{isAgentLive(e) ? 'Live' : 'Offline'}</span>
                  {isAgentOnBreak(e) && <span className="asPill break">Break</span>}
                </div>
              </div>
            ))}
            {unassigned.length === 0 && <div className="asEmpty">No unassigned agents.</div>}
          </div>
        </section>
      </div>

      <div className="asTop">
        <div className="asTopHead">Top Assignments</div>
        <div className="asTopChips">
          {topAssignments.length === 0 ? (
            <div className="asMuted">No assignments found.</div>
          ) : (
            topAssignments.map(([label, count]) => (
              <div key={label} className="asChip" title={label}>
                <div className="asChipLabel">{label}</div>
                <div className="asChipCount">{count}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="asTableWrap">
        <div className="asTableHead">All Agents (Filtered)</div>
        <table className="asTable">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Role</th>
              <th>Assignment</th>
              <th>Live</th>
              <th>Break</th>
              <th>Presence</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id}>
                <td className="tdName">{e.name}</td>
                <td>{e.role}</td>
                <td>{e.assignedTo || '—'}</td>
                <td>{isAgentLive(e) ? 'Yes' : 'No'}</td>
                <td>{isAgentOnBreak(e) ? 'Yes' : 'No'}</td>
                <td>{e.presence}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="asNoRows">
                  No results.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default AssignmentPage