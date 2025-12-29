/**
 * TranscriptEditor Tests
 * Using proper vitest setup for React 18
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { TranscriptEditor } from '../components/TranscriptEditor'
import type { TranscriptV1, EdlV1 } from '../../shared/editor-types'

// Mock electronAPI on window before component loads
const mockElectronAPI = {
  computePendingRemovals: vi.fn().mockResolvedValue({ ranges: [], total_removed_ms: 0, duration_ms: 30000 }),
  synthesizeVoiceTest: vi.fn().mockResolvedValue({ success: true, outputPath: '/tmp/test.mp4' }),
  getFileUrl: vi.fn().mockResolvedValue('file:///tmp/test.mp4'),
  cloneVoice: vi.fn().mockResolvedValue({ success: true, voice_name: 'Test Voice' })
}

// Add to window
Object.defineProperty(window, 'electronAPI', {
  value: mockElectronAPI,
  writable: true
})

// Real transcript data matching ElevenLabs output
const realTranscript: TranscriptV1 = {
  version: '1',
  video_id: 'test-video',
  tokens: [
    { token_id: 't1', text: 'Get', start_ms: 0, end_ms: 500, confidence: 0.95 },
    { token_id: 't2', text: 'some', start_ms: 500, end_ms: 800, confidence: 0.95 },
    { token_id: 't3', text: 'video', start_ms: 800, end_ms: 1200, confidence: 0.95 },
    { token_id: 't4', text: 'footage.', start_ms: 1200, end_ms: 1800, confidence: 0.95 },
    { token_id: 't5', text: 'Something', start_ms: 2000, end_ms: 2500, confidence: 0.95 }
  ],
  segments: [
    { segment_id: 's1', start_ms: 0, end_ms: 1800, text: 'Get some video footage.', token_ids: ['t1', 't2', 't3', 't4'] },
    { segment_id: 's2', start_ms: 2000, end_ms: 2500, text: 'Something', token_ids: ['t5'] }
  ]
}

const emptyEdl: EdlV1 = {
  version: '1',
  video_id: 'test-video',
  edl_version_id: 'edl-1',
  created_at: new Date().toISOString(),
  params: {
    merge_threshold_ms: 200,
    pre_roll_ms: 50,
    post_roll_ms: 50,
    audio_crossfade_ms: 10
  },
  remove_ranges: []
}

describe('TranscriptEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the transcript editor container', () => {
    const { container } = render(
      <TranscriptEditor
        filePath="/test/video.mp4"
        transcript={realTranscript}
        edl={emptyEdl}
        onEdlChange={vi.fn()}
        onExport={vi.fn()}
        isExporting={false}
        exportError={null}
        exportSuccess={null}
      />
    )

    const editor = container.querySelector('.transcript-editor')
    expect(editor).not.toBeNull()
  })

  it('renders tokens with correct text', () => {
    const { container } = render(
      <TranscriptEditor
        filePath="/test/video.mp4"
        transcript={realTranscript}
        edl={emptyEdl}
        onEdlChange={vi.fn()}
        onExport={vi.fn()}
        isExporting={false}
        exportError={null}
        exportSuccess={null}
      />
    )

    const tokens = container.querySelectorAll('[data-token-id]')
    expect(tokens.length).toBe(5)

    const t1 = container.querySelector('[data-token-id="t1"]')
    const t2 = container.querySelector('[data-token-id="t2"]')
    const t3 = container.querySelector('[data-token-id="t3"]')
    const t4 = container.querySelector('[data-token-id="t4"]')
    const t5 = container.querySelector('[data-token-id="t5"]')

    expect(t1?.textContent).toBe('Get')
    expect(t2?.textContent).toBe('some')
    expect(t3?.textContent).toBe('video')
    expect(t4?.textContent).toBe('footage.')
    expect(t5?.textContent).toBe('Something')
  })

  it('renders control buttons', () => {
    const { container } = render(
      <TranscriptEditor
        filePath="/test/video.mp4"
        transcript={realTranscript}
        edl={emptyEdl}
        onEdlChange={vi.fn()}
        onExport={vi.fn()}
        isExporting={false}
        exportError={null}
        exportSuccess={null}
      />
    )

    const buttons = container.querySelectorAll('button')
    const buttonTexts = Array.from(buttons).map(b => b.textContent)

    expect(buttonTexts).toContain('Clear All')
    expect(buttonTexts).toContain('Export')
    expect(buttonTexts).toContain('Synthesize')
    expect(buttonTexts).toContain('Clone Voice')
  })

  it('has contenteditable text area', () => {
    const { container } = render(
      <TranscriptEditor
        filePath="/test/video.mp4"
        transcript={realTranscript}
        edl={emptyEdl}
        onEdlChange={vi.fn()}
        onExport={vi.fn()}
        isExporting={false}
        exportError={null}
        exportSuccess={null}
      />
    )

    const textArea = container.querySelector('.transcript-text')
    expect(textArea).not.toBeNull()
    expect(textArea?.getAttribute('contenteditable')).toBe('true')
  })

  it('shows no-edits message when empty', () => {
    const { container } = render(
      <TranscriptEditor
        filePath="/test/video.mp4"
        transcript={realTranscript}
        edl={emptyEdl}
        onEdlChange={vi.fn()}
        onExport={vi.fn()}
        isExporting={false}
        exportError={null}
        exportSuccess={null}
      />
    )

    const noEdits = container.querySelector('.no-edits')
    expect(noEdits).not.toBeNull()
    expect(noEdits?.textContent).toContain('Click in text to edit')
  })
})
