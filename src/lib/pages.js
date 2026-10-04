import { Calendar, Users, ClipboardCheck, Star, Tags, SlidersHorizontal, Building2, ScanLine, LayoutDashboard, FileSpreadsheet, Siren, UserPlus, Radio } from 'lucide-react'

// ─── Page registry (single source: navbar, document.title, Users matrix) ───
// Every page belongs to exactly one phase: 1 = Deployment (pre-visit planning
// & consent), 2 = Attendance (finalize + execution & reporting). The phase
// switch (src/lib/phase.js + PhaseSwitch) filters this registry — it replaces
// the old `group` dropdown mechanism, so no entry carries `group` anymore.
export const PHASES = { 1: 'Deployment', 2: 'Attendance' }

export const PAGES = {
  // Command Center first: aso/super_admin land here (first visible key wins).
  dashboard: { label: 'Dashboard', icon: LayoutDashboard, roles: ['aso', 'super_admin'], phase: 2 },
  schedule: { label: 'Schedule', icon: Calendar, roles: ['aso', 'super_admin'], phase: 1 },
  consent: { label: 'Consent & Deploy', icon: ClipboardCheck, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin', 'vss_operator'], phase: 1 },
  vss: { label: 'VSS', icon: Star, roles: ['centre_user', 'centre_admin', 'aso', 'super_admin', 'vss_operator'], phase: 1 },
  alloc: { label: 'Finalize Deployment', icon: Tags, roles: ['aso', 'super_admin'], phase: 2 },
  deployment: { label: 'Overview', icon: Users, roles: ['aso', 'super_admin'], phase: 1 },
  centreLists: { label: 'Centre Lists', icon: Building2, roles: ['aso', 'super_admin'], phase: 1 },
  inchargeDashboard: { label: 'Dashboard', icon: LayoutDashboard, roles: ['dept_incharge'], phase: 2 },
  scanner: { label: 'Scanner', icon: ScanLine, roles: ['scanner'], phase: 2 },
  // attendance analytics — read-only; the DB resolves each role's own scope.
  attendance: { label: 'Attendance', icon: ScanLine, roles: ['aso', 'super_admin', 'centre_user', 'centre_admin', 'dept_incharge'], phase: 2 },
  // attendance intelligence suite (v45) — aso/super_admin only, except Reports
  // which dept_incharge also sees as a standalone tab
  reports: { label: 'Reports', icon: FileSpreadsheet, roles: ['dept_incharge', 'aso', 'super_admin'], phase: 2 },
  // liveScanners (wired 2026-10-03): LiveScannersPage existed but had NO PAGES
  // key and NO App.jsx branch, so it was unreachable for every role — the
  // scanner-ops dashboard could never be opened.
  liveScanners: { label: 'Live Scanners', icon: Radio, roles: ['aso', 'super_admin'], phase: 2 },
  anomalies: { label: 'Anomalies', icon: Siren, roles: ['aso', 'super_admin'], phase: 2 },
  // phase-2 hardening: per-centre permission overrides — super_admin only
  control: { label: 'Control Panel', icon: SlidersHorizontal, roles: ['super_admin'], phase: 1 },
  // user management (v48) — logins, invites, custom roles — super_admin only
  users: { label: 'Users', icon: UserPlus, roles: ['super_admin'], phase: 1 },
}
