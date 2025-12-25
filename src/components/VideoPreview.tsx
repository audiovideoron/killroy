import { useRef, useImperativeHandle, forwardRef } from 'react'

interface VideoPreviewProps {
  originalUrl: string | null
  processedUrl: string | null
}

export interface VideoPreviewHandle {
  playOriginal: () => void
  playProcessed: () => void
}

export const VideoPreview = forwardRef<VideoPreviewHandle, VideoPreviewProps>(
  ({ originalUrl, processedUrl }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null)

    useImperativeHandle(ref, () => ({
      playOriginal: () => {
        if (videoRef.current && originalUrl) {
          videoRef.current.src = originalUrl
          videoRef.current.play()
        }
      },
      playProcessed: () => {
        if (videoRef.current && processedUrl) {
          videoRef.current.src = processedUrl
          videoRef.current.play()
        }
      }
    }), [originalUrl, processedUrl])

    return (
      <div className="section">
        <video
          ref={videoRef}
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
