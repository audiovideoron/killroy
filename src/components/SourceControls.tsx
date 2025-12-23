interface SourceControlsProps {
  filePath: string | null
  startTime: number
  duration: number
  onSelectFile: () => void
  onStartTimeChange: (value: number) => void
  onDurationChange: (value: number) => void
}

export function SourceControls({
  filePath,
  startTime,
  duration,
  onSelectFile,
  onStartTimeChange,
  onDurationChange
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
          <span>Start (sec)</span>
          <input
            type="number"
            min={0}
            value={startTime}
            onChange={e => onStartTimeChange(Number(e.target.value))}
            style={{ width: 60 }}
          />
        </div>
        <div className="field">
          <span>Duration (sec)</span>
          <input
            type="number"
            min={1}
            max={60}
            value={duration}
            onChange={e => onDurationChange(Number(e.target.value))}
            style={{ width: 60 }}
          />
        </div>
      </div>
    </div>
  )
}
