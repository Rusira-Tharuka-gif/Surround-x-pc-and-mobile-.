import { useCallback, useEffect, useRef, useState } from 'react';
import { stepSmoothedWavePoints, WAVE_POINT_COUNT } from '../utils/waveMath';

const HERO_THEATER_IMAGE = '/assets/aistudio/1794649766228_86899eeb.jpg';

const SPLASH_DISPLAY_MS = 6950;
const FADE_DURATION_MS = 550;
const HARD_FAILSAFE_MS = 8000;

const LOADING_STATUS_STEPS: { text: string; delayMs: number }[] = [
  { text: 'Initializing Spatial Audio Studio...', delayMs: 0 },
  { text: 'Initializing DSP Engine...', delayMs: 1150 },
  { text: 'Loading 48 kHz Mastering & Crossover Matrix...', delayMs: 2300 },
  { text: 'Mapping 5.1 Channels [FL, FR, C, LFE, SL, SR]...', delayMs: 3450 },
  { text: 'Calibrating Soft Limiter (-1.5 dBFS) & AC3 Encoder...', delayMs: 4600 },
  { text: 'Ready — Surround X Spatial Engine', delayMs: 5800 },
];

interface SplashScreenProps {
  onComplete: () => void;
}

export function SplashScreen({ onComplete }: SplashScreenProps) {
  const [fadingOut, setFadingOut] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);

  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Float32Array>(new Float32Array(WAVE_POINT_COUNT));
  const scratchRef = useRef<Float32Array>(new Float32Array(WAVE_POINT_COUNT));
  const completedRef = useRef(false);
  const dismissTimerRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const triggerDismiss = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    setFadingOut(true);
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      onCompleteRef.current();
    }, FADE_DURATION_MS);
  }, []);

  // 7–8 second loading sequence (~7500ms total including fade) with full timer cleanup and non-blocking ceiling
  useEffect(() => {
    completedRef.current = false;
    setStatusIndex(0);
    let cancelled = false;

    let displayTimerId: number | null = null;
    let fontsCapTimerId: number | null = null;

    const minWait = new Promise<void>((resolve) => {
      displayTimerId = window.setTimeout(resolve, SPLASH_DISPLAY_MS);
    });

    const fontsReady =
      typeof document !== 'undefined' && document.fonts?.ready
        ? Promise.race([
            document.fonts.ready.then(() => undefined).catch(() => undefined),
            new Promise<void>((resolve) => {
              fontsCapTimerId = window.setTimeout(resolve, 1500);
            }),
          ])
        : Promise.resolve();

    const stepTimerIds = LOADING_STATUS_STEPS.slice(1).map((step, idx) =>
      window.setTimeout(() => {
        if (!cancelled) setStatusIndex(idx + 1);
      }, step.delayMs),
    );

    const failsafeTimerId = window.setTimeout(() => {
      if (!cancelled) triggerDismiss();
    }, HARD_FAILSAFE_MS);

    Promise.all([minWait, fontsReady]).then(() => {
      if (!cancelled) triggerDismiss();
    });

    return () => {
      cancelled = true;
      if (displayTimerId !== null) window.clearTimeout(displayTimerId);
      if (fontsCapTimerId !== null) window.clearTimeout(fontsCapTimerId);
      for (const timerId of stepTimerIds) {
        window.clearTimeout(timerId);
      }
      window.clearTimeout(failsafeTimerId);
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [triggerDismiss]);

  // Single smooth glowing wave line animation on dark obsidian surface
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = canvasWrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let cssWidth = Math.max(220, wrap.clientWidth || 520);
    let cssHeight = Math.max(48, wrap.clientHeight || 56);
    let dpr = Math.min(2, window.devicePixelRatio || 1);

    const syncCanvasSize = () => {
      const w = Math.max(220, wrap.clientWidth || 520);
      const h = Math.max(48, wrap.clientHeight || 56);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      cssWidth = w;
      cssHeight = h;
      const backingW = Math.round(w * dpr);
      const backingH = Math.round(h * dpr);
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }
    };

    syncCanvasSize();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            syncCanvasSize();
            if (reducedMotion) drawWave(performance.now(), true);
          })
        : null;
    resizeObserver?.observe(wrap);

    let rafId = 0;
    let lastNow = performance.now();
    let lastPaint = 0;

    const drawWave = (now: number, force = false) => {
      if (!force && now - lastPaint < 20) {
        if (!reducedMotion) {
          rafId = requestAnimationFrame((ts) => drawWave(ts, false));
        }
        return;
      }
      lastPaint = now;

      const dtSec = Math.min(0.05, Math.max(0.008, (now - lastNow) * 0.001));
      lastNow = now;
      const t = now * 0.001;

      // Fluid calm-to-resonant loading energy pulse
      const waveEnergy = reducedMotion ? 0.2 : 0.34 + 0.14 * Math.sin(t * 2.4);

      const nextPoints = stepSmoothedWavePoints(
        pointsRef.current,
        reducedMotion ? 0.45 : t * 1.15,
        waveEnergy,
        dtSec,
        scratchRef.current,
      );
      scratchRef.current = pointsRef.current;
      pointsRef.current = nextPoints;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const midY = cssHeight * 0.5;
      const maxExcursion = cssHeight * 0.38;
      const padX = 12;
      const spanW = Math.max(40, cssWidth - padX * 2);

      // Subtle obsidian horizon baseline
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padX, midY);
      ctx.lineTo(cssWidth - padX, midY);
      ctx.stroke();

      // Single continuous glowing neon gradient wave
      const grad = ctx.createLinearGradient(padX, 0, cssWidth - padX, 0);
      grad.addColorStop(0, '#00F0FF');
      grad.addColorStop(0.5, '#38BDF8');
      grad.addColorStop(1, '#A855F7');

      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.25;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0, 240, 255, 0.8)';
      ctx.shadowBlur = 12;

      const n = nextPoints.length;
      ctx.beginPath();
      ctx.moveTo(padX, midY + nextPoints[0] * maxExcursion);

      for (let i = 1; i < n - 1; i++) {
        const x = padX + (i / (n - 1)) * spanW;
        const y = midY + nextPoints[i] * maxExcursion;
        const nextX = padX + ((i + 1) / (n - 1)) * spanW;
        const nextY = midY + nextPoints[i + 1] * maxExcursion;
        ctx.quadraticCurveTo(x, y, (x + nextX) * 0.5, (y + nextY) * 0.5);
      }

      ctx.lineTo(padX + spanW, midY + nextPoints[n - 1] * maxExcursion);
      ctx.stroke();
      ctx.restore();

      if (!reducedMotion && document.visibilityState !== 'hidden') {
        rafId = requestAnimationFrame((ts) => drawWave(ts, false));
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !reducedMotion) {
        if (rafId) cancelAnimationFrame(rafId);
        lastNow = performance.now();
        rafId = requestAnimationFrame((ts) => drawWave(ts, true));
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    drawWave(performance.now(), true);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibility);
      resizeObserver?.disconnect();
    };
  }, []);

  return (
    <main
      data-testid="splash-screen"
      className={`relative z-50 h-[100dvh] min-h-[100dvh] w-full overflow-hidden flex flex-col justify-between transition-opacity duration-500 ease-out ${
        fadingOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
      style={{
        background:
          'radial-gradient(circle at 50% 38%, #0D111A 0%, #090C14 58%, #07090E 100%)',
      }}
    >
      <h1 className="sr-only">Surround X — Stereo to 5.1 Dolby Digital Audio Studio</h1>

      {/* Soft obsidian ambient backdrop derived from reference art */}
      {!imageFailed && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
          <img
            src={HERO_THEATER_IMAGE}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="w-full h-full object-cover object-center opacity-15 blur-xl scale-105 select-none"
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at 50% 44%, rgba(7, 9, 14, 0.45) 0%, rgba(7, 9, 14, 0.92) 68%, #07090E 100%)',
            }}
          />
        </div>
      )}

      {/* Compact Top Bar */}
      <header className="relative z-20 w-full max-w-5xl mx-auto px-4 sm:px-8 pt-3 sm:pt-5 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-slate-300 whitespace-nowrap">
          <span className="font-display font-bold tracking-wider text-[#00F0FF]">
            SURROUND X
          </span>
          <span className="text-cyan-400/40" aria-hidden="true">
            ·
          </span>
          <span className="text-slate-300/85">Spatial Studio</span>
        </div>

        <button
          type="button"
          onClick={triggerDismiss}
          className="hardware-btn min-h-[44px] px-4 py-2 rounded-xl text-xs font-medium text-cyan-100 hover:text-white cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-cyan-300"
        >
          Skip
        </button>
      </header>

      {/* Centered Obsidian Theater Visual + Smooth Glowing Wave Line */}
      <div className="relative z-10 flex-1 min-h-0 w-full max-w-xl mx-auto px-4 sm:px-6 py-2 flex flex-col items-center justify-center gap-3.5 sm:gap-4">
        <div className="relative w-full max-w-[min(100%,calc(44dvh*4/3))] rounded-2xl overflow-hidden bg-[#07090E]/90 border border-cyan-400/20 shadow-[0_24px_60px_-16px_rgba(0,0,0,0.95),0_0_36px_-14px_rgba(0,240,255,0.22)]">
          {!imageFailed ? (
            <div className="relative w-full aspect-[4/3] flex items-center justify-center bg-[#07090E]">
              <img
                src={HERO_THEATER_IMAGE}
                alt="Surround X 5.1 home theater speakers with glowing cyan acoustic rings"
                referrerPolicy="no-referrer"
                onError={() => setImageFailed(true)}
                data-testid="splash-hero-image"
                className="w-full h-full object-cover object-center select-none pointer-events-none block"
              />
              <div
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(7, 9, 14, 0.2) 0%, transparent 22%, transparent 76%, rgba(7, 9, 14, 0.62) 100%)',
                }}
              />
            </div>
          ) : (
            <div className="px-6 py-12 text-center bg-gradient-to-b from-[#0D111A] to-[#07090E]">
              <p className="font-display text-3xl sm:text-4xl font-bold tracking-[0.18em] text-white">
                SURROUND <span className="text-[#00F0FF]">X</span>
              </p>
              <p className="mt-2 text-xs sm:text-sm tracking-[0.12em] text-cyan-100/80">
                Audio Convert: Stereo to 5.1 Surround
              </p>
            </div>
          )}
        </div>

        {/* Smooth Glowing Wave Line Module */}
        <section
          aria-label="Loading Surround X studio"
          className="w-full rounded-2xl bg-[#07090E]/92 backdrop-blur-md border border-cyan-400/20 px-4 pt-3 pb-3.5 shadow-[inset_0_1px_0_rgba(226,232,240,0.08),0_18px_42px_-16px_rgba(0,0,0,0.92)]"
        >
          <div
            ref={canvasWrapRef}
            className="relative w-full h-14 sm:h-16 min-w-0 max-w-full overflow-hidden"
            aria-hidden="true"
          >
            <canvas
              ref={canvasRef}
              data-testid="splash-wave-canvas"
              className="w-full h-full block pointer-events-none"
            />
          </div>

          <div className="mt-2 min-h-[2rem] sm:min-h-[1.25rem] flex items-center justify-between gap-3 text-[11px] sm:text-xs">
            <span
              data-testid="splash-status-text"
              className={`min-w-0 flex-1 font-medium tracking-wide leading-4 transition-colors duration-300 ${
                statusIndex === LOADING_STATUS_STEPS.length - 1
                  ? 'text-emerald-200'
                  : 'text-cyan-100/90'
              }`}
            >
              {LOADING_STATUS_STEPS[statusIndex].text}
            </span>
            <span className="font-mono text-[11px] text-slate-400 whitespace-nowrap shrink-0">
              5.1 AC3
            </span>
          </div>

          <div className="mt-2 h-1 w-full rounded-full bg-[#0D111A] border border-cyan-400/15 overflow-hidden">
            <div
              className="h-full w-full origin-left bg-gradient-to-r from-[#00F0FF] via-[#38BDF8] to-[#A855F7] animate-[splash-bar_6.95s_cubic-bezier(0.22,1,0.36,1)_forwards]"
            />
          </div>
        </section>
      </div>

      {/* Quiet Bottom Caption */}
      <footer className="relative z-20 w-full max-w-5xl mx-auto px-4 sm:px-8 pb-4 sm:pb-5 text-center shrink-0">
        <p className="text-[11px] sm:text-xs text-slate-400/80 tracking-wide">
          Stereo to 5.1 Surround · 48 kHz Mastering Engine
        </p>
      </footer>
    </main>
  );
}
