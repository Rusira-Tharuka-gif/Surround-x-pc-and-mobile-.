import { Sparkles, Heart } from 'lucide-react';

export function CreativeThinkingCard() {
  return (
    <aside
      aria-label="Creative Thinking & Appreciation"
      className="w-full max-w-[1380px] mx-auto pt-4 pb-2"
    >
      {/* 1px Animated Gradient Border Shimmer Frame */}
      <div className="premium-border-shimmer relative rounded-xl p-[1px] shadow-[0_12px_32px_-12px_rgba(0,240,255,0.22)] transition-shadow duration-300 hover:shadow-[0_12px_38px_-10px_rgba(0,240,255,0.34)]">
        <div className="relative overflow-hidden rounded-[11px] px-3.5 py-2.5 sm:px-5 sm:py-3.5 bg-[#090D16]/94 backdrop-blur-md">
          {/* Subtle obsidian ambient glow */}
          <div
            aria-hidden="true"
            className="absolute -right-14 -top-14 w-40 h-40 rounded-full pointer-events-none blur-2xl opacity-20"
            style={{
              background:
                'radial-gradient(circle, rgba(0,240,255,0.45) 0%, rgba(168,85,247,0.18) 65%, transparent 100%)',
            }}
          />

          <div className="relative z-10 flex flex-col sm:flex-row items-center justify-between gap-2.5 text-center sm:text-left">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[#0D1422] border border-cyan-400/40 text-cyan-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_0_12px_rgba(0,240,255,0.22)] shrink-0">
                <Sparkles className="w-3.5 h-3.5 text-cyan-300" aria-hidden="true" />
              </span>
              <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2.5">
                <h3 className="font-display text-sm font-bold tracking-tight text-white">
                  Creative Thinking
                </h3>
                <span className="hidden sm:inline text-cyan-400/45" aria-hidden="true">·</span>
                <p className="font-mono text-xs text-cyan-300/95">
                  by Rusira Tharuka
                </p>
              </div>
            </div>

            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070B12]/90 border border-emerald-400/30 text-emerald-200/95 font-mono text-[11px] sm:text-xs shadow-[inset_0_1px_2px_rgba(0,0,0,0.75)] max-w-full">
              <Heart className="w-3 h-3 text-emerald-400 fill-emerald-400/30 shrink-0" aria-hidden="true" />
              <span className="leading-snug">
                Thanks to Minidu Madusith &amp; ChamathZ for technical &amp; coding support
              </span>
            </div>
          </div>

          {/* Two Distinct Brothers' Appreciation Lines */}
          <div className="relative z-10 mt-2.5 pt-2.5 border-t border-cyan-400/15 grid grid-cols-1 md:grid-cols-2 gap-1.5 md:gap-4 text-center sm:text-left">
            <p className="text-[11px] sm:text-xs text-slate-300/90 leading-relaxed">
              <span className="font-semibold text-cyan-200">ChamathZ</span>
              {' '}— Software engineering insight, flow review, and technical perspective.
            </p>
            <p className="text-[11px] sm:text-xs text-slate-300/90 leading-relaxed">
              <span className="font-semibold text-emerald-200">Minidu Madusith</span>
              {' '}— Steady brotherly backing and real-world support along the build.
            </p>
          </div>
        </div>
      </div>

      {/* Separate Compact Bottom Footer Slot */}
      <footer
        data-testid="studio-bottom-footer"
        className="mt-3 pt-1 pb-1 text-center"
      >
        <p className="font-mono text-[11px] sm:text-xs text-slate-400/85 tracking-wide">
          All rights reserved. Developed by rusira
        </p>
      </footer>
    </aside>
  );
}
