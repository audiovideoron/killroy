/// <reference types="../types/electron-api" />

declare global {
  interface Window {
    electronAPI: {
      selectFile: () => Promise<string | null>
      renderPreview: (options: {
        inputPath: string
        startTime: number
        duration: number
        autoGain: any
        loudness: any
        noiseReduction: any
        hpf: any
        lpf: any
        bands: any[]
        compressor: any
        autoMix: any
        noiseSampleRegion: any
      }) => Promise<any>
      renderFullAudio: (options: {
        inputPath: string
        startTime: number
        duration: number
        autoGain: any
        loudness: any
        noiseReduction: any
        hpf: any
        lpf: any
        bands: any[]
        compressor: any
        autoMix: any
        noiseSampleRegion: any
      }) => Promise<any>
      getFileUrl: (filePath: string) => Promise<string>
      onJobProgress: (callback: (event: any) => void) => () => void
      getTranscript: (filePath: string) => Promise<{ transcript: any; edl: any; asrBackend: string }>
      renderFinal: (filePath: string, edl: any, outputPath: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>
      saveDialog: (defaultPath: string) => Promise<string | null>
      cancelRender: (jobId: string) => Promise<{ cancelled: boolean; message: string }>
      detectQuietCandidates: (filePath: string) => Promise<any>
    }
  }
}

export {}
