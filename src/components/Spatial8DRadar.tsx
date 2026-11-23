import { Headphones } from 'lucide-react';

interface Spatial8DRadarProps {
  active: boolean;
  isConverting: boolean;
  orbitPeriodSec: number;
  liveAngleDeg?: number | null;
  compact?: boolean;
}

function getSectorLabel(deg: number): string {
  const norm = ((deg % 360) + 360) % 360;
  if (norm < 22.5 || norm >= 337.5) return 'FRONT';
  if (norm < 67.5) return 'FRONT-R';
  if (norm < 112.5) return 'RIGHT';
  if (norm < 157.5) return 'REAR-R';
  if (norm < 202.5) return 'REAR';
  if (norm < 247.5) return 'REAR-L';
  if (norm < 292.5) return 'LEFT';
  return 'FRONT-L';
}

export function Spatial8DRadar({
  active,
  isConverting,
  orbitPeriodSec,
  liveAngleDeg = null,
  compact = false,
}: Spatial8DRadarProps) {
  const hasLiveAngle = typeof liveAngleDeg === 'number' && Number.isFinite(liveAngleDeg);
  const smoothDeg = hasLiveAngle ? ((liveAngleDeg % 360) + 360) % 360 : 0;
  const displayDeg = hasLiveAngle ? Math.round(smoothDeg) % 360 : 0;
  const spinDurationSec = isConverting ? 2.4 : Math.max(2.5, orbitPeriodSec);

  return (
    <div
      data-testid={compact ? 'spatial-8d-radar-compact' : 'spatial-8d-radar'}
      data-active={active ? 'true' : 'false'}
      data-converting={isConverting ? 'true' : 'false'}
      className={`glass-subpanel rounded-xl flex items-center gap-3 sm:gap-3.5 w-full min-w-0 overflow-hidden ${
        compact ? 'p-3' : 'p-3 sm:p-4'
      }`}
    >
      {/* Spinning Circular 8D Azimuth Radar */}
      <div
        className={`relative shrink-0 flex items-center justify-center ${
          compact ? 'w-14 h-14' : 'w-20 h-20'
        }`}
      >
        <svg
          viewBox="0 0 100 100"
          className="w-full h-full block"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="radarBeamGrad" x1="50%" y1="0%" x2="100%" y2="50%">
              <stop offset="0%" stopColor="rgba(0, 240, 255, 0.72)" />
              <stop offset="55%" stopColor="rgba(168, 85, 247, 0.34)" />
              <stop offset="100%" stopColor="rgba(0, 240, 255, 0)" />
            </linearGradient>
            <radialGradient id="radarCoreGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(0, 240, 255, 0.2)" />
              <stop offset="100%" stopColor="rgba(7, 9, 14, 0.94)" />
            </radialGradient>
          </defs>

          {/* Concentric Orbital Rings */}
          <circle cx="50" cy="50" r="46" fill="url(#radarCoreGrad)" stroke="rgba(34,211,238,0.28)" strokeWidth="1.2" />
          <circle cx="50" cy="50" r="34" fill="none" stroke="rgba(52,211,153,0.24)" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx="50" cy="50" r="20" fill="none" stroke="rgba(34,211,238,0.2)" strokeWidth="1" />

          {/* Crosshair Axes */}
          <line x1="50" y1="6" x2="50" y2="94" stroke="rgba(148,163,184,0.16)" strokeWidth="0.8" />
          <line x1="6" y1="50" x2="94" y2="50" stroke="rgba(148,163,184,0.16)" strokeWidth="0.8" />

          {/* Rotating 360-Degree Swept Radar Wedge + Sound Emitter Node */}
          <g
            data-testid={compact ? 'radar-rotor-compact' : 'radar-rotor'}
            style={
              hasLiveAngle && !isConverting
                ? {
                    transformOrigin: '50px 50px',
                    transform: `rotate(${smoothDeg.toFixed(2)}deg)`,
                  }
                : active
                  ? {
                      transformOrigin: '50px 50px',
                      animation: `radar-orbit-spin ${spinDurationSec}s linear infinite`,
                    }
                  : {
                      transformOrigin: '50px 50px',
                      transform: 'rotate(32deg)',
                    }
            }
          >
            {/* Swept Radar Sector */}
            <path
              d="M50,50 L50,6 A44,44 0 0,1 88,28 Z"
              fill="url(#radarBeamGrad)"
              opacity={active ? 0.95 : 0.35}
            />
            <line
              x1="50"
              y1="50"
              x2="50"
              y2="8"
              stroke={active ? '#6ee7b7' : '#38bdf8'}
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            {/* Glowing Orbiting Audio Source Node */}
            <circle
              cx="50"
              cy="12"
              r={active ? 7.5 : 5}
              fill="rgba(52, 211, 153, 0.28)"
            />
            <circle
              cx="50"
              cy="12"
              r={active ? 4.2 : 3.2}
              fill={active ? '#a7f3d0' : '#22d3ee'}
              stroke="#021210"
              strokeWidth="1"
            />
          </g>
        </svg>

        {/* Central Headphone Listener Icon */}
        <div
          className={`absolute inset-0 flex items-center justify-center pointer-events-none ${
            active ? 'text-cyan-200' : 'text-slate-300'
          }`}
        >
          <Headphones className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} aria-hidden="true" />
        </div>
      </div>

      {/* Live 8D Spatial Readout */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-white tracking-tight truncate">
            {isConverting
              ? '360° Binaural Rotation Active'
              : active
                ? 'Live 8D Orbital Preview'
                : '8D Binaural Spatializer'}
          </span>
          <span
            className={`font-mono text-[10px] px-1.5 py-0.5 rounded border shrink-0 tabular-nums ${
              active
                ? 'hardware-pill-active-violet text-violet-100'
                : 'hardware-badge text-cyan-200'
            }`}
          >
            {hasLiveAngle && !isConverting
              ? `${String(displayDeg).padStart(3, '0')}°`
              : `${orbitPeriodSec.toFixed(1)}s/rev`}
          </span>
        </div>

        <p className="text-[11px] font-mono text-slate-300/85 mt-1 leading-snug">
          {isConverting
            ? 'Applying ITD delay, pinna LPF & 360° binaural panning...'
            : hasLiveAngle
              ? `Azimuth ${String(displayDeg).padStart(3, '0')}° · ${getSectorLabel(displayDeg)} · Headphone Stage`
              : '360° ITD panning + pinna frequency filter · Ideal for headphones'}
        </p>
      </div>
    </div>
  );
}
