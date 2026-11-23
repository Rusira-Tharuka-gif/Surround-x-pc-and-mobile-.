import { useEffect, useRef, type CSSProperties } from 'react';
import { Radio, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { ChannelConfig, ChannelId, ExportFormat } from '../utils/audioTypes';
import {
  clampGainDb,
  computeEffectiveChannelGains,
  get8dAzimuthDegrees,
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  wrapAzimuth180,
  wrapAzimuth360,
  type TrackEnergyFrame,
} from '../utils/channelMath';
import { ZERO_LEVELS, type ChannelLevels } from '../utils/stageAudioPlayer';
import {
  SpeakerStage3D,
  type SpeakerRingRefs,
} from './SpeakerStage3D';
import { GlowingWaveVisualizer } from './GlowingWaveVisualizer';

export type StageActivityMode = 'idle' | 'loaded' | 'playing' | 'converting' | 'sweeping';

interface AcousticStageMonitorProps {
  channels: ChannelConfig[];
  liveLevelsRef: React.MutableRefObject<ChannelLevels>;
  energyProfile: TrackEnergyFrame[];
  activityMode: StageActivityMode;
  spatialMode?: ExportFormat;
  selectedChannel: ChannelId;
  activeSweepChannel: ChannelId | null;
  onSelectChannel: (id: ChannelId) => void;
  onUpdateGain: (id: ChannelId, gainDb: number) => void;
  onToggleMute: (id: ChannelId) => void;
  onToggleSolo: (id: ChannelId) => void;
  onTriggerCalibrationTone: (id: ChannelId) => void;
  onRunSweep: () => void;
  onResetChannels: () => void;
}

const MODE_LABELS: Record<StageActivityMode, string> = {
  idle: 'Standby · Load audio to activate',
  loaded: 'Track Loaded · Console Ready',
  playing: 'Live Playback · Audio Reactive',
  converting: 'Encoding 5.1 AC3 · Active Matrix',
  sweeping: 'Channel Calibration Sweep',
};

export function AcousticStageMonitor({
  channels,
  liveLevelsRef,
  energyProfile,
  activityMode,
  spatialMode = 'ac3',
  selectedChannel,
  activeSweepChannel,
  onSelectChannel,
  onUpdateGain,
  onToggleMute,
  onToggleSolo,
  onTriggerCalibrationTone,
  onRunSweep,
  onResetChannels,
}: AcousticStageMonitorProps) {
  const effectiveGains = computeEffectiveChannelGains(channels);

  const meterRefs = useRef<Partial<Record<ChannelId, HTMLDivElement | null>>>({});
  const smoothedRef = useRef<Record<ChannelId, number>>({
    FL: 0,
    FR: 0,
    C: 0,
    LFE: 0,
    SL: 0,
    SR: 0,
  });
  const lastRenderedRef = useRef<Record<ChannelId, number>>({
    FL: -1,
    FR: -1,
    C: -1,
    LFE: -1,
    SL: -1,
    SR: -1,
  });
  const ringRefs = useRef<SpeakerRingRefs>({
    coreRing: { FL: null, FR: null, C: null, LFE: null, SL: null, SR: null },
    coreGlow: { FL: null, FR: null, C: null, LFE: null, SL: null, SR: null },
    driverCone: { FL: null, FR: null, C: null, LFE: null, SL: null, SR: null },
    lfePortGlow: null,
  });

  const stateRef = useRef({
    channels,
    effectiveGains,
    energyProfile,
    activityMode,
    spatialMode,
    selectedChannel,
    activeSweepChannel,
  });
  stateRef.current = {
    channels,
    effectiveGains,
    energyProfile,
    activityMode,
    spatialMode,
    selectedChannel,
    activeSweepChannel,
  };

  useEffect(() => {
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let rafId = 0;
    let lastNow = performance.now();
    let lastFramePaint = 0;

    const applyVisualFrame = (now: number, force = false) => {
      const {
        channels: curChannels,
        effectiveGains: gains,
        energyProfile: profile,
        activityMode: mode,
        spatialMode: curSpatialMode,
        activeSweepChannel: sweepCh,
      } = stateRef.current;

      // Cap visual updates cleanly at ~48fps (20ms) on 120Hz mobile screens while staying buttery smooth
      if (!force && now - lastFramePaint < 20) {
        if ((mode === 'playing' || mode === 'converting' || mode === 'sweeping') && !reducedMotion) {
          rafId = requestAnimationFrame((ts) => applyVisualFrame(ts, false));
        }
        return;
      }
      lastFramePaint = now;

      const dt = Math.min(0.05, Math.max(0.008, (now - lastNow) * 0.001));
      lastNow = now;
      const frameNorm = dt * 60;
      const t = now * 0.001;
      let currentLevels: ChannelLevels = ZERO_LEVELS;

      if (mode === 'playing') {
        currentLevels = liveLevelsRef.current;
      } else if (mode === 'sweeping' && sweepCh) {
        const sweepPulse = reducedMotion ? 0.9 : 0.8 + 0.2 * Math.sin(t * 14);
        currentLevels = {
          FL: sweepCh === 'FL' ? sweepPulse : 0.05,
          FR: sweepCh === 'FR' ? sweepPulse : 0.05,
          C: sweepCh === 'C' ? sweepPulse : 0.05,
          LFE: sweepCh === 'LFE' ? Math.min(1, sweepPulse + 0.06) : 0.05,
          SL: sweepCh === 'SL' ? sweepPulse : 0.05,
          SR: sweepCh === 'SR' ? sweepPulse : 0.05,
          lfeBeat: sweepCh === 'LFE' ? Math.min(1, sweepPulse + 0.06) : 0.05,
        };
      } else if (mode === 'loaded') {
        currentLevels = ZERO_LEVELS;
      } else if (mode === 'converting') {
        const beatWave = reducedMotion
          ? 0.6
          : Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2.2), 2);
        if (curSpatialMode === '8d-spatial' && !reducedMotion) {
          const progress = (t * 0.125) % 1.0;
          const azimuthDeg = get8dAzimuthDegrees(progress);
          const computeProximity = (targetDeg: number, aperture = 65): number => {
            const diff = Math.abs(wrapAzimuth180(azimuthDeg - targetDeg));
            if (diff >= aperture) return 0;
            const norm = diff / aperture;
            return Math.pow(Math.cos(norm * Math.PI * 0.5), 2);
          };
          const wC = computeProximity(0, 65);
          const wFL = computeProximity(-30, 65);
          const wSL = computeProximity(-110, 75);
          const wSR = computeProximity(110, 75);
          const wFR = computeProximity(30, 65);

          currentLevels = {
            FL: 0.18 + 0.78 * wFL,
            FR: 0.18 + 0.78 * wFR,
            C: 0.18 + 0.80 * wC,
            LFE: 0.42 + 0.48 * beatWave,
            SL: 0.18 + 0.78 * wSL,
            SR: 0.18 + 0.78 * wSR,
            lfeBeat: 0.78 * beatWave,
            orbitAngleDeg: wrapAzimuth360(azimuthDeg),
          };
        } else if (profile.length > 0) {
          const idx = Math.floor((t * 12) % profile.length);
          const frame = profile[idx];
          currentLevels = {
            FL: Math.min(1, frame.FL * 0.92),
            FR: Math.min(1, frame.FR * 0.92),
            C: Math.min(1, frame.C * 0.92),
            LFE: Math.min(1, frame.LFE * 0.94 + beatWave * 0.28),
            SL: Math.min(1, frame.SL * 0.9),
            SR: Math.min(1, frame.SR * 0.9),
            lfeBeat: Math.min(1, Math.max(frame.lfeBeat * 0.96, beatWave * 0.82)),
          };
        } else {
          currentLevels = {
            FL: 0.56,
            FR: 0.56,
            C: 0.52,
            LFE: 0.48 + 0.44 * beatWave,
            SL: 0.48,
            SR: 0.48,
            lfeBeat: 0.78 * beatWave,
          };
        }
      }

      const smoothed = smoothedRef.current;
      const lastRendered = lastRenderedRef.current;
      const isInactive = mode === 'idle' || mode === 'loaded';

      for (const ch of curChannels) {
        const gain = gains[ch.id];
        const muted = gain <= 0.001;
        const isLfe = ch.id === 'LFE';

        const raw = isInactive
          ? 0
          : isLfe
            ? currentLevels.lfeBeat * 0.68 + currentLevels.LFE * 0.32
            : currentLevels[ch.id] ?? 0;
        const target =
          muted || isInactive
            ? 0
            : Math.min(
                0.98,
                raw * (isLfe ? Math.min(1.26, Math.max(0.12, gain)) : Math.min(1.35, Math.max(0.12, gain))),
              );

        const prev = smoothed[ch.id];
        const attackRate = Math.min(1, (isLfe ? 0.84 : 0.7) * frameNorm);
        const releaseRate = Math.min(1, (isLfe ? 0.24 : 0.26) * frameNorm);
        const nextSmooth = isInactive
          ? 0
          : target >= prev
            ? prev + (target - prev) * attackRate
            : prev + (target - prev) * releaseRate;
        smoothed[ch.id] = muted || isInactive ? 0 : Math.max(0, Math.min(1, nextSmooth));

        const smoothE = smoothed[ch.id];
        const activeE = isInactive
          ? 0
          : isLfe
            ? Math.min(1, smoothE * 0.78 + Math.pow(smoothE, 1.32) * 0.22)
            : smoothE;

        // Soft-knee perceptual boost so subtle passages & smaller speakers react visibly without clipping
        const responsiveE =
          isInactive || muted ? 0 : Math.min(1, Math.pow(activeE, 0.68) * 1.15);

        // Skip redundant GPU style writes when quantized amplitude is unchanged
        const quantized = muted || isInactive ? (muted ? -0.5 : 0) : Math.round(responsiveE * 200) / 200;
        if (!force && lastRendered[ch.id] === quantized) {
          continue;
        }
        lastRendered[ch.id] = quantized;

        // 1. GPU-composited meter bar via transform: scaleX() (zero layout reflow)
        const meterEl = meterRefs.current[ch.id];
        if (meterEl) {
          const meterScale = isInactive || muted ? 0 : Math.min(1, responsiveE);
          meterEl.style.transform = `scaleX(${meterScale.toFixed(3)})`;
        }

        // 2. Inner speaker center driver ring (GPU transform: scale3d() + opacity)
        const coreRing = ringRefs.current.coreRing[ch.id];
        if (coreRing) {
          if (muted) {
            coreRing.style.transform = 'scale3d(1, 1, 1)';
            coreRing.style.opacity = '0.18';
          } else {
            const ringScale = reducedMotion ? 1 : 1 + responsiveE * (isLfe ? 0.25 : 0.22);
            coreRing.style.transform = `scale3d(${ringScale.toFixed(3)}, ${ringScale.toFixed(3)}, 1)`;
            coreRing.style.opacity = Math.min(1, 0.42 + responsiveE * 0.58).toFixed(2);
          }
        }

        // 3. Inner woofer glow halo (GPU transform: scale3d() + opacity, zero SVG blur filters)
        const coreGlow = ringRefs.current.coreGlow[ch.id];
        if (coreGlow) {
          if (muted || isInactive || responsiveE <= 0.02 || reducedMotion) {
            coreGlow.style.opacity = '0';
            coreGlow.style.transform = 'scale3d(0.75, 0.75, 1)';
          } else {
            const glowScale = 0.75 + responsiveE * 0.48;
            coreGlow.style.transform = `scale3d(${glowScale.toFixed(3)}, ${glowScale.toFixed(3)}, 1)`;
            coreGlow.style.opacity = Math.min(0.95, responsiveE * 0.94).toFixed(2);
          }
        }

        // 4. Inner physical driver cone bass/signal excursion (GPU transform: scale3d())
        const coneEl = ringRefs.current.driverCone[ch.id];
        if (coneEl) {
          const excursion = muted || reducedMotion ? 1 : 1 + responsiveE * (isLfe ? 0.18 : 0.12);
          coneEl.style.transform =
            excursion <= 1.002
              ? 'scale3d(1, 1, 1)'
              : `scale3d(${excursion.toFixed(3)}, ${excursion.toFixed(3)}, 1)`;
        }

        // 5. LFE recessed bass-reflex port pressure glow (GPU transform + opacity)
        if (isLfe) {
          const portGlow = ringRefs.current.lfePortGlow;
          if (portGlow) {
            if (muted || isInactive || responsiveE <= 0.04 || reducedMotion) {
              portGlow.style.opacity = '0';
              portGlow.style.transform = 'scale3d(0.8, 0.8, 1)';
            } else {
              const portScale = 0.8 + responsiveE * 0.95;
              portGlow.style.transform = `scale3d(${portScale.toFixed(3)}, ${portScale.toFixed(3)}, 1)`;
              portGlow.style.opacity = Math.min(0.94, responsiveE * 0.92).toFixed(2);
            }
          }
        }
      }

      if ((mode === 'playing' || mode === 'converting' || mode === 'sweeping') && !reducedMotion) {
        rafId = requestAnimationFrame((ts) => applyVisualFrame(ts, false));
      }
    };

    applyVisualFrame(performance.now(), true);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [activityMode, activeSweepChannel, liveLevelsRef]);

  // Keep muted/unmuted ring styling synced immediately while paused or idle without restarting rAF
  useEffect(() => {
    if (activityMode !== 'idle' && activityMode !== 'loaded') return;
    for (const ch of channels) {
      const muted = effectiveGains[ch.id] <= 0.001;
      const coreRing = ringRefs.current.coreRing[ch.id];
      if (coreRing) {
        coreRing.style.transform = 'scale3d(1, 1, 1)';
        coreRing.style.opacity = muted ? '0.18' : '0.42';
      }
      const coreGlow = ringRefs.current.coreGlow[ch.id];
      if (coreGlow) {
        coreGlow.style.opacity = '0';
        coreGlow.style.transform = 'scale3d(0.75, 0.75, 1)';
      }
      const meterEl = meterRefs.current[ch.id];
      if (meterEl) {
        meterEl.style.transform = 'scaleX(0)';
      }
    }
  }, [activityMode, channels, effectiveGains]);

  return (
    <section
      id="stage-monitor"
      aria-label="Acoustic Stage Monitor"
      className="glass-panel acoustic-stage-monitor rounded-2xl p-4 sm:p-5 flex flex-col gap-4 w-full min-w-0 max-w-full overflow-hidden"
      data-testid="acoustic-stage-monitor"
      data-activity-mode={activityMode}
    >
      {/* Console Header */}
      <div className="acoustic-stage-header flex flex-wrap items-center justify-between gap-3 border-b border-cyan-400/20 pb-3.5 min-w-0">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg sm:text-xl font-semibold text-white tracking-tight">
            Acoustic Stage Monitor
          </h2>
          <p className="text-xs text-slate-300/85 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
            <span className="sm:whitespace-nowrap">3D 5.1 Home Theater Stage</span>
            <span className="text-cyan-400/50 hidden sm:inline" aria-hidden="true">·</span>
            <span className="font-mono text-[#00F0FF]/95 sm:whitespace-nowrap break-words">
              {activityMode === 'converting'
                ? spatialMode === '8d-spatial'
                  ? 'Encoding 8D Spatial Binaural · Clockwise Orbit'
                  : spatialMode === 'dts'
                    ? 'Encoding 5.1 DTS · Active Matrix'
                    : 'Encoding 5.1 AC3 · Active Matrix'
                : MODE_LABELS[activityMode]}
            </span>
          </p>
        </div>

        <div className="acoustic-stage-actions flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onRunSweep}
            className="hardware-btn inline-flex items-center justify-center gap-1.5 px-3 sm:px-3.5 py-2 min-h-[40px] rounded-lg text-xs font-medium text-cyan-100 transition-colors cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-cyan-300"
          >
            <Radio className="w-3.5 h-3.5 text-[#00F0FF] shrink-0" aria-hidden="true" />
            <span className="truncate">{activeSweepChannel ? `Sweeping ${activeSweepChannel}` : 'Channel Sweep'}</span>
          </button>

          <button
            type="button"
            onClick={onResetChannels}
            aria-label="Reset all 6 channel gains, mutes, and solos"
            className="hardware-btn inline-flex items-center justify-center gap-1.5 px-3 sm:px-3.5 py-2 min-h-[40px] rounded-lg text-xs font-medium text-slate-200 hover:text-white transition-colors cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-sky-300"
          >
            <RotateCcw className="w-3.5 h-3.5 text-slate-300 shrink-0" aria-hidden="true" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* Unified 3D Speaker Stage + Hardware Channel Controller Bay */}
      <div className="acoustic-stage-body flex flex-col gap-3.5 w-full min-w-0">
        <SpeakerStage3D
          channels={channels}
          effectiveGains={effectiveGains}
          selectedChannel={selectedChannel}
          activeSweepChannel={activeSweepChannel}
          isAudioActive={
            activityMode === 'playing' ||
            activityMode === 'converting' ||
            activityMode === 'sweeping'
          }
          ringRefs={ringRefs}
          onSelectSpeaker={(id) => {
            onSelectChannel(id);
            onTriggerCalibrationTone(id);
          }}
        />

        {/* Responsive Single Glowing Wave Line Visualizer */}
        <GlowingWaveVisualizer
          liveLevelsRef={liveLevelsRef}
          energyProfile={energyProfile}
          activityMode={activityMode}
        />

        {/* 6-Channel Precision Hardware Strips */}
        <div className="acoustic-channel-grid grid grid-cols-1 lg:grid-cols-2 gap-3.5 w-full min-w-0">
          {channels.map((ch) => {
            const isMuted = effectiveGains[ch.id] <= 0.001;
            const isSelected = selectedChannel === ch.id;
            const isSwept = activeSweepChannel === ch.id;
            const isLfe = ch.id === 'LFE';
            const isCenter = ch.id === 'C';
            const isSurround = ch.id === 'SL' || ch.id === 'SR';

            const activeCardClass = isSelected || isSwept
              ? isLfe
                ? 'border-emerald-400/75 shadow-[0_0_24px_-8px_rgba(52,211,153,0.48)]'
                : isCenter
                  ? 'border-amber-400/75 shadow-[0_0_24px_-8px_rgba(251,191,36,0.48)]'
                  : isSurround
                    ? 'border-violet-400/75 shadow-[0_0_24px_-8px_rgba(168,85,247,0.48)]'
                    : 'border-[#00F0FF]/75 shadow-[0_0_24px_-8px_rgba(0,240,255,0.48)]'
              : 'hover:border-cyan-400/35';

            const badgeClass = isLfe
              ? isSelected || isSwept
                ? 'hardware-badge-lfe-active text-emerald-100'
                : 'hardware-badge-lfe text-emerald-300'
              : isCenter
                ? isSelected || isSwept
                  ? 'hardware-badge-amber-active text-amber-100'
                  : 'hardware-badge-amber text-amber-300'
                : isSurround
                  ? isSelected || isSwept
                    ? 'hardware-badge-violet-active text-violet-100'
                    : 'hardware-badge-violet text-violet-300'
                  : isSelected || isSwept
                    ? 'hardware-badge-active text-cyan-100'
                    : 'hardware-badge text-[#00F0FF]';

            const meterGradientClass = isLfe
              ? 'bg-gradient-to-r from-emerald-600 via-emerald-400 to-teal-200'
              : isCenter
                ? 'bg-gradient-to-r from-amber-600 via-amber-400 to-yellow-200'
                : isSurround
                  ? 'bg-gradient-to-r from-purple-600 via-violet-400 to-fuchsia-200'
                  : 'bg-gradient-to-r from-cyan-600 via-cyan-400 to-[#00F0FF]';

            const sliderToneClass = isLfe
              ? 'studio-slider-lfe'
              : isCenter
                ? 'studio-slider-amber'
                : isSurround
                  ? 'studio-slider-violet'
                  : '';

            const dbToneClass = Math.abs(clampGainDb(ch.gainDb)) > 0.05
              ? isLfe
                ? 'text-emerald-300 hover:bg-emerald-500/15'
                : isCenter
                  ? 'text-amber-300 hover:bg-amber-500/15'
                  : isSurround
                    ? 'text-violet-300 hover:bg-violet-500/15'
                    : 'text-cyan-300 hover:bg-cyan-500/15'
              : 'text-slate-200/90 hover:text-white';

            return (
              <div
                key={ch.id}
                data-testid={`channel-card-${ch.id}`}
                className={`acoustic-channel-card glass-subpanel rounded-xl p-3.5 sm:p-4 flex flex-col gap-3 transition-colors min-w-0 w-full ${activeCardClass}`}
              >
                {/* Row 1: Channel Identity + Mute / Solo / Tone Buttons */}
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectChannel(ch.id);
                      onTriggerCalibrationTone(ch.id);
                    }}
                    className="flex items-center gap-2 sm:gap-2.5 text-left group cursor-pointer focus-visible:outline-2 focus-visible:outline-sky-300 rounded-lg min-w-0 flex-1"
                  >
                    <span
                      className={`inline-flex items-center justify-center min-w-[2.25rem] sm:min-w-[2.4rem] h-8 px-1.5 rounded-lg font-mono text-[11px] font-bold tracking-wider shrink-0 transition-colors ${badgeClass}`}
                    >
                      {ch.shortName}
                    </span>

                    <div className="min-w-0 flex-1">
                      <span className="text-xs sm:text-[13px] font-semibold text-slate-100 group-hover:text-white block leading-tight truncate">
                        {ch.label}
                      </span>
                      <span className="text-[11px] font-mono text-slate-400 block leading-tight mt-1 truncate">
                        {ch.angleLabel}
                      </span>
                    </div>
                  </button>

                  <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onToggleMute(ch.id)}
                      aria-label={`${ch.muted ? 'Unmute' : 'Mute'} ${ch.label}`}
                      aria-pressed={ch.muted}
                      className={`w-8 h-8 rounded-lg font-mono text-[11px] font-semibold flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-sky-300 ${
                        ch.muted
                          ? 'hardware-btn-mute-active text-rose-100'
                          : 'hardware-btn text-slate-200 hover:text-white'
                      }`}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleSolo(ch.id)}
                      aria-label={`${ch.solo ? 'Unsolo' : 'Solo'} ${ch.label}`}
                      aria-pressed={ch.solo}
                      className={`w-8 h-8 rounded-lg font-mono text-[11px] font-semibold flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-sky-300 ${
                        ch.solo
                          ? 'hardware-btn-solo-active text-amber-100'
                          : 'hardware-btn text-slate-200 hover:text-white'
                      }`}
                    >
                      S
                    </button>
                    <button
                      type="button"
                      onClick={() => onTriggerCalibrationTone(ch.id)}
                      aria-label={`Play calibration tone for ${ch.label}`}
                      className="hardware-btn w-8 h-8 rounded-lg text-cyan-300 hover:text-white flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-sky-300"
                    >
                      {isMuted ? (
                        <VolumeX className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                      ) : (
                        <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Row 2: Dedicated Recessed GPU-Composited Signal Level Meter */}
                <div
                  className="w-full h-2 rounded-full bg-[#05070B] border border-slate-800/95 shadow-inner overflow-hidden p-[1px]"
                  aria-hidden="true"
                  data-testid={`channel-meter-${ch.id}`}
                >
                  <div
                    ref={(el) => {
                      meterRefs.current[ch.id] = el;
                    }}
                    className={`w-full h-full rounded-full origin-left will-change-transform ${meterGradientClass}`}
                    style={{ transform: 'scaleX(0)' }}
                  />
                </div>

                {/* Row 3: Dedicated Machined Gain Fader Row */}
                {(() => {
                  const safeGainDb = clampGainDb(ch.gainDb);
                  const sliderFillPct = Math.max(
                    0,
                    Math.min(100, ((safeGainDb - MIN_GAIN_DB) / (MAX_GAIN_DB - MIN_GAIN_DB)) * 100),
                  );
                  const sliderStyle = {
                    '--slider-pct': `${sliderFillPct.toFixed(1)}%`,
                  } as CSSProperties;

                  return (
                    <div
                      className="flex items-center gap-2 sm:gap-3 min-w-0 w-full min-h-[28px]"
                      data-testid={`channel-slider-row-${ch.id}`}
                    >
                      <label htmlFor={`gain-${ch.id}`} className="sr-only">
                        {ch.label} Gain in decibels
                      </label>
                      <input
                        id={`gain-${ch.id}`}
                        type="range"
                        min={MIN_GAIN_DB}
                        max={MAX_GAIN_DB}
                        step={0.5}
                        value={safeGainDb}
                        style={sliderStyle}
                        title="Drag to adjust gain · Double-click to reset to 0.0 dB"
                        onChange={(e) => {
                          const nextVal = Number(e.target.value);
                          if (Number.isFinite(nextVal)) {
                            onUpdateGain(ch.id, nextVal);
                          }
                        }}
                        onDoubleClick={() => onUpdateGain(ch.id, 0)}
                        className={`studio-slider flex-1 min-w-0 w-full ${sliderToneClass}`}
                      />
                      <button
                        type="button"
                        onClick={() => onUpdateGain(ch.id, 0)}
                        aria-label={`Reset ${ch.label} gain to 0 dB (current ${safeGainDb.toFixed(1)} dB)`}
                        title={safeGainDb !== 0 ? 'Tap to reset gain to 0.0 dB' : 'Channel gain at 0.0 dB'}
                        className={`font-mono text-xs tabular-nums w-[3.9rem] sm:w-[4.25rem] text-right shrink-0 whitespace-nowrap rounded px-1 py-0.5 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-sky-300 ${dbToneClass}`}
                      >
                        {safeGainDb > 0 ? `+${safeGainDb.toFixed(1)}` : safeGainDb.toFixed(1)} dB
                      </button>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
