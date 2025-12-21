import type { JobProgressViewState } from '../hooks/useJobProgress'

interface JobProgressBannerProps {
  currentJob: JobProgressViewState | null
}

/**
 * Displays job progress information with status text and progress bar.
 *
 * Shows:
 * - Status text for running/terminal states
 * - Determinate or indeterminate progress bar for active states
 * - Nothing when no job is active
 */
export function JobProgressBanner({ currentJob }: JobProgressBannerProps) {
  if (!currentJob) {
    return null
  }

  // Build status text based on job state
  const phaseName = currentJob.phase === 'original-preview' ? 'Original' :
                    currentJob.phase === 'processed-preview' ? 'Processed' : ''

  let statusText: string
  if (currentJob.status === 'running') {
    if (currentJob.indeterminate) {
      statusText = `Rendering ${phaseName}...`
    } else {
      const percentDisplay = Math.round(currentJob.percent * 100)
      statusText = `Rendering ${phaseName}... ${percentDisplay}%`
    }
  } else if (currentJob.status === 'completed') {
    statusText = 'Completed'
  } else if (currentJob.status === 'failed') {
    statusText = 'Failed'
  } else if (currentJob.status === 'cancelled') {
    statusText = 'Cancelled'
  } else if (currentJob.status === 'timed_out') {
    statusText = 'Timed out'
  } else if (currentJob.status === 'queued') {
    statusText = 'Queued...'
  } else {
    statusText = 'Rendering...'
  }

  // Determine status class for styling
  const statusClass = currentJob.status === 'failed' || currentJob.status === 'timed_out' ? 'error' :
                       currentJob.status === 'completed' ? 'done' :
                       'rendering'

  return (
    <>
      <div className={`status ${statusClass}`} style={{ marginLeft: 12 }}>
        {statusText}
      </div>
      {(currentJob.status === 'running' || currentJob.status === 'queued') && (
        <div style={{ width: 200, marginLeft: 12 }}>
          {currentJob.indeterminate ? (
            <progress style={{ width: '100%' }} />
          ) : (
            <progress value={currentJob.percent} max={1} style={{ width: '100%' }} />
          )}
        </div>
      )}
    </>
  )
}
