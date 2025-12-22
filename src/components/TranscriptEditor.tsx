/**
 * Transcript Editor - Minimal word-based editor
 */

import { useState, useCallback } from 'react'
import type { TranscriptV1, TranscriptToken, EdlV1, RemoveRange } from '../../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'

interface TranscriptEditorProps {
  transcript: TranscriptV1
  edl: EdlV1
  onEdlChange: (edl: EdlV1) => void
}

export function TranscriptEditor({ transcript, edl, onEdlChange }: TranscriptEditorProps) {
  const [selectedTokenIds, setSelectedTokenIds] = useState<Set<string>>(new Set())

  // Check if token is removed
  const isTokenRemoved = useCallback(
    (token: TranscriptToken): boolean => {
      return edl.remove_ranges.some(
        (range) => token.start_ms >= range.start_ms && token.end_ms <= range.end_ms
      )
    },
    [edl.remove_ranges]
  )

  // Toggle token selection
  const toggleTokenSelection = useCallback((tokenId: string) => {
    setSelectedTokenIds((prev) => {
      const next = new Set(prev)
      if (next.has(tokenId)) {
        next.delete(tokenId)
      } else {
        next.add(tokenId)
      }
      return next
    })
  }, [])

  // Delete selected tokens
  const deleteSelection = useCallback(() => {
    if (selectedTokenIds.size === 0) return

    const tokensToRemove = transcript.tokens.filter((t) =>
      selectedTokenIds.has(t.token_id)
    )

    if (tokensToRemove.length === 0) return

    // Compute remove range from selected tokens
    const start_ms = Math.min(...tokensToRemove.map((t) => t.start_ms))
    const end_ms = Math.max(...tokensToRemove.map((t) => t.end_ms))

    const newRemoveRange: RemoveRange = {
      range_id: uuidv4(),
      start_ms,
      end_ms,
      source: 'user',
      reason: 'selection'
    }

    // Append to EDL
    const newEdl: EdlV1 = {
      ...edl,
      edl_version_id: uuidv4(), // New version
      created_at: new Date().toISOString(),
      remove_ranges: [...edl.remove_ranges, newRemoveRange]
    }

    onEdlChange(newEdl)
    setSelectedTokenIds(new Set()) // Clear selection
  }, [selectedTokenIds, transcript.tokens, edl, onEdlChange])

  // Undo (remove last remove_range)
  const undo = useCallback(() => {
    if (edl.remove_ranges.length === 0) return

    const newEdl: EdlV1 = {
      ...edl,
      edl_version_id: uuidv4(),
      created_at: new Date().toISOString(),
      remove_ranges: edl.remove_ranges.slice(0, -1)
    }

    onEdlChange(newEdl)
  }, [edl, onEdlChange])

  // Clear all edits
  const clearAll = useCallback(() => {
    const newEdl: EdlV1 = {
      ...edl,
      edl_version_id: uuidv4(),
      created_at: new Date().toISOString(),
      remove_ranges: []
    }

    onEdlChange(newEdl)
    setSelectedTokenIds(new Set())
  }, [edl, onEdlChange])

  return (
    <div className="transcript-editor">
      <div className="transcript-controls">
        <button onClick={deleteSelection} disabled={selectedTokenIds.size === 0}>
          Delete Selected ({selectedTokenIds.size})
        </button>
        <button onClick={undo} disabled={edl.remove_ranges.length === 0}>
          Undo
        </button>
        <button onClick={clearAll} disabled={edl.remove_ranges.length === 0}>
          Clear All
        </button>
        <span className="edits-count">
          {edl.remove_ranges.length} edit{edl.remove_ranges.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="transcript-text">
        {transcript.tokens.map((token) => {
          const isRemoved = isTokenRemoved(token)
          const isSelected = selectedTokenIds.has(token.token_id)

          return (
            <span
              key={token.token_id}
              className={`token ${isRemoved ? 'removed' : ''} ${isSelected ? 'selected' : ''}`}
              onClick={() => !isRemoved && toggleTokenSelection(token.token_id)}
              data-token-id={token.token_id}
              data-start-ms={token.start_ms}
              data-end-ms={token.end_ms}
            >
              {token.text}{' '}
            </span>
          )
        })}
      </div>

      <style>{`
        .transcript-editor {
          padding: 20px;
          background: #f5f5f5;
          border-radius: 8px;
        }

        .transcript-controls {
          margin-bottom: 16px;
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .transcript-controls button {
          padding: 8px 16px;
          border: 1px solid #ccc;
          background: white;
          border-radius: 4px;
          cursor: pointer;
        }

        .transcript-controls button:hover:not(:disabled) {
          background: #e0e0e0;
        }

        .transcript-controls button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .edits-count {
          margin-left: auto;
          color: #666;
          font-size: 14px;
        }

        .transcript-text {
          background: white;
          padding: 16px;
          border-radius: 4px;
          line-height: 1.8;
          font-size: 16px;
          user-select: none;
        }

        .token {
          cursor: pointer;
          padding: 2px 0;
          transition: background-color 0.1s;
        }

        .token:hover:not(.removed) {
          background-color: #e3f2fd;
        }

        .token.selected {
          background-color: #2196f3;
          color: white;
        }

        .token.removed {
          text-decoration: line-through;
          opacity: 0.4;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  )
}
