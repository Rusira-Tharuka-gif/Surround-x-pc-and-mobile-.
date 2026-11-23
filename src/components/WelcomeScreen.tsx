import { useState } from 'react';
import { ArrowRight, Disc3, Play, Sliders, Speaker, Cpu } from 'lucide-react';

const FINAL_THEATER_IMAGE = '/assets/aistudio/1794649766228_86899eeb.jpg';

interface WelcomeScreenProps {
  onEnterStudio: () => void;
  onLaunchWithDemo: () => void;
}

const CAPABILITIES = [
  {
    icon: Speaker,
    title: '3D Acoustic Stage',
    detail: 'Interactive 6-speaker spatial layout with real-time LED core reactivity.',
  },
  {
    icon: Sliders,
    title: 'Precision Channel Matrix',
    detail: 'Cinema Pro, Ambient Hall, and Discrete upmixing with per-channel trim.',
  },
  {
    icon: Cpu,
    title: 'WASM 5.1 AC3 Engine',
    detail: 'Encode 48 kHz Dolby Digital AC3 up to 640 kbps locally in your browser.',
  },
];

export function WelcomeScreen({ onEnterStudio, onLaunchWithDemo }: WelcomeScreenProps) {
  const [exiting, setExiting] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const handleAction = (callback: () => void) => {
    if (exiting) return;
    setExiting(true);
    window.setTimeout(callback, 360);
  };

  return (
    <main
      data-testid="welcome-screen"
      className={`relative z-10 min-h-[100dvh] w-full overflow-x-hidden flex flex-col justify-between transition-all duration-300 ease-out ${
        exiting ? 'opacity-0 scale-[1.01] pointer-events-none' : 'opacity-100 scale-100'
      }`}
      style={{
        background:
          'radial-gradient(circle at 50% 42%, #0D111A 0%, #090C14 58%, #07090E 100%)',
      }}
    >
      {/* Full-Screen Cinematic Forest Home Theater Background */}
      {!imageFailed && (
        <img
          src={FINAL_THEATER_IMAGE}
          alt="Surround X forest home theater backdrop"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          className="fixed inset-0 w-full h-full object-cover object-[50%_38%] opacity-70 select-none pointer-events-none"
        />
      )}

      {/* Deep Obsidian Midnight Gradient Overlay */}
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(180deg, rgba(7, 9, 14, 0.88) 0%, rgba(13, 17, 26, 0.65) 42%, rgba(9, 12, 19, 0.92) 70%, rgba(7, 9, 14, 0.99) 88%)',
        }}
      />

      {/* Soft Radial Vignette */}
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 78% 70% at 50% 44%, transparent 25%, rgba(7, 9, 14, 0.72) 75%, rgba(7, 9, 14, 0.97) 100%)',
        }}
      />

      {/* Top Minimal Brand Header */}
      <header className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-8 pt-5 sm:pt-7 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl hardware-badge text-[#00F0FF]">
            <Disc3 className="w-4.5 h-4.5" aria-hidden="true" />
          </span>
          <span className="font-display text-lg sm:text-xl font-bold tracking-tight text-white">
            Surround X
          </span>
        </div>

        <p className="hidden sm:flex items-center gap-2 font-mono text-xs text-slate-300 whitespace-nowrap shrink-0">
          <span>48 kHz</span>
          <span className="text-cyan-400/50" aria-hidden="true">·</span>
          <span>6-Channel AC3</span>
          <span className="text-cyan-400/50" aria-hidden="true">·</span>
          <span>Browser WASM</span>
        </p>
      </header>

      {/* Centered Hero Glassmorphic Panel + Capability Strip */}
      <div className="relative z-10 flex-1 flex items-center justify-center px-4 sm:px-6 py-8 sm:py-10">
        <div className="w-full max-w-3xl flex flex-col gap-4">
          <section
            aria-label="Surround X Welcome"
            className="glass-panel rounded-2xl px-6 py-8 sm:px-10 sm:py-11 text-center"
          >
            <p className="font-mono text-xs sm:text-sm font-medium tracking-[0.16em] text-cyan-300 mb-3">
              Spatial Audio Studio
            </p>

            <h1 className="font-display text-3xl sm:text-5xl font-bold tracking-tight text-white leading-[1.12] text-balance max-w-2xl mx-auto">
              Stereo to 5.1 Dolby Digital AC3 Converter
            </h1>

            <p className="mt-4 text-sm sm:text-base text-slate-200/85 leading-relaxed max-w-xl mx-auto">
              Upmix stereo tracks into discrete 6-channel surround sound directly inside your browser. Preview live signal dynamics on the 3D Acoustic Stage Monitor, fine-tune every speaker channel, and export compliant 48 kHz AC3 streams.
            </p>

            <div className="mt-7 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => handleAction(onEnterStudio)}
                className="hardware-cta-primary inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-sm active:scale-[0.99] cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-cyan-300"
              >
                <span>Enter Studio</span>
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={() => handleAction(onLaunchWithDemo)}
                className="hardware-btn inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-cyan-100 font-semibold text-sm hover:text-white active:scale-[0.99] cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-cyan-300"
              >
                <Play className="w-4 h-4 text-[#00F0FF]" aria-hidden="true" />
                <span>Launch with Demo Track</span>
              </button>
            </div>
          </section>

          {/* Single-Elevation Glassmorphic Studio Highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {CAPABILITIES.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="glass-subpanel rounded-xl p-4 text-left">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Icon className="w-4 h-4 text-cyan-300 shrink-0" aria-hidden="true" />
                    <h2 className="font-display text-sm font-semibold text-white">
                      {item.title}
                    </h2>
                  </div>
                  <p className="text-xs text-slate-300/85 leading-relaxed">{item.detail}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Subtle Bottom Footer Spacer */}
      <footer className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-8 pb-5 text-center sm:text-left">
        <p className="text-xs text-slate-400/80 font-mono">
          Client-side WebAssembly processing · Private local audio workflow
        </p>
      </footer>
    </main>
  );
}
