import { contextBridge, ipcRenderer } from 'electron'
import type { RenderOptions, RenderResult } from '../shared/types'
import type { TranscriptV1, EdlV1 } from '../shared/editor-types'

// Re-export types for backwards compatibility
export type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  RenderOptions,
  RenderResult
} from '../shared/types'

export type {
  TranscriptV1,
  EdlV1
} from '../shared/editor-types'

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('select-file'),

  renderPreview: (options: RenderOptions): Promise<RenderResult> =>
    ipcRenderer.invoke('render-preview', options),

  getFileUrl: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('get-file-url', filePath),

  getTranscript: (filePath: string): Promise<{ transcript: TranscriptV1; edl: EdlV1 }> =>
    ipcRenderer.invoke('get-transcript', filePath),

  renderFinal: (filePath: string, edl: EdlV1, outputPath: string): Promise<{ success: boolean; outputPath?: string; error?: string }> =>
    ipcRenderer.invoke('render-final', filePath, edl, outputPath),

  saveDialog: (defaultPath: string): Promise<string | null> =>
    ipcRenderer.invoke('save-dialog', defaultPath)
})
