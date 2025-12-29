import { contextBridge, ipcRenderer } from 'electron'
import type { RenderOptions, RenderResult, JobProgressEvent, QuietCandidatesResult } from '../shared/types'
import type { TranscriptV1, EdlV1 } from '../shared/editor-types'

// Re-export types for backwards compatibility
export type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseSamplingParams,
  RenderOptions,
  RenderResult,
  JobProgressEvent,
  JobStatus,
  QuietCandidate,
  QuietCandidatesResult
} from '../shared/types'

export type {
  TranscriptV1,
  EdlV1
} from '../shared/editor-types'

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('select-file'),

  getAutoLoadFile: (): Promise<string | null> => ipcRenderer.invoke('get-auto-load-file'),

  renderPreview: (options: RenderOptions): Promise<RenderResult> =>
    ipcRenderer.invoke('render-preview', options),

  renderFullAudio: (options: RenderOptions): Promise<RenderResult> =>
    ipcRenderer.invoke('render-full-audio', options),

  getFileUrl: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('get-file-url', filePath),

  // Progress event listener
  onJobProgress: (callback: (event: JobProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: JobProgressEvent) => callback(data)
    ipcRenderer.on('job:progress', listener)
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('job:progress', listener)
    }
  },

  getTranscript: (filePath: string): Promise<{ transcript: TranscriptV1; edl: EdlV1; asrBackend: string }> =>
    ipcRenderer.invoke('get-transcript', filePath),

  renderFinal: (filePath: string, edl: EdlV1, outputPath: string): Promise<{ success: boolean; outputPath?: string; error?: string }> =>
    ipcRenderer.invoke('render-final', filePath, edl, outputPath),

  saveDialog: (defaultPath: string): Promise<string | null> =>
    ipcRenderer.invoke('save-dialog', defaultPath),

  detectQuietCandidates: (filePath: string): Promise<QuietCandidatesResult> =>
    ipcRenderer.invoke('detect-quiet-candidates', filePath),

  computePendingRemovals: (filePath: string, edl: EdlV1): Promise<{ ranges: Array<{ start_ms: number; end_ms: number }>; total_removed_ms: number; duration_ms: number }> =>
    ipcRenderer.invoke('compute-pending-removals', filePath, edl),

  synthesizeVoiceTest: (filePath: string, transcript: TranscriptV1, edl: EdlV1): Promise<{ success: boolean; outputPath?: string; error?: string; report?: { chunks: number; total_target_ms: number; total_synth_ms: number; tempo_adjustments: number } }> =>
    ipcRenderer.invoke('synthesize-voice-test', filePath, transcript, edl),

  cloneVoice: (filePath: string): Promise<{ success: boolean; voice_id?: string; voice_name?: string; error?: string }> =>
    ipcRenderer.invoke('clone-voice', filePath)
})
