export type ChannelId = 'FL' | 'FR' | 'C' | 'LFE' | 'SL' | 'SR';

export type UpmixProfile = 'cinema-pro' | 'ambient-hall' | 'direct-discrete';

export type ExportFormat = 'ac3' | 'dts' | 'flac' | '8d-spatial';

export type SpatialContainerFormat = 'mp3' | 'wav';

export type Ac3BitrateKbps = 384 | 448 | 640;

export interface ChannelConfig {
  id: ChannelId;
  label: string;
  shortName: string;
  angleLabel: string;
  gainDb: number;
  muted: boolean;
  solo: boolean;
  /** Normalized SVG coordinates (0..100) for the Acoustic Stage Monitor */
  stageX: number;
  stageY: number;
}

export interface AudioTrackMetadata {
  name: string;
  sizeBytes: number;
  mimeType: string;
  durationSec: number;
  sampleRate: number;
  sourceChannels: number;
  isDemo?: boolean;
}

export interface ConversionResult {
  blob: Blob;
  url: string;
  outputFilename: string;
  sizeBytes: number;
  format: ExportFormat;
  codecLabel: string;
  bitrateKbps?: number;
  sampleRate: 48000;
  channels: number;
  elapsedMs: number;
  usedCustomMix: boolean;
  channelRms?: Record<ChannelId, number>;
  statusLogs?: string[];
}

export type ConversionPhase =
  | 'idle'
  | 'loading-engine'
  | 'preparing-audio'
  | 'processing-8d'
  | 'encoding-ac3'
  | 'encoding-output'
  | 'completed'
  | 'error';

export const CHANNEL_ORDER: readonly ChannelId[] = ['FL', 'FR', 'C', 'LFE', 'SL', 'SR'] as const;

export const INITIAL_CHANNELS: ChannelConfig[] = [
  {
    id: 'FL',
    label: 'Front Left',
    shortName: 'FL',
    angleLabel: '-30°',
    gainDb: 0,
    muted: false,
    solo: false,
    stageX: 20,
    stageY: 22,
  },
  {
    id: 'C',
    label: 'Center',
    shortName: 'C',
    angleLabel: '0°',
    gainDb: 0,
    muted: false,
    solo: false,
    stageX: 50,
    stageY: 15,
  },
  {
    id: 'FR',
    label: 'Front Right',
    shortName: 'FR',
    angleLabel: '+30°',
    gainDb: 0,
    muted: false,
    solo: false,
    stageX: 80,
    stageY: 22,
  },
  {
    id: 'LFE',
    label: 'Subwoofer',
    shortName: 'LFE',
    angleLabel: '120 Hz LPF',
    gainDb: 0,
    muted: false,
    solo: false,
    stageX: 65,
    stageY: 52,
  },
  {
    id: 'SL',
    label: 'Surround Left',
    shortName: 'SL',
    angleLabel: '-110°',
    gainDb: 0,
    muted: false,
    solo: false,
    stageX: 20,
    stageY: 80,
  },
  {
    id: 'SR',
    label: 'Surround Right',
    shortName: 'SR',
    angleLabel: '+110°',
    gainDb: 0,
    muted: false,
    solo: false,
    stageX: 80,
    stageY: 80,
  },
];
