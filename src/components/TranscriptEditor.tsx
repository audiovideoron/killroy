/**
 * Transcript Editor - Contenteditable text editor
 * Simple implementation with logging throughout
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { TranscriptV1, TranscriptToken, EdlV1, RemoveRange, WordReplacement, WordInsertion } from '../../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'

// Logging helper
const log = (msg: string, ...args: unknown[]) => {
  console.log(`[TranscriptEditor] ${msg}`, ...args)
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
  onSynthesisComplete?: (videoUrl: string) => void
}

export function TranscriptEditor({
  filePath,
  transcript,
  edl,
  onEdlChange,
  onExport,
  isExporting,
  exportError,
  exportSuccess,
  onSynthesisComplete
}: TranscriptEditorProps) {
  log('Render - tokens:', transcript.tokens.length)
  if (transcript.tokens.length > 0) {
    log('First 3 tokens:', transcript.tokens.slice(0, 3).map(t => ({ id: t.token_id.slice(0,8), text: t.text })))
  } else {
    log('WARNING: No tokens in transcript!')
  }

  const editorRef = useRef<HTMLDivElement>(null)
  const [isSynthesizing, setIsSynthesizing] = useState(false)
  const [synthesisError, setSynthesisError] = useState<string | null>(null)
  const [isCloning, setIsCloning] = useState(false)
  const [cloneResult, setCloneResult] = useState<{ success: boolean; voice_name?: string; error?: string } | null>(null)

  // Edit tracking
  const [deletedTokenIds, setDeletedTokenIds] = useState<Set<string>>(new Set())
  const [modifications, setModifications] = useState<Map<string, string>>(new Map())
  const [insertions, setInsertions] = useState<Map<string, string>>(new Map()) // after_token_id -> text

  // Build token lookup
  const tokenMap = useRef<Map<string, TranscriptToken>>(new Map())
  useEffect(() => {
    tokenMap.current = new Map(transcript.tokens.map(t => [t.token_id, t]))
    log('Token map built:', tokenMap.current.size, 'tokens')
  }, [transcript.tokens])

  // Sync edits to EDL
  useEffect(() => {
    const removeRanges: RemoveRange[] = []
    const replacements: WordReplacement[] = []
    const insertionList: WordInsertion[] = []

    // Build remove ranges from deleted tokens
    deletedTokenIds.forEach(tokenId => {
      const token = tokenMap.current.get(tokenId)
      if (token) {
        removeRanges.push({
          range_id: uuidv4(),
          start_ms: token.start_ms,
          end_ms: token.end_ms,
          source: 'user',
          reason: 'selection'
        })
      }
    })

    // Build replacements from modifications
    modifications.forEach((newText, tokenId) => {
      const token = tokenMap.current.get(tokenId)
      if (token) {
        replacements.push({
          replacement_id: uuidv4(),
          token_id: tokenId,
          original_text: token.text,
          replacement_text: newText,
          start_ms: token.start_ms,
          end_ms: token.end_ms
        })
      }
    })

    // Build insertions
    insertions.forEach((text, afterTokenId) => {
      insertionList.push({
        insertion_id: uuidv4(),
        text,
        after_token_id: afterTokenId || null
      })
    })

    const newEdl: EdlV1 = {
      ...edl,
      edl_version_id: uuidv4(),
      created_at: new Date().toISOString(),
      remove_ranges: removeRanges,
      replacements: replacements.length > 0 ? replacements : undefined,
      insertions: insertionList.length > 0 ? insertionList : undefined
    }

    log('EDL update - deletions:', removeRanges.length, 'replacements:', replacements.length, 'insertions:', insertionList.length)
    onEdlChange(newEdl)
  }, [deletedTokenIds, modifications, insertions])

  // Handle input changes - diff against original
  const handleInput = useCallback(() => {
    if (!editorRef.current) return

    const newDeletedIds = new Set<string>()
    const newModifications = new Map<string, string>()
    const newInsertions = new Map<string, string>()

    // Walk the DOM and compare to original tokens
    const spans = editorRef.current.querySelectorAll('span[data-token-id]')
    const foundTokenIds = new Set<string>()

    spans.forEach(span => {
      const tokenId = span.getAttribute('data-token-id')
      if (!tokenId) return

      foundTokenIds.add(tokenId)
      const originalToken = tokenMap.current.get(tokenId)
      if (!originalToken) return

      const currentText = span.textContent?.trim() || ''
      const originalText = originalToken.text.trim()

      if (currentText !== originalText && currentText.length > 0) {
        newModifications.set(tokenId, currentText)
      }
    })

    // Find deleted tokens (in original but not in DOM)
    transcript.tokens.forEach(token => {
      if (!foundTokenIds.has(token.token_id)) {
        newDeletedIds.add(token.token_id)
      }
    })

    // Check for inserted text (text nodes not inside token spans)
    // For now, simplified - just track deletions and modifications

    log('Input - found:', foundTokenIds.size, 'deleted:', newDeletedIds.size, 'modified:', newModifications.size)

    setDeletedTokenIds(newDeletedIds)
    setModifications(newModifications)
  }, [transcript.tokens])

  // Clear all edits
  const clearAll = useCallback(() => {
    log('Clear all edits')
    setDeletedTokenIds(new Set())
    setModifications(new Map())
    setInsertions(new Map())

    // Reset editor content
    if (editorRef.current) {
      editorRef.current.innerHTML = transcript.tokens
        .map(t => `<span data-token-id="${t.token_id}" class="token">${t.text}</span>`)
        .join(' ')
    }
  }, [transcript.tokens])

  // Synthesize
  const synthesizeVoice = useCallback(async () => {
    log('Starting synthesis')
    setIsSynthesizing(true)
    setSynthesisError(null)

    try {
      const result = await window.electronAPI.synthesizeVoiceTest(filePath, transcript, edl)
      if (result.success && result.outputPath) {
        log('Synthesis success:', result.outputPath)
        const videoUrl = await window.electronAPI.getFileUrl(result.outputPath)
        onSynthesisComplete?.(`${videoUrl}?v=${Date.now()}`)
      } else {
        setSynthesisError(result.error || 'Synthesis failed')
      }
    } catch (err) {
      setSynthesisError(String(err))
    } finally {
      setIsSynthesizing(false)
    }
  }, [filePath, transcript, edl, onSynthesisComplete])

  // Clone voice
  const cloneVoice = useCallback(async () => {
    log('Starting voice clone')
    setIsCloning(true)
    setCloneResult(null)

    try {
      const result = await window.electronAPI.cloneVoice(filePath)
      setCloneResult(result)
    } catch (err) {
      setCloneResult({ success: false, error: String(err) })
    } finally {
      setIsCloning(false)
    }
  }, [filePath])

  const hasEdits = deletedTokenIds.size > 0 || modifications.size > 0 || insertions.size > 0

  // Build initial HTML content
  const initialHtml = transcript.tokens
    .map(t => `<span data-token-id="${t.token_id}" class="token">${t.text}</span>`)
    .join(' ')

  log('Rendering with initialHtml length:', initialHtml.length)

  // Debug: log what we're actually rendering
  console.log('[TranscriptEditor] About to render HTML:', initialHtml.substring(0, 200))
  console.log('[TranscriptEditor] HTML length:', initialHtml.length, 'chars')

  // Debug: verify DOM content after mount
  useEffect(() => {
    if (editorRef.current) {
      const domContent = editorRef.current.innerHTML
      console.log('[TranscriptEditor] DOM innerHTML after mount:', domContent.substring(0, 200))
      console.log('[TranscriptEditor] DOM innerHTML length:', domContent.length, 'chars')
      if (domContent.length === 0 && initialHtml.length > 0) {
        console.error('[TranscriptEditor] BUG: HTML was not applied to DOM!')
        // Force-apply content
        editorRef.current.innerHTML = initialHtml
        console.log('[TranscriptEditor] Force-applied innerHTML')
      }
    }
  }, [initialHtml])

  return (
    <div className="transcript-editor">
      {/* Controls */}
      <div className="transcript-controls">
        <span className="edits-summary">
          {deletedTokenIds.size > 0 && <span className="badge deleted">{deletedTokenIds.size} deleted</span>}
          {modifications.size > 0 && <span className="badge modified">{modifications.size} modified</span>}
          {insertions.size > 0 && <span className="badge inserted">{insertions.size} inserted</span>}
          {!hasEdits && <span className="no-edits">Click in text to edit</span>}
        </span>
        <button onClick={clearAll} disabled={!hasEdits}>Clear All</button>
        <button onClick={onExport} disabled={isExporting} className="export-btn">
          {isExporting ? 'Exporting...' : 'Export'}
        </button>
        <button onClick={synthesizeVoice} disabled={isSynthesizing} className="synth-btn">
          {isSynthesizing ? 'Synthesizing...' : 'Synthesize'}
        </button>
        <button onClick={cloneVoice} disabled={isCloning} className="clone-btn">
          {isCloning ? 'Cloning...' : 'Clone Voice'}
        </button>
      </div>

      {/* Status messages */}
      {exportSuccess && <div className="status success">✓ Exported: {exportSuccess.split('/').pop()}</div>}
      {exportError && <div className="status error">Export failed: {exportError}</div>}
      {synthesisError && <div className="status error">Synthesis failed: {synthesisError}</div>}
      {cloneResult?.success && <div className="status success">✓ Voice cloned: {cloneResult.voice_name}</div>}
      {cloneResult && !cloneResult.success && <div className="status error">Clone failed: {cloneResult.error}</div>}

      {/* Editor - using dangerouslySetInnerHTML for proper contentEditable */}
      <div
        ref={editorRef}
        className="transcript-text"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        spellCheck={false}
        dangerouslySetInnerHTML={{ __html: initialHtml }}
      />

      <style>{`
        .transcript-editor {
          padding: 16px;
          background: #f5f5f5;
          border-radius: 8px;
        }
        .transcript-controls {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: 12px;
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
        .export-btn { background: #4fc3f7 !important; color: #000; font-weight: 600; }
        .synth-btn { background: #ab47bc !important; color: #fff; font-weight: 600; }
        .clone-btn { background: #ff7043 !important; color: #fff; font-weight: 600; }
        .edits-summary {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-right: auto;
        }
        .badge {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
        }
        .badge.deleted { background: #fee2e2; color: #991b1b; }
        .badge.modified { background: #fef3c7; color: #92400e; }
        .badge.inserted { background: #dcfce7; color: #166534; }
        .no-edits { color: #666; font-size: 14px; }
        .status {
          padding: 8px 12px;
          border-radius: 4px;
          margin-bottom: 12px;
          font-size: 14px;
        }
        .status.success { background: #4caf50; color: white; }
        .status.error { background: #f44336; color: white; }
        .transcript-text {
          background: white;
          color: #000;
          padding: 16px;
          border-radius: 4px;
          line-height: 2;
          font-size: 16px;
          min-height: 150px;
          outline: none;
          border: 2px solid transparent;
        }
        .transcript-text:focus {
          border-color: #2196f3;
        }
        .transcript-text .token {
          padding: 2px 4px;
          border-radius: 2px;
          color: #000;
        }
        .transcript-text .token:hover {
          background: #e3f2fd;
        }
      `}</style>
    </div>
  )
}
