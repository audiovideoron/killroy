/// <reference types="../types/electron-api" />

import type {
  AutoGainParams,
  AutoMixParams,
  CompressorParams,
  EQBand,
  FilterParams,
  JobProgressEvent,
  LoudnessParams,
  NoiseSamplingParams,
  ProtocolErrorEvent,
  QuietCandidate,
  QuietCandidatesResult,
  RenderOptions,
  RenderResult,
} from '../../shared/types'

import type {
  EdlV1,
  TranscriptV1,
} from '../../shared/editor-types'

declare global {
  interface Window {
    electronAPI: {
      selectFile: () => Promise<string | null>
      getAutoLoadFile: () => Promise<string | null>
      renderPreview: (options: RenderOptions) => Promise<RenderResult>
      renderFullAudio: (options: RenderOptions) => Promise<RenderResult>
      getFileUrl: (filePath: string) => Promise<string>
      onJobProgress: (callback: (event: JobProgressEvent) => void) => () => void
      getTranscript: (filePath: string) => Promise<{ transcript: TranscriptV1; edl: EdlV1; asrBackend: string }>
      renderFinal: (filePath: string, edl: EdlV1, outputPath: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>
      saveDialog: (defaultPath: string) => Promise<string | null>
      cancelRender: (jobId: string) => Promise<{ success: boolean; message: string }>
      detectQuietCandidates: (filePath: string) => Promise<QuietCandidatesResult>
      computePendingRemovals: (filePath: string, edl: EdlV1) => Promise<{ ranges: Array<{ start_ms: number; end_ms: number }>; total_removed_ms: number; duration_ms: number }>
      synthesizeVoiceTest: (filePath: string, transcript: TranscriptV1, edl: EdlV1) => Promise<{ success: boolean; outputPath?: string; error?: string; report?: { chunks: number; total_target_ms: number; total_synth_ms: number; tempo_adjustments: number } }>
      cloneVoice: (filePath: string) => Promise<{ success: boolean; voice_id?: string; voice_name?: string; error?: string }>
      onProtocolError: (callback: (event: ProtocolErrorEvent) => void) => () => void
    }
  }
}

export {}
