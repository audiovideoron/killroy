import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  RenderResult
} from '../../shared/types'
import type { TranscriptV1, EdlV1 } from '../../shared/editor-types'

declare global {
  interface Window {
    electronAPI: {
      selectFile: () => Promise<string | null>
      renderPreview: (options: {
        inputPath: string
        startTime: number
        duration: number
        bands: EQBand[]
        hpf: FilterParams
        lpf: FilterParams
        compressor: CompressorParams
        noiseReduction: NoiseReductionParams
      }) => Promise<RenderResult>
      getFileUrl: (filePath: string) => Promise<string>
      getTranscript: (filePath: string) => Promise<{ transcript: TranscriptV1; edl: EdlV1; asrBackend: string }>
      renderFinal: (filePath: string, edl: EdlV1, outputPath: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>
      saveDialog: (defaultPath: string) => Promise<string | null>
      cancelRender: (jobId: string) => Promise<{ cancelled: boolean; message: string }>
    }
  }
}

export {}
