import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Knob } from '../Knob'

describe('Knob', () => {
  const defaultProps = {
    value: 50,
    min: 0,
    max: 100,
    defaultValue: 50,
    onChange: vi.fn(),
    label: 'Test Knob'
  }

  it('renders with correct ARIA attributes', () => {
    render(<Knob {...defaultProps} />)
    const slider = screen.getByRole('slider')

    expect(slider).toHaveAttribute('aria-label', 'Test Knob')
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '100')
    expect(slider).toHaveAttribute('aria-valuenow', '50')
  })

  it('is focusable with tabIndex', () => {
    render(<Knob {...defaultProps} />)
    const slider = screen.getByRole('slider')

    expect(slider).toHaveAttribute('tabindex', '0')
  })

  describe('keyboard navigation', () => {
    it('increases value with ArrowUp', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'ArrowUp' })

      expect(onChange).toHaveBeenCalled()
      const newValue = onChange.mock.calls[0][0]
      expect(newValue).toBeGreaterThan(50)
    })

    it('increases value with ArrowRight', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'ArrowRight' })

      expect(onChange).toHaveBeenCalled()
      const newValue = onChange.mock.calls[0][0]
      expect(newValue).toBeGreaterThan(50)
    })

    it('decreases value with ArrowDown', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'ArrowDown' })

      expect(onChange).toHaveBeenCalled()
      const newValue = onChange.mock.calls[0][0]
      expect(newValue).toBeLessThan(50)
    })

    it('decreases value with ArrowLeft', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'ArrowLeft' })

      expect(onChange).toHaveBeenCalled()
      const newValue = onChange.mock.calls[0][0]
      expect(newValue).toBeLessThan(50)
    })

    it('sets value to minimum with Home key', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'Home' })

      expect(onChange).toHaveBeenCalledWith(0)
    })

    it('sets value to maximum with End key', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'End' })

      expect(onChange).toHaveBeenCalledWith(100)
    })

    it('increases value by large step with PageUp', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'PageUp' })

      expect(onChange).toHaveBeenCalled()
      const newValue = onChange.mock.calls[0][0]
      expect(newValue).toBeGreaterThan(55) // Should be ~60 (50 + 10%)
    })

    it('decreases value by large step with PageDown', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'PageDown' })

      expect(onChange).toHaveBeenCalled()
      const newValue = onChange.mock.calls[0][0]
      expect(newValue).toBeLessThan(45) // Should be ~40 (50 - 10%)
    })

    it('respects minimum boundary', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} value={0} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'ArrowDown' })

      expect(onChange).toHaveBeenCalledWith(0)
    })

    it('respects maximum boundary', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} value={100} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'ArrowUp' })

      expect(onChange).toHaveBeenCalledWith(100)
    })

    it('prevents default behavior for handled keys', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      // ArrowUp should trigger onChange, which means the key was handled
      fireEvent.keyDown(slider, { key: 'ArrowUp' })
      expect(onChange).toHaveBeenCalled()

      // Verify that unhandled keys don't trigger onChange
      onChange.mockClear()
      fireEvent.keyDown(slider, { key: 'q' })
      expect(onChange).not.toHaveBeenCalled()
    })

    it('does not handle unrecognized keys', () => {
      const onChange = vi.fn()
      render(<Knob {...defaultProps} onChange={onChange} />)
      const slider = screen.getByRole('slider')

      fireEvent.keyDown(slider, { key: 'a' })

      expect(onChange).not.toHaveBeenCalled()
    })
  })

  describe('focus indicator', () => {
    it('shows focus outline when focused', () => {
      render(<Knob {...defaultProps} />)
      const slider = screen.getByRole('slider')

      fireEvent.focus(slider)

      expect(slider).toHaveStyle({ outline: '2px solid #4fc3f7' })
    })

    it('hides focus outline when blurred', () => {
      render(<Knob {...defaultProps} />)
      const slider = screen.getByRole('slider')

      fireEvent.focus(slider)
      fireEvent.blur(slider)

      expect(slider).toHaveStyle({ outline: 'none' })
    })

    it('uses emphasis color for focus outline', () => {
      render(<Knob {...defaultProps} emphasis="primary" />)
      const slider = screen.getByRole('slider')

      fireEvent.focus(slider)

      expect(slider).toHaveStyle({ outline: '2px solid #5ad4ff' })
    })
  })
})
