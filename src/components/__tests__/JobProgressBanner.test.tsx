import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { JobProgressBanner } from '../JobProgressBanner'
import type { JobProgressViewState } from '../../hooks/useJobProgress'

describe('JobProgressBanner', () => {
  it('returns null when currentJob is null', () => {
    const { container } = render(<JobProgressBanner currentJob={null} />)
    expect(container.firstChild).toBeNull()
  })

  describe('Phase Display', () => {
    it('shows "Rendering Original..." for original-preview phase with indeterminate progress', () => {
      const job: JobProgressViewState = {
        jobId: 'test-1',
        phase: 'original-preview',
        percent: 0,
        indeterminate: true,
        status: 'running'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Rendering Original...')).toBeInTheDocument()
    })

    it('shows "Rendering Processed..." for processed-preview phase with indeterminate progress', () => {
      const job: JobProgressViewState = {
        jobId: 'test-2',
        phase: 'processed-preview',
        percent: 0,
        indeterminate: true,
        status: 'running'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Rendering Processed...')).toBeInTheDocument()
    })
  })

  describe('Progress Display', () => {
    it('shows percentage when not indeterminate', () => {
      const job: JobProgressViewState = {
        jobId: 'test-3',
        phase: 'original-preview',
        percent: 0.45,
        indeterminate: false,
        status: 'running'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Rendering Original... 45%')).toBeInTheDocument()
    })

    it('shows indeterminate progress bar when indeterminate=true', () => {
      const job: JobProgressViewState = {
        jobId: 'test-4',
        phase: 'original-preview',
        percent: 0,
        indeterminate: true,
        status: 'running'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const progress = container.querySelector('progress')
      expect(progress).toBeInTheDocument()
      expect(progress).not.toHaveAttribute('value')
    })

    it('shows determinate progress bar with correct value when not indeterminate', () => {
      const job: JobProgressViewState = {
        jobId: 'test-5',
        phase: 'processed-preview',
        percent: 0.75,
        indeterminate: false,
        status: 'running'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const progress = container.querySelector('progress')
      expect(progress).toBeInTheDocument()
      expect(progress).toHaveAttribute('value', '0.75')
      expect(progress).toHaveAttribute('max', '1')
    })

    it('shows progress bar for queued status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-6',
        phase: 'original-preview',
        percent: 0,
        indeterminate: true,
        status: 'queued'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const progress = container.querySelector('progress')
      expect(progress).toBeInTheDocument()
    })

    it('does not show progress bar for completed status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-7',
        phase: 'original-preview',
        percent: 1.0,
        indeterminate: false,
        status: 'completed'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const progress = container.querySelector('progress')
      expect(progress).not.toBeInTheDocument()
    })

    it('does not show progress bar for failed status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-8',
        phase: 'original-preview',
        percent: 0.5,
        indeterminate: false,
        status: 'failed'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const progress = container.querySelector('progress')
      expect(progress).not.toBeInTheDocument()
    })
  })

  describe('Status Text', () => {
    it('shows "Completed" for completed status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-9',
        phase: '',
        percent: 1.0,
        indeterminate: false,
        status: 'completed'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Completed')).toBeInTheDocument()
    })

    it('shows "Failed" for failed status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-10',
        phase: 'original-preview',
        percent: 0.3,
        indeterminate: false,
        status: 'failed'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Failed')).toBeInTheDocument()
    })

    it('shows "Cancelled" for cancelled status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-11',
        phase: 'processed-preview',
        percent: 0.6,
        indeterminate: false,
        status: 'cancelled'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Cancelled')).toBeInTheDocument()
    })

    it('shows "Timed out" for timed_out status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-12',
        phase: 'original-preview',
        percent: 0.2,
        indeterminate: false,
        status: 'timed_out'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Timed out')).toBeInTheDocument()
    })

    it('shows "Queued..." for queued status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-13',
        phase: 'original-preview',
        percent: 0,
        indeterminate: true,
        status: 'queued'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Queued...')).toBeInTheDocument()
    })
  })

  describe('CSS Classes', () => {
    it('applies "error" class for failed status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-14',
        phase: 'original-preview',
        percent: 0.5,
        indeterminate: false,
        status: 'failed'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const statusDiv = container.querySelector('.status')
      expect(statusDiv).toHaveClass('error')
    })

    it('applies "error" class for timed_out status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-15',
        phase: 'processed-preview',
        percent: 0.7,
        indeterminate: false,
        status: 'timed_out'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const statusDiv = container.querySelector('.status')
      expect(statusDiv).toHaveClass('error')
    })

    it('applies "done" class for completed status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-16',
        phase: '',
        percent: 1.0,
        indeterminate: false,
        status: 'completed'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const statusDiv = container.querySelector('.status')
      expect(statusDiv).toHaveClass('done')
    })

    it('applies "rendering" class for running status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-17',
        phase: 'original-preview',
        percent: 0.4,
        indeterminate: false,
        status: 'running'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const statusDiv = container.querySelector('.status')
      expect(statusDiv).toHaveClass('rendering')
    })

    it('applies "rendering" class for cancelled status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-18',
        phase: 'processed-preview',
        percent: 0.6,
        indeterminate: false,
        status: 'cancelled'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const statusDiv = container.querySelector('.status')
      expect(statusDiv).toHaveClass('rendering')
    })

    it('applies "rendering" class for queued status', () => {
      const job: JobProgressViewState = {
        jobId: 'test-19',
        phase: 'original-preview',
        percent: 0,
        indeterminate: true,
        status: 'queued'
      }
      const { container } = render(<JobProgressBanner currentJob={job} />)
      const statusDiv = container.querySelector('.status')
      expect(statusDiv).toHaveClass('rendering')
    })
  })

  describe('Edge Cases', () => {
    it('rounds percentage to nearest integer', () => {
      const job: JobProgressViewState = {
        jobId: 'test-20',
        phase: 'original-preview',
        percent: 0.456,
        indeterminate: false,
        status: 'running'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Rendering Original... 46%')).toBeInTheDocument()
    })

    it('handles 0% progress', () => {
      const job: JobProgressViewState = {
        jobId: 'test-21',
        phase: 'processed-preview',
        percent: 0.0,
        indeterminate: false,
        status: 'running'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Rendering Processed... 0%')).toBeInTheDocument()
    })

    it('handles 100% progress', () => {
      const job: JobProgressViewState = {
        jobId: 'test-22',
        phase: 'original-preview',
        percent: 1.0,
        indeterminate: false,
        status: 'running'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Rendering Original... 100%')).toBeInTheDocument()
    })

    it('handles empty phase name gracefully', () => {
      const job: JobProgressViewState = {
        jobId: 'test-23',
        phase: '',
        percent: 0.5,
        indeterminate: false,
        status: 'running'
      }
      render(<JobProgressBanner currentJob={job} />)
      expect(screen.getByText('Rendering ... 50%')).toBeInTheDocument()
    })
  })
})
