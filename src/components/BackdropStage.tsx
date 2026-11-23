import { useState } from 'react';

const FINAL_THEATER_IMAGE = '/assets/aistudio/1794649766228_86899eeb.jpg';

export function BackdropStage() {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div
      className="fixed inset-0 z-0 overflow-hidden studio-backdrop-fallback pointer-events-none select-none"
      aria-hidden="true"
    >
      {!imageFailed && (
        <img
          src={FINAL_THEATER_IMAGE}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          className="studio-backdrop-image opacity-65"
        />
      )}

      {/* Measured obsidian contrast scrim for crisp WCAG AA legibility across mobile and desktop */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#07090E]/90 via-[#0D111A]/80 to-[#07090E]/97" />

      {/* Subtle studio cyan/violet radial vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 85% 65% at 50% 42%, transparent 22%, rgba(7, 9, 14, 0.84) 100%)',
        }}
      />
    </div>
  );
}
