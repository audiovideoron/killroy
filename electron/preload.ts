import { contextBridge, ipcRenderer } from 'electron'
import type { RenderOptions, RenderResult } from '../shared/types'

// Re-export types for backwards compatibility
export type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  RenderOptions,
  RenderResult
} from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('select-file'),

  renderPreview: (options: RenderOptions): Promise<RenderResult> =>
    ipcRenderer.invoke('render-preview', options),

  getFileUrl: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('get-file-url', filePath)
})
