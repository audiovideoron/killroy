import { contextBridge, ipcRenderer } from 'electron'

export interface EQBand {
  frequency: number
  gain: number
  q: number
  enabled: boolean
}

export interface FilterParams {
  frequency: number
  q: number
  enabled: boolean
}

export interface CompressorParams {
  threshold: number    // -60 to 0 dB
  ratio: number        // 1 to 20
  attack: number       // 0.01 to 200 ms
  release: number      // 10 to 2000 ms
  makeup: number       // -20 to 20 dB
  emphasis: number     // 20 to 2000 Hz (HPF on detector)
  mode: 'LEVEL' | 'COMP' | 'LIMIT'
  enabled: boolean
}

export interface NoiseReductionParams {
  strength: number     // 0-100, maps to afftdn parameters
  enabled: boolean
}

export interface RenderOptions {
  inputPath: string
  startTime: number
  duration: number
  bands: EQBand[]
  hpf: FilterParams
  lpf: FilterParams
  compressor: CompressorParams
  noiseReduction: NoiseReductionParams
}

export interface RenderResult {
  success: boolean
  error?: string
  originalPath?: string
  processedPath?: string
}

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('select-file'),

  renderPreview: (options: RenderOptions): Promise<RenderResult> =>
    ipcRenderer.invoke('render-preview', options),

  getFileUrl: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('get-file-url', filePath)
})
