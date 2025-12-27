import { Toggle } from './Knob'
import { Knob } from './Knob'
import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseSamplingParams,
  AutoMixParams,
  AutoMixPreset
} from '../../shared/types'

interface AudioControlsProps {
  bands: EQBand[]
  hpf: FilterParams
  lpf: FilterParams
  compressor: CompressorParams
  noiseSampling: NoiseSamplingParams
  autoMix: AutoMixParams
  onBandUpdate: (index: number, field: keyof EQBand, value: number | boolean) => void
  onHpfChange: (hpf: FilterParams) => void
  onLpfChange: (lpf: FilterParams) => void
  onCompressorChange: (compressor: CompressorParams) => void
  onNoiseSamplingChange: (noiseSampling: NoiseSamplingParams) => void
  onAutoMixChange: (autoMix: AutoMixParams) => void
  onAutoMixPresetChange: (preset: AutoMixPreset) => void
}

export function AudioControls({
  bands,
  hpf,
  lpf,
  compressor,
  noiseSampling,
  autoMix,
  onBandUpdate,
  onHpfChange,
  onLpfChange,
  onCompressorChange,
  onNoiseSamplingChange,
  onAutoMixChange,
  onAutoMixPresetChange
}: AudioControlsProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 0' }}>
      {/* AutoMix Horizontal Bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 16,
        padding: '8px 16px',
        background: `
          linear-gradient(180deg,
            rgba(58,58,64,1) 0%,
            rgba(48,48,54,1) 50%,
            rgba(42,42,48,1) 100%
          )
        `,
        border: '1px solid #555',
        borderRadius: 3,
        boxShadow: `
          0 2px 6px rgba(0,0,0,0.4),
          inset 0 1px 0 rgba(255,255,255,0.08)
        `,
        marginLeft: 'auto',
        marginRight: 'auto'
      }}>
        <span style={{ fontSize: 10, color: '#888', fontWeight: 600, letterSpacing: 2 }}>AUTOMIX</span>
        <Toggle checked={autoMix.enabled} onChange={v => onAutoMixChange({ ...autoMix, enabled: v })} />
        <div style={{ display: 'flex', gap: 4 }}>
          {(['LIGHT', 'MEDIUM', 'HEAVY'] as AutoMixPreset[]).map(preset => (
            <button
              key={preset}
              onClick={() => onAutoMixPresetChange(preset)}
              style={{
                padding: '5px 12px',
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: 0.5,
                border: '1px solid #333',
                borderRadius: 2,
                cursor: 'pointer',
                background: autoMix.preset === preset
                  ? 'linear-gradient(180deg, #3a3a3a 0%, #2a2a2a 100%)'
                  : 'linear-gradient(180deg, #4a4a4a 0%, #3a3a3a 100%)',
                color: autoMix.preset === preset
                  ? (autoMix.enabled ? '#4fc3f7' : '#888')
                  : '#666',
                boxShadow: autoMix.preset === preset
                  ? 'inset 0 2px 4px rgba(0,0,0,0.5), 0 0 4px rgba(79,195,247,0.2)'
                  : '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)',
                opacity: autoMix.enabled ? 1 : 0.5
              }}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      {/* Channel Strips Row */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
      {/* Compressor Strip */}
      <div style={{
        width: 150,
        background: `
          linear-gradient(180deg,
            rgba(68,68,74,1) 0%,
            rgba(54,54,60,1) 8%,
            rgba(48,48,54,1) 50%,
            rgba(42,42,48,1) 92%,
            rgba(34,34,40,1) 100%
          )
        `,
        border: '1px solid #555',
        borderRadius: 3,
        padding: '10px 0',
        boxShadow: `
          0 2px 8px rgba(0,0,0,0.6),
          0 8px 24px rgba(0,0,0,0.4),
          inset 0 1px 0 rgba(255,255,255,0.12),
          inset 0 -1px 0 rgba(0,0,0,0.3)
        `,
        position: 'relative' as const
      }}>
        {/* Noise texture overlay */}
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          opacity: 0.03,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          pointerEvents: 'none'
        }} />

        {/* COMP Header */}
        <div style={{
          textAlign: 'center',
          padding: '4px 0 5px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.05)',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)'
        }}>
          <span style={{ fontSize: 10, color: '#888', fontWeight: 600, letterSpacing: 2 }}>COMP</span>
        </div>

        {/* Noise Sampling Section */}
        <div style={{
          padding: '6px 10px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>NOISE SAMPLING</span>
            <Toggle checked={noiseSampling.enabled} onChange={v => onNoiseSamplingChange({ enabled: v })} />
          </div>
        </div>

        {/* DYNAMICS Section - Threshold (dominant) + Ratio */}
        <div style={{
          padding: '6px 10px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>DYNAMICS</span>
            <Toggle checked={compressor.enabled} onChange={v => onCompressorChange({ ...compressor, enabled: v })} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Knob value={compressor.threshold} min={-60} max={0} defaultValue={-20}
              onChange={v => onCompressorChange({ ...compressor, threshold: v })} label="" unit="dB" size={54} emphasis="primary" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <Knob value={compressor.ratio} min={1} max={20} defaultValue={4}
                onChange={v => onCompressorChange({ ...compressor, ratio: v })} label="" unit=":1" size={38} emphasis="secondary" />
              {/* GR Meter placeholder - visual only based on threshold/ratio */}
              <div style={{
                width: 38,
                height: 38,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                alignItems: 'center',
                background: '#0a0a0a',
                borderRadius: 2,
                border: '1px solid #333',
                padding: 2
              }}>
                {[...Array(6)].map((_, i) => (
                  <div key={i} style={{
                    width: 6,
                    height: 3,
                    marginBottom: 1,
                    borderRadius: 1,
                    background: i < 2 ? '#f44' : i < 4 ? '#fa0' : '#4a4a4a',
                    opacity: compressor.enabled && compressor.mode !== 'LEVEL' ? (i < Math.abs(compressor.threshold) / 10 ? 0.9 : 0.2) : 0.15
                  }} />
                ))}
                <span style={{ fontSize: 6, color: '#555', marginTop: 2 }}>GR</span>
              </div>
            </div>
          </div>
        </div>

        {/* TIMING Section - Attack + Release */}
        <div style={{
          padding: '6px 10px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
        }}>
          <div style={{ marginBottom: 4 }}>
            <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>TIMING</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Knob value={compressor.attack} min={0.1} max={200} defaultValue={10}
              onChange={v => onCompressorChange({ ...compressor, attack: v })} label="ATK" unit="" logarithmic size={42} emphasis="secondary" />
            <Knob value={compressor.release} min={10} max={2000} defaultValue={100}
              onChange={v => onCompressorChange({ ...compressor, release: v })} label="REL" unit="" logarithmic size={42} emphasis="secondary" />
          </div>
        </div>

        {/* DETECTOR Section - Emphasis */}
        <div style={{
          padding: '6px 10px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
        }}>
          <div style={{ marginBottom: 4 }}>
            <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>DETECTOR</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Knob value={compressor.emphasis} min={20} max={2000} defaultValue={20}
              onChange={v => onCompressorChange({ ...compressor, emphasis: v })} label="EMPH" unit="" logarithmic size={42} emphasis="tertiary" />
          </div>
        </div>

        {/* OUTPUT Section - Makeup */}
        <div style={{
          padding: '6px 10px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
        }}>
          <div style={{ marginBottom: 4 }}>
            <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>OUTPUT</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Knob value={compressor.makeup} min={-20} max={20} defaultValue={0}
              onChange={v => onCompressorChange({ ...compressor, makeup: v })} label="GAIN" unit="dB" size={42} emphasis="secondary" />
          </div>
        </div>

        {/* MODE Buttons */}
        <div style={{
          padding: '8px 10px',
          display: 'flex',
          justifyContent: 'center',
          gap: 4
        }}>
          {(['LEVEL', 'COMP', 'LIMIT'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => onCompressorChange({ ...compressor, mode })}
              style={{
                padding: '4px 8px',
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: 0.5,
                border: '1px solid #333',
                borderRadius: 2,
                cursor: 'pointer',
                background: compressor.mode === mode
                  ? 'linear-gradient(180deg, #3a3a3a 0%, #2a2a2a 100%)'
                  : 'linear-gradient(180deg, #4a4a4a 0%, #3a3a3a 100%)',
                color: compressor.mode === mode ? '#4fc3f7' : '#888',
                boxShadow: compressor.mode === mode
                  ? 'inset 0 2px 4px rgba(0,0,0,0.5), 0 0 4px rgba(79,195,247,0.2)'
                  : '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)'
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* EQ Section - Channel Strip Faceplate */}
      <div style={{
        width: 168,
        background: `
          linear-gradient(180deg,
            rgba(72,72,78,1) 0%,
            rgba(58,58,64,1) 8%,
            rgba(52,52,58,1) 50%,
            rgba(46,46,52,1) 92%,
            rgba(38,38,44,1) 100%
          )
        `,
        border: '1px solid #555',
        borderRadius: 3,
        padding: '10px 0',
        boxShadow: `
          0 2px 8px rgba(0,0,0,0.6),
          0 8px 24px rgba(0,0,0,0.4),
          inset 0 1px 0 rgba(255,255,255,0.12),
          inset 0 -1px 0 rgba(0,0,0,0.3)
        `,
        position: 'relative' as const
      }}>
        {/* Noise texture overlay */}
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          opacity: 0.03,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          pointerEvents: 'none'
        }} />
        {/* EQ Header */}
        <div style={{
          textAlign: 'center',
          padding: '4px 0 5px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.05)',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)'
        }}>
          <span style={{ fontSize: 10, color: '#888', fontWeight: 600, letterSpacing: 2 }}>EQ</span>
        </div>

        {/* HI Band */}
        <div style={{
          padding: '6px 10px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 9, color: '#777', fontWeight: 600, letterSpacing: 1 }}>HI</span>
            <Toggle checked={bands[2].enabled} onChange={v => onBandUpdate(2, 'enabled', v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Knob value={bands[2].frequency} min={20} max={20000} defaultValue={5000}
              onChange={v => onBandUpdate(2, 'frequency', v)} label="" unit="" logarithmic size={54} emphasis="primary" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <Knob value={bands[2].q} min={0.1} max={10} defaultValue={1.0}
                onChange={v => onBandUpdate(2, 'q', v)} label="" decimals={1} size={38} emphasis="tertiary" />
              <Knob value={bands[2].gain} min={-24} max={24} defaultValue={0}
                onChange={v => onBandUpdate(2, 'gain', v)} label="" unit="" decimals={0} size={38} emphasis="secondary" />
            </div>
          </div>
        </div>

        {/* MID Band */}
        <div style={{
          padding: '6px 10px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 9, color: '#777', fontWeight: 600, letterSpacing: 1 }}>MID</span>
            <Toggle checked={bands[1].enabled} onChange={v => onBandUpdate(1, 'enabled', v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Knob value={bands[1].frequency} min={20} max={20000} defaultValue={1000}
              onChange={v => onBandUpdate(1, 'frequency', v)} label="" unit="" logarithmic size={54} emphasis="primary" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <Knob value={bands[1].q} min={0.1} max={10} defaultValue={1.0}
                onChange={v => onBandUpdate(1, 'q', v)} label="" decimals={1} size={38} emphasis="tertiary" />
              <Knob value={bands[1].gain} min={-24} max={24} defaultValue={0}
                onChange={v => onBandUpdate(1, 'gain', v)} label="" unit="" decimals={0} size={38} emphasis="secondary" />
            </div>
          </div>
        </div>

        {/* LO Band */}
        <div style={{
          padding: '6px 10px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 9, color: '#777', fontWeight: 600, letterSpacing: 1 }}>LO</span>
            <Toggle checked={bands[0].enabled} onChange={v => onBandUpdate(0, 'enabled', v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Knob value={bands[0].frequency} min={20} max={20000} defaultValue={200}
              onChange={v => onBandUpdate(0, 'frequency', v)} label="" unit="" logarithmic size={54} emphasis="primary" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <Knob value={bands[0].q} min={0.1} max={10} defaultValue={1.0}
                onChange={v => onBandUpdate(0, 'q', v)} label="" decimals={1} size={38} emphasis="tertiary" />
              <Knob value={bands[0].gain} min={-24} max={24} defaultValue={0}
                onChange={v => onBandUpdate(0, 'gain', v)} label="" unit="" decimals={0} size={38} emphasis="secondary" />
            </div>
          </div>
        </div>

        {/* HP / LP Filters */}
        <div style={{
          padding: '6px 10px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          background: 'linear-gradient(180deg, rgba(0,0,0,0.06) 0%, transparent 50%)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 8, color: '#666', fontWeight: 600, width: 14 }}>HP</span>
            <Knob value={hpf.frequency} min={20} max={2000} defaultValue={80}
              onChange={v => onHpfChange({ ...hpf, frequency: v })} label="" unit="" logarithmic size={36} emphasis="tertiary" />
            <Toggle checked={hpf.enabled} onChange={v => onHpfChange({ ...hpf, enabled: v })} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 8, color: '#666', fontWeight: 600, width: 14 }}>LP</span>
            <Knob value={lpf.frequency} min={1000} max={20000} defaultValue={12000}
              onChange={v => onLpfChange({ ...lpf, frequency: v })} label="" unit="" logarithmic size={36} emphasis="tertiary" />
            <Toggle checked={lpf.enabled} onChange={v => onLpfChange({ ...lpf, enabled: v })} />
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
