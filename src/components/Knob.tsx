import { useRef, useCallback, useEffect, useState } from 'react'

interface KnobProps {
  value: number
  min: number
  max: number
  defaultValue: number
  onChange: (value: number) => void
  label: string
  unit?: string
  logarithmic?: boolean
  size?: number
  decimals?: number
  emphasis?: 'primary' | 'secondary' | 'tertiary'
}

export function Knob({
  value,
  min,
  max,
  defaultValue,
  onChange,
  label,
  unit = '',
  logarithmic = false,
  size = 60,
  decimals = 0,
  emphasis = 'secondary'
}: KnobProps) {
  // Visual hierarchy colors based on emphasis
  const ringColor = emphasis === 'primary' ? '#5ad4ff' : emphasis === 'secondary' ? '#4fc3f7' : '#3a9cc4'
  const ringOpacity = emphasis === 'primary' ? 1 : emphasis === 'secondary' ? 0.85 : 0.6
  const trackColor = emphasis === 'primary' ? '#444' : '#333'
  const valueColor = emphasis === 'primary' ? '#eee' : emphasis === 'secondary' ? '#ccc' : '#999'
  const knobRef = useRef<SVGSVGElement>(null)
  const isDragging = useRef(false)
  const startY = useRef(0)
  const startValue = useRef(0)
  const [isFocused, setIsFocused] = useState(false)

  // Convert value to normalized 0-1 range
  const valueToNormalized = useCallback((val: number): number => {
    if (logarithmic) {
      const minLog = Math.log(min)
      const maxLog = Math.log(max)
      return (Math.log(val) - minLog) / (maxLog - minLog)
    }
    return (val - min) / (max - min)
  }, [min, max, logarithmic])

  // Convert normalized 0-1 to actual value
  const normalizedToValue = useCallback((norm: number): number => {
    const clamped = Math.max(0, Math.min(1, norm))
    if (logarithmic) {
      const minLog = Math.log(min)
      const maxLog = Math.log(max)
      return Math.exp(minLog + clamped * (maxLog - minLog))
    }
    return min + clamped * (max - min)
  }, [min, max, logarithmic])

  // Rotation angle (270 degrees total range, from -135 to +135)
  const normalized = valueToNormalized(value)
  const angle = -135 + normalized * 270

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    startY.current = e.clientY
    startValue.current = valueToNormalized(value)
    document.body.style.cursor = 'ns-resize'
  }, [value, valueToNormalized])

  const handleDoubleClick = useCallback(() => {
    onChange(defaultValue)
  }, [defaultValue, onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const stepSize = (max - min) * 0.02 // 2% of range
    const largeStepSize = (max - min) * 0.1 // 10% of range

    let newValue = value
    let handled = false

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        newValue = Math.min(max, value + stepSize)
        handled = true
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        newValue = Math.max(min, value - stepSize)
        handled = true
        break
      case 'Home':
        newValue = min
        handled = true
        break
      case 'End':
        newValue = max
        handled = true
        break
      case 'PageUp':
        newValue = Math.min(max, value + largeStepSize)
        handled = true
        break
      case 'PageDown':
        newValue = Math.max(min, value - largeStepSize)
        handled = true
        break
    }

    if (handled) {
      e.preventDefault()
      onChange(newValue)
    }
  }, [value, min, max, onChange])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return

      const deltaY = startY.current - e.clientY
      const sensitivity = 0.005
      const newNormalized = startValue.current + deltaY * sensitivity
      const newValue = normalizedToValue(newNormalized)
      onChange(newValue)
    }

    const handleMouseUp = () => {
      isDragging.current = false
      document.body.style.cursor = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [normalizedToValue, onChange])

  const displayValue = decimals === 0
    ? Math.round(value)
    : value.toFixed(decimals)

  const cx = size / 2
  const cy = size / 2
  const radius = size * 0.38

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 2,
      userSelect: 'none'
    }}>
      <div style={{
        filter: emphasis === 'primary'
          ? 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))'
          : 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))'
      }}>
        <svg
          ref={knobRef}
          width={size}
          height={size}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          tabIndex={0}
          role="slider"
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          style={{
            cursor: 'pointer',
            outline: isFocused ? `2px solid ${ringColor}` : 'none',
            outlineOffset: '2px',
            borderRadius: '50%'
          }}
        >
          <defs>
            <radialGradient id={`knobGrad-${size}`} cx="30%" cy="30%">
              <stop offset="0%" stopColor="#3a3a3a" />
              <stop offset="100%" stopColor="#1a1a1a" />
            </radialGradient>
            <linearGradient id={`rimGrad-${size}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#666" />
              <stop offset="50%" stopColor="#444" />
              <stop offset="100%" stopColor="#333" />
            </linearGradient>
          </defs>
          {/* Outer bezel - mounting ring */}
          <circle
            cx={cx}
            cy={cy}
            r={radius + 5}
            fill="none"
            stroke={`url(#rimGrad-${size})`}
            strokeWidth={3}
          />
          {/* Background circle */}
          <circle
            cx={cx}
            cy={cy}
            r={radius + 2}
            fill="#0a0a0a"
          />
          {/* Track arc */}
          <path
            d={describeArc(cx, cy, radius, -135, 135)}
            fill="none"
            stroke={trackColor}
            strokeWidth={emphasis === 'primary' ? 5 : 4}
            strokeLinecap="round"
          />
          {/* Value arc */}
          <path
            d={describeArc(cx, cy, radius, -135, angle)}
            fill="none"
            stroke={ringColor}
            strokeWidth={emphasis === 'primary' ? 5 : 4}
            strokeLinecap="round"
            opacity={ringOpacity}
          />
          {/* Knob body with gradient */}
          <circle
            cx={cx}
            cy={cy}
            r={radius - 6}
            fill={`url(#knobGrad-${size})`}
            stroke="#555"
            strokeWidth={1}
          />
          {/* Highlight rim on knob */}
          <circle
            cx={cx}
            cy={cy}
            r={radius - 7}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />
          {/* Indicator line */}
          <line
            x1={cx}
            y1={cy - radius + 12}
            x2={cx}
            y2={cy - 6}
            stroke={ringColor}
            strokeWidth={2}
            strokeLinecap="round"
            opacity={ringOpacity}
            transform={`rotate(${angle}, ${cx}, ${cy})`}
          />
        </svg>
      </div>
      <div style={{ fontSize: 10, color: valueColor, fontWeight: 500 }}>
        {displayValue}{unit}
      </div>
      {label && <div style={{ fontSize: 8, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>}
    </div>
  )
}

// Helper to draw SVG arc
function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
  const rad = (angle - 90) * Math.PI / 180
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad)
  }
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle)
  const end = polarToCartesian(cx, cy, r, startAngle)
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`
}

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer'
      }}
    >
      <div style={{
        width: 16,
        height: 16,
        borderRadius: 2,
        background: checked
          ? 'linear-gradient(180deg, #2a2a2a 0%, #3a3a3a 100%)'
          : 'linear-gradient(180deg, #4a4a4a 0%, #3a3a3a 100%)',
        border: '1px solid #222',
        boxShadow: checked
          ? 'inset 0 2px 4px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.05)'
          : '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        {checked && <div style={{
          width: 6,
          height: 6,
          borderRadius: 1,
          background: '#4fc3f7',
          boxShadow: '0 0 3px rgba(79,195,247,0.6)'
        }} />}
      </div>
      {label && <span style={{ fontSize: 8, color: '#555' }}>{label}</span>}
    </div>
  )
}
