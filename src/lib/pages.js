import { Calendar, Users, ClipboardCheck, Star, Tags, SlidersHorizontal, Building2, ScanLine, LayoutDashboard, FileSpreadsheet, Siren, UserPlus } from 'lucide-react'

// ─── Page registry (single source: navbar, document.title, Users matrix) ───
export const PAGES = {
  // Command Center first: aso/super_admin land here (first visible key wins).
  dashboard: { label: 'Dashboard', icon: LayoutDashboard, roles: ['aso', 'super_admin'] },
  schedule: { label: 'Schedule', icon: Calendar, roles: ['aso', 'super_admin'] },
  consent: { label: 'Consent & Deploy', icon: ClipboardCheck, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin', 'vss_operator'] },
  vss: { label: 'VSS', icon: Star, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin', 'vss_operator'] },
  alloc: { label: 'Finalize Deployment', icon: Tags, roles: ['aso', 'super_admin'] },
  deployment: { label: 'Overview', icon: Users, roles: ['aso', 'super_admin'] },
  centreLists: { label: 'Centre Lists', icon: Building2, roles: ['aso', 'super_admin'] },
  inchargeDashboard: { label: 'Dashboard', icon: LayoutDashboard, roles: ['dept_incharge'] },
  scanner: { label: 'Scanner', icon: ScanLine, roles: ['scanner'] },
  // attendance analytics — read-only; the DB resolves each role's own scope.
  // The grouped intelligence pages share one `group` so the navbar renders a
  // single Attendance dropdown instead of separate pills (a group with a single
  // visible page renders as a plain tab). Reports stands alone (no group).
  attendance: { label: 'Attendance', icon: ScanLine, roles: ['aso', 'super_admin', 'centre_user', 'centre_admin', 'dept_incharge'], group: 'attendance' },
  // attendance intelligence suite (v45) — aso/super_admin only, except Reports
  // which dept_incharge also sees as a standalone tab
  reports: { label: 'Reports', icon: FileSpreadsheet, roles: ['dept_incharge', 'aso', 'super_admin'] },
  anomalies: { label: 'Anomalies', icon: Siren, roles: ['aso', 'super_admin'], group: 'attendance' },
  // phase-2 hardening: per-centre permission overrides — super_admin only
  control: { label: 'Control Panel', icon: SlidersHorizontal, roles: ['super_admin'] },
  // user management (v48) — logins, invites, custom roles — super_admin only
  users: { label: 'Users', icon: UserPlus, roles: ['super_admin'] },
}
