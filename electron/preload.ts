import { contextBridge, ipcRenderer } from 'electron'
import type { RenderOptions, RenderResult, JobProgressEvent } from '../shared/types'

// Re-export types for backwards compatibility
export type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  RenderOptions,
  RenderResult,
  JobProgressEvent,
  JobStatus
} from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('select-file'),

  renderPreview: (options: RenderOptions): Promise<RenderResult> =>
    ipcRenderer.invoke('render-preview', options),

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
  }
})
