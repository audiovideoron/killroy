import { useRef, useState, useImperativeHandle, forwardRef, useCallback } from 'react'

interface VideoPreviewProps {
  originalUrl: string | null
  processedUrl: string | null
}

export type PlaybackMode = 'IDLE' | 'MAIN'

export interface VideoPreviewHandle {
  playOriginal: () => void
  playProcessed: () => void
  playUrl: (url: string) => void  // Direct URL playback (bypasses stale props)
  stopAll: () => void
  getMode: () => PlaybackMode
}

export const VideoPreview = forwardRef<VideoPreviewHandle, VideoPreviewProps>(
  ({ originalUrl, processedUrl }, ref) => {
    const mainVideoRef = useRef<HTMLVideoElement>(null)

    // Mode ref for immediate access (not async like state)
    const modeRef = useRef<PlaybackMode>('IDLE')
    // State for UI updates (async)
    const [displayMode, setDisplayMode] = useState<PlaybackMode>('IDLE')

    // Hard-stop main playback
    const stopMain = useCallback(() => {
      if (mainVideoRef.current) {
        mainVideoRef.current.pause()
        mainVideoRef.current.currentTime = 0
        console.log('[VideoPreview] MAIN stopped')
      }
    }, [])

    useImperativeHandle(ref, () => ({
      playOriginal: () => {
        modeRef.current = 'MAIN'
        setDisplayMode('MAIN')

        if (mainVideoRef.current && originalUrl) {
          console.log('[VideoPreview] MAIN playOriginal:', {
            intent: 'MAIN',
            playerId: 'mainVideoRef',
            src: originalUrl,
            type: 'original'
          })
          mainVideoRef.current.src = originalUrl
          mainVideoRef.current.play().catch(e => console.error('[VideoPreview] MAIN play error:', e))
        }
      },

      playProcessed: () => {
        modeRef.current = 'MAIN'
        setDisplayMode('MAIN')

        if (mainVideoRef.current && processedUrl) {
          console.log('[VideoPreview] MAIN playProcessed:', {
            intent: 'MAIN',
            playerId: 'mainVideoRef',
            src: processedUrl,
            type: 'processed'
          })
          mainVideoRef.current.src = processedUrl
          mainVideoRef.current.play().catch(e => console.error('[VideoPreview] MAIN play error:', e))
        }
      },

      playUrl: (url: string) => {
        modeRef.current = 'MAIN'
        setDisplayMode('MAIN')

        if (mainVideoRef.current && url) {
          console.log('[VideoPreview] MAIN playUrl:', {
            intent: 'MAIN',
            playerId: 'mainVideoRef',
            src: url,
            type: 'direct'
          })
          mainVideoRef.current.src = url
          mainVideoRef.current.play().catch(e => console.error('[VideoPreview] MAIN play error:', e))
        }
      },

      stopAll: () => {
        stopMain()
        modeRef.current = 'IDLE'
        setDisplayMode('IDLE')
        console.log('[VideoPreview] All playback stopped, mode: IDLE')
      },

      getMode: () => modeRef.current
    }), [originalUrl, processedUrl, stopMain])

    return (
      <div className="section" style={{ position: 'relative' }}>
        <video
          ref={mainVideoRef}
          controls
          style={{
            width: '100%',
            maxHeight: 400,
            willChange: 'transform',
            transform: 'translateZ(0)'
          }}
        />
      </div>
    )
  }
)

VideoPreview.displayName = 'VideoPreview'
