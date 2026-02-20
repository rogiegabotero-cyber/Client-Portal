import React, { useMemo } from 'react'
import './dashboard.css'
import { dashboardData } from '../data/dummyData'

const clamp = (n, min, max) => Math.max(min, Math.min(max, n))

const toMinutes = (hhmm) => {
  const [h, m] = (hhmm || '00:00').split(':').map(Number)
  return h * 60 + m
}

const isAgentLive = (e) => e.presence !== 'absent' && e.isLive === true

const computeAttendance = (employees, graceMinutes) => {
  let absent = 0
  let present = 0
  let late = 0

  for (const e of employees) {
    if (e.presence === 'absent') {
      absent++
      continue
    }

    if (!e.clockIn) {
      // treat "present but no clock-in" as absent-like for dashboard rollup
      absent++
      continue
    }

    const shiftStartM = toMinutes(e.shiftStart || '09:00')
    const clockInM = e.clockIn.getHours() * 60 + e.clockIn.getMinutes()
    const isLate = clockInM > shiftStartM + graceMinutes

    if (isLate) late++
    else present++
  }

  return { absent, present, late }
}

const Donut = ({ value = 50, label = '', sub = '' }) => {
  const v = clamp(value, 0, 100)
  return (
    <div className="donutCard">
      <div className="donut" style={{ background: `conic-gradient(#f59e0b ${v}%, #a855f7 0)` }}>
        <div className="donutInner">
          <div className="donutValue">{value}</div>
        </div>
      </div>
      <div className="donutMeta">
        <div className="donutLabel">{label}</div>
        <div className="donutSub">{sub}</div>
      </div>
    </div>
  )
}

const MiniBars = ({ items = [] }) => {
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="miniBars">
      {items.map((i) => (
        <div className="miniBarRow" key={i.label}>
          <div className="miniBarLabel">{i.label}</div>
          <div className="miniBarTrack">
            <div className="miniBarFill" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
          <div className="miniBarValue">{i.value}</div>
        </div>
      ))}
    </div>
  )
}

const HeatmapTable = ({ data = [], cols = [] }) => {
  const flat = data.flatMap((row) => row.values)
  const max = Math.max(...flat, 1)

  const cellBg = (v) => {
    const t = v / max
    const alpha = 0.15 + t * 0.55
    return `rgba(56, 189, 248, ${alpha})`
  }

  return (
    <div className="heatWrap">
      <table className="heatTable">
        <thead>
          <tr>
            <th>Job Role</th>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
            <th>Grand Total</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const total = row.values.reduce((a, b) => a + b, 0)
            return (
              <tr key={row.role}>
                <td className="heatRole">{row.role}</td>
                {row.values.map((v, idx) => (
                  <td key={idx} style={{ background: cellBg(v) }}>
                    {v}
                  </td>
                ))}
                <td className="heatTotal">{total}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const PerformanceBars = ({ items = [] }) => {
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="perfBarsWrap">
      <div className="perfBars perfBarsFull">
        {items.map((i) => (
          <div className="perfBar perfBarFull" key={i.label} title={`${i.label}: ${i.value}`}>
            <div className="perfBarFill" style={{ height: `${(i.value / max) * 100}%` }} />
            <div className="perfBarTick">{i.value}</div>
            <div className="perfBarLabel">{i.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

const AttendancePie = ({ a = 0, b = 0, c = 0 }) => {
  const total = a + b + c || 1
  const pa = (a / total) * 100
  const pb = (b / total) * 100

  const bg = `conic-gradient(
    #ef4444 0 ${pa}%,
    #f59e0b ${pa}% ${pa + pb}%,
    #60a5fa ${pa + pb}% 100%
  )`

  return (
    <div className="attWrap">
      <div className="attPie" style={{ background: bg }}>
        <div className="attHole" />
      </div>

      <div className="attLegend">
        <div className="attLegendRow">
          <span className="dot red" /> <span>Absent</span>
          <span className="attNum">{a}</span>
        </div>
        <div className="attLegendRow">
          <span className="dot orange" /> <span>Present</span>
          <span className="attNum">{b}</span>
        </div>
        <div className="attLegendRow">
          <span className="dot blue" /> <span>Late</span>
          <span className="attNum">{c}</span>
        </div>
      </div>
    </div>
  )
}

const Dashboard = ({ employees = [], graceMinutes = 10 }) => {
  const liveAgents = useMemo(() => employees.filter(isAgentLive).length, [employees])
  const att = useMemo(() => computeAttendance(employees, graceMinutes), [employees, graceMinutes])

  return (
    <div className="dashX">
      <div className="topBar">
        <div className="kpi">
          <div className="kpiLabel">LIVE AGENTS</div>
          <div className="kpiValue">{liveAgents}</div>
        </div>
        <div className="kpi">
          <div className="kpiLabel">CLIENT ENGAGEMENT</div>
          <div className="kpiValue">{dashboardData.kpis.clientEngagement.toLocaleString()}</div>
        </div>
        <div className="kpi">
          <div className="kpiLabel">APPOINTMENT SET</div>
          <div className="kpiValue">{dashboardData.kpis.appointmentSet}</div>
        </div>
        <div className="kpi">
          <div className="kpiLabel">BILLABLE HOURS</div>
          <div className="kpiValue">{dashboardData.kpis.billableHours}</div>
        </div>
      </div>

      <div className="dashLayout">
        <div className="dashMain">
          <div className="grid gridNoUpdate">
            <section className="panel p-att">
              <div className="panelHead">ATTENDANCE</div>
              <div className="panelBody panelBodyFill">
                <AttendancePie a={att.absent} b={att.present} c={att.late} />
              </div>
            </section>

            <section className="panel p-perf">
              <div className="panelHead">PERFORMANCE</div>
              <div className="panelBody panelBodyFill">
                <PerformanceBars items={dashboardData.performance} />
              </div>
            </section>

            <section className="panel p-heat">
              <div className="panelHead">JOB SATISFACTION</div>
              <div className="panelBody panelBodyFill">
                <HeatmapTable data={dashboardData.heatData} cols={dashboardData.heatCols} />
              </div>
            </section>

            <section className="panel p-mini">
              <div className="panelHead">&nbsp;</div>
              <div className="panelBody panelBodyFill">
                <MiniBars items={dashboardData.mini} />
              </div>
            </section>

            <section className="panel p-stats">
              <div className="panelHead center">AGENT STATS</div>
              <div className="panelBody panelBodyFill">
                <div className="donutRow">
                  {dashboardData.agentStats.map((a) => (
                    <Donut key={a.name} value={a.value} label={a.name} sub={a.sub} />
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>

        <aside className="updateSidebar">
          <div className="panelHead">UPDATE</div>
          <div className="panelBody updateBody">
            <div className="updateBox">
              {dashboardData.updates.map((item) => (
                <div key={item} className="updateItem">
                  {item}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default Dashboard