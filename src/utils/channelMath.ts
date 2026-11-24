import type {
  Ac3BitrateKbps,
  ChannelConfig,
  ChannelId,
  ExportFormat,
  SpatialContainerFormat,
  UpmixProfile,
} from './audioTypes';

export function dbToLinear(db: number): number {
  if (db <= -60) return 0;
  return Math.pow(10, db / 20);
}

export const MIN_GAIN_DB = -18;
export const MAX_GAIN_DB = 6;

export function clampGainDb(db: number): number {
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(db * 10) / 10));
}

/**
 * Computes effective linear gain for each of the 6 channels respecting Mute and Solo rules.
 * If any channel has `solo: true`, only soloed (and non-muted) channels remain audible.
 */
export function computeEffectiveChannelGains(channels: ChannelConfig[]): Record<ChannelId, number> {
  const anySolo = channels.some((ch) => ch.solo);
  const result: Record<ChannelId, number> = {
    FL: 1,
    FR: 1,
    C: 1,
    LFE: 1,
    SL: 1,
    SR: 1,
  };

  for (const ch of channels) {
    if (ch.muted || (anySolo && !ch.solo)) {
      result[ch.id] = 0;
    } else {
      result[ch.id] = dbToLinear(ch.gainDb);
    }
  }

  return result;
}

export function hasCustomChannelEdits(
  channels: ChannelConfig[],
  upmixProfile: UpmixProfile = 'cinema-pro',
): boolean {
  if (upmixProfile !== 'cinema-pro') return true;
  return channels.some((ch) => ch.muted || ch.solo || Math.abs(ch.gainDb) > 0.01);
}

export function sanitizeInputExtension(filename: string): string {
  const parts = filename.toLowerCase().trim().split('.');
  if (parts.length < 2) return 'wav';
  const ext = parts[parts.length - 1].replace(/[^a-z0-9]/g, '');
  const allowed = new Set([
    'wav',
    'mp3',
    'flac',
    'aac',
    'm4a',
    'ogg',
    'opus',
    'webm',
    'mp4',
    'aiff',
    'wma',
    'ac3',
  ]);
  return allowed.has(ext) ? ext : 'bin';
}

export function isSupportedAudioFile(filename: string, mimeType: string): boolean {
  if (mimeType && (mimeType.startsWith('audio/') || mimeType === 'video/mp4' || mimeType === 'video/webm')) {
    return true;
  }
  const ext = sanitizeInputExtension(filename);
  return ext !== 'bin';
}

export function buildOutputAc3Filename(sourceFilename: string): string {
  return buildOutputFilename(sourceFilename, 'ac3', 'wav');
}

export function buildOutputFilename(
  sourceFilename: string,
  format: ExportFormat,
  spatialContainer: SpatialContainerFormat = 'mp3',
): string {
  const base = sourceFilename
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeBase = base.length > 0 ? base : 'surround_mix';
  switch (format) {
    case 'ac3':
      return `${safeBase}_5.1.ac3`;
    case 'dts':
      return `${safeBase}_5.1.dts`;
    case 'flac':
      return `${safeBase}_5.1.flac`;
    case '8d-spatial':
      return `${safeBase}_8D_Spatial.${spatialContainer}`;
  }
}

/**
 * Builds the standard, reliable FFmpeg command arguments for 5.1 AC3 encoding
 * without fragile filter_complex syntax.
 */
export function buildAc3FfmpegArgs(
  inputName: string,
  outputName: string,
  bitrateKbps: Ac3BitrateKbps = 448,
): string[] {
  return buildFfmpegArgsForFormat(inputName, outputName, 'ac3', { bitrateKbps });
}

export function buildFfmpegArgsForFormat(
  inputName: string,
  outputName: string,
  format: ExportFormat,
  options: {
    bitrateKbps?: Ac3BitrateKbps;
    spatialContainer?: SpatialContainerFormat;
  } = {},
): string[] {
  const bitrateKbps = options.bitrateKbps ?? 448;
  switch (format) {
    case 'ac3':
      return [
        '-y',
        '-i',
        inputName,
        '-vn',
        '-c:a',
        'ac3',
        '-b:a',
        `${bitrateKbps}k`,
        '-ar',
        '48000',
        '-ac',
        '6',
        outputName,
      ];
    case 'dts':
      return [
        '-y',
        '-i',
        inputName,
        '-vn',
        '-c:a',
        'dca',
        '-strict',
        '-2',
        '-b:a',
        '768k',
        '-ar',
        '48000',
        '-ac',
        '6',
        outputName,
      ];
    case 'flac':
      return [
        '-y',
        '-i',
        inputName,
        '-vn',
        '-c:a',
        'flac',
        '-compression_level',
        '2',
        '-ar',
        '48000',
        '-ac',
        '6',
        outputName,
      ];
    case '8d-spatial':
      if (options.spatialContainer === 'wav') {
        return ['-y', '-i', inputName, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', outputName];
      }
      return [
        '-y',
        '-i',
        inputName,
        '-vn',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '320k',
        '-compression_level',
        '5',
        '-ar',
        '48000',
        '-ac',
        '2',
        outputName,
      ];
  }
}

export function isValidAc3Bitstream(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 64 && bytes[0] === 0x0b && bytes[1] === 0x77;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const totalSec = Math.floor(seconds);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Generates a deterministic, pleasant harmonic stereo PCM WAV buffer (Uint8Array)
 * with distinct left/right panning, center harmonic focus, and 55 Hz LFE sub-bass pulse
 * so users can audition all 6 separated channels immediately.
 */
export function createDemoStereoWavBuffer(
  durationSec = 8,
  sampleRate = 48000,
): Uint8Array {
  const numChannels = 2;
  const bitsPerSample = 16;
  const numFrames = Math.floor(durationSec * sampleRate);
  const dataSize = numFrames * numChannels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  view.setUint16(32, numChannels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const t = i / sampleRate;
    const fadeIn = Math.min(1, t / 0.25);
    const fadeOut = Math.min(1, (durationSec - t) / 0.5);
    const env = fadeIn * fadeOut;

    // Punchy 120 BPM sub-bass kick & drop envelope every 0.5s (45-58 Hz)
    const beatPhase = (t * 2.0) % 1.0; // 2 beats/sec = 120 BPM
    const kickEnv = Math.exp(-beatPhase * 6.5);
    const dropEnv = 0.28 + 0.72 * kickEnv;
    const subFreq = 46 + 24 * Math.exp(-beatPhase * 18);
    const bass = Math.sin(2 * Math.PI * subFreq * t) * 0.44 * dropEnv;

    // Centered warm lead harmonic (drives Center & Mains)
    const centerPulse = 0.55 + 0.45 * Math.sin(2 * Math.PI * 1.0 * t);
    const root = Math.sin(2 * Math.PI * 196.0 * t) * 0.16 * centerPulse;
    const lead = Math.sin(2 * Math.PI * 523.25 * t) * 0.08 * Math.max(0, Math.sin(2 * Math.PI * 0.5 * t));

    // Stereo panned harmonic arpeggio (drives FL/FR & SL/SR separation)
    const pan = 0.5 + 0.44 * Math.sin(2 * Math.PI * 0.35 * t);
    const fifth = Math.sin(2 * Math.PI * 293.66 * t) * 0.16;
    const minorThird = Math.sin(2 * Math.PI * 233.08 * t + 0.35 * Math.sin(2 * Math.PI * 0.25 * t)) * 0.15;
    const shimmer = Math.sin(2 * Math.PI * 880 * t) * 0.06 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2.0 * t));

    const left = Math.max(
      -0.95,
      Math.min(0.95, (bass + root + lead + fifth * (1 - pan * 0.65) + shimmer * (1 - pan)) * env),
    );
    const right = Math.max(
      -0.95,
      Math.min(0.95, (bass + root + lead + minorThird * (0.35 + pan * 0.65) + shimmer * pan) * env),
    );

    view.setInt16(offset, Math.round(left * 32767), true);
    view.setInt16(offset + 2, Math.round(right * 32767), true);
    offset += 4;
  }

  return new Uint8Array(buffer);
}

/**
 * Encodes an array of 6 Float32Arrays ([FL, FR, C, LFE, SL, SR]) into a valid 48kHz PCM16 6-channel
 * WAVEFORMATEXTENSIBLE WAV Uint8Array with explicit 5.1 channel mask (0x003F: FL+FR+FC+LFE+BL+BR)
 * so FFmpeg maps all 6 channels deterministically without layout guessing.
 */
export function encodeSixChannelPcmWav(
  channelData: readonly Float32Array[],
  sampleRate = 48000,
): Uint8Array {
  if (channelData.length !== 6) {
    throw new Error(`Expected 6 discrete channels for 5.1 WAV encoding, received ${channelData.length}.`);
  }
  const numChannels = 6;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const maxFrames = 600 * 48000;
  const numFrames = Math.min(channelData[0].length, maxFrames);
  const dataSize = numFrames * blockAlign;
  const fmtChunkSize = 40; // WAVEFORMATEXTENSIBLE
  const headerSize = 12 + 8 + fmtChunkSize + 8; // 68 bytes
  let buffer: ArrayBuffer;
  try {
    buffer = new ArrayBuffer(headerSize + dataSize);
  } catch (err) {
    throw new Error('Memory allocation limit reached for 5.1 multichannel audio buffer. Please use a shorter track or smaller file size.');
  }
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, headerSize - 8 + dataSize, true);
  writeAscii(8, 'WAVE');

  // fmt chunk (WAVEFORMATEXTENSIBLE)
  writeAscii(12, 'fmt ');
  view.setUint32(16, fmtChunkSize, true);
  view.setUint16(20, 0xfffe, true); // WAVE_FORMAT_EXTENSIBLE
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint16(36, 22, true); // cbSize = 22
  view.setUint16(38, bitsPerSample, true); // wValidBitsPerSample
  view.setUint32(40, 0x003f, true); // dwChannelMask: FL | FR | FC | LFE | BL | BR (5.1)

  // KSDATAFORMAT_SUBTYPE_PCM GUID: 00000001-0000-0010-8000-00aa00389b71
  const pcmGuid = [
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
  ];
  for (let i = 0; i < pcmGuid.length; i++) {
    view.setUint8(44 + i, pcmGuid[i]);
  }

  writeAscii(60, 'data');
  view.setUint32(64, dataSize, true);

  let offset = headerSize;
  const fl = channelData[0];
  const fr = channelData[1];
  const c = channelData[2];
  const lfe = channelData[3];
  const sl = channelData[4];
  const sr = channelData[5];

  const isTruncated = channelData[0].length > maxFrames;
  const fadeLen = isTruncated ? Math.min(numFrames, 1024) : 0;

  for (let frame = 0; frame < numFrames; frame++) {
    let fade = 1.0;
    if (isTruncated && frame >= numFrames - fadeLen) {
      const p = (numFrames - 1 - frame) / fadeLen;
      fade = Math.max(0, Math.min(1, p));
    }
    const s0 = Math.max(-1, Math.min(1, (fl[frame] ?? 0) * fade));
    const s1 = Math.max(-1, Math.min(1, (fr[frame] ?? 0) * fade));
    const s2 = Math.max(-1, Math.min(1, (c[frame] ?? 0) * fade));
    const s3 = Math.max(-1, Math.min(1, (lfe[frame] ?? 0) * fade));
    const s4 = Math.max(-1, Math.min(1, (sl[frame] ?? 0) * fade));
    const s5 = Math.max(-1, Math.min(1, (sr[frame] ?? 0) * fade));

    view.setInt16(offset, Math.round(s0 * 32767), true);
    view.setInt16(offset + 2, Math.round(s1 * 32767), true);
    view.setInt16(offset + 4, Math.round(s2 * 32767), true);
    view.setInt16(offset + 6, Math.round(s3 * 32767), true);
    view.setInt16(offset + 8, Math.round(s4 * 32767), true);
    view.setInt16(offset + 10, Math.round(s5 * 32767), true);
    offset += 12;
  }

  return new Uint8Array(buffer);
}

/**
 * Encodes stereo Float32Arrays ([L, R]) into a valid 48 kHz PCM16 RIFF/WAVE Uint8Array.
 */
export function encodeStereoPcmWav(
  leftIn: Float32Array,
  rightIn: Float32Array,
  sampleRate = 48000,
): Uint8Array {
  const numChannels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const maxFrames = 600 * 48000;
  const numFrames = Math.min(leftIn.length, rightIn.length, maxFrames);
  const dataSize = numFrames * blockAlign;
  const headerSize = 44;
  let buffer: ArrayBuffer;
  try {
    buffer = new ArrayBuffer(headerSize + dataSize);
  } catch (err) {
    throw new Error('Memory allocation limit reached for stereo audio buffer. Please use a shorter track or smaller file size.');
  }
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = headerSize;
  const isTruncatedStereo = leftIn.length > maxFrames;
  const fadeLenStereo = isTruncatedStereo ? Math.min(numFrames, 1024) : 0;

  for (let i = 0; i < numFrames; i++) {
    let fade = 1.0;
    if (isTruncatedStereo && i >= numFrames - fadeLenStereo) {
      const p = (numFrames - 1 - i) / fadeLenStereo;
      fade = Math.max(0, Math.min(1, p));
    }
    const l = Math.max(-1, Math.min(1, (leftIn[i] ?? 0) * fade));
    const r = Math.max(-1, Math.min(1, (rightIn[i] ?? 0) * fade));
    view.setInt16(offset, Math.round(l * 32767), true);
    view.setInt16(offset + 2, Math.round(r * 32767), true);
    offset += 4;
  }

  return new Uint8Array(buffer);
}

/**
 * Decodes an uncompressed PCM16 / PCM24 / Float32 RIFF WAVE buffer into Float32Array channels
 * by walking RIFF chunks safely (handles LIST/INFO/JUNK chunks written by FFmpeg).
 */
export function decodePcmWavToChannels(
  wavBytes: Uint8Array,
  maxFrames = 600 * 48000,
): {
  sampleRate: number;
  channels: Float32Array[];
} {
  if (wavBytes.byteLength < 44) {
    throw new Error('WAV buffer is too short to be valid.');
  }
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const tag = (off: number) =>
    String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Invalid RIFF/WAVE header.');
  }

  let audioFormat = 1;
  let numChannels = 2;
  let sampleRate = 48000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= wavBytes.byteLength) {
    const chunkId = tag(pos);
    const chunkSize = view.getUint32(pos + 4, true);
    const payloadPos = pos + 8;

    if (chunkId === 'fmt ' && payloadPos + 16 <= wavBytes.byteLength) {
      audioFormat = view.getUint16(payloadPos, true);
      numChannels = view.getUint16(payloadPos + 2, true);
      sampleRate = view.getUint32(payloadPos + 4, true);
      bitsPerSample = view.getUint16(payloadPos + 14, true);
      if (audioFormat === 0xfffe && chunkSize >= 40 && payloadPos + 26 <= wavBytes.byteLength) {
        audioFormat = view.getUint16(payloadPos + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = payloadPos;
      dataLength = Math.min(chunkSize, wavBytes.byteLength - payloadPos);
      break;
    }

    pos = payloadPos + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || numChannels <= 0) {
    throw new Error('WAV data chunk missing or empty.');
  }
  if (dataLength === 0) {
    return {
      sampleRate,
      channels: Array.from({ length: numChannels }, () => new Float32Array(0)),
    };
  }

  const bytesPerSample = Math.max(1, bitsPerSample / 8);
  const blockAlign = numChannels * bytesPerSample;
  const numFrames = Math.min(maxFrames, Math.floor(dataLength / blockAlign));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(numFrames));

  if (
    IS_LITTLE_ENDIAN &&
    audioFormat === 1 &&
    bitsPerSample === 16 &&
    ((wavBytes.byteOffset + dataOffset) & 1) === 0
  ) {
    const pcm16 = new Int16Array(
      wavBytes.buffer,
      wavBytes.byteOffset + dataOffset,
      numFrames * numChannels,
    );
    const inv32768 = 1 / 32768;
    if (numChannels === 2) {
      const ch0 = channels[0];
      const ch1 = channels[1];
      for (let f = 0, idx = 0; f < numFrames; f++, idx += 2) {
        ch0[f] = pcm16[idx] * inv32768;
        ch1[f] = pcm16[idx + 1] * inv32768;
      }
      return { sampleRate, channels };
    }
    if (numChannels === 6) {
      const ch0 = channels[0];
      const ch1 = channels[1];
      const ch2 = channels[2];
      const ch3 = channels[3];
      const ch4 = channels[4];
      const ch5 = channels[5];
      for (let f = 0, idx = 0; f < numFrames; f++, idx += 6) {
        ch0[f] = pcm16[idx] * inv32768;
        ch1[f] = pcm16[idx + 1] * inv32768;
        ch2[f] = pcm16[idx + 2] * inv32768;
        ch3[f] = pcm16[idx + 3] * inv32768;
        ch4[f] = pcm16[idx + 4] * inv32768;
        ch5[f] = pcm16[idx + 5] * inv32768;
      }
      return { sampleRate, channels };
    }
    for (let f = 0, idx = 0; f < numFrames; f++) {
      for (let ch = 0; ch < numChannels; ch++, idx++) {
        channels[ch][f] = pcm16[idx] * inv32768;
      }
    }
    return { sampleRate, channels };
  }

  let offset = dataOffset;
  for (let f = 0; f < numFrames; f++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        sample = view.getFloat32(offset, true);
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(offset, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(offset);
        const b1 = view.getUint8(offset + 1);
        const b2 = view.getInt8(offset + 2);
        sample = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
      } else if (bitsPerSample === 32) {
        sample = view.getInt32(offset, true) / 2147483648;
      }
      channels[ch][f] = Math.max(-1, Math.min(1, sample));
      offset += bytesPerSample;
    }
  }

  return { sampleRate, channels };
}

function softLimit(x: number): number {
  if (x > -0.9 && x < 0.9) return x;
  return Math.tanh(x);
}

function softLimit95(x: number): number {
  if (x > -0.88 && x < 0.88) return x;
  return Math.tanh(x / 0.95) * 0.95;
}

const IS_LITTLE_ENDIAN =
  new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;

function floatToPcm16(s: number): number {
  if (s <= -1) return -32767;
  if (s >= 1) return 32767;
  return Math.round(s * 32767);
}

function writeSixChannelWavHeader(view: DataView, numFrames: number, sampleRate: number): number {
  const numChannels = 6;
  const bitsPerSample = 16;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const fmtChunkSize = 40;
  const headerSize = 68;

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, headerSize - 8 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, fmtChunkSize, true);
  view.setUint16(20, 0xfffe, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint16(36, 22, true);
  view.setUint16(38, bitsPerSample, true);
  view.setUint32(40, 0x003f, true);

  const pcmGuid = [
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
  ];
  for (let i = 0; i < pcmGuid.length; i++) {
    view.setUint8(44 + i, pcmGuid[i]);
  }

  writeAscii(60, 'data');
  view.setUint32(64, dataSize, true);
  return headerSize;
}

function writeStereoWavHeader(view: DataView, numFrames: number, sampleRate: number): number {
  const numChannels = 2;
  const bitsPerSample = 16;
  const blockAlign = 4;
  const dataSize = numFrames * blockAlign;
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  return 44;
}

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function createButterworthLpfCoeffs(cutoffHz: number, sampleRate: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const q = Math.SQRT1_2; // 0.70710678
  const alpha = sinW0 / (2 * q);
  const a0 = 1 + alpha;
  const oneMinusCos = 1 - cosW0;
  return {
    b0: (oneMinusCos * 0.5) / a0,
    b1: oneMinusCos / a0,
    b2: (oneMinusCos * 0.5) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

function createButterworthHpfCoeffs(cutoffHz: number, sampleRate: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const q = Math.SQRT1_2; // 0.70710678
  const alpha = sinW0 / (2 * q);
  const a0 = 1 + alpha;
  const onePlusCos = 1 + cosW0;
  return {
    b0: (onePlusCos * 0.5) / a0,
    b1: -onePlusCos / a0,
    b2: (onePlusCos * 0.5) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

class BiquadStage {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly c: BiquadCoeffs;

  constructor(coeffs: BiquadCoeffs) {
    this.c = coeffs;
  }

  process(x: number): number {
    const y =
      this.c.b0 * x +
      this.c.b1 * this.x1 +
      this.c.b2 * this.x2 -
      this.c.a1 * this.y1 -
      this.c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class LR4Stage {
  private readonly s1: BiquadStage;
  private readonly s2: BiquadStage;

  constructor(coeffs: BiquadCoeffs) {
    this.s1 = new BiquadStage(coeffs);
    this.s2 = new BiquadStage(coeffs);
  }

  process(x: number): number {
    return this.s2.process(this.s1.process(x));
  }
}

const POW_072_N = 2048;
const POW_072_MAX = 2.85;
const POW_072_SCALE = POW_072_N / POW_072_MAX;
const POW_072_LUT = (() => {
  const arr = new Float64Array(POW_072_N + 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = Math.pow((i * POW_072_MAX) / POW_072_N, 0.72);
  }
  return arr;
})();

const BLOCK_FRAMES = 4096;

function biquadCopy(
  src: Float32Array,
  sOff: number,
  dst: Float64Array,
  count: number,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number,
  fs: Float64Array,
  stOff: number,
): void {
  let x1 = fs[stOff];
  let x2 = fs[stOff + 1];
  let y1 = fs[stOff + 2];
  let y2 = fs[stOff + 3];
  for (let i = 0; i < count; i++) {
    const x = src[sOff + i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    dst[i] = y;
  }
  fs[stOff] = x1;
  fs[stOff + 1] = x2;
  fs[stOff + 2] = y1;
  fs[stOff + 3] = y2;
}

function biquadCopy64(
  src: Float64Array,
  dst: Float64Array,
  count: number,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number,
  fs: Float64Array,
  stOff: number,
): void {
  let x1 = fs[stOff];
  let x2 = fs[stOff + 1];
  let y1 = fs[stOff + 2];
  let y2 = fs[stOff + 3];
  for (let i = 0; i < count; i++) {
    const x = src[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    dst[i] = y;
  }
  fs[stOff] = x1;
  fs[stOff + 1] = x2;
  fs[stOff + 2] = y1;
  fs[stOff + 3] = y2;
}

function biquadInPlace(
  buf: Float64Array,
  count: number,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number,
  fs: Float64Array,
  stOff: number,
): void {
  let x1 = fs[stOff];
  let x2 = fs[stOff + 1];
  let y1 = fs[stOff + 2];
  let y2 = fs[stOff + 3];
  for (let i = 0; i < count; i++) {
    const x = buf[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
  fs[stOff] = x1;
  fs[stOff + 1] = x2;
  fs[stOff + 2] = y1;
  fs[stOff + 3] = y2;
}

/**
 * True Pro Logic II active spatial matrix upmixing processor for 5.1 channel surround.
 * Channel order: [0: FL, 1: FR, 2: C, 3: LFE, 4: SL, 5: SR]
 *
 * Architecture & DSP stages:
 * 1. Phase-Coherent 3-Band LR4 Crossover (150 Hz & 6.5 kHz):
 *    Splits Left & Right cleanly into Low Beat (<150 Hz), Vocal/Mid (150 Hz-6.5 kHz), and Air/Cymbal (>6.5 kHz)
 *    with exact Linkwitz-Riley magnitude summation and zero comb filtering.
 * 2. Strict Lead Vocal Center Isolation (C):
 *    Measures mid/side dominance and cross-correlation specifically inside the 150 Hz-6.5 kHz vocal band
 *    so centered lead vocals route strictly to Center (C) even while wide beats, reverb, and hi-hats play.
 * 3. Front Soundstage Music/Beat/Reverb Separation (FL / FR):
 *    Cancels centered lead vocals exclusively inside the 150 Hz-6.5 kHz vocal band with matched phase,
 *    preserving 100% of kick/beat punch (<150 Hz), crisp percussion/echoes (>6.5 kHz), and stereo instruments/reverb
 *    without vocal muddiness or front-heavy anti-phase bleed.
 * 4. Surround Ambient & Reverb Routing (SL / SR):
 *    Extracts out-of-phase stereo differences, reverb tails, and echoes (80 Hz-16 kHz) with 12ms/18ms Haas delays,
 *    strictly gated against centered vocal bleed.
 * 5. Clean Subwoofer Filtering (LFE):
 *    Cascaded 4th-order (-24 dB/oct) Linkwitz-Riley Low-Pass Filter at 120 Hz isolates pure sub-bass (<120 Hz).
 */
export class StreamingMatrixUpmix51 {
  private readonly gains: Record<ChannelId, number>;
  private readonly profile: UpmixProfile;

  private readonly lfeC: BiquadCoeffs;
  private readonly lp150C: BiquadCoeffs;
  private readonly hp150C: BiquadCoeffs;
  private readonly lp6500C: BiquadCoeffs;
  private readonly hp6500C: BiquadCoeffs;
  // 18 cascaded biquads (9 LR4 stages) * 4 state variables [x1, x2, y1, y2] = 72 doubles
  private readonly fltState = new Float64Array(72);

  // Reusable L1-cache-resident sub-block scratch buffers
  private readonly bufLLow = new Float64Array(BLOCK_FRAMES);
  private readonly bufLAbove = new Float64Array(BLOCK_FRAMES);
  private readonly bufLVocal = new Float64Array(BLOCK_FRAMES);
  private readonly bufLAir = new Float64Array(BLOCK_FRAMES);
  private readonly bufRLow = new Float64Array(BLOCK_FRAMES);
  private readonly bufRAbove = new Float64Array(BLOCK_FRAMES);
  private readonly bufRVocal = new Float64Array(BLOCK_FRAMES);
  private readonly bufRAir = new Float64Array(BLOCK_FRAMES);
  private readonly bufLfe = new Float64Array(BLOCK_FRAMES);

  private readonly alphaSurHp: number;
  private slHpPrevX = 0;
  private slHpPrevY = 0;
  private srHpPrevX = 0;
  private srHpPrevY = 0;

  private readonly alphaSurLp: number;
  private slLpY = 0;
  private srLpY = 0;

  private readonly alphaEchoDamp: number;
  private slEchoDampY = 0;
  private srEchoDampY = 0;

  private readonly pwrSmooth: number;
  private readonly pwrAlpha: number;
  private pwrL = 0;
  private pwrR = 0;
  private pwrCross = 0;
  private vPwrL = 0;
  private vPwrR = 0;
  private vPwrM = 0;
  private vPwrS = 0;
  private vPwrCross = 0;

  private readonly apLenSL: number;
  private readonly apLenSR: number;
  private readonly apBufSL: Float32Array;
  private readonly apBufSR: Float32Array;
  private apIdxSL = 0;
  private apIdxSR = 0;
  private readonly apGain = 0.55;

  private readonly tapDirectSL: number;
  private readonly tapEcho1SL: number;
  private readonly tapEcho2SL: number;
  private readonly ringSL: Float32Array;
  private readonly ringLenSL: number;
  private idxSL = 0;

  private readonly tapDirectSR: number;
  private readonly tapEcho1SR: number;
  private readonly tapEcho2SR: number;
  private readonly ringSR: Float32Array;
  private readonly ringLenSR: number;
  private idxSR = 0;

  private readonly centerAmt: number;
  private readonly vocalCancel: number;
  private readonly stereoWidthBoost: number;
  private readonly frontBeatAirGain: number;
  private readonly surroundGain: number;
  private readonly lfeBoost: number;
  private readonly antiPhaseMask: number;

  constructor(
    gains: Record<ChannelId, number>,
    profile: UpmixProfile,
    sampleRate = 48000,
  ) {
    this.gains = gains;
    this.profile = profile;

    this.lfeC = createButterworthLpfCoeffs(110, sampleRate);
    this.lp150C = createButterworthLpfCoeffs(150, sampleRate);
    this.hp150C = createButterworthHpfCoeffs(150, sampleRate);
    this.lp6500C = createButterworthLpfCoeffs(6500, sampleRate);
    this.hp6500C = createButterworthHpfCoeffs(6500, sampleRate);

    const dt = 1 / sampleRate;
    const rcSurHp = 1 / (2 * Math.PI * 110);
    this.alphaSurHp = rcSurHp / (rcSurHp + dt);
    const rcSurLp = 1 / (2 * Math.PI * 13500);
    this.alphaSurLp = dt / (rcSurLp + dt);
    const rcEchoDamp = 1 / (2 * Math.PI * 3800);
    this.alphaEchoDamp = dt / (rcEchoDamp + dt);

    this.pwrSmooth = Math.exp(-1 / (sampleRate * 0.008));
    this.pwrAlpha = 1 - this.pwrSmooth;

    this.apLenSL = Math.max(4, Math.round(sampleRate * 0.0043));
    this.apLenSR = Math.max(4, Math.round(sampleRate * 0.0067));
    this.apBufSL = new Float32Array(this.apLenSL);
    this.apBufSR = new Float32Array(this.apLenSR);

    this.tapDirectSL = Math.max(1, Math.round(sampleRate * 0.014));
    this.tapEcho1SL = Math.max(2, Math.round(sampleRate * 0.036));
    this.tapEcho2SL = Math.max(3, Math.round(sampleRate * 0.062));
    this.ringSL = new Float32Array(this.tapEcho2SL + 1);
    this.ringLenSL = this.ringSL.length;

    this.tapDirectSR = Math.max(1, Math.round(sampleRate * 0.022));
    this.tapEcho1SR = Math.max(2, Math.round(sampleRate * 0.044));
    this.tapEcho2SR = Math.max(3, Math.round(sampleRate * 0.074));
    this.ringSR = new Float32Array(this.tapEcho2SR + 1);
    this.ringLenSR = this.ringSR.length;

    this.centerAmt = profile === 'direct-discrete' ? 1.1 : profile === 'ambient-hall' ? 0.96 : 1.05;
    this.vocalCancel = profile === 'direct-discrete' ? 0.99 : profile === 'ambient-hall' ? 0.92 : 0.97;
    this.stereoWidthBoost = profile === 'direct-discrete' ? 0.12 : profile === 'ambient-hall' ? 0.22 : 0.16;
    this.frontBeatAirGain = profile === 'ambient-hall' ? 0.94 : 1.02;
    this.surroundGain = profile === 'direct-discrete' ? 1.22 : profile === 'ambient-hall' ? 1.48 : 1.3;
    this.lfeBoost = profile === 'cinema-pro' ? 0.98 : profile === 'ambient-hall' ? 0.82 : 0.9;
    this.antiPhaseMask = profile === 'ambient-hall' ? 0.85 : 1.0;
  }

  private filterSubBlock(leftIn: Float32Array, rightIn: Float32Array, sOff: number, count: number): void {
    const fs = this.fltState;
    const lp1 = this.lp150C;
    const hp1 = this.hp150C;
    const lp6 = this.lp6500C;
    const hp6 = this.hp6500C;
    const lfe = this.lfeC;

    biquadCopy(leftIn, sOff, this.bufLLow, count, lp1.b0, lp1.b1, lp1.b2, lp1.a1, lp1.a2, fs, 8);
    biquadInPlace(this.bufLLow, count, lp1.b0, lp1.b1, lp1.b2, lp1.a1, lp1.a2, fs, 12);
    biquadCopy(leftIn, sOff, this.bufLAbove, count, hp1.b0, hp1.b1, hp1.b2, hp1.a1, hp1.a2, fs, 16);
    biquadInPlace(this.bufLAbove, count, hp1.b0, hp1.b1, hp1.b2, hp1.a1, hp1.a2, fs, 20);
    biquadCopy64(this.bufLAbove, this.bufLVocal, count, lp6.b0, lp6.b1, lp6.b2, lp6.a1, lp6.a2, fs, 24);
    biquadInPlace(this.bufLVocal, count, lp6.b0, lp6.b1, lp6.b2, lp6.a1, lp6.a2, fs, 28);
    biquadCopy64(this.bufLAbove, this.bufLAir, count, hp6.b0, hp6.b1, hp6.b2, hp6.a1, hp6.a2, fs, 32);
    biquadInPlace(this.bufLAir, count, hp6.b0, hp6.b1, hp6.b2, hp6.a1, hp6.a2, fs, 36);

    biquadCopy(rightIn, sOff, this.bufRLow, count, lp1.b0, lp1.b1, lp1.b2, lp1.a1, lp1.a2, fs, 40);
    biquadInPlace(this.bufRLow, count, lp1.b0, lp1.b1, lp1.b2, lp1.a1, lp1.a2, fs, 44);
    biquadCopy(rightIn, sOff, this.bufRAbove, count, hp1.b0, hp1.b1, hp1.b2, hp1.a1, hp1.a2, fs, 48);
    biquadInPlace(this.bufRAbove, count, hp1.b0, hp1.b1, hp1.b2, hp1.a1, hp1.a2, fs, 52);
    biquadCopy64(this.bufRAbove, this.bufRVocal, count, lp6.b0, lp6.b1, lp6.b2, lp6.a1, lp6.a2, fs, 56);
    biquadInPlace(this.bufRVocal, count, lp6.b0, lp6.b1, lp6.b2, lp6.a1, lp6.a2, fs, 60);
    biquadCopy64(this.bufRAbove, this.bufRAir, count, hp6.b0, hp6.b1, hp6.b2, hp6.a1, hp6.a2, fs, 64);
    biquadInPlace(this.bufRAir, count, hp6.b0, hp6.b1, hp6.b2, hp6.a1, hp6.a2, fs, 68);

    const bLfe = this.bufLfe;
    for (let i = 0; i < count; i++) {
      bLfe[i] = (leftIn[sOff + i] + rightIn[sOff + i]) * 0.5;
    }
    biquadInPlace(bLfe, count, lfe.b0, lfe.b1, lfe.b2, lfe.a1, lfe.a2, fs, 0);
    biquadInPlace(bLfe, count, lfe.b0, lfe.b1, lfe.b2, lfe.a1, lfe.a2, fs, 4);
  }

  private mixSubBlockWav(
    leftIn: Float32Array,
    rightIn: Float32Array,
    sOff: number,
    count: number,
    pcm16: Int16Array | null,
    pcmStartIdx: number,
    fallbackView: DataView | null,
    fallbackByteOffset: number,
    sumSq: Float64Array,
    totalChunkFrames: number,
    chunkFrameBase: number,
    fadeStart: number,
    fadeLen: number,
    applyEndFade: boolean,
  ): void {
    const bLLow = this.bufLLow;
    const bLVoc = this.bufLVocal;
    const bLAir = this.bufLAir;
    const bRLow = this.bufRLow;
    const bRVoc = this.bufRVocal;
    const bRAir = this.bufRAir;
    const bLfe = this.bufLfe;

    const ps = this.pwrSmooth;
    const pa = this.pwrAlpha;
    let pwrL = this.pwrL;
    let pwrR = this.pwrR;
    let pwrCross = this.pwrCross;
    let vPwrL = this.vPwrL;
    let vPwrR = this.vPwrR;
    let vPwrM = this.vPwrM;
    let vPwrS = this.vPwrS;
    let vPwrCross = this.vPwrCross;

    const alphaSurHp = this.alphaSurHp;
    const alphaSurLp = this.alphaSurLp;
    const alphaEchoDamp = this.alphaEchoDamp;
    let slHpPrevX = this.slHpPrevX;
    let slHpPrevY = this.slHpPrevY;
    let srHpPrevX = this.srHpPrevX;
    let srHpPrevY = this.srHpPrevY;
    let slLpY = this.slLpY;
    let srLpY = this.srLpY;
    let slEchoDampY = this.slEchoDampY;
    let srEchoDampY = this.srEchoDampY;

    const apBufSL = this.apBufSL;
    const apBufSR = this.apBufSR;
    const apLenSL = this.apLenSL;
    const apLenSR = this.apLenSR;
    const apGain = this.apGain;
    let apIdxSL = this.apIdxSL;
    let apIdxSR = this.apIdxSR;

    const ringSL = this.ringSL;
    const ringSR = this.ringSR;
    const rLenSL = this.ringLenSL;
    const rLenSR = this.ringLenSR;
    const tapDirectSL = this.tapDirectSL;
    const tapEcho1SL = this.tapEcho1SL;
    const tapEcho2SL = this.tapEcho2SL;
    const tapDirectSR = this.tapDirectSR;
    const tapEcho1SR = this.tapEcho1SR;
    const tapEcho2SR = this.tapEcho2SR;
    let iSL = this.idxSL;
    let iSR = this.idxSR;

    const centerAmtG = this.centerAmt * this.gains.C;
    const lfeBoostG = this.lfeBoost * this.gains.LFE;
    const gFL = this.gains.FL;
    const gFR = this.gains.FR;
    const gSL = this.gains.SL;
    const gSR = this.gains.SR;
    const vocalCancel = this.vocalCancel;
    const stereoWidthBoost = this.stereoWidthBoost;
    const frontBeatAirGain = this.frontBeatAirGain;
    const antiPhaseMask = this.antiPhaseMask;
    const surroundBase = 1.4 * this.surroundGain;
    const isDirect = this.profile === 'direct-discrete';
    const lut = POW_072_LUT;

    let pcmIdx = pcmStartIdx;
    let byteOffset = fallbackByteOffset;

    for (let k = 0; k < count; k++) {
      const l = leftIn[sOff + k];
      const r = rightIn[sOff + k];
      const side = (l - r) * 0.5;

      const lLow = bLLow[k];
      const lVocal = bLVoc[k];
      const lAir = bLAir[k];
      const rLow = bRLow[k];
      const rVocal = bRVoc[k];
      const rAir = bRAir[k];
      const yLfe = bLfe[k];

      const vMid = (lVocal + rVocal) * 0.5;
      const vSide = (lVocal - rVocal) * 0.5;

      pwrL = pwrL * ps + l * l * pa;
      pwrR = pwrR * ps + r * r * pa;
      pwrCross = pwrCross * ps + l * r * pa;

      const totalPwr = pwrL + pwrR + 1e-7;
      const twoCross = 2 * pwrCross;
      const rawCorr = twoCross / totalPwr;
      const corrNorm = rawCorr > 1 ? 1 : rawCorr < -1 ? -1 : rawCorr;
      const pwrM = 0.25 * (pwrL + pwrR + twoCross);
      const pwrS = 0.25 * (pwrL + pwrR - twoCross);

      vPwrL = vPwrL * ps + lVocal * lVocal * pa;
      vPwrR = vPwrR * ps + rVocal * rVocal * pa;
      vPwrM = vPwrM * ps + vMid * vMid * pa;
      vPwrS = vPwrS * ps + vSide * vSide * pa;
      vPwrCross = vPwrCross * ps + lVocal * rVocal * pa;

      const vTotalPwr = vPwrL + vPwrR + 1e-7;
      const rawVCorr = (2 * vPwrCross) / vTotalPwr;
      const vCorrNorm = rawVCorr > 1 ? 1 : rawVCorr < -1 ? -1 : rawVCorr;
      const vMsRatio = (vPwrM - vPwrS) / (vPwrM + vPwrS + 1e-7);

      let vocalCenterCorr = 0;
      if (vCorrNorm > 0.01 && vMsRatio > 0) {
        const scaled = (vCorrNorm / 0.36) * POW_072_SCALE;
        const idx = scaled >= POW_072_N ? POW_072_N : (scaled | 0);
        const y0 = lut[idx];
        const powEst = y0 + (lut[idx + 1] - y0) * (scaled - idx);
        const msFactor = vMsRatio * 2.2;
        const vEst = powEst * (msFactor < 1 ? msFactor : 1);
        vocalCenterCorr = vEst < 1 ? vEst : 1;
      }

      const antiCorr = corrNorm < 0 ? (corrNorm < -1 ? 1 : -corrNorm) : 0;
      const rawSurrDom = (pwrS - pwrM) / (pwrM + pwrS + 1e-7);
      const surrDominance = rawSurrDom <= 0 ? 0 : rawSurrDom >= 1 ? 1 : rawSurrDom;
      const domFloor = surrDominance > 0.08 ? surrDominance : 0.08;
      const rawSurrCancel = Math.sqrt(antiCorr * domFloor) * 1.02;
      const surrCancel = rawSurrCancel >= 1 ? 1 : rawSurrCancel;

      const extractedCenter = vMid * vocalCenterCorr;

      const diffLR = vPwrL - vPwrR;
      const absDiffLR = diffLR < 0 ? -diffLR : diffLR;
      const rawOverlap = 1 - absDiffLR / vTotalPwr;
      const stereoOverlap = rawOverlap > 0 ? rawOverlap : 0;
      const sideMusicBoost = vSide * stereoWidthBoost * stereoOverlap * (1 - antiCorr);
      const surrAtten = surrCancel * antiPhaseMask;
      const lowSide = (lLow - rLow) * 0.5;
      const airSide = (lAir - rAir) * 0.5;

      const centerCut = extractedCenter * vocalCancel;
      const vSideAtten = vSide * surrAtten;
      const frontVocalL = lVocal - centerCut + sideMusicBoost - vSideAtten;
      const frontVocalR = rVocal - centerCut - sideMusicBoost + vSideAtten;

      const lowSideAtten = lowSide * surrAtten;
      const airSideAtten = airSide * surrAtten;
      const frontBeatAirL = (lLow - lowSideAtten + (lAir - airSideAtten)) * frontBeatAirGain;
      const frontBeatAirR = (rLow + lowSideAtten + (rAir + airSideAtten)) * frontBeatAirGain;

      const frontL = frontBeatAirL + frontVocalL;
      const frontR = frontBeatAirR + frontVocalR;

      const balanceL = Math.sqrt(pwrL > 0 ? pwrL / totalPwr : 0);
      const balanceR = Math.sqrt(pwrR > 0 ? pwrR / totalPwr : 0);
      let surrSteer: number;
      if (isDirect) {
        const s = antiCorr * 1.3 + surrDominance * 0.75 + 0.35;
        surrSteer = s < 0.65 ? 0.65 : s > 1.2 ? 1.2 : s;
      } else {
        const s = antiCorr * 1.35 + surrDominance * 0.8 + 0.55;
        surrSteer = s < 0.85 ? 0.85 : s > 1.28 ? 1.28 : s;
      }

      const surrScale = surroundBase * surrSteer;
      const slRaw = side * balanceL * surrScale;
      const srRaw = -side * balanceR * surrScale;

      const slHp = alphaSurHp * (slHpPrevY + slRaw - slHpPrevX);
      slHpPrevX = slRaw;
      slHpPrevY = slHp;
      slLpY = slLpY + alphaSurLp * (slHp - slLpY);

      const srHp = alphaSurHp * (srHpPrevY + srRaw - srHpPrevX);
      srHpPrevX = srRaw;
      srHpPrevY = srHp;
      srLpY = srLpY + alphaSurLp * (srHp - srLpY);

      const apDelayedSL = apBufSL[apIdxSL];
      const apOutSL = apDelayedSL - apGain * slLpY;
      apBufSL[apIdxSL] = slLpY + apGain * apOutSL;
      if (++apIdxSL >= apLenSL) apIdxSL = 0;

      const apDelayedSR = apBufSR[apIdxSR];
      const apOutSR = apDelayedSR - apGain * srLpY;
      apBufSR[apIdxSR] = srLpY + apGain * apOutSR;
      if (++apIdxSR >= apLenSR) apIdxSR = 0;

      ringSL[iSL] = apOutSL;
      let tDirL = iSL - tapDirectSL;
      if (tDirL < 0) tDirL += rLenSL;
      let tE1L = iSL - tapEcho1SL;
      if (tE1L < 0) tE1L += rLenSL;
      let tE2L = iSL - tapEcho2SL;
      if (tE2L < 0) tE2L += rLenSL;
      const slEchoRaw = ringSL[tE1L] * 0.36 + ringSL[tE2L] * 0.22;
      slEchoDampY = slEchoDampY + alphaEchoDamp * (slEchoRaw - slEchoDampY);
      const surroundOutSL = ringSL[tDirL] * 0.88 + slEchoDampY;
      if (++iSL >= rLenSL) iSL = 0;

      ringSR[iSR] = apOutSR;
      let tDirR = iSR - tapDirectSR;
      if (tDirR < 0) tDirR += rLenSR;
      let tE1R = iSR - tapEcho1SR;
      if (tE1R < 0) tE1R += rLenSR;
      let tE2R = iSR - tapEcho2SR;
      if (tE2R < 0) tE2R += rLenSR;
      const srEchoRaw = ringSR[tE1R] * 0.36 + ringSR[tE2R] * 0.22;
      srEchoDampY = srEchoDampY + alphaEchoDamp * (srEchoRaw - srEchoDampY);
      const surroundOutSR = ringSR[tDirR] * 0.88 + srEchoDampY;
      if (++iSR >= rLenSR) iSR = 0;

      const o0 = frontL * gFL;
      const o1 = frontR * gFR;
      const o2 = extractedCenter * centerAmtG;
      const o3 = yLfe * lfeBoostG;
      const o4 = surroundOutSL * gSL;
      const o5 = surroundOutSR * gSR;

      let fade = 1.0;
      const fGlobal = chunkFrameBase + k;
      if (applyEndFade && fGlobal >= fadeStart) {
        const p = (totalChunkFrames - 1 - fGlobal) / fadeLen;
        fade = p <= 0 ? 0 : p >= 1 ? 1 : p;
      }

      const s0 = (o0 > -0.88 && o0 < 0.88 ? o0 : Math.tanh(o0 / 0.95) * 0.95) * fade;
      const s1 = (o1 > -0.88 && o1 < 0.88 ? o1 : Math.tanh(o1 / 0.95) * 0.95) * fade;
      const s2 = (o2 > -0.88 && o2 < 0.88 ? o2 : Math.tanh(o2 / 0.95) * 0.95) * fade;
      const s3 = (o3 > -0.88 && o3 < 0.88 ? o3 : Math.tanh(o3 / 0.95) * 0.95) * fade;
      const s4 = (o4 > -0.88 && o4 < 0.88 ? o4 : Math.tanh(o4 / 0.95) * 0.95) * fade;
      const s5 = (o5 > -0.88 && o5 < 0.88 ? o5 : Math.tanh(o5 / 0.95) * 0.95) * fade;

      if ((fGlobal & 63) === 0) {
        sumSq[0] += s0 * s0;
        sumSq[1] += s1 * s1;
        sumSq[2] += s2 * s2;
        sumSq[3] += s3 * s3;
        sumSq[4] += s4 * s4;
        sumSq[5] += s5 * s5;
      }

      if (pcm16) {
        pcm16[pcmIdx] = s0 <= -1 ? -32767 : s0 >= 1 ? 32767 : Math.round(s0 * 32767);
        pcm16[pcmIdx + 1] = s1 <= -1 ? -32767 : s1 >= 1 ? 32767 : Math.round(s1 * 32767);
        pcm16[pcmIdx + 2] = s2 <= -1 ? -32767 : s2 >= 1 ? 32767 : Math.round(s2 * 32767);
        pcm16[pcmIdx + 3] = s3 <= -1 ? -32767 : s3 >= 1 ? 32767 : Math.round(s3 * 32767);
        pcm16[pcmIdx + 4] = s4 <= -1 ? -32767 : s4 >= 1 ? 32767 : Math.round(s4 * 32767);
        pcm16[pcmIdx + 5] = s5 <= -1 ? -32767 : s5 >= 1 ? 32767 : Math.round(s5 * 32767);
        pcmIdx += 6;
      } else if (fallbackView) {
        fallbackView.setInt16(byteOffset, floatToPcm16(s0), true);
        fallbackView.setInt16(byteOffset + 2, floatToPcm16(s1), true);
        fallbackView.setInt16(byteOffset + 4, floatToPcm16(s2), true);
        fallbackView.setInt16(byteOffset + 6, floatToPcm16(s3), true);
        fallbackView.setInt16(byteOffset + 8, floatToPcm16(s4), true);
        fallbackView.setInt16(byteOffset + 10, floatToPcm16(s5), true);
        byteOffset += 12;
      }
    }

    this.pwrL = pwrL;
    this.pwrR = pwrR;
    this.pwrCross = pwrCross;
    this.vPwrL = vPwrL;
    this.vPwrR = vPwrR;
    this.vPwrM = vPwrM;
    this.vPwrS = vPwrS;
    this.vPwrCross = vPwrCross;

    this.slHpPrevX = slHpPrevX;
    this.slHpPrevY = slHpPrevY;
    this.srHpPrevX = srHpPrevX;
    this.srHpPrevY = srHpPrevY;
    this.slLpY = slLpY;
    this.srLpY = srLpY;
    this.slEchoDampY = slEchoDampY;
    this.srEchoDampY = srEchoDampY;

    this.apIdxSL = apIdxSL;
    this.apIdxSR = apIdxSR;
    this.idxSL = iSL;
    this.idxSR = iSR;
  }

  private mixSubBlockFloat(
    leftIn: Float32Array,
    rightIn: Float32Array,
    sOff: number,
    count: number,
    flOut: Float32Array,
    frOut: Float32Array,
    cOut: Float32Array,
    lfeOut: Float32Array,
    slOut: Float32Array,
    srOut: Float32Array,
  ): void {
    const bLLow = this.bufLLow;
    const bLVoc = this.bufLVocal;
    const bLAir = this.bufLAir;
    const bRLow = this.bufRLow;
    const bRVoc = this.bufRVocal;
    const bRAir = this.bufRAir;
    const bLfe = this.bufLfe;

    const ps = this.pwrSmooth;
    const pa = this.pwrAlpha;
    let pwrL = this.pwrL;
    let pwrR = this.pwrR;
    let pwrCross = this.pwrCross;
    let vPwrL = this.vPwrL;
    let vPwrR = this.vPwrR;
    let vPwrM = this.vPwrM;
    let vPwrS = this.vPwrS;
    let vPwrCross = this.vPwrCross;

    const alphaSurHp = this.alphaSurHp;
    const alphaSurLp = this.alphaSurLp;
    const alphaEchoDamp = this.alphaEchoDamp;
    let slHpPrevX = this.slHpPrevX;
    let slHpPrevY = this.slHpPrevY;
    let srHpPrevX = this.srHpPrevX;
    let srHpPrevY = this.srHpPrevY;
    let slLpY = this.slLpY;
    let srLpY = this.srLpY;
    let slEchoDampY = this.slEchoDampY;
    let srEchoDampY = this.srEchoDampY;

    const apBufSL = this.apBufSL;
    const apBufSR = this.apBufSR;
    const apLenSL = this.apLenSL;
    const apLenSR = this.apLenSR;
    const apGain = this.apGain;
    let apIdxSL = this.apIdxSL;
    let apIdxSR = this.apIdxSR;

    const ringSL = this.ringSL;
    const ringSR = this.ringSR;
    const rLenSL = this.ringLenSL;
    const rLenSR = this.ringLenSR;
    const tapDirectSL = this.tapDirectSL;
    const tapEcho1SL = this.tapEcho1SL;
    const tapEcho2SL = this.tapEcho2SL;
    const tapDirectSR = this.tapDirectSR;
    const tapEcho1SR = this.tapEcho1SR;
    const tapEcho2SR = this.tapEcho2SR;
    let iSL = this.idxSL;
    let iSR = this.idxSR;

    const centerAmtG = this.centerAmt * this.gains.C;
    const lfeBoostG = this.lfeBoost * this.gains.LFE;
    const gFL = this.gains.FL;
    const gFR = this.gains.FR;
    const gSL = this.gains.SL;
    const gSR = this.gains.SR;
    const vocalCancel = this.vocalCancel;
    const stereoWidthBoost = this.stereoWidthBoost;
    const frontBeatAirGain = this.frontBeatAirGain;
    const antiPhaseMask = this.antiPhaseMask;
    const surroundBase = 1.4 * this.surroundGain;
    const isDirect = this.profile === 'direct-discrete';
    const lut = POW_072_LUT;

    for (let k = 0; k < count; k++) {
      const l = leftIn[sOff + k];
      const r = rightIn[sOff + k];
      const side = (l - r) * 0.5;

      const lLow = bLLow[k];
      const lVocal = bLVoc[k];
      const lAir = bLAir[k];
      const rLow = bRLow[k];
      const rVocal = bRVoc[k];
      const rAir = bRAir[k];
      const yLfe = bLfe[k];

      const vMid = (lVocal + rVocal) * 0.5;
      const vSide = (lVocal - rVocal) * 0.5;

      pwrL = pwrL * ps + l * l * pa;
      pwrR = pwrR * ps + r * r * pa;
      pwrCross = pwrCross * ps + l * r * pa;

      const totalPwr = pwrL + pwrR + 1e-7;
      const twoCross = 2 * pwrCross;
      const rawCorr = twoCross / totalPwr;
      const corrNorm = rawCorr > 1 ? 1 : rawCorr < -1 ? -1 : rawCorr;
      const pwrM = 0.25 * (pwrL + pwrR + twoCross);
      const pwrS = 0.25 * (pwrL + pwrR - twoCross);

      vPwrL = vPwrL * ps + lVocal * lVocal * pa;
      vPwrR = vPwrR * ps + rVocal * rVocal * pa;
      vPwrM = vPwrM * ps + vMid * vMid * pa;
      vPwrS = vPwrS * ps + vSide * vSide * pa;
      vPwrCross = vPwrCross * ps + lVocal * rVocal * pa;

      const vTotalPwr = vPwrL + vPwrR + 1e-7;
      const rawVCorr = (2 * vPwrCross) / vTotalPwr;
      const vCorrNorm = rawVCorr > 1 ? 1 : rawVCorr < -1 ? -1 : rawVCorr;
      const vMsRatio = (vPwrM - vPwrS) / (vPwrM + vPwrS + 1e-7);

      let vocalCenterCorr = 0;
      if (vCorrNorm > 0.01 && vMsRatio > 0) {
        const scaled = (vCorrNorm / 0.36) * POW_072_SCALE;
        const idx = scaled >= POW_072_N ? POW_072_N : (scaled | 0);
        const y0 = lut[idx];
        const powEst = y0 + (lut[idx + 1] - y0) * (scaled - idx);
        const msFactor = vMsRatio * 2.2;
        const vEst = powEst * (msFactor < 1 ? msFactor : 1);
        vocalCenterCorr = vEst < 1 ? vEst : 1;
      }

      const antiCorr = corrNorm < 0 ? (corrNorm < -1 ? 1 : -corrNorm) : 0;
      const rawSurrDom = (pwrS - pwrM) / (pwrM + pwrS + 1e-7);
      const surrDominance = rawSurrDom <= 0 ? 0 : rawSurrDom >= 1 ? 1 : rawSurrDom;
      const domFloor = surrDominance > 0.08 ? surrDominance : 0.08;
      const rawSurrCancel = Math.sqrt(antiCorr * domFloor) * 1.02;
      const surrCancel = rawSurrCancel >= 1 ? 1 : rawSurrCancel;

      const extractedCenter = vMid * vocalCenterCorr;

      const diffLR = vPwrL - vPwrR;
      const absDiffLR = diffLR < 0 ? -diffLR : diffLR;
      const rawOverlap = 1 - absDiffLR / vTotalPwr;
      const stereoOverlap = rawOverlap > 0 ? rawOverlap : 0;
      const sideMusicBoost = vSide * stereoWidthBoost * stereoOverlap * (1 - antiCorr);
      const surrAtten = surrCancel * antiPhaseMask;
      const lowSide = (lLow - rLow) * 0.5;
      const airSide = (lAir - rAir) * 0.5;

      const centerCut = extractedCenter * vocalCancel;
      const vSideAtten = vSide * surrAtten;
      const frontVocalL = lVocal - centerCut + sideMusicBoost - vSideAtten;
      const frontVocalR = rVocal - centerCut - sideMusicBoost + vSideAtten;

      const lowSideAtten = lowSide * surrAtten;
      const airSideAtten = airSide * surrAtten;
      const frontBeatAirL = (lLow - lowSideAtten + (lAir - airSideAtten)) * frontBeatAirGain;
      const frontBeatAirR = (rLow + lowSideAtten + (rAir + airSideAtten)) * frontBeatAirGain;

      const frontL = frontBeatAirL + frontVocalL;
      const frontR = frontBeatAirR + frontVocalR;

      const balanceL = Math.sqrt(pwrL > 0 ? pwrL / totalPwr : 0);
      const balanceR = Math.sqrt(pwrR > 0 ? pwrR / totalPwr : 0);
      let surrSteer: number;
      if (isDirect) {
        const s = antiCorr * 1.3 + surrDominance * 0.75 + 0.35;
        surrSteer = s < 0.65 ? 0.65 : s > 1.2 ? 1.2 : s;
      } else {
        const s = antiCorr * 1.35 + surrDominance * 0.8 + 0.55;
        surrSteer = s < 0.85 ? 0.85 : s > 1.28 ? 1.28 : s;
      }

      const surrScale = surroundBase * surrSteer;
      const slRaw = side * balanceL * surrScale;
      const srRaw = -side * balanceR * surrScale;

      const slHp = alphaSurHp * (slHpPrevY + slRaw - slHpPrevX);
      slHpPrevX = slRaw;
      slHpPrevY = slHp;
      slLpY = slLpY + alphaSurLp * (slHp - slLpY);

      const srHp = alphaSurHp * (srHpPrevY + srRaw - srHpPrevX);
      srHpPrevX = srRaw;
      srHpPrevY = srHp;
      srLpY = srLpY + alphaSurLp * (srHp - srLpY);

      const apDelayedSL = apBufSL[apIdxSL];
      const apOutSL = apDelayedSL - apGain * slLpY;
      apBufSL[apIdxSL] = slLpY + apGain * apOutSL;
      if (++apIdxSL >= apLenSL) apIdxSL = 0;

      const apDelayedSR = apBufSR[apIdxSR];
      const apOutSR = apDelayedSR - apGain * srLpY;
      apBufSR[apIdxSR] = srLpY + apGain * apOutSR;
      if (++apIdxSR >= apLenSR) apIdxSR = 0;

      ringSL[iSL] = apOutSL;
      let tDirL = iSL - tapDirectSL;
      if (tDirL < 0) tDirL += rLenSL;
      let tE1L = iSL - tapEcho1SL;
      if (tE1L < 0) tE1L += rLenSL;
      let tE2L = iSL - tapEcho2SL;
      if (tE2L < 0) tE2L += rLenSL;
      const slEchoRaw = ringSL[tE1L] * 0.36 + ringSL[tE2L] * 0.22;
      slEchoDampY = slEchoDampY + alphaEchoDamp * (slEchoRaw - slEchoDampY);
      const surroundOutSL = ringSL[tDirL] * 0.88 + slEchoDampY;
      if (++iSL >= rLenSL) iSL = 0;

      ringSR[iSR] = apOutSR;
      let tDirR = iSR - tapDirectSR;
      if (tDirR < 0) tDirR += rLenSR;
      let tE1R = iSR - tapEcho1SR;
      if (tE1R < 0) tE1R += rLenSR;
      let tE2R = iSR - tapEcho2SR;
      if (tE2R < 0) tE2R += rLenSR;
      const srEchoRaw = ringSR[tE1R] * 0.36 + ringSR[tE2R] * 0.22;
      srEchoDampY = srEchoDampY + alphaEchoDamp * (srEchoRaw - srEchoDampY);
      const surroundOutSR = ringSR[tDirR] * 0.88 + srEchoDampY;
      if (++iSR >= rLenSR) iSR = 0;

      const o0 = frontL * gFL;
      const o1 = frontR * gFR;
      const o2 = extractedCenter * centerAmtG;
      const o3 = yLfe * lfeBoostG;
      const o4 = surroundOutSL * gSL;
      const o5 = surroundOutSR * gSR;

      const outIdx = sOff + k;
      flOut[outIdx] = o0 > -0.9 && o0 < 0.9 ? o0 : Math.tanh(o0);
      frOut[outIdx] = o1 > -0.9 && o1 < 0.9 ? o1 : Math.tanh(o1);
      cOut[outIdx] = o2 > -0.9 && o2 < 0.9 ? o2 : Math.tanh(o2);
      lfeOut[outIdx] = o3 > -0.9 && o3 < 0.9 ? o3 : Math.tanh(o3);
      slOut[outIdx] = o4 > -0.9 && o4 < 0.9 ? o4 : Math.tanh(o4);
      srOut[outIdx] = o5 > -0.9 && o5 < 0.9 ? o5 : Math.tanh(o5);
    }

    this.pwrL = pwrL;
    this.pwrR = pwrR;
    this.pwrCross = pwrCross;
    this.vPwrL = vPwrL;
    this.vPwrR = vPwrR;
    this.vPwrM = vPwrM;
    this.vPwrS = vPwrS;
    this.vPwrCross = vPwrCross;

    this.slHpPrevX = slHpPrevX;
    this.slHpPrevY = slHpPrevY;
    this.srHpPrevX = srHpPrevX;
    this.srHpPrevY = srHpPrevY;
    this.slLpY = slLpY;
    this.srLpY = srLpY;
    this.slEchoDampY = slEchoDampY;
    this.srEchoDampY = srEchoDampY;

    this.apIdxSL = apIdxSL;
    this.apIdxSR = apIdxSR;
    this.idxSL = iSL;
    this.idxSR = iSR;
  }

  processToFloatArrays(
    leftIn: Float32Array,
    rightIn: Float32Array,
    start: number,
    end: number,
    fl: Float32Array,
    fr: Float32Array,
    c: Float32Array,
    lfe: Float32Array,
    sl: Float32Array,
    sr: Float32Array,
  ): void {
    for (let pos = start; pos < end; pos += BLOCK_FRAMES) {
      const count = Math.min(BLOCK_FRAMES, end - pos);
      this.filterSubBlock(leftIn, rightIn, pos, count);
      this.mixSubBlockFloat(leftIn, rightIn, pos, count, fl, fr, c, lfe, sl, sr);
    }
  }

  processRangeToWavBytes(
    leftIn: Float32Array,
    rightIn: Float32Array,
    startFrame: number,
    frameCount: number,
    sampleRate: number,
    sumSq: Float64Array,
    applyEndFade: boolean,
  ): Uint8Array {
    const headerSize = 68;
    const dataSize = frameCount * 12;
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);
    const offset = writeSixChannelWavHeader(view, frameCount, sampleRate);
    const pcm16 = IS_LITTLE_ENDIAN
      ? new Int16Array(buffer, headerSize, frameCount * 6)
      : null;

    const fadeLen = applyEndFade ? Math.min(frameCount, 1024) : 0;
    const fadeStart = frameCount - fadeLen;

    for (let f = 0; f < frameCount; f += BLOCK_FRAMES) {
      const count = Math.min(BLOCK_FRAMES, frameCount - f);
      this.filterSubBlock(leftIn, rightIn, startFrame + f, count);
      this.mixSubBlockWav(
        leftIn,
        rightIn,
        startFrame + f,
        count,
        pcm16,
        f * 6,
        pcm16 ? null : view,
        offset + f * 12,
        sumSq,
        frameCount,
        f,
        fadeStart,
        fadeLen,
        applyEndFade,
      );
    }

    return new Uint8Array(buffer);
  }
}

export function matrixUpmixStereoToSixChannels(
  leftIn: Float32Array,
  rightIn: Float32Array,
  gains: Record<ChannelId, number>,
  profile: UpmixProfile,
  sampleRate = 48000,
): Float32Array[] {
  const length = Math.min(leftIn.length, rightIn.length);
  const fl = new Float32Array(length);
  const fr = new Float32Array(length);
  const c = new Float32Array(length);
  const lfe = new Float32Array(length);
  const sl = new Float32Array(length);
  const sr = new Float32Array(length);

  if (length === 0) {
    return [fl, fr, c, lfe, sl, sr];
  }

  const processor = new StreamingMatrixUpmix51(gains, profile, sampleRate);
  const chunkSize = 48000 * 10;
  for (let chunkStart = 0; chunkStart < length; chunkStart += chunkSize) {
    const chunkEnd = Math.min(length, chunkStart + chunkSize);
    processor.processToFloatArrays(leftIn, rightIn, chunkStart, chunkEnd, fl, fr, c, lfe, sl, sr);
  }

  const channelsList = [fl, fr, c, lfe, sl, sr];
  let peak = 0;
  for (const chArr of channelsList) {
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(chArr[i]);
      if (abs > peak) peak = abs;
    }
  }
  if (peak > 0.95) {
    const scale = 0.95 / peak;
    for (const chArr of channelsList) {
      for (let i = 0; i < length; i++) {
        chArr[i] *= scale;
      }
    }
  }

  return channelsList;
}

/**
 * Streaming single-pass stereo-to-5.1 matrix upmix directly into a 6-channel WAVEFORMATEXTENSIBLE
 * PCM16 WAV Uint8Array + RMS summary, avoiding massive 6xFloat32Array heap spikes.
 */
export function encodeMatrixUpmixStereoToSixChannelWav(
  leftIn: Float32Array,
  rightIn: Float32Array,
  gains: Record<ChannelId, number>,
  profile: UpmixProfile,
  sampleRate = 48000,
): { wavBytes: Uint8Array; channelRms: Record<ChannelId, number> } {
  const maxFrames = 600 * 48000;
  const totalAvailable = Math.min(leftIn.length, rightIn.length);
  const numFrames = Math.min(totalAvailable, maxFrames);
  const isTruncated = totalAvailable > maxFrames;
  const processor = new StreamingMatrixUpmix51(gains, profile, sampleRate);
  const sumSq = new Float64Array(6);
  const wavBytes = processor.processRangeToWavBytes(
    leftIn,
    rightIn,
    0,
    numFrames,
    sampleRate,
    sumSq,
    isTruncated,
  );
  const sampleCount = Math.max(1, Math.ceil(numFrames / 64));
  const channelRms: Record<ChannelId, number> = {
    FL: Math.min(1, Math.sqrt(sumSq[0] / sampleCount)),
    FR: Math.min(1, Math.sqrt(sumSq[1] / sampleCount)),
    C: Math.min(1, Math.sqrt(sumSq[2] / sampleCount)),
    LFE: Math.min(1, Math.sqrt(sumSq[3] / sampleCount)),
    SL: Math.min(1, Math.sqrt(sumSq[4] / sampleCount)),
    SR: Math.min(1, Math.sqrt(sumSq[5] / sampleCount)),
  };
  return { wavBytes, channelRms };
}

/**
 * Streaming single-pass encoder for already-discrete 6-channel audio ([FL, FR, C, LFE, SL, SR])
 * directly into a 6-channel WAVEFORMATEXTENSIBLE PCM16 WAV Uint8Array + RMS summary.
 */
export function encodeDiscreteSixChannelsToWav(
  sourceChannels: readonly Float32Array[],
  gains: Record<ChannelId, number>,
  sampleRate = 48000,
  startFrame = 0,
  frameCount?: number,
  sumSqAccum?: Float64Array,
): { wavBytes: Uint8Array; channelRms: Record<ChannelId, number> } {
  const maxFrames = 600 * 48000;
  const totalAvailable = sourceChannels[0]?.length ?? 0;
  const maxAllowed = Math.min(totalAvailable, maxFrames);
  const count = Math.max(0, Math.min(frameCount ?? maxAllowed - startFrame, maxAllowed - startFrame));
  const isTruncated = totalAvailable > maxFrames && startFrame + count >= maxFrames;
  const fadeLen = isTruncated ? Math.min(count, 1024) : 0;

  const headerSize = 68;
  const buffer = new ArrayBuffer(headerSize + count * 12);
  const view = new DataView(buffer);
  let offset = writeSixChannelWavHeader(view, count, sampleRate);
  const pcm16 = IS_LITTLE_ENDIAN ? new Int16Array(buffer, headerSize, count * 6) : null;

  const fl = sourceChannels[0];
  const fr = sourceChannels[1] ?? fl;
  const c = sourceChannels[2] ?? fl;
  const lfe = sourceChannels[3] ?? fl;
  const sl = sourceChannels[4] ?? fl;
  const sr = sourceChannels[5] ?? fr;

  const gFL = gains.FL;
  const gFR = gains.FR;
  const gC = gains.C;
  const gLFE = gains.LFE;
  const gSL = gains.SL;
  const gSR = gains.SR;
  const sumSq = sumSqAccum ?? new Float64Array(6);
  const fadeStart = count - fadeLen;
  let pcmIdx = 0;

  for (let f = 0; f < count; f++) {
    const i = startFrame + f;
    let fade = 1.0;
    if (isTruncated && f >= fadeStart) {
      fade = Math.max(0, Math.min(1, (count - 1 - f) / fadeLen));
    }
    const s0 = softLimit95((fl[i] ?? 0) * gFL) * fade;
    const s1 = softLimit95((fr[i] ?? 0) * gFR) * fade;
    const s2 = softLimit95((c[i] ?? 0) * gC) * fade;
    const s3 = softLimit95((lfe[i] ?? 0) * gLFE) * fade;
    const s4 = softLimit95((sl[i] ?? 0) * gSL) * fade;
    const s5 = softLimit95((sr[i] ?? 0) * gSR) * fade;

    if ((f & 63) === 0) {
      sumSq[0] += s0 * s0;
      sumSq[1] += s1 * s1;
      sumSq[2] += s2 * s2;
      sumSq[3] += s3 * s3;
      sumSq[4] += s4 * s4;
      sumSq[5] += s5 * s5;
    }

    if (pcm16) {
      pcm16[pcmIdx] = floatToPcm16(s0);
      pcm16[pcmIdx + 1] = floatToPcm16(s1);
      pcm16[pcmIdx + 2] = floatToPcm16(s2);
      pcm16[pcmIdx + 3] = floatToPcm16(s3);
      pcm16[pcmIdx + 4] = floatToPcm16(s4);
      pcm16[pcmIdx + 5] = floatToPcm16(s5);
      pcmIdx += 6;
    } else {
      view.setInt16(offset, floatToPcm16(s0), true);
      view.setInt16(offset + 2, floatToPcm16(s1), true);
      view.setInt16(offset + 4, floatToPcm16(s2), true);
      view.setInt16(offset + 6, floatToPcm16(s3), true);
      view.setInt16(offset + 8, floatToPcm16(s4), true);
      view.setInt16(offset + 10, floatToPcm16(s5), true);
      offset += 12;
    }
  }

  const sampleCount = Math.max(1, Math.ceil(count / 64));
  const channelRms: Record<ChannelId, number> = {
    FL: Math.min(1, Math.sqrt(sumSq[0] / sampleCount)),
    FR: Math.min(1, Math.sqrt(sumSq[1] / sampleCount)),
    C: Math.min(1, Math.sqrt(sumSq[2] / sampleCount)),
    LFE: Math.min(1, Math.sqrt(sumSq[3] / sampleCount)),
    SL: Math.min(1, Math.sqrt(sumSq[4] / sampleCount)),
    SR: Math.min(1, Math.sqrt(sumSq[5] / sampleCount)),
  };
  return { wavBytes: new Uint8Array(buffer), channelRms };
}

/**
 * Applies channel gains/mutes/solos to an already-discrete 6-channel source ([FL, FR, C, LFE, SL, SR]).
 */
export function applyGainsToSixChannels(
  sourceChannels: readonly Float32Array[],
  gains: Record<ChannelId, number>,
): Float32Array[] {
  const order: ChannelId[] = ['FL', 'FR', 'C', 'LFE', 'SL', 'SR'];
  return order.map((id, chIdx) => {
    const src = sourceChannels[chIdx] ?? new Float32Array(sourceChannels[0]?.length ?? 0);
    const out = new Float32Array(src.length);
    const g = gains[id];
    for (let i = 0; i < src.length; i++) {
      out[i] = softLimit(src[i] * g);
    }
    return out;
  });
}

/**
 * Computes normalized RMS energy (0..1) per channel across the generated 6-channel mix
 * for user-facing separation verification.
 */
export function computeSixChannelRmsSummary(
  sixChannels: readonly Float32Array[],
): Record<ChannelId, number> {
  const order: ChannelId[] = ['FL', 'FR', 'C', 'LFE', 'SL', 'SR'];
  const summary: Record<ChannelId, number> = {
    FL: 0,
    FR: 0,
    C: 0,
    LFE: 0,
    SL: 0,
    SR: 0,
  };

  for (let ch = 0; ch < 6; ch++) {
    const arr = sixChannels[ch];
    if (!arr || arr.length === 0) continue;
    const step = Math.max(1, Math.floor(arr.length / 4096));
    let sumSq = 0;
    let count = 0;
    for (let i = 0; i < arr.length; i += step) {
      sumSq += arr[i] * arr[i];
      count++;
    }
    summary[order[ch]] = count > 0 ? Math.min(1, Math.sqrt(sumSq / count)) : 0;
  }

  return summary;
}

export interface TrackEnergyFrame {
  FL: number;
  FR: number;
  C: number;
  LFE: number;
  SL: number;
  SR: number;
  lfeBeat: number;
}

/**
 * Maps linear RMS amplitude (0..1) to a broadcast/studio dBFS perceptual meter level (0..0.97)
 * across [-46 dBFS .. -1 dBFS], preventing commercial -10 LUFS tracks or transients from
 * pinning level bars permanently at 100%.
 */
export function rmsToStudioMeterLevel(rms: number, offsetDb = 0): number {
  if (!Number.isFinite(rms) || rms <= 1e-4) return 0;
  const db = 20 * Math.log10(Math.min(1.5, rms)) + offsetDb;
  const minDb = -46;
  const maxDb = -1;
  const norm = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));
  if (norm <= 0) return 0;
  return Math.min(0.97, Math.pow(norm, 1.35));
}

/**
 * Computes real-time subwoofer bass beat intensity (0..0.95) from current low-frequency level
 * against an exponential moving average baseline.
 */
export function computeBassBeatIntensity(
  currentBassLevel: number,
  movingAvgBass: number,
  previousBeat: number,
): { nextAvg: number; beat: number } {
  const safeCurrent = Math.max(0, Math.min(0.97, currentBassLevel));
  const nextAvg = movingAvgBass <= 0 ? safeCurrent : movingAvgBass * 0.88 + safeCurrent * 0.12;
  const threshold = Math.max(0.08, nextAvg * 1.07);
  const delta =
    safeCurrent > threshold
      ? Math.min(0.95, (safeCurrent - threshold) * 2.5 + safeCurrent * 0.62)
      : 0;
  const decayed = previousBeat * 0.78;
  const beat = Math.max(decayed, Math.min(0.95, Math.max(delta, safeCurrent * 0.62)));
  return { nextAvg, beat };
}

/**
 * Extracts a normalized 6-channel reactive energy envelope from decoded stereo PCM samples
 * so the Acoustic Stage Monitor reflects track dynamics when loaded or converting.
 */
export function extractTrackEnergyProfile(
  leftIn: Float32Array,
  rightIn: Float32Array,
  bins = 48,
): TrackEnergyFrame[] {
  const length = Math.min(leftIn.length, rightIn.length);
  if (length === 0 || bins <= 0) return [];

  const frames: TrackEnergyFrame[] = [];
  const windowSize = Math.max(1, Math.floor(length / bins));
  let avgBass = 0;
  let prevBeat = 0;
  let lowState = 0;

  for (let b = 0; b < bins; b++) {
    const start = b * windowSize;
    const end = Math.min(length, start + windowSize);
    const step = Math.max(1, Math.floor((end - start) / 128));

    let sumL = 0;
    let sumR = 0;
    let sumMid = 0;
    let sumSide = 0;
    let sumBass = 0;
    let count = 0;

    for (let i = start; i < end; i += step) {
      const l = leftIn[i];
      const r = rightIn[i];
      const mid = (l + r) * 0.5;
      const side = (l - r) * 0.5;
      lowState = lowState * 0.82 + mid * 0.18;

      sumL += l * l;
      sumR += r * r;
      sumMid += mid * mid;
      sumSide += side * side;
      sumBass += lowState * lowState;
      count++;
    }

    const inv = count > 0 ? 1 / count : 1;
    const fl = Math.min(1, Math.sqrt(sumL * inv) * 2.2);
    const fr = Math.min(1, Math.sqrt(sumR * inv) * 2.2);
    const c = Math.min(1, Math.sqrt(sumMid * inv) * 2.1);
    const lfeRaw = Math.min(1, Math.sqrt(sumBass * inv) * 3.1);
    const sideRms = Math.min(1, Math.sqrt(sumSide * inv) * 2.8);
    const sl = Math.min(1, fl * 0.55 + sideRms * 0.65);
    const sr = Math.min(1, fr * 0.55 + sideRms * 0.65);

    const beatState = computeBassBeatIntensity(lfeRaw, avgBass, prevBeat);
    avgBass = beatState.nextAvg;
    prevBeat = beatState.beat;

    frames.push({
      FL: fl,
      FR: fr,
      C: c,
      LFE: lfeRaw,
      SL: sl,
      SR: sr,
      lfeBeat: beatState.beat,
    });
  }

  return frames;
}

export interface Binaural8DOptions {
  sampleRate?: number;
  orbitPeriodSec?: number;
  reverbMix?: number;
  bassAnchor?: number;
}

/**
 * Computes continuous unwrapped azimuth angle theta (in degrees) for 360-degree 8D spatial audio rotation
 * with strictly constant, uniform angular velocity (360° / orbitPeriodSec):
 * 1. Center (C) [0° / front center stage] at p = 0.0
 * 2. Front Left (FL) [-30°] at p = 30/360 (1/12)
 * 3. Surround Left (SL) [-110°] at p = 110/360
 * 4. Direct Rear [-180°] at p = 0.5
 * 5. Surround Right (SR) [+110° / unwrapped -250°] at p = 250/360
 * 6. Front Right (FR) [+30° / unwrapped -330°] at p = 330/360 (11/12)
 * 7. Returning seamlessly back to Center (C) [0° / unwrapped -360°] at p = 1.0
 */
export function get8dAzimuthDegrees(progress: number): number {
  if (progress === 1.0) return -360;
  const p = ((progress % 1) + 1) % 1;
  return p === 0 ? 0 : -360 * p;
}

/**
 * Returns wrapped azimuth angle in [-180, 180] degrees.
 */
export function wrapAzimuth180(deg: number): number {
  const norm = ((((deg + 180) % 360) + 360) % 360) - 180;
  return norm === -180 ? 180 : norm;
}

/**
 * Returns standard 0..360 display angle for SVG radar rotation and sector labeling.
 */
export function wrapAzimuth360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * True 360-degree 8D Binaural Spatial Audio DSP processor for headphones.
 * Combines:
 * 1. Constant-velocity 360-deg clockwise azimuth panning law (Center -> FL -> SL -> SR -> FR -> Center)
 * 2. Sub-millisecond Interaural Time Difference (ITD <= 0.62 ms across head width)
 * 3. Panning-frequency pinna & head-shadowing dynamic LPF (3.8 kHz behind head -> 16 kHz front)
 * 4. Multi-tap concert hall early reflections & diffuse stereo reverb tail
 * 5. Center-locked sub-bass warmth (<120 Hz) so bass hits remain grounded while vocals/melody orbit
 */
export class Streaming8DBinaural {
  private readonly sampleRate: number;
  private readonly orbitPeriodSec: number;
  private readonly reverbMix: number;
  private readonly bassAnchor: number;

  private readonly itdBufLen: number;
  private readonly itdBufL: Float32Array;
  private readonly itdBufR: Float32Array;
  private itdWrite = 0;

  private readonly tap1Len: number;
  private readonly tap2Len: number;
  private readonly tap3Len: number;
  private readonly verbBufL: Float32Array;
  private readonly verbBufR: Float32Array;
  private verbIdx = 0;

  private pinnaStateL = 0;
  private pinnaStateR = 0;
  private reverbDampL = 0;
  private reverbDampR = 0;
  private subBassState = 0;

  private readonly dt: number;
  private readonly twoPiDt: number;
  private readonly maxItdSamples: number;
  private readonly subAlpha: number;
  private readonly invOrbitSamples: number;
  private readonly verbLen: number;
  private sampleIndex = 0;
  private outL = 0;
  private outR = 0;

  private ctrlCountdown8d = 0;
  private cachedGainL = 0.7071;
  private cachedGainR = 0.7071;
  private cachedPresence = 1;
  private cachedDelayL = 0;
  private cachedDelayR = 0;
  private cachedAlphaL = 0.5;
  private cachedAlphaR = 0.5;
  private cachedCenterWeight = 0.28;

  constructor(options: Binaural8DOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.orbitPeriodSec = Math.max(2.0, options.orbitPeriodSec ?? 8.0);
    this.reverbMix = Math.max(0, Math.min(0.45, options.reverbMix ?? 0.24));
    this.bassAnchor = Math.max(0, Math.min(0.6, options.bassAnchor ?? 0.28));

    this.itdBufLen = Math.max(16, Math.ceil(this.sampleRate * 0.002));
    this.itdBufL = new Float32Array(this.itdBufLen);
    this.itdBufR = new Float32Array(this.itdBufLen);

    this.tap1Len = Math.max(8, Math.round(this.sampleRate * 0.019));
    this.tap2Len = Math.max(8, Math.round(this.sampleRate * 0.031));
    this.tap3Len = Math.max(8, Math.round(this.sampleRate * 0.047));
    this.verbBufL = new Float32Array(this.tap3Len + 1);
    this.verbBufR = new Float32Array(this.tap3Len + 1);
    this.verbLen = this.verbBufL.length;

    this.dt = 1 / this.sampleRate;
    this.twoPiDt = 2 * Math.PI * this.dt;
    this.maxItdSamples = this.sampleRate * 0.00062;
    this.subAlpha = this.dt / (1 / (2 * Math.PI * 115) + this.dt);
    this.invOrbitSamples = 1 / (this.sampleRate * this.orbitPeriodSec);
  }

  private readItd(buf: Float32Array, d: number): number {
    const intD = d | 0;
    let idx0 = this.itdWrite - intD;
    if (idx0 < 0) idx0 += this.itdBufLen;
    let idx1 = idx0 - 1;
    if (idx1 < 0) idx1 += this.itdBufLen;
    const frac = d - intD;
    return buf[idx0] * (1 - frac) + buf[idx1] * frac;
  }

  private processSample(l: number, r: number): void {
    const mono = (l + r) * 0.5;
    const widthSide = (l - r) * 0.25;

    this.subBassState = this.subBassState + this.subAlpha * (mono - this.subBassState);
    const orbitMid = mono - this.subBassState * 0.45;
    const srcL = orbitMid + widthSide;
    const srcR = orbitMid - widthSide;

    this.itdBufL[this.itdWrite] = srcL;
    this.itdBufR[this.itdWrite] = srcR;

    if (this.ctrlCountdown8d === 0) {
      this.ctrlCountdown8d = 7;
      const progress = this.sampleIndex * this.invOrbitSamples;
      const azimuthDeg = get8dAzimuthDegrees(progress);
      const azimuthRad = (azimuthDeg * Math.PI) / 180;
      const pan = Math.sin(azimuthRad);
      const depth = Math.cos(azimuthRad);

      const panHalfAngle = (pan + 1) * 0.25 * Math.PI;
      this.cachedGainL = Math.cos(panHalfAngle);
      this.cachedGainR = Math.sin(panHalfAngle);

      const rearDepthNorm = (depth + 1) * 0.5;
      this.cachedPresence = 0.82 + 0.18 * rearDepthNorm;

      this.cachedDelayL = pan > 0 ? pan * this.maxItdSamples : 0;
      this.cachedDelayR = pan < 0 ? -pan * this.maxItdSamples : 0;

      const rearCutoff = 3800 + 11700 * rearDepthNorm;
      const cutoffL = Math.max(2400, rearCutoff - (pan > 0 ? pan * 1800 : 0));
      const cutoffR = Math.max(2400, rearCutoff - (pan < 0 ? -pan * 1800 : 0));

      const wcL = this.twoPiDt * cutoffL;
      const wcR = this.twoPiDt * cutoffR;
      this.cachedAlphaL = wcL / (1 + wcL);
      this.cachedAlphaR = wcR / (1 + wcR);
      this.cachedCenterWeight = depth > 0 ? depth * 0.28 : 0;
    } else {
      this.ctrlCountdown8d--;
    }
    this.sampleIndex++;

    const delayedL = this.readItd(this.itdBufL, this.cachedDelayL);
    const delayedR = this.readItd(this.itdBufR, this.cachedDelayR);
    if (++this.itdWrite >= this.itdBufLen) this.itdWrite = 0;

    const pres = this.cachedPresence;
    this.pinnaStateL =
      this.pinnaStateL + this.cachedAlphaL * (delayedL * this.cachedGainL * pres - this.pinnaStateL);
    this.pinnaStateR =
      this.pinnaStateR + this.cachedAlphaR * (delayedR * this.cachedGainR * pres - this.pinnaStateR);

    const vLen = this.verbLen;
    const vIdx = this.verbIdx;
    let idx1 = vIdx - this.tap1Len;
    if (idx1 < 0) idx1 += vLen;
    let idx2 = vIdx - this.tap2Len;
    if (idx2 < 0) idx2 += vLen;
    let idx3 = vIdx - this.tap3Len;
    if (idx3 < 0) idx3 += vLen;

    const reflL = this.verbBufL[idx1] * 0.45 + this.verbBufR[idx2] * 0.32 + this.verbBufL[idx3] * 0.23;
    const reflR = this.verbBufR[idx1] * 0.45 + this.verbBufL[idx2] * 0.32 + this.verbBufR[idx3] * 0.23;

    this.reverbDampL = this.reverbDampL * 0.68 + reflL * 0.32;
    this.reverbDampR = this.reverbDampR * 0.68 + reflR * 0.32;

    this.verbBufL[vIdx] = Math.max(-1, Math.min(1, this.pinnaStateL * 0.55 + this.reverbDampR * 0.34));
    this.verbBufR[vIdx] = Math.max(-1, Math.min(1, this.pinnaStateR * 0.55 + this.reverbDampL * 0.34));
    this.verbIdx = vIdx + 1 >= vLen ? 0 : vIdx + 1;

    const centerBlend = mono * this.cachedCenterWeight;

    this.outL =
      this.pinnaStateL * 1.12 +
      this.reverbDampL * this.reverbMix +
      this.subBassState * this.bassAnchor +
      centerBlend;
    this.outR =
      this.pinnaStateR * 1.12 +
      this.reverbDampR * this.reverbMix +
      this.subBassState * this.bassAnchor +
      centerBlend;
  }

  processRangeToFloatArrays(
    leftIn: Float32Array,
    rightIn: Float32Array,
    start: number,
    end: number,
    outL: Float32Array,
    outR: Float32Array,
  ): void {
    for (let i = start; i < end; i++) {
      this.processSample(leftIn[i], rightIn[i]);
      outL[i] = softLimit(this.outL);
      outR[i] = softLimit(this.outR);
    }
  }

  processRangeToPcm16Bytes(
    leftIn: Float32Array,
    rightIn: Float32Array,
    startFrame: number,
    frameCount: number,
    includeWavHeader: boolean,
    applyEndFade: boolean,
  ): Uint8Array {
    const headerSize = includeWavHeader ? 44 : 0;
    const buffer = new ArrayBuffer(headerSize + frameCount * 4);
    const view = includeWavHeader ? new DataView(buffer) : null;
    let offset =
      includeWavHeader && view ? writeStereoWavHeader(view, frameCount, this.sampleRate) : 0;
    const pcm16 = IS_LITTLE_ENDIAN
      ? new Int16Array(buffer, headerSize, frameCount * 2)
      : null;
    const fallbackView = pcm16 ? null : view ?? new DataView(buffer);
    const fadeLen = applyEndFade ? Math.min(frameCount, 1024) : 0;
    const fadeStart = frameCount - fadeLen;
    let pcmIdx = 0;

    for (let f = 0; f < frameCount; f++) {
      const i = startFrame + f;
      let fade = 1.0;
      if (applyEndFade && f >= fadeStart) {
        fade = Math.max(0, Math.min(1, (frameCount - 1 - f) / fadeLen));
      }
      this.processSample(leftIn[i], rightIn[i]);
      const lOut = softLimit95(this.outL) * fade;
      const rOut = softLimit95(this.outR) * fade;
      if (pcm16) {
        pcm16[pcmIdx] = floatToPcm16(lOut);
        pcm16[pcmIdx + 1] = floatToPcm16(rOut);
        pcmIdx += 2;
      } else if (fallbackView) {
        fallbackView.setInt16(offset, floatToPcm16(lOut), true);
        fallbackView.setInt16(offset + 2, floatToPcm16(rOut), true);
        offset += 4;
      }
    }

    return new Uint8Array(buffer);
  }
}

export function processStereoTo8dBinaural(
  leftIn: Float32Array,
  rightIn: Float32Array,
  options: Binaural8DOptions = {},
): { left: Float32Array; right: Float32Array } {
  const maxFrames = 600 * 48000;
  const length = Math.min(leftIn.length, rightIn.length, maxFrames);
  const outL = new Float32Array(length);
  const outR = new Float32Array(length);
  if (length === 0) {
    return { left: outL, right: outR };
  }

  const processor = new Streaming8DBinaural(options);
  const chunkSize = 48000 * 10;
  for (let chunkStart = 0; chunkStart < length; chunkStart += chunkSize) {
    const chunkEnd = Math.min(length, chunkStart + chunkSize);
    processor.processRangeToFloatArrays(leftIn, rightIn, chunkStart, chunkEnd, outL, outR);
  }

  let peak = 0;
  for (let i = 0; i < length; i++) {
    const absL = Math.abs(outL[i]);
    const absR = Math.abs(outR[i]);
    if (absL > peak) peak = absL;
    if (absR > peak) peak = absR;
  }
  if (peak > 0.95) {
    const scale = 0.95 / peak;
    for (let i = 0; i < length; i++) {
      outL[i] *= scale;
      outR[i] *= scale;
    }
  }

  return { left: outL, right: outR };
}

/**
 * Streams stereo input through 8D Binaural DSP into small 15-second PCM16 chunks (+ 44-byte RIFF header)
 * so Blob assembly never requires allocating a huge contiguous ArrayBuffer.
 */
export function encodeStereo8dBinauralWavChunks(
  leftIn: Float32Array,
  rightIn: Float32Array,
  options: Binaural8DOptions = {},
  chunkDurationSec = 15,
): { chunks: Uint8Array[]; totalFrames: number; totalBytes: number } {
  const sampleRate = options.sampleRate ?? 48000;
  const maxFrames = 600 * 48000;
  const totalAvailable = Math.min(leftIn.length, rightIn.length);
  const totalFrames = Math.min(totalAvailable, maxFrames);
  const isTruncated = totalAvailable > maxFrames;

  const headerBuf = new ArrayBuffer(44);
  writeStereoWavHeader(new DataView(headerBuf), totalFrames, sampleRate);
  const chunks: Uint8Array[] = [new Uint8Array(headerBuf)];

  const processor = new Streaming8DBinaural(options);
  const chunkFrames = Math.max(1024, Math.floor(sampleRate * chunkDurationSec));
  for (let start = 0; start < totalFrames; start += chunkFrames) {
    const count = Math.min(chunkFrames, totalFrames - start);
    const isLast = start + count >= totalFrames;
    chunks.push(
      processor.processRangeToPcm16Bytes(leftIn, rightIn, start, count, false, isTruncated && isLast),
    );
  }

  return { chunks, totalFrames, totalBytes: 44 + totalFrames * 4 };
}

/**
 * Single-pass streaming 8D Binaural WAV encoder (zero intermediate outL/outR Float32Array buffers).
 */
export function encodeStereo8dBinauralToWav(
  leftIn: Float32Array,
  rightIn: Float32Array,
  options: Binaural8DOptions = {},
): Uint8Array {
  const maxFrames = 600 * 48000;
  const totalAvailable = Math.min(leftIn.length, rightIn.length);
  const numFrames = Math.min(totalAvailable, maxFrames);
  const processor = new Streaming8DBinaural(options);
  return processor.processRangeToPcm16Bytes(
    leftIn,
    rightIn,
    0,
    numFrames,
    true,
    totalAvailable > maxFrames,
  );
}
