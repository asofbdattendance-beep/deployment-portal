import { WifiOff } from 'lucide-react'
import { useOnline } from '../../hooks/useOnline'

/**
 * OfflineBanner — slim global banner shown when the browser is offline.
 * Mounted once in App.jsx under the header so every attendance page gets
 * offline awareness for free. Renders nothing while online.
 */
export default function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <div className="offline-banner" role="alert">
      <WifiOff size={15} aria-hidden="true" />
      <span>You are offline. Scans queue on this device and sync when you reconnect.</span>
    </div>
  )
}
