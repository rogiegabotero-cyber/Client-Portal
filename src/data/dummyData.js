export const GRACE_MINUTES = 10
export const DUMMY_SHIFT_HOURS = 9

export const NO_SHOW_MINUTES = 30
export const NO_EMPLOYEES_TEXT = 'No employees found. Please add employees to display data.'

const todayAt = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

export const createInitialEmployees = () => [
  {
    id: 'E-001',
    name: 'YUME',
    role: 'Customer Support',
    isLive: true,
    onBreak: false,
    presence: 'present',
    shiftStart: '09:00',
    clockIn: todayAt('09:04'),
    assignedTo: 'Tickets: Billing Queue',
    absentReason: ''
  },
  {
    id: 'E-002',
    name: 'VELLE',
    role: 'Operations',
    isLive: true,
    onBreak: false,
    presence: 'present',
    shiftStart: '09:00',
    clockIn: todayAt('09:00'),
    assignedTo: 'Inventory Audit',
    absentReason: ''
  },
  {
    id: 'E-003',
    name: 'CLARICE',
    role: 'QA',
    isLive: false,
    onBreak: false,
    presence: 'Clocked Out',
    shiftStart: '09:00',
    clockIn: todayAt('09:01'),
    assignedTo: 'Regression Suite',
    absentReason: ''
  },
  {
    id: 'E-004',
    name: 'EDSIE',
    role: 'Engineer',
    isLive: false,
    onBreak: false,
    presence: 'Clocked Out',
    shiftStart: '10:00',
    clockIn: todayAt('08:50'),
    assignedTo: 'Bugfix: Task Board',
    absentReason: ''
  },
  {
    id: 'E-005',
    name: 'LYNDER',
    role: 'Customer Support',
    isLive: false,
    onBreak: false,
    presence: 'present',
    shiftStart: '11:00',
    clockIn: null,
    assignedTo: 'Tickets: General Queue',
    absentReason: ''
  },
  {
    id: 'E-006',
    name: 'KIM',
    role: 'Sales',
    isLive: true,
    onBreak: true,
    presence: 'present',
    shiftStart: '10:00',
    clockIn: todayAt('10:02'),
    assignedTo: 'Outbound Calls',
    absentReason: ''
  },
  {
    id: 'E-007',
    name: 'MIA',
    role: 'Admin',
    isLive: false,
    onBreak: false,
    presence: 'absent',
    shiftStart: '09:00',
    clockIn: null,
    assignedTo: 'Documentation',
    absentReason: 'Sick leave'
  },
  {
    id: 'E-008',
    name: 'RON',
    role: 'QA',
    isLive: false,
    onBreak: false,
    presence: 'present',
    shiftStart: '13:00',
    clockIn: null,
    assignedTo: 'Ticket Review',
    absentReason: ''
  }
]

export const dashboardData = {
  kpis: {
    clientEngagement: 1000,
    appointmentSet: 40,
    billableHours: 300
  },
  attendance: {
    absent: 92,
    present: 133,
    late: 12
  },
  performance: [
    { label: 'YUME', value: 92 },
    { label: 'VELLE', value: 128 },
    { label: 'CLARICE', value: 75 },
    { label: 'EDSIE', value: 58 },
    { label: 'LYNDER', value: 44 },
    { label: 'KIM', value: 110 },
    { label: 'MIA', value: 98 },
    { label: 'RON', value: 66 }
  ],
  heatCols: ['1', '2', '3', '4'],
  heatData: [
    { role: 'Support', values: [26, 19, 43, 43] },
    { role: 'Sales', values: [10, 16, 13, 13] },
    { role: 'QA', values: [56, 48, 75, 80] },
    { role: 'Ops', values: [21, 21, 27, 33] },
    { role: 'Admin', values: [26, 32, 49, 36] },
    { role: 'Tech', values: [15, 16, 27, 22] },
    { role: 'HR', values: [54, 53, 90, 95] },
    { role: 'Finance', values: [69, 54, 91, 112] }
  ],
  mini: [
    { label: 'Attrition Count', value: 99 },
    { label: 'Coaching', value: 58 },
    { label: 'QA Flags', value: 44 },
    { label: 'Escalations', value: 31 },
    { label: 'Training', value: 5 }
  ],
  agentStats: [
    { name: 'YUME', value: 38, sub: 'Under 25' },
    { name: 'VELLE', value: 112, sub: '25-34' },
    { name: 'CLARICE', value: 51, sub: '35-44' },
    { name: 'EDSIE', value: 25, sub: '45-54' },
    { name: 'LYNDER', value: 11, sub: 'Over 55' }
  ],
  updates: ['UPCOMING LEAVE', 'NEWSLETTER', 'NATIONAL HOLIDAYS']
}

export const uiData = {
  liveAgents: ['YUME', 'VELLE', 'KIM', 'EDSIE'],
  notifications: []
}