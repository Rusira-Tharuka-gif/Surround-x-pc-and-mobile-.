import type { CSSProperties, MutableRefObject } from 'react';
import type { ChannelConfig, ChannelId } from '../utils/audioTypes';

export interface SpeakerRingRefs {
  coreRing: Record<ChannelId, SVGCircleElement | null>;
  coreGlow: Record<ChannelId, SVGCircleElement | null>;
  driverCone: Record<ChannelId, SVGGElement | null>;
  lfePortGlow: SVGCircleElement | null;
}

interface SpeakerStage3DProps {
  channels: ChannelConfig[];
  effectiveGains: Record<ChannelId, number>;
  selectedChannel: ChannelId;
  activeSweepChannel: ChannelId | null;
  isAudioActive?: boolean;
  ringRefs: MutableRefObject<SpeakerRingRefs>;
  onSelectSpeaker: (id: ChannelId) => void;
}

export interface SpeakerAnchor {
  cx: number;
  cy: number;
  baseR: number;
  hitLeftPct: number;
  hitTopPct: number;
  hitWidthPct: number;
  hitHeightPct: number;
  labelLeftPct: number;
  labelTopPct: number;
  roleTitle: string;
}

export const SPEAKER_ANCHORS: Record<ChannelId, SpeakerAnchor> = {
  SL: {
    cx: 68,
    cy: 279,
    baseR: 13,
    hitLeftPct: 3.8,
    hitTopPct: 55,
    hitWidthPct: 10.2,
    hitHeightPct: 24,
    labelLeftPct: 8.5,
    labelTopPct: 86.2,
    roleTitle: 'Surround Left (SL) satellite speaker',
  },
  FL: {
    cx: 179,
    cy: 136,
    baseR: 15.5,
    hitLeftPct: 18.4,
    hitTopPct: 13,
    hitWidthPct: 9.2,
    hitHeightPct: 67,
    labelLeftPct: 22.4,
    labelTopPct: 86.2,
    roleTitle: 'Front Left (FL) floor-standing tower speaker',
  },
  C: {
    cx: 354,
    cy: 267,
    baseR: 13.5,
    hitLeftPct: 34.5,
    hitTopPct: 56,
    hitWidthPct: 19.5,
    hitHeightPct: 18,
    labelLeftPct: 44.25,
    labelTopPct: 86.2,
    roleTitle: 'Center (C) horizontal dialogue speaker',
  },
  FR: {
    cx: 527,
    cy: 136,
    baseR: 15.5,
    hitLeftPct: 61.8,
    hitTopPct: 13,
    hitWidthPct: 9.2,
    hitHeightPct: 67,
    labelLeftPct: 65.9,
    labelTopPct: 86.2,
    roleTitle: 'Front Right (FR) floor-standing tower speaker',
  },
  LFE: {
    cx: 630,
    cy: 236,
    baseR: 23.5,
    hitLeftPct: 72.2,
    hitTopPct: 41,
    hitWidthPct: 13.2,
    hitHeightPct: 39,
    labelLeftPct: 78.75,
    labelTopPct: 86.2,
    roleTitle: 'Subwoofer (LFE) ivy-draped bass enclosure',
  },
  SR: {
    cx: 732,
    cy: 279,
    baseR: 13,
    hitLeftPct: 86.0,
    hitTopPct: 55,
    hitWidthPct: 10.2,
    hitHeightPct: 24,
    labelLeftPct: 91.5,
    labelTopPct: 86.2,
    roleTitle: 'Surround Right (SR) satellite speaker',
  },
};

const FIREFLIES = [
  { x: 54, y: 122, r: 1.5, glow: 5.0, color: '#fef08a', o: 0.48 },
  { x: 112, y: 82, r: 1.7, glow: 5.5, color: '#d9f99d', o: 0.54 },
  { x: 136, y: 196, r: 1.2, glow: 4.0, color: '#fef08a', o: 0.38 },
  { x: 246, y: 112, r: 1.5, glow: 5.0, color: '#bbf7d0', o: 0.46 },
  { x: 288, y: 66, r: 1.4, glow: 4.5, color: '#fef08a', o: 0.48 },
  { x: 428, y: 74, r: 1.4, glow: 4.8, color: '#d9f99d', o: 0.46 },
  { x: 468, y: 128, r: 1.3, glow: 4.2, color: '#fef08a', o: 0.38 },
  { x: 594, y: 92, r: 1.6, glow: 5.4, color: '#d9f99d', o: 0.5 },
  { x: 676, y: 118, r: 1.3, glow: 4.5, color: '#fef08a', o: 0.44 },
  { x: 742, y: 154, r: 1.5, glow: 5.0, color: '#bbf7d0', o: 0.48 },
  { x: 108, y: 368, r: 1.3, glow: 4.2, color: '#fef08a', o: 0.4 },
  { x: 694, y: 374, r: 1.4, glow: 4.5, color: '#d9f99d', o: 0.4 },
];

const GPU_CENTER_STYLE: CSSProperties = {
  transformBox: 'fill-box',
  transformOrigin: 'center',
  willChange: 'transform, opacity',
};

export function SpeakerStage3D({
  channels,
  effectiveGains,
  selectedChannel,
  activeSweepChannel,
  isAudioActive = false,
  ringRefs,
  onSelectSpeaker,
}: SpeakerStage3DProps) {
  const byId = Object.fromEntries(channels.map((ch) => [ch.id, ch])) as Record<
    ChannelId,
    ChannelConfig
  >;
  const isNodePulsing = (id: ChannelId) => isAudioActive && (effectiveGains[id] ?? 0) > 0.001;

  return (
    <div
      className="acoustic-stage-visual relative w-full max-w-full min-w-0 aspect-[800/420] rounded-xl bg-[#07090E]/92 border border-cyan-400/22 overflow-hidden shadow-[inset_0_1px_0_rgba(226,232,240,0.12),0_18px_40px_-20px_rgba(0,0,0,0.95)] select-none"
      data-testid="speaker-stage-3d"
    >
      <svg
        viewBox="0 0 800 420"
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full block"
        aria-hidden="true"
      >
        <defs>
          {/* Deep Twilight Forest Canopy Sky */}
          <linearGradient id="forestSkyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#031317" />
            <stop offset="42%" stopColor="#062127" />
            <stop offset="76%" stopColor="#031418" />
            <stop offset="100%" stopColor="#010709" />
          </linearGradient>

          {/* Cool Moonlight Mist Glow Centering over Stage */}
          <radialGradient id="moonCanopyGlow" cx="46%" cy="14%" r="60%">
            <stop offset="0%" stopColor="rgba(186, 230, 253, 0.3)" />
            <stop offset="28%" stopColor="rgba(56, 189, 248, 0.14)" />
            <stop offset="62%" stopColor="rgba(14, 116, 144, 0.05)" />
            <stop offset="100%" stopColor="rgba(2, 11, 14, 0)" />
          </radialGradient>

          {/* Soft Volumetric Beam Shimmer */}
          <linearGradient id="moonRayGrad" x1="50%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%" stopColor="rgba(186, 230, 253, 0.14)" />
            <stop offset="55%" stopColor="rgba(56, 189, 248, 0.05)" />
            <stop offset="100%" stopColor="rgba(6, 24, 30, 0)" />
          </linearGradient>

          {/* Ground-Hugging Stone Mist */}
          <radialGradient id="stageFloorMistGrad" cx="48%" cy="50%" r="54%">
            <stop offset="0%" stopColor="rgba(125, 211, 252, 0.12)" />
            <stop offset="55%" stopColor="rgba(34, 211, 238, 0.04)" />
            <stop offset="100%" stopColor="rgba(2, 11, 14, 0)" />
          </radialGradient>

          {/* Brushed Obsidian Speaker Hardware Materials */}
          <linearGradient id="cabinetFrontGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#2c373f" />
            <stop offset="22%" stopColor="#161e24" />
            <stop offset="68%" stopColor="#0c1115" />
            <stop offset="100%" stopColor="#05080a" />
          </linearGradient>

          <linearGradient id="cabinetBevelRightGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#121a20" />
            <stop offset="100%" stopColor="#040709" />
          </linearGradient>

          <linearGradient id="cabinetBevelLeftGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#040709" />
            <stop offset="100%" stopColor="#182229" />
          </linearGradient>

          <linearGradient id="cabinetTopGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#475864" />
            <stop offset="100%" stopColor="#1a242b" />
          </linearGradient>

          <linearGradient id="avDeckFrontGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#222d35" />
            <stop offset="35%" stopColor="#0e1419" />
            <stop offset="100%" stopColor="#05080b" />
          </linearGradient>

          <radialGradient id="wooferConeGrad" cx="40%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#2c3840" />
            <stop offset="52%" stopColor="#0f1519" />
            <stop offset="86%" stopColor="#070b0d" />
            <stop offset="100%" stopColor="#030507" />
          </radialGradient>

          <radialGradient id="lfePortGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(165, 243, 252, 0.92)" />
            <stop offset="52%" stopColor="rgba(45, 212, 191, 0.36)" />
            <stop offset="100%" stopColor="rgba(20, 184, 166, 0)" />
          </radialGradient>

          <radialGradient id="innerConeCyanGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(0, 240, 255, 0.9)" />
            <stop offset="52%" stopColor="rgba(0, 240, 255, 0.42)" />
            <stop offset="100%" stopColor="rgba(0, 240, 255, 0)" />
          </radialGradient>

          <radialGradient id="innerConeAmberGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(253, 230, 138, 0.92)" />
            <stop offset="52%" stopColor="rgba(251, 191, 36, 0.44)" />
            <stop offset="100%" stopColor="rgba(245, 158, 11, 0)" />
          </radialGradient>

          <radialGradient id="innerConeVioletGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(233, 213, 255, 0.92)" />
            <stop offset="52%" stopColor="rgba(168, 85, 247, 0.46)" />
            <stop offset="100%" stopColor="rgba(168, 85, 247, 0)" />
          </radialGradient>

          <radialGradient id="innerConeLfeGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(167, 243, 208, 0.92)" />
            <stop offset="52%" stopColor="rgba(52, 211, 153, 0.48)" />
            <stop offset="100%" stopColor="rgba(16, 185, 129, 0)" />
          </radialGradient>

          {/* Mossy Stone Pedestal Gradients */}
          <linearGradient id="stoneTopGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#182a27" />
            <stop offset="48%" stopColor="#0f1e1c" />
            <stop offset="100%" stopColor="#081211" />
          </linearGradient>

          <linearGradient id="stoneCliffGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#122220" />
            <stop offset="38%" stopColor="#091314" />
            <stop offset="100%" stopColor="#020608" />
          </linearGradient>

          <linearGradient id="mossCrestGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#2f5e36" />
            <stop offset="60%" stopColor="#183922" />
            <stop offset="100%" stopColor="#0b1f14" />
          </linearGradient>

          <linearGradient id="ivyLeafGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4d7c4f" />
            <stop offset="52%" stopColor="#254d2b" />
            <stop offset="100%" stopColor="#0d2614" />
          </linearGradient>
        </defs>

        {/* ================= 1. CLEAN DARK TWILIGHT FOREST ATMOSPHERE ================= */}
        <rect x="0" y="0" width="800" height="420" fill="url(#forestSkyGrad)" />
        <ellipse cx="364" cy="84" rx="360" ry="225" fill="url(#moonCanopyGlow)" />

        {/* Distant Misty Tree Silhouettes */}
        <g opacity="0.34" fill="#031215">
          <path d="M126,0 L146,0 L142,306 L120,306 Z" />
          <path d="M262,0 L276,0 L272,306 L256,306 Z" />
          <path d="M452,0 L468,0 L474,306 L454,306 Z" />
          <path d="M614,0 L632,0 L628,306 L608,306 Z" />
          <path d="M210,36 C255,68 308,58 344,24 L318,0 L190,0 Z" />
          <path d="M510,20 C464,58 418,44 378,12 L404,0 L526,0 Z" />
        </g>

        {/* Volumetric Moonlight Shafts Behind Center Stage */}
        <polygon points="295,0 426,0 538,314 196,314" fill="url(#moonRayGrad)" opacity="0.58" />
        <polygon points="334,0 388,0 448,314 274,314" fill="url(#moonRayGrad)" opacity="0.78" />

        {/* Foreground Gnarled Ancient Tree Trunks & Overarching Mossy Limbs */}
        <g fill="#020c0e">
          <path d="M0,0 L86,0 C74,56 64,124 68,205 C71,254 88,292 108,324 L0,336 Z" opacity="0.96" />
          <path d="M44,12 C112,56 178,66 248,18 C272,2 284,0 284,0 L42,0 Z" opacity="0.86" />
          <path d="M0,78 C48,88 86,120 112,158 C92,162 66,144 36,126 L0,122 Z" opacity="0.72" />
          <path d="M800,0 L712,0 C724,62 732,134 726,216 C722,262 706,294 688,324 L800,336 Z" opacity="0.96" />
          <path d="M754,10 C686,58 618,62 552,14 C534,0 520,0 520,0 L756,0 Z" opacity="0.86" />
          <path d="M800,82 C754,94 714,122 688,160 C708,164 734,146 764,128 L800,124 Z" opacity="0.72" />
        </g>

        {/* Subtle Canopy Moss Highlights on Framing Branches */}
        <g fill="#193b27" opacity="0.45">
          <path d="M72,20 C114,48 164,54 222,22 C176,34 128,28 84,8 Z" />
          <path d="M728,18 C684,48 634,50 578,18 C624,30 672,26 716,6 Z" />
          <path d="M48,162 C64,186 64,220 56,248 C50,218 46,190 48,162 Z" />
          <path d="M746,166 C730,192 730,224 738,252 C744,222 748,194 746,166 Z" />
        </g>

        {/* Lightweight Firefly Bokeh (zero expensive SVG Gaussian blur filters) */}
        {FIREFLIES.map((dot, idx) => (
          <g key={`firefly-${idx}`} opacity={dot.o}>
            <circle cx={dot.x} cy={dot.y} r={dot.glow} fill={dot.color} opacity="0.14" />
            <circle cx={dot.x} cy={dot.y} r={dot.r} fill={dot.color} />
          </g>
        ))}

        {/* ================= 2. MOSSY STONE STAGE PEDESTAL & FLOOR MIST ================= */}
        <g>
          <polygon
            points="16,336 104,302 696,302 784,336 760,358 40,358"
            fill="url(#stoneTopGrad)"
            stroke="rgba(125, 211, 252, 0.14)"
            strokeWidth="1"
          />

          <ellipse cx="385" cy="314" rx="295" ry="20" fill="url(#stageFloorMistGrad)" />

          <polygon
            points="24,344 120,336 244,346 392,340 554,346 686,336 774,344 800,420 0,420"
            fill="url(#stoneCliffGrad)"
          />
          <polygon points="168,342 268,348 232,386 144,376" fill="rgba(148, 163, 184, 0.045)" />
          <polygon points="396,341 498,346 472,390 382,384" fill="rgba(148, 163, 184, 0.04)" />
          <polygon points="562,345 668,338 648,386 544,380" fill="rgba(148, 163, 184, 0.045)" />

          <path
            d="M28,342 Q64,328 104,339 Q142,331 182,344 Q146,360 98,356 Q56,360 28,342 Z"
            fill="url(#mossCrestGrad)"
            opacity="0.82"
          />
          <path
            d="M254,343 Q306,335 358,344 Q404,336 452,344 Q404,354 352,352 Q296,356 254,343 Z"
            fill="url(#mossCrestGrad)"
            opacity="0.68"
          />
          <path
            d="M608,343 Q652,330 698,340 Q742,331 774,343 Q740,360 692,356 Q646,358 608,343 Z"
            fill="url(#mossCrestGrad)"
            opacity="0.82"
          />
          <path d="M0,360 C46,354 88,376 116,420 L0,420 Z" fill="#030b09" />
          <path d="M800,360 C754,354 712,376 684,420 L800,420 Z" fill="#030b09" />
        </g>

        {/* Ground Contact Shadows */}
        <ellipse cx="68" cy="316" rx="34" ry="5.5" fill="rgba(0,0,0,0.72)" />
        <ellipse cx="182" cy="324" rx="38" ry="6.5" fill="rgba(0,0,0,0.78)" />
        <ellipse cx="354" cy="316" rx="98" ry="6" fill="rgba(0,0,0,0.72)" />
        <ellipse cx="524" cy="324" rx="38" ry="6.5" fill="rgba(0,0,0,0.78)" />
        <ellipse cx="630" cy="325" rx="52" ry="7.5" fill="rgba(0,0,0,0.8)" />
        <ellipse cx="732" cy="316" rx="34" ry="5.5" fill="rgba(0,0,0,0.72)" />

        {/* ================= 3. SL: FAR LEFT SURROUND SATELLITE ================= */}
        <g>
          <polygon points="44,246 58,238 104,238 92,246" fill="url(#cabinetTopGrad)" />
          <polygon points="92,246 104,238 104,302 92,310" fill="url(#cabinetBevelRightGrad)" />
          <rect
            x="44"
            y="246"
            width="48"
            height="64"
            rx="3"
            fill="url(#cabinetFrontGrad)"
            stroke={selectedChannel === 'SL' || activeSweepChannel === 'SL' ? '#c084fc' : '#2a3942'}
            strokeWidth={selectedChannel === 'SL' || activeSweepChannel === 'SL' ? 1.6 : 1}
          />
          <line x1="46" y1="248" x2="46" y2="308" stroke="rgba(192, 132, 252, 0.22)" strokeWidth="0.9" />
          <circle cx="68" cy="257" r="4.2" fill="#080d10" stroke="#334155" strokeWidth="0.8" />
          <circle cx="68" cy="257" r="1.8" fill="#64748b" />
          {isNodePulsing('SL') && (
            <circle
              cx="68"
              cy="279"
              r="18"
              fill="none"
              stroke="#c084fc"
              strokeWidth="1.2"
              className="animate-speaker-node-pulse"
              pointerEvents="none"
            />
          )}
          <g
            ref={(el) => {
              ringRefs.current.driverCone.SL = el;
            }}
            data-speaker-cone="SL"
            style={GPU_CENTER_STYLE}
          >
            <circle cx="68" cy="279" r="15.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.2" />
            <circle
              ref={(el) => {
                ringRefs.current.coreGlow.SL = el;
              }}
              cx="68"
              cy="279"
              r="15"
              fill="url(#innerConeVioletGlow)"
              pointerEvents="none"
              style={{ ...GPU_CENTER_STYLE, opacity: 0 }}
            />
            <circle cx="68" cy="279" r="5.5" fill="#0a1014" stroke="#334155" strokeWidth="0.8" />
            <circle
              ref={(el) => {
                ringRefs.current.coreRing.SL = el;
              }}
              data-speaker-ring="SL"
              cx="68"
              cy="279"
              r="12.5"
              fill="none"
              stroke={byId.SL?.muted ? '#475569' : '#c084fc'}
              strokeWidth="2.4"
              style={{
                ...GPU_CENTER_STYLE,
                opacity: byId.SL?.muted ? 0.2 : 0.56,
              }}
            />
          </g>
        </g>

        {/* ================= 4. FL: FRONT LEFT FLOOR-STANDING TOWER ================= */}
        <g>
          <polygon points="148,314 158,308 214,308 206,314" fill="#1e2930" />
          <rect x="148" y="314" width="58" height="7" rx="1.5" fill="#090e11" stroke="#26343d" strokeWidth="0.8" />
          <polygon points="156,64 170,56 214,56 202,64" fill="url(#cabinetTopGrad)" />
          <polygon points="202,64 214,56 214,306 202,314" fill="url(#cabinetBevelRightGrad)" />
          <rect
            x="156"
            y="64"
            width="46"
            height="250"
            rx="2.5"
            fill="url(#cabinetFrontGrad)"
            stroke={selectedChannel === 'FL' || activeSweepChannel === 'FL' ? '#00f0ff' : '#2e3e48'}
            strokeWidth={selectedChannel === 'FL' || activeSweepChannel === 'FL' ? 1.7 : 1}
          />
          <line x1="158" y1="67" x2="158" y2="311" stroke="rgba(0, 240, 255, 0.26)" strokeWidth="1" />
          <circle cx="179" cy="92" r="6" fill="#080d10" stroke="#334155" strokeWidth="0.9" />
          <circle cx="179" cy="92" r="2.4" fill="#64748b" />
          {isNodePulsing('FL') && (
            <circle
              cx="179"
              cy="136"
              r="21.5"
              fill="none"
              stroke="#00f0ff"
              strokeWidth="1.2"
              className="animate-speaker-node-pulse"
              pointerEvents="none"
            />
          )}
          <g
            ref={(el) => {
              ringRefs.current.driverCone.FL = el;
            }}
            data-speaker-cone="FL"
            style={GPU_CENTER_STYLE}
          >
            <circle cx="179" cy="136" r="18.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.4" />
            <circle
              ref={(el) => {
                ringRefs.current.coreGlow.FL = el;
              }}
              cx="179"
              cy="136"
              r="18"
              fill="url(#innerConeCyanGlow)"
              pointerEvents="none"
              style={{ ...GPU_CENTER_STYLE, opacity: 0 }}
            />
            <circle cx="179" cy="136" r="7" fill="#090e11" stroke="#334155" strokeWidth="0.9" />
            <circle
              ref={(el) => {
                ringRefs.current.coreRing.FL = el;
              }}
              data-speaker-ring="FL"
              cx="179"
              cy="136"
              r="15"
              fill="none"
              stroke={byId.FL?.muted ? '#475569' : '#00f0ff'}
              strokeWidth="2.6"
              style={{
                ...GPU_CENTER_STYLE,
                opacity: byId.FL?.muted ? 0.2 : 0.6,
              }}
            />
          </g>
          <circle cx="179" cy="194" r="15.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.2" />
          <circle cx="179" cy="194" r="5.5" fill="#090e11" />
          <circle cx="179" cy="248" r="15.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.2" />
          <circle cx="179" cy="248" r="5.5" fill="#090e11" />
          <rect x="167" y="284" width="24" height="7" rx="3.5" fill="#030507" stroke="#1e293b" strokeWidth="0.8" />
        </g>

        {/* ================= 5. C: CENTER SPEAKER + LOW-PROFILE OBSIDIAN AV DECK ================= */}
        <g>
          <polygon points="264,296 274,290 434,290 444,296" fill="url(#cabinetTopGrad)" />
          <rect
            x="264"
            y="296"
            width="180"
            height="17"
            rx="2"
            fill="url(#avDeckFrontGrad)"
            stroke="#2a3942"
            strokeWidth="0.9"
          />
          <rect x="272" y="300" width="164" height="6" rx="1" fill="#04070a" opacity="0.85" />
          <line x1="278" y1="308.5" x2="316" y2="308.5" stroke="rgba(56, 189, 248, 0.45)" strokeWidth="1" />
          <circle cx="426" cy="306" r="1.4" fill="#38bdf8" opacity="0.7" />

          <polygon points="292,246 302,238 406,238 416,246" fill="url(#cabinetTopGrad)" />
          <rect
            x="292"
            y="246"
            width="124"
            height="42"
            rx="3.5"
            fill="url(#cabinetFrontGrad)"
            stroke={selectedChannel === 'C' || activeSweepChannel === 'C' ? '#fbbf24' : '#2e3e48'}
            strokeWidth={selectedChannel === 'C' || activeSweepChannel === 'C' ? 1.7 : 1}
          />
          <line x1="295" y1="248" x2="413" y2="248" stroke="rgba(251, 191, 36, 0.24)" strokeWidth="0.9" />
          <circle cx="316" cy="267" r="12.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.1" />
          <circle cx="316" cy="267" r="4.5" fill="#090e11" />
          <circle cx="392" cy="267" r="12.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.1" />
          <circle cx="392" cy="267" r="4.5" fill="#090e11" />
          {isNodePulsing('C') && (
            <circle
              cx="354"
              cy="267"
              r="18.5"
              fill="none"
              stroke="#fbbf24"
              strokeWidth="1.2"
              className="animate-speaker-node-pulse"
              pointerEvents="none"
            />
          )}
          <g
            ref={(el) => {
              ringRefs.current.driverCone.C = el;
            }}
            data-speaker-cone="C"
            style={GPU_CENTER_STYLE}
          >
            <circle cx="354" cy="267" r="16" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.3" />
            <circle
              ref={(el) => {
                ringRefs.current.coreGlow.C = el;
              }}
              cx="354"
              cy="267"
              r="15.5"
              fill="url(#innerConeAmberGlow)"
              pointerEvents="none"
              style={{ ...GPU_CENTER_STYLE, opacity: 0 }}
            />
            <circle cx="354" cy="267" r="5.8" fill="#090e11" stroke="#334155" strokeWidth="0.9" />
            <circle
              ref={(el) => {
                ringRefs.current.coreRing.C = el;
              }}
              data-speaker-ring="C"
              cx="354"
              cy="267"
              r="13"
              fill="none"
              stroke={byId.C?.muted ? '#475569' : '#fbbf24'}
              strokeWidth="2.5"
              style={{
                ...GPU_CENTER_STYLE,
                opacity: byId.C?.muted ? 0.2 : 0.6,
              }}
            />
          </g>
        </g>

        {/* ================= 6. FR: FRONT RIGHT FLOOR-STANDING TOWER ================= */}
        <g>
          <polygon points="492,314 500,308 556,308 558,314" fill="#1e2930" />
          <rect x="498" y="314" width="58" height="7" rx="1.5" fill="#090e11" stroke="#26343d" strokeWidth="0.8" />
          <polygon points="504,64 492,56 536,56 550,64" fill="url(#cabinetTopGrad)" />
          <polygon points="492,56 504,64 504,314 492,306" fill="url(#cabinetBevelLeftGrad)" />
          <rect
            x="504"
            y="64"
            width="46"
            height="250"
            rx="2.5"
            fill="url(#cabinetFrontGrad)"
            stroke={selectedChannel === 'FR' || activeSweepChannel === 'FR' ? '#00f0ff' : '#2e3e48'}
            strokeWidth={selectedChannel === 'FR' || activeSweepChannel === 'FR' ? 1.7 : 1}
          />
          <line x1="548" y1="67" x2="548" y2="311" stroke="rgba(0, 240, 255, 0.26)" strokeWidth="1" />
          <circle cx="527" cy="92" r="6" fill="#080d10" stroke="#334155" strokeWidth="0.9" />
          <circle cx="527" cy="92" r="2.4" fill="#64748b" />
          {isNodePulsing('FR') && (
            <circle
              cx="527"
              cy="136"
              r="21.5"
              fill="none"
              stroke="#00f0ff"
              strokeWidth="1.2"
              className="animate-speaker-node-pulse"
              pointerEvents="none"
            />
          )}
          <g
            ref={(el) => {
              ringRefs.current.driverCone.FR = el;
            }}
            data-speaker-cone="FR"
            style={GPU_CENTER_STYLE}
          >
            <circle cx="527" cy="136" r="18.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.4" />
            <circle
              ref={(el) => {
                ringRefs.current.coreGlow.FR = el;
              }}
              cx="527"
              cy="136"
              r="18"
              fill="url(#innerConeCyanGlow)"
              pointerEvents="none"
              style={{ ...GPU_CENTER_STYLE, opacity: 0 }}
            />
            <circle cx="527" cy="136" r="7" fill="#090e11" stroke="#334155" strokeWidth="0.9" />
            <circle
              ref={(el) => {
                ringRefs.current.coreRing.FR = el;
              }}
              data-speaker-ring="FR"
              cx="527"
              cy="136"
              r="15"
              fill="none"
              stroke={byId.FR?.muted ? '#475569' : '#00f0ff'}
              strokeWidth="2.6"
              style={{
                ...GPU_CENTER_STYLE,
                opacity: byId.FR?.muted ? 0.2 : 0.6,
              }}
            />
          </g>
          <circle cx="527" cy="194" r="15.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.2" />
          <circle cx="527" cy="194" r="5.5" fill="#090e11" />
          <circle cx="527" cy="248" r="15.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.2" />
          <circle cx="527" cy="248" r="5.5" fill="#090e11" />
          <rect x="515" y="284" width="24" height="7" rx="3.5" fill="#030507" stroke="#1e293b" strokeWidth="0.8" />
        </g>

        {/* ================= 7. LFE: IVY-DRAPED SUBWOOFER CABINET ================= */}
        <g>
          <rect x="592" y="316" width="12" height="5" rx="1.5" fill="#050809" />
          <rect x="656" y="316" width="12" height="5" rx="1.5" fill="#050809" />
          <polygon points="586,184 570,172 654,172 674,184" fill="url(#cabinetTopGrad)" />
          <polygon points="570,172 586,184 586,316 570,304" fill="url(#cabinetBevelLeftGrad)" />
          <rect
            x="586"
            y="184"
            width="88"
            height="132"
            rx="3.5"
            fill="url(#cabinetFrontGrad)"
            stroke={selectedChannel === 'LFE' || activeSweepChannel === 'LFE' ? '#34d399' : '#2c3d42'}
            strokeWidth={selectedChannel === 'LFE' || activeSweepChannel === 'LFE' ? 1.8 : 1.1}
          />
          {/* Recessed Sub-Bass Reflex Port */}
          <circle cx="630" cy="291" r="11" fill="#020405" stroke="#1e293b" strokeWidth="1.3" />
          <circle cx="630" cy="291" r="7.2" fill="#000000" />
          <circle
            ref={(el) => {
              ringRefs.current.lfePortGlow = el;
            }}
            cx="630"
            cy="291"
            r="12"
            fill="url(#lfePortGrad)"
            pointerEvents="none"
            style={{
              ...GPU_CENTER_STYLE,
              opacity: 0,
            }}
          />

          {/* Primary High-Excursion Sub Woofer & Inner Core Ring */}
          {isNodePulsing('LFE') && (
            <circle
              cx="630"
              cy="236"
              r="34"
              fill="none"
              stroke="#34d399"
              strokeWidth="1.4"
              className="animate-speaker-node-pulse"
              pointerEvents="none"
            />
          )}
          <g
            ref={(el) => {
              ringRefs.current.driverCone.LFE = el;
            }}
            data-speaker-cone="LFE"
            style={GPU_CENTER_STYLE}
          >
            <circle cx="630" cy="236" r="30.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.7" />
            <circle cx="630" cy="236" r="26.5" fill="none" stroke="#0c1418" strokeWidth="2.4" />
            <circle
              ref={(el) => {
                ringRefs.current.coreGlow.LFE = el;
              }}
              cx="630"
              cy="236"
              r="29"
              fill="url(#innerConeLfeGlow)"
              pointerEvents="none"
              style={{ ...GPU_CENTER_STYLE, opacity: 0 }}
            />
            <circle cx="630" cy="236" r="11" fill="#080c0f" stroke="#334155" strokeWidth="1.1" />
            <circle
              ref={(el) => {
                ringRefs.current.coreRing.LFE = el;
              }}
              data-speaker-ring="LFE"
              cx="630"
              cy="236"
              r="22.5"
              fill="none"
              stroke={byId.LFE?.muted ? '#475569' : '#34d399'}
              strokeWidth="3.3"
              style={{
                ...GPU_CENTER_STYLE,
                opacity: byId.LFE?.muted ? 0.2 : 0.64,
              }}
            />
          </g>

          {/* Natural Draping Ivy Vines & Leaves */}
          <g opacity="0.94">
            <path
              d="M576,177 C594,163 632,163 668,179 M588,178 C578,200 582,228 576,258 M602,174 C598,194 606,210 595,230 M658,175 C670,194 666,220 672,244"
              fill="none"
              stroke="#1e4625"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
            {[
              { x: 580, y: 176, rot: -28, s: 1.05 },
              { x: 595, y: 170, rot: 14, s: 1.12 },
              { x: 612, y: 172, rot: -16, s: 0.95 },
              { x: 628, y: 169, rot: 22, s: 1.08 },
              { x: 646, y: 172, rot: 36, s: 0.95 },
              { x: 664, y: 180, rot: 54, s: 0.9 },
              { x: 672, y: 196, rot: 68, s: 0.85 },
              { x: 668, y: 214, rot: 48, s: 0.82 },
              { x: 582, y: 194, rot: -64, s: 1.0 },
              { x: 593, y: 187, rot: 24, s: 0.9 },
              { x: 579, y: 214, rot: -48, s: 0.95 },
              { x: 596, y: 205, rot: 18, s: 0.86 },
              { x: 580, y: 234, rot: -58, s: 0.9 },
              { x: 577, y: 252, rot: -40, s: 0.82 },
              { x: 591, y: 222, rot: 30, s: 0.78 },
            ].map((leaf, i) => (
              <path
                key={`ivy-leaf-${i}`}
                d="M0,-6 C4.2,-5.5 7,-1.5 0,7 C-7,-1.5 -4.2,-5.5 0,-6 Z"
                transform={`translate(${leaf.x}, ${leaf.y}) rotate(${leaf.rot}) scale(${leaf.s})`}
                fill="url(#ivyLeafGrad)"
                stroke="#071d0e"
                strokeWidth="0.6"
              />
            ))}
          </g>
        </g>

        {/* ================= 8. SR: FAR RIGHT SURROUND SATELLITE ================= */}
        <g>
          <polygon points="708,246 696,238 742,238 756,246" fill="url(#cabinetTopGrad)" />
          <polygon points="696,238 708,246 708,310 696,302" fill="url(#cabinetBevelLeftGrad)" />
          <rect
            x="708"
            y="246"
            width="48"
            height="64"
            rx="3"
            fill="url(#cabinetFrontGrad)"
            stroke={selectedChannel === 'SR' || activeSweepChannel === 'SR' ? '#c084fc' : '#2a3942'}
            strokeWidth={selectedChannel === 'SR' || activeSweepChannel === 'SR' ? 1.6 : 1}
          />
          <line x1="754" y1="248" x2="754" y2="308" stroke="rgba(192, 132, 252, 0.22)" strokeWidth="0.9" />
          <circle cx="732" cy="257" r="4.2" fill="#080d10" stroke="#334155" strokeWidth="0.8" />
          <circle cx="732" cy="257" r="1.8" fill="#64748b" />
          {isNodePulsing('SR') && (
            <circle
              cx="732"
              cy="279"
              r="18"
              fill="none"
              stroke="#c084fc"
              strokeWidth="1.2"
              className="animate-speaker-node-pulse"
              pointerEvents="none"
            />
          )}
          <g
            ref={(el) => {
              ringRefs.current.driverCone.SR = el;
            }}
            data-speaker-cone="SR"
            style={GPU_CENTER_STYLE}
          >
            <circle cx="732" cy="279" r="15.5" fill="url(#wooferConeGrad)" stroke="#1e293b" strokeWidth="1.2" />
            <circle
              ref={(el) => {
                ringRefs.current.coreGlow.SR = el;
              }}
              cx="732"
              cy="279"
              r="15"
              fill="url(#innerConeVioletGlow)"
              pointerEvents="none"
              style={{ ...GPU_CENTER_STYLE, opacity: 0 }}
            />
            <circle cx="732" cy="279" r="5.5" fill="#0a1014" stroke="#334155" strokeWidth="0.8" />
            <circle
              ref={(el) => {
                ringRefs.current.coreRing.SR = el;
              }}
              data-speaker-ring="SR"
              cx="732"
              cy="279"
              r="12.5"
              fill="none"
              stroke={byId.SR?.muted ? '#475569' : '#c084fc'}
              strokeWidth="2.4"
              style={{
                ...GPU_CENTER_STYLE,
                opacity: byId.SR?.muted ? 0.2 : 0.56,
              }}
            />
          </g>
        </g>
      </svg>

      {/* Accessible Speaker Interaction Hotspots & Sleek Dark Channel Badges */}
      {channels.map((ch) => {
        const anchor = SPEAKER_ANCHORS[ch.id];
        const isMuted = effectiveGains[ch.id] <= 0.001;
        const isSelected = selectedChannel === ch.id;
        const isSwept = activeSweepChannel === ch.id;
        const isLfe = ch.id === 'LFE';
        const isCenter = ch.id === 'C';
        const isSurround = ch.id === 'SL' || ch.id === 'SR';

        const speakerBadgeClass = isMuted
          ? 'bg-slate-950/92 border border-slate-700/80 text-slate-500'
          : isLfe
            ? isSelected || isSwept
              ? 'hardware-badge-lfe-active text-emerald-100'
              : 'hardware-badge-lfe text-emerald-200 hover:border-emerald-300/75'
            : isCenter
              ? isSelected || isSwept
                ? 'hardware-badge-amber-active text-amber-100'
                : 'hardware-badge-amber text-amber-200 hover:border-amber-300/75'
              : isSurround
                ? isSelected || isSwept
                  ? 'hardware-badge-violet-active text-violet-100'
                  : 'hardware-badge-violet text-violet-200 hover:border-violet-300/75'
                : isSelected || isSwept
                  ? 'hardware-badge-active text-white'
                  : 'hardware-badge text-cyan-100 hover:border-cyan-300/75';

        return (
          <div key={`hotspot-${ch.id}`}>
            <button
              type="button"
              onClick={() => onSelectSpeaker(ch.id)}
              aria-label={`Audition ${anchor.roleTitle}`}
              aria-pressed={isSelected}
              style={{
                left: `${anchor.hitLeftPct}%`,
                top: `${anchor.hitTopPct}%`,
                width: `${anchor.hitWidthPct}%`,
                height: `${anchor.hitHeightPct}%`,
              }}
              className="absolute rounded-lg cursor-pointer bg-transparent focus-visible:outline-2 focus-visible:outline-sky-300"
            />

            <button
              type="button"
              onClick={() => onSelectSpeaker(ch.id)}
              aria-label={`Select ${ch.label} (${ch.shortName}) channel`}
              style={{
                left: `${anchor.labelLeftPct}%`,
                top: `${anchor.labelTopPct}%`,
                transform: 'translate(-50%, -50%)',
              }}
              className={`absolute px-1 sm:px-2 py-0.5 rounded-md text-[9px] sm:text-[11px] font-mono leading-tight flex items-center gap-1 whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-sky-300 ${speakerBadgeClass}`}
            >
              <span className="font-semibold tracking-tight">{ch.shortName}</span>
              <span className="hidden sm:inline text-slate-300/85 tabular-nums">
                {ch.gainDb > 0 ? `+${ch.gainDb.toFixed(0)}` : ch.gainDb.toFixed(0)}dB
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
