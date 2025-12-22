import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptEditor } from '../components/TranscriptEditor'
import type { TranscriptV1, EdlV1 } from '../../shared/editor-types'

describe('STEP 5 Gate: Transcript Editor', () => {
  const mockTranscript: TranscriptV1 = {
    version: '1',
    video_id: 'test-video',
    tokens: [
      {
        token_id: 'token-1',
        text: 'Hello',
        start_ms: 0,
        end_ms: 500,
        confidence: 0.95
      },
      {
        token_id: 'token-2',
        text: 'world',
        start_ms: 500,
        end_ms: 1000,
        confidence: 0.98
      },
      {
        token_id: 'token-3',
        text: 'um',
        start_ms: 1000,
        end_ms: 1200,
        confidence: 0.92
      },
      {
        token_id: 'token-4',
        text: 'test',
        start_ms: 1200,
        end_ms: 1600,
        confidence: 0.96
      }
    ],
    segments: []
  }

  const mockEdl: EdlV1 = {
    version: '1',
    video_id: 'test-video',
    edl_version_id: 'edl-1',
    created_at: '2025-01-01T00:00:00Z',
    params: {
      merge_threshold_ms: 80,
      pre_roll_ms: 40,
      post_roll_ms: 40,
      audio_crossfade_ms: 12
    },
    remove_ranges: []
  }

  it('renders all tokens', () => {
    const onEdlChange = vi.fn()
    render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={mockEdl}
        onEdlChange={onEdlChange}
      />
    )

    expect(screen.getByText(/Hello/)).toBeInTheDocument()
    expect(screen.getByText(/world/)).toBeInTheDocument()
    expect(screen.getByText(/um/)).toBeInTheDocument()
    expect(screen.getByText(/test/)).toBeInTheDocument()
  })

  it('allows token selection', () => {
    const onEdlChange = vi.fn()
    const { container } = render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={mockEdl}
        onEdlChange={onEdlChange}
      />
    )

    const tokens = container.querySelectorAll('.token')
    expect(tokens.length).toBe(4)

    // Click first token
    fireEvent.click(tokens[0])
    expect(tokens[0]).toHaveClass('selected')

    // Click second token
    fireEvent.click(tokens[1])
    expect(tokens[1]).toHaveClass('selected')

    // Deselect first token
    fireEvent.click(tokens[0])
    expect(tokens[0]).not.toHaveClass('selected')
  })

  it('deletes selected tokens and appends remove_range', () => {
    const onEdlChange = vi.fn()
    const { container } = render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={mockEdl}
        onEdlChange={onEdlChange}
      />
    )

    const tokens = container.querySelectorAll('.token')

    // Select token-2 and token-3 (indices 1, 2)
    fireEvent.click(tokens[1])
    fireEvent.click(tokens[2])

    const deleteButton = screen.getByText(/Delete Selected/)
    fireEvent.click(deleteButton)

    expect(onEdlChange).toHaveBeenCalledTimes(1)

    const newEdl = onEdlChange.mock.calls[0][0]
    expect(newEdl.remove_ranges.length).toBe(1)
    expect(newEdl.remove_ranges[0].start_ms).toBe(500)
    expect(newEdl.remove_ranges[0].end_ms).toBe(1200)
    expect(newEdl.remove_ranges[0].source).toBe('user')
    expect(newEdl.remove_ranges[0].reason).toBe('selection')
  })

  it('shows removed tokens as struck through', () => {
    const edlWithRemoves: EdlV1 = {
      ...mockEdl,
      remove_ranges: [
        {
          range_id: 'r1',
          start_ms: 1000,
          end_ms: 1200,
          source: 'user',
          reason: 'selection'
        }
      ]
    }

    const onEdlChange = vi.fn()
    const { container } = render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={edlWithRemoves}
        onEdlChange={onEdlChange}
      />
    )

    const tokens = container.querySelectorAll('.token')

    // token-3 (um, 1000-1200) should be removed
    expect(tokens[2]).toHaveClass('removed')

    // Others should not
    expect(tokens[0]).not.toHaveClass('removed')
    expect(tokens[1]).not.toHaveClass('removed')
    expect(tokens[3]).not.toHaveClass('removed')
  })

  it('undo removes last remove_range', () => {
    const edlWithRemoves: EdlV1 = {
      ...mockEdl,
      remove_ranges: [
        {
          range_id: 'r1',
          start_ms: 1000,
          end_ms: 1200,
          source: 'user',
          reason: 'selection'
        }
      ]
    }

    const onEdlChange = vi.fn()
    render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={edlWithRemoves}
        onEdlChange={onEdlChange}
      />
    )

    const undoButton = screen.getByText(/Undo/)
    fireEvent.click(undoButton)

    expect(onEdlChange).toHaveBeenCalledTimes(1)
    const newEdl = onEdlChange.mock.calls[0][0]
    expect(newEdl.remove_ranges.length).toBe(0)
  })

  it('clear all removes all remove_ranges', () => {
    const edlWithRemoves: EdlV1 = {
      ...mockEdl,
      remove_ranges: [
        {
          range_id: 'r1',
          start_ms: 500,
          end_ms: 1000,
          source: 'user',
          reason: 'selection'
        },
        {
          range_id: 'r2',
          start_ms: 1000,
          end_ms: 1200,
          source: 'user',
          reason: 'selection'
        }
      ]
    }

    const onEdlChange = vi.fn()
    render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={edlWithRemoves}
        onEdlChange={onEdlChange}
      />
    )

    const clearButton = screen.getByText(/Clear All/)
    fireEvent.click(clearButton)

    expect(onEdlChange).toHaveBeenCalledTimes(1)
    const newEdl = onEdlChange.mock.calls[0][0]
    expect(newEdl.remove_ranges.length).toBe(0)
  })

  it('disables delete button when no selection', () => {
    const onEdlChange = vi.fn()
    render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={mockEdl}
        onEdlChange={onEdlChange}
      />
    )

    const deleteButton = screen.getByText(/Delete Selected/)
    expect(deleteButton).toBeDisabled()
  })

  it('disables undo and clear when no edits', () => {
    const onEdlChange = vi.fn()
    render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={mockEdl}
        onEdlChange={onEdlChange}
      />
    )

    const undoButton = screen.getByText(/Undo/)
    const clearButton = screen.getByText(/Clear All/)

    expect(undoButton).toBeDisabled()
    expect(clearButton).toBeDisabled()
  })

  it('shows edit count', () => {
    const edlWithRemoves: EdlV1 = {
      ...mockEdl,
      remove_ranges: [
        {
          range_id: 'r1',
          start_ms: 500,
          end_ms: 1000,
          source: 'user',
          reason: 'selection'
        }
      ]
    }

    const onEdlChange = vi.fn()
    render(
      <TranscriptEditor
        transcript={mockTranscript}
        edl={edlWithRemoves}
        onEdlChange={onEdlChange}
      />
    )

    expect(screen.getByText(/1 edit$/)).toBeInTheDocument()
  })
})
