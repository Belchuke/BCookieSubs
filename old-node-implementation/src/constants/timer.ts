// How often each library folder is re-scanned. The worker wakes every
// LIBRARY_SCAN_TICK_MS but only scans paths whose last scan is older than this
// (or that were never scanned / manually queued for rescan).
export const LIBRARY_SCAN_INTERVAL_MINUTES = 30
// How often the worker wakes to check for due paths. Kept short so a manual
// rescan (which marks a path immediately due) is picked up quickly.
export const LIBRARY_SCAN_TICK_MS = 15_000
export const STUCK_SCAN_THRESHOLD_MINUTES = 10
export const STARTUP_DELAY_MS = 30_000
export const CREDIT_DURATION_MS = 5000

export const TASK_INTERVAL_MS = 2000
export const IDLE_INTERVAL_MS = 5000
export const MODEL_REQUEST_TIMEOUT_MS = 300_000
