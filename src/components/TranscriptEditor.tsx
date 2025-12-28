/**
 * Transcript Editor - Minimal word-based editor
 */

import { useState, useCallback, useEffect } from 'react'
import type { TranscriptV1, TranscriptToken, EdlV1, RemoveRange } from '../../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'

interface PendingRemovalsResult {
  ranges: Array<{ start_ms: number; end_ms: number }>
  total_removed_ms: number
  duration_ms: number
}

// Format milliseconds as MM:SS.mmm
function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  const millis = ms % 1000
  return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`
}

interface TranscriptEditorProps {
  filePath: string
  transcript: TranscriptV1
  edl: EdlV1
  onEdlChange: (edl: EdlV1) => void
  onExport: () => void
  isExporting: boolean
  exportError: string | null
  exportSuccess: string | null
}

export function TranscriptEditor({ filePath, transcript, edl, onEdlChange, onExport, isExporting, exportError, exportSuccess }: TranscriptEditorProps) {
  const [selectedTokenIds, setSelectedTokenIds] = useState<Set<string>>(new Set())
  const [pendingRemovals, setPendingRemovals] = useState<PendingRemovalsResult | null>(null)

  // Compute pending removals when edl changes
  useEffect(() => {
    if (edl.remove_ranges.length === 0) {
      setPendingRemovals(null)
      return
    }

    window.electronAPI.computePendingRemovals(filePath, edl)
      .then(setPendingRemovals)
      .catch(() => setPendingRemovals(null))
  }, [filePath, edl])

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
        <button
          onClick={onExport}
          disabled={isExporting}
          style={{
            marginLeft: 'auto',
            background: '#4fc3f7',
            color: '#000',
            fontWeight: 600,
            border: '1px solid #333'
          }}
        >
          {isExporting ? 'Exporting...' : 'Export Edited Video'}
        </button>
      </div>

      {exportSuccess && (
        <div style={{
          padding: '12px',
          background: '#4caf50',
          color: 'white',
          borderRadius: 4,
          marginBottom: 16
        }}>
          ✓ Exported successfully: {exportSuccess.split('/').pop()}
        </div>
      )}

      {exportError && (
        <div style={{
          padding: '12px',
          background: '#f44',
          color: 'white',
          borderRadius: 4,
          marginBottom: 16
        }}>
          Export failed: {exportError}
        </div>
      )}

      {/* Pending Removals Diagnostic */}
      {pendingRemovals && pendingRemovals.ranges.length > 0 && (
        <div style={{
          padding: '12px',
          background: '#2a2a2a',
          border: '1px solid #444',
          borderRadius: 4,
          marginBottom: 16,
          fontSize: 13,
          fontFamily: 'monospace'
        }}>
          <div style={{ color: '#888', marginBottom: 8 }}>Pending Removals (effective ranges after padding/merge):</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#aaa', textAlign: 'left' }}>
                <th style={{ padding: '4px 8px' }}>#</th>
                <th style={{ padding: '4px 8px' }}>Start</th>
                <th style={{ padding: '4px 8px' }}>End</th>
                <th style={{ padding: '4px 8px' }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {pendingRemovals.ranges.map((r, i) => (
                <tr key={i} style={{ color: '#ddd' }}>
                  <td style={{ padding: '4px 8px' }}>{i + 1}</td>
                  <td style={{ padding: '4px 8px' }}>{formatMs(r.start_ms)}</td>
                  <td style={{ padding: '4px 8px' }}>{formatMs(r.end_ms)}</td>
                  <td style={{ padding: '4px 8px' }}>{formatMs(r.end_ms - r.start_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #444', color: '#4fc3f7' }}>
            Total removed: {formatMs(pendingRemovals.total_removed_ms)} / {formatMs(pendingRemovals.duration_ms)} ({((pendingRemovals.total_removed_ms / pendingRemovals.duration_ms) * 100).toFixed(1)}%)
          </div>
        </div>
      )}

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
          color: #111;
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
          color: #777;
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  )
}
