import { useCallback, useEffect, useState } from 'react'

/**
 * Reads + toggles the local telemetry opt-in flag over IPC. The flag lives in
 * the main process (telemetry-config.json); this hook mirrors it into React
 * state so the Settings toggle stays in sync.
 *
 * Capture is intentionally NOT exposed here — call
 * `window.electron.telemetry.capture(...)` directly at the interaction site
 * (it's fire-and-forget and a no-op when disabled), so the hook stays a thin
 * settings binding rather than a god-object.
 */
export function useTelemetry(): {
  enabled: boolean
  loading: boolean
  setEnabled: (next: boolean) => Promise<void>
} {
  const [enabled, setEnabledState] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.electron.telemetry.isEnabled()
      .then(v => { if (!cancelled) setEnabledState(v) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const setEnabled = useCallback(async (next: boolean) => {
    await window.electron.telemetry.setEnabled(next)
    setEnabledState(next)
  }, [])

  return { enabled, loading, setEnabled }
}
