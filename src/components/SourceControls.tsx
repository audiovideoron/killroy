/**
 * Source file selection and preview start time controls.
 *
 * Note: Preview duration is fixed at 10 seconds (PREVIEW_DURATION_SEC).
 * See: docs/noise-sample-auto-selection-investigation.md
 */

interface SourceControlsProps {
  filePath: string | null
  startTime: number
  onSelectFile: () => void
  onStartTimeChange: (value: number) => void
}

export function SourceControls({
  filePath,
  startTime,
  onSelectFile,
  onStartTimeChange
}: SourceControlsProps) {
  // Extract filename from path (handles both Unix and Windows)
  const fileName = filePath?.split(/[/\\]/).pop()

  return (
    <div className="section" style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
      <div>
        <button onClick={onSelectFile}>Choose Video...</button>
        {fileName && <div className="file-path" style={{ maxWidth: 300 }}>{fileName}</div>}
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <div className="field">
          <span>Preview Start (sec)</span>
          <input
            type="number"
            min={0}
            value={startTime}
            onChange={e => onStartTimeChange(Number(e.target.value))}
            style={{ width: 60 }}
          />
        </div>
      </div>
    </div>
  )
}
