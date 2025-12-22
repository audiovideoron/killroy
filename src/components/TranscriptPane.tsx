import { TranscriptEditor } from './TranscriptEditor'
import type { TranscriptV1, EdlV1 } from '../../shared/editor-types'

interface TranscriptPaneProps {
  filePath: string | null
  transcript: TranscriptV1 | undefined
  edl: EdlV1 | undefined
  asrBackend: string | undefined
  isTranscriptLoading: boolean
  transcriptError: string | null
  isExporting: boolean
  exportError: string | null
  exportSuccess: string | null
  onEdlChange: (newEdl: EdlV1) => void
  onExport: () => void
  onLoadTranscript: () => void
}

export function TranscriptPane({
  filePath,
  transcript,
  edl,
  asrBackend,
  isTranscriptLoading,
  transcriptError,
  isExporting,
  exportError,
  exportSuccess,
  onEdlChange,
  onExport,
  onLoadTranscript
}: TranscriptPaneProps) {
  if (!filePath) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>
        <p>No media file selected</p>
        <p style={{ fontSize: 14 }}>Choose a video file using the button above to view its transcript</p>
      </div>
    )
  }

  if (asrBackend === 'mock' && !isTranscriptLoading) {
    return (
      <>
        <div style={{
          padding: '12px 16px',
          background: '#ff9800',
          color: '#000',
          borderRadius: 4,
          marginBottom: 16,
          fontSize: 14,
          fontWeight: 500
        }}>
          ⚠ Mock transcript in use — Whisper ASR not configured
        </div>
        {transcript && edl && (
          <TranscriptEditor
            transcript={transcript}
            edl={edl}
            onEdlChange={onEdlChange}
            onExport={onExport}
            isExporting={isExporting}
            exportError={exportError}
            exportSuccess={exportSuccess}
          />
        )}
      </>
    )
  }

  if (isTranscriptLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 18, marginBottom: 12 }}>Transcribing audio...</div>
        <div style={{ fontSize: 14, color: '#888' }}>This may take a moment</div>
      </div>
    )
  }

  if (transcriptError) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 18, color: '#f44', marginBottom: 12 }}>Error loading transcript</div>
        <div style={{ fontSize: 14, color: '#888', marginBottom: 20 }}>{transcriptError}</div>
        <button onClick={onLoadTranscript}>Retry</button>
      </div>
    )
  }

  if (transcript && edl) {
    return (
      <TranscriptEditor
        transcript={transcript}
        edl={edl}
        onEdlChange={onEdlChange}
        onExport={onExport}
        isExporting={isExporting}
        exportError={exportError}
        exportSuccess={exportSuccess}
      />
    )
  }

  return null
}
