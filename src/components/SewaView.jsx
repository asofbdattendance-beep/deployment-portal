import { useMemo } from 'react'
import PrevisitView from './PrevisitView'
import { useSewaViewData } from '../hooks/useSewaViewData'
import { SEWA_MODE_VISIT, SEWA_MODE_PREVISIT, scheduleWindow, expandDateRange } from '../lib/sewaMode'

/**
 * SewaView — the shared sewa register. One component, two lenses: the
 * previsit improvements (Total roster with day ticks, Present register,
 * Attention sections, Logs tab, row drill-in, snapshot-hold, exports)
 * render for Bhati Visit too — only the dates differ (visit window dates
 * instead of previsit event dates).
 *
 * Data comes from useSewaViewData (mode-aware, same contract both ways)
 * and drops straight into PrevisitView's mode-aware props; this wrapper
 * only resolves the visit window off the schedule. Day columns in visit
 * mode are EXACTLY the window dates — previsit scans can never grow a
 * Bhati Visit column (pinned by SewaView.test.jsx).
 */
export default function SewaView({
  schedules = [],
  scheduleId,
  initialTab,
  mode = SEWA_MODE_VISIT,
  initialCentre = 'all',
}) {
  const schedule = (schedules || []).find((s) => s.id === scheduleId)
  const windowDates = useMemo(() => {
    if (mode !== SEWA_MODE_VISIT) return []
    const win = scheduleWindow(schedule)
    return expandDateRange(win.start, win.end)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, schedule?.visit_start_date, schedule?.visit_end_date])
  const viewData = useSewaViewData(scheduleId, mode, windowDates)
  return (
    <PrevisitView
      schedules={schedules}
      scheduleId={scheduleId}
      initialTab={initialTab}
      mode={mode === SEWA_MODE_PREVISIT ? SEWA_MODE_PREVISIT : SEWA_MODE_VISIT}
      windowDates={windowDates}
      initialCentre={initialCentre}
      viewData={viewData}
    />
  )
}
