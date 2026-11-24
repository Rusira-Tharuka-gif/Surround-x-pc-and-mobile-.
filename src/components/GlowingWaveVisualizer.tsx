import { useEffect, useRef } from 'react';
import type { ChannelLevels } from '../utils/stageAudioPlayer';
import type { TrackEnergyFrame } from '../utils/channelMath';
import {
  computeEdgeTaper,
  computeWaveEnergy,
  stepFullWidthStudioWave,
  STUDIO_BAND_COUNT,
  synthesizeChannelBands,
  type FullWidthWaveState,
} from '../utils/waveMath';

export type WaveActivityMode = 'idle' | 'loaded' | 'playing' | 'converting' | 'sweeping';

interface GlowingWaveVisualizerProps {
  liveLevelsRef: React.MutableRefObject<ChannelLevels>;
  energyProfile: TrackEnergyFrame[];
  activityMode: WaveActivityMode;
}

const MODE_STATUS_LABELS: Record<WaveActivityMode, string> = {
  idle: 'STANDBY · AWAITING AUDIO',
  loaded: 'TRACK READY · PLAY TO MONITOR',
  playing: 'LIVE SPECTRUM · REAL-TIME DSP',
  converting: 'ACTIVE 5.1 MATRIX ENCODE',
  sweeping: 'CALIBRATION TONE SWEEP',
};

export function GlowingWaveVisualizer({
  liveLevelsRef,
  energyProfile,
  activityMode,
}: GlowingWaveVisualizerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const waveStateRef = useRef<FullWidthWaveState>({
    bands: new Float32Array(STUDIO_BAND_COUNT),
    peakCaps: new Float32Array(STUDIO_BAND_COUNT),
    primaryWave: new Float32Array(STUDIO_BAND_COUNT),
    secondaryWave: new Float32Array(STUDIO_BAND_COUNT),
    phase: 0,
  });
  const synthBandsRef = useRef<Float32Array>(new Float32Array(STUDIO_BAND_COUNT));
  const smoothedEnergyRef = useRef<number>(0);

  const stateRef = useRef({
    activityMode,
    energyProfile,
  });
  stateRef.current = {
    activityMode,
    energyProfile,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let cssWidth = Math.max(240, container.clientWidth || 640);
    let cssHeight = Math.max(60, container.clientHeight || 76);
    let dpr = Math.min(2.5, window.devicePixelRatio || 1);

    const syncSize = () => {
      const w = Math.max(240, container.clientWidth || 640);
      const h = Math.max(60, container.clientHeight || 76);
      dpr = Math.min(2.5, window.devicePixelRatio || 1);
      cssWidth = w;
      cssHeight = h;
      const backingW = Math.round(w * dpr);
      const backingH = Math.round(h * dpr);
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }
    };

    syncSize();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            syncSize();
            if (reducedMotion) {
              drawFrame(performance.now(), true);
            }
          })
        : null;
    resizeObserver?.observe(container);

    let rafId = 0;
    let lastNow = performance.now();
    let lastPaint = 0;

    const drawFrame = (now: number, force = false) => {
      // Pace rendering at ~50fps (20ms interval) for silky animation with zero GPU jank
      if (!force && now - lastPaint < 20) {
        if (!reducedMotion) {
          rafId = requestAnimationFrame((ts) => drawFrame(ts, false));
        }
        return;
      }
      lastPaint = now;

      const dtSec = Math.min(0.033, Math.max(0.004, (now - lastNow) * 0.001));
      lastNow = now;
      const t = now * 0.001;

      const { activityMode: mode, energyProfile: profile } = stateRef.current;

      let targetEnergy = 0;
      let targetBands: Float32Array | null = null;
      const isActive = mode === 'playing' || mode === 'sweeping' || mode === 'converting';

      if (mode === 'playing') {
        const levels = liveLevelsRef.current;
        targetEnergy = computeWaveEnergy(levels, true);
        if (levels.spectrum && levels.spectrum.length === STUDIO_BAND_COUNT) {
          targetBands = levels.spectrum;
        } else {
          targetBands = synthesizeChannelBands(levels, t, synthBandsRef.current);
        }
      } else if (mode === 'sweeping') {
        targetEnergy = 0.52 + 0.16 * Math.sin(t * 6);
        targetBands = synthesizeChannelBands(
          {
            FL: 0.52 + 0.18 * Math.sin(t * 4.2),
            FR: 0.52 + 0.18 * Math.cos(t * 4.2),
            C: 0.55,
            LFE: 0.62,
            SL: 0.48 + 0.16 * Math.sin(t * 3.1 + 1),
            SR: 0.48 + 0.16 * Math.cos(t * 3.1 + 1),
            lfeBeat: 0.58,
          },
          t,
          synthBandsRef.current,
        );
      } else if (mode === 'converting') {
        if (profile.length > 0) {
          const frame = profile[Math.floor((t * 10) % profile.length)];
          const frameLevels: ChannelLevels = {
            FL: frame.FL,
            FR: frame.FR,
            C: frame.C,
            LFE: frame.LFE,
            SL: frame.SL,
            SR: frame.SR,
            lfeBeat: frame.lfeBeat,
          };
          targetEnergy = computeWaveEnergy(frameLevels, true);
          targetBands = synthesizeChannelBands(frameLevels, t, synthBandsRef.current);
        } else {
          const pulse = 0.52 + 0.18 * Math.sin(t * 3.5);
          targetEnergy = pulse;
          targetBands = synthesizeChannelBands(
            {
              FL: pulse,
              FR: pulse,
              C: 0.48 + 0.12 * Math.cos(t * 2.4),
              LFE: 0.56 + 0.22 * Math.sin(t * 4.8),
              SL: 0.45 + 0.15 * Math.sin(t * 2.8 + 0.9),
              SR: 0.45 + 0.15 * Math.cos(t * 2.8 + 0.9),
              lfeBeat: 0.54 + 0.2 * Math.sin(t * 4.8),
            },
            t,
            synthBandsRef.current,
          );
        }
      }

      // Smooth master audio energy with fast attack and silky musical release
      const prevE = smoothedEnergyRef.current;
      const eRate = targetEnergy >= prevE ? 18.0 : 4.8;
      const eAlpha = 1 - Math.exp(-dtSec * eRate);
      const smoothE = prevE + (targetEnergy - prevE) * eAlpha;
      smoothedEnergyRef.current = smoothE < 0.001 ? 0 : smoothE;

      const waveState = waveStateRef.current;
      stepFullWidthStudioWave(
        waveState,
        targetBands,
        reducedMotion ? 0.5 : t,
        reducedMotion ? 0 : smoothedEnergyRef.current,
        dtSec,
        !reducedMotion && isActive,
      );

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const padX = 10;
      const spanW = Math.max(40, cssWidth - padX * 2);
      const baselineY = Math.round(cssHeight * 0.76);
      const maxExcursion = Math.max(20, baselineY - 8);
      const n = STUDIO_BAND_COUNT;
      const isAudiblyActive = isActive && smoothedEnergyRef.current > 0.015;

      // 1. Studio Precision Decibel Reference Grid Lines
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.07)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);

      // -6 dB and -18 dB reference levels
      const gridLevels = [0.75, 0.38];
      for (const level of gridLevels) {
        const gy = Math.round(baselineY - maxExcursion * level);
        ctx.beginPath();
        ctx.moveTo(padX, gy);
        ctx.lineTo(padX + spanW, gy);
        ctx.stroke();
      }

      // Clean Solid Studio Baseline
      ctx.setLineDash([]);
      ctx.strokeStyle = isAudiblyActive ? 'rgba(0, 240, 255, 0.28)' : 'rgba(148, 163, 184, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padX, baselineY);
      ctx.lineTo(padX + spanW, baselineY);
      ctx.stroke();

      // Compute display points for each frequency band
      const ptsX = new Float32Array(n);
      const ptsY = new Float32Array(n);
      const peaksY = new Float32Array(n);

      for (let i = 0; i < n; i++) {
        const u = n > 1 ? i / (n - 1) : 0.5;
        const taper = computeEdgeTaper(u, 0.48);
        const x = padX + u * spanW;
        ptsX[i] = x;

        const rawBand = waveState.bands[i];
        const bandAmp = isAudiblyActive ? Math.min(1.0, rawBand * taper * 1.1) : 0;
        // Calm resting breath when paused/idle
        const idleBreath = isAudiblyActive ? 0 : 0.02 * Math.sin(u * Math.PI * 3 - t * 1.8) * taper;
        const totalAmp = Math.max(0, bandAmp + idleBreath);

        ptsY[i] = baselineY - totalAmp * maxExcursion;

        const rawPeak = waveState.peakCaps[i];
        const peakAmp = isAudiblyActive ? Math.min(1.0, rawPeak * taper * 1.08) : 0;
        peaksY[i] = baselineY - peakAmp * maxExcursion;
      }

      // 2. Luminous Gradient Area Fill Under Frequency Curve
      if (isAudiblyActive || smoothE > 0.005) {
        const fillGrad = ctx.createLinearGradient(padX, baselineY - maxExcursion, padX + spanW, baselineY);
        fillGrad.addColorStop(0, 'rgba(0, 240, 255, 0.24)');
        fillGrad.addColorStop(0.5, 'rgba(56, 189, 248, 0.20)');
        fillGrad.addColorStop(1, 'rgba(168, 85, 247, 0.24)');

        ctx.beginPath();
        ctx.moveTo(ptsX[0], baselineY);
        ctx.lineTo(ptsX[0], ptsY[0]);

        for (let i = 1; i < n - 1; i++) {
          const cx = (ptsX[i] + ptsX[i + 1]) * 0.5;
          const cy = (ptsY[i] + ptsY[i + 1]) * 0.5;
          ctx.quadraticCurveTo(ptsX[i], ptsY[i], cx, cy);
        }
        ctx.lineTo(ptsX[n - 1], ptsY[n - 1]);
        ctx.lineTo(ptsX[n - 1], baselineY);
        ctx.closePath();

        ctx.fillStyle = fillGrad;
        ctx.fill();

        // 3. Subtle Sub-Baseline Mirrored Reflection (Depth Realism)
        const reflectGrad = ctx.createLinearGradient(0, baselineY, 0, cssHeight);
        reflectGrad.addColorStop(0, 'rgba(0, 240, 255, 0.12)');
        reflectGrad.addColorStop(1, 'rgba(0, 240, 255, 0.0)');

        ctx.beginPath();
        ctx.moveTo(ptsX[0], baselineY);
        for (let i = 1; i < n - 1; i++) {
          const rx = ptsX[i];
          const ry = baselineY + (baselineY - ptsY[i]) * 0.22;
          const nextRx = ptsX[i + 1];
          const nextRy = baselineY + (baselineY - ptsY[i + 1]) * 0.22;
          ctx.quadraticCurveTo(rx, ry, (rx + nextRx) * 0.5, (ry + nextRy) * 0.5);
        }
        ctx.lineTo(ptsX[n - 1], baselineY);
        ctx.closePath();
        ctx.fillStyle = reflectGrad;
        ctx.fill();
      }

      // 4. Precision Studio Frequency Rungs (Crisp Vertical Columns)
      const stepW = spanW / n;
      const barW = Math.max(1.5, Math.min(4.0, stepW * 0.52));

      for (let i = 0; i < n; i++) {
        const h = baselineY - ptsY[i];
        if (h <= 1.2) continue;

        const bx = ptsX[i] - barW * 0.5;
        const by = ptsY[i];
        const u = n > 1 ? i / (n - 1) : 0.5;

        // Color mapped dynamically across frequency: Cyan (Bass) -> Sky (Mid) -> Violet (Treble)
        let barColor = 'rgba(0, 240, 255, 0.42)';
        if (u > 0.65) {
          barColor = 'rgba(168, 85, 247, 0.45)';
        } else if (u > 0.35) {
          barColor = 'rgba(56, 189, 248, 0.42)';
        }

        ctx.fillStyle = barColor;
        if (typeof ctx.roundRect === 'function') {
          ctx.beginPath();
          ctx.roundRect(bx, by, barW, h, [Math.min(1.5, barW * 0.5), Math.min(1.5, barW * 0.5), 0, 0]);
          ctx.fill();
        } else {
          ctx.fillRect(bx, by, barW, h);
        }
      }

      // 5. Floating Transient Peak Pips (Studio Meter Peak Hold)
      if (isAudiblyActive) {
        for (let i = 0; i < n; i++) {
          const py = peaksY[i];
          const curY = ptsY[i];
          // Only show floating peak if it sits cleanly above current instantaneous level
          if (baselineY - py > 3 && py < curY - 2) {
            const u = n > 1 ? i / (n - 1) : 0.5;
            let peakColor = '#00F0FF';
            if (u > 0.65) peakColor = '#C084FC';
            else if (u > 0.35) peakColor = '#38BDF8';

            ctx.fillStyle = peakColor;
            const pipW = Math.max(2.5, barW * 1.25);
            const px = ptsX[i] - pipW * 0.5;
            ctx.fillRect(px, py, pipW, 1.5);
          }
        }
      }

      // 6. Master Glowing Frequency Contour Ribbon (Dual-Layer: Translucent Halo + Sharp Core)
      const ribbonGrad = ctx.createLinearGradient(padX, 0, padX + spanW, 0);
      ribbonGrad.addColorStop(0, '#00F0FF');
      ribbonGrad.addColorStop(0.5, '#38BDF8');
      ribbonGrad.addColorStop(1, '#A855F7');

      // Layer A: Soft outer glowing neon halo (zero CPU blur filter overhead)
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.22)';
      ctx.lineWidth = 5.0 + smoothE * 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(ptsX[0], ptsY[0]);
      for (let i = 1; i < n - 1; i++) {
        const cx = (ptsX[i] + ptsX[i + 1]) * 0.5;
        const cy = (ptsY[i] + ptsY[i + 1]) * 0.5;
        ctx.quadraticCurveTo(ptsX[i], ptsY[i], cx, cy);
      }
      ctx.lineTo(ptsX[n - 1], ptsY[n - 1]);
      ctx.stroke();

      // Layer B: Ultra-crisp precision top spline
      ctx.strokeStyle = ribbonGrad;
      ctx.lineWidth = 2.0 + smoothE * 0.6;
      ctx.beginPath();
      ctx.moveTo(ptsX[0], ptsY[0]);
      for (let i = 1; i < n - 1; i++) {
        const cx = (ptsX[i] + ptsX[i + 1]) * 0.5;
        const cy = (ptsY[i] + ptsY[i + 1]) * 0.5;
        ctx.quadraticCurveTo(ptsX[i], ptsY[i], cx, cy);
      }
      ctx.lineTo(ptsX[n - 1], ptsY[n - 1]);
      ctx.stroke();

      ctx.restore();

      if (!reducedMotion && document.visibilityState !== 'hidden') {
        rafId = requestAnimationFrame((ts) => drawFrame(ts, false));
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !reducedMotion) {
        if (rafId) cancelAnimationFrame(rafId);
        lastNow = performance.now();
        rafId = requestAnimationFrame((ts) => drawFrame(ts, true));
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    drawFrame(performance.now(), true);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibility);
      resizeObserver?.disconnect();
    };
  }, [liveLevelsRef]);

  const statusLabel = MODE_STATUS_LABELS[activityMode] ?? 'STANDBY';
  const isPulseActive = activityMode === 'playing' || activityMode === 'converting' || activityMode === 'sweeping';

  return (
    <div
      data-testid="glowing-wave-visualizer"
      data-wave-mode={activityMode}
      className="relative w-full min-w-0 max-w-full rounded-xl bg-[#06080D]/95 border border-cyan-400/25 shadow-[inset_0_1px_0_rgba(0,240,255,0.12),inset_0_-1px_12px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col"
      aria-hidden="true"
    >
      {/* Precision Studio Telemetry Header */}
      <div className="flex items-center justify-between px-2.5 sm:px-3 pt-1.5 pb-1 text-[10px] font-mono tracking-wider select-none border-b border-cyan-400/10 min-w-0">
        <div className="flex items-center gap-1.5 text-cyan-300/85 min-w-0 shrink">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              isPulseActive ? 'bg-[#00F0FF] shadow-[0_0_8px_#00F0FF] animate-pulse' : 'bg-slate-600'
            }`}
          />
          <span className="font-semibold text-slate-200 truncate">SPECTRUM ANALYZER</span>
          <span className="text-slate-600 hidden md:inline">·</span>
          <span className="text-slate-400 hidden md:inline">64-BAND LOG</span>
        </div>

        <div className="flex items-center gap-1.5 text-slate-400 shrink-0">
          <span
            className={`text-[9.5px] sm:text-[10px] font-semibold tracking-wider ${
              isPulseActive ? 'text-[#00F0FF]' : 'text-slate-400'
            }`}
          >
            {activityMode === 'playing' ? (
              <>
                <span className="sm:hidden">LIVE DSP</span>
                <span className="hidden sm:inline">LIVE SPECTRUM · REAL-TIME DSP</span>
              </>
            ) : (
              statusLabel
            )}
          </span>
        </div>
      </div>

      {/* Main Studio Canvas Viewport */}
      <div ref={containerRef} className="relative w-full h-16 sm:h-20 min-h-[64px]">
        <canvas
          ref={canvasRef}
          className="w-full h-full block pointer-events-none"
        />
      </div>

      {/* Logarithmic Frequency Range Anchor Bar */}
      <div className="flex items-center justify-between px-3 py-1 text-[9px] font-mono text-slate-500 border-t border-cyan-400/10 bg-[#040609]/70 select-none">
        <span className="text-cyan-400/80 font-medium">30 Hz · SUB</span>
        <span className="text-sky-400/70 hidden xs:inline">120 Hz · BASS</span>
        <span className="text-sky-300/80 font-medium">1 kHz · MID</span>
        <span className="text-violet-400/70 hidden xs:inline">4 kHz · PRESENCE</span>
        <span className="text-purple-400/80 font-medium">16 kHz · AIR</span>
      </div>
    </div>
  );
}
