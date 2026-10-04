import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * useSewadarSearch — debounced directory search for the ASO scanner picker.
 *
 * One RPC per settled query: `attendance_search_sewadars` (v68) searches
 * both rosters (dp + VSS) by badge/name/centre, applies the caller's
 * attendance scope server-side, and returns identity + deployed + open_now
 * for the top matches. The client never holds the roster.
 *
 * - Queries shorter than 2 chars (or a missing schedule) short-circuit to
 *   [] with no RPC — a 1-char prefix would match half the visit and the
 *   LIMIT clamp would hide the sewadar being typed.
 * - Stale responses lose the seq race and never paint.
 */
export function useSewadarSearch(scheduleId, query, { limit = 10, debounceMs = 250 } = {}) {
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const q = (query || '').trim()
    if (!scheduleId || q.length < 2) {
      seqRef.current += 1
      setResults([])
      setSearching(false)
      setSearchError(null)
      return undefined
    }
    setSearching(true)
    setSearchError(null)
    const seq = ++seqRef.current
    const t = setTimeout(async () => {
      try {
        const { data, error } = await supabase.rpc('attendance_search_sewadars', {
          p_schedule: scheduleId,
          p_query: q,
          p_limit: limit,
        })
        if (seq !== seqRef.current) return
        if (error) throw error
        setResults(Array.isArray(data) ? data : [])
      } catch (e) {
        if (seq !== seqRef.current) return
        setSearchError(e)
        setResults([])
      } finally {
        if (seq === seqRef.current) setSearching(false)
      }
    }, debounceMs)
    return () => clearTimeout(t)
  }, [scheduleId, query, limit, debounceMs])

  return { results, searching, searchError }
}
