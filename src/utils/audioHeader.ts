export interface ParsedAudioHeader {
  sampleRate: number;
  sourceChannels: number;
  durationSec: number | null;
}

const MPEG_SAMPLERATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

/**
 * Parses lightweight container header metadata from just the first <= 64 KB of an audio file,
 * avoiding full-file ArrayBuffer allocations on 15MB–250MB+ tracks.
 */
export function parseAudioHeaderBytes(
  bytes: Uint8Array,
  filename = '',
  totalFileSizeBytes = bytes.byteLength,
): ParsedAudioHeader {
  const fallback: ParsedAudioHeader = { sampleRate: 48000, sourceChannels: 2, durationSec: null };
  if (bytes.byteLength < 12) return fallback;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, len: number) => {
    if (offset + len > bytes.byteLength) return '';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += String.fromCharCode(view.getUint8(offset + i));
    }
    return out;
  };

  // 1. RIFF / WAVE
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    let pos = 12;
    let channels = 2;
    let sampleRate = 48000;
    let byteRate = 0;
    let dataSize = 0;
    while (pos + 8 <= bytes.byteLength) {
      const id = ascii(pos, 4);
      const size = view.getUint32(pos + 4, true);
      const payload = pos + 8;
      if (id === 'fmt ' && payload + 16 <= bytes.byteLength) {
        channels = Math.max(1, view.getUint16(payload + 2, true));
        sampleRate = Math.max(8000, view.getUint32(payload + 4, true));
        byteRate = view.getUint32(payload + 8, true);
      } else if (id === 'data') {
        dataSize = size > 0 && totalFileSizeBytes > payload ? Math.min(size, totalFileSizeBytes - payload) : size;
        break;
      }
      pos = payload + size + (size % 2);
    }
    const durationSec = byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
    return { sampleRate, sourceChannels: channels, durationSec };
  }

  // 2. FLAC (fLaC + STREAMINFO)
  if (ascii(0, 4) === 'fLaC' && bytes.byteLength >= 42) {
    const blockType = bytes[4] & 0x7f;
    if (blockType === 0) {
      const b18 = (bytes[18] << 16) | (bytes[19] << 8) | bytes[20];
      const sampleRate = (b18 >> 4) & 0xfffff;
      const sourceChannels = ((b18 >> 1) & 0x07) + 1;
      const totalSamplesHigh = bytes[21] & 0x0f;
      const totalSamplesLow = view.getUint32(22, false);
      const totalSamples = totalSamplesHigh * 4294967296 + totalSamplesLow;
      const durationSec = sampleRate > 0 && totalSamples > 0 ? totalSamples / sampleRate : null;
      if (sampleRate >= 8000) {
        return { sampleRate, sourceChannels, durationSec };
      }
    }
  }

  // 3. OGG (Vorbis / Opus)
  if (ascii(0, 4) === 'OggS' && bytes.byteLength >= 44) {
    const idxOpus = findAsciiBytes(bytes, 'OpusHead');
    if (idxOpus >= 0 && idxOpus + 16 <= bytes.byteLength) {
      const ch = Math.max(1, bytes[idxOpus + 9]);
      return { sampleRate: 48000, sourceChannels: ch, durationSec: null };
    }
    const idxVorbis = findAsciiBytes(bytes, '\x01vorbis');
    if (idxVorbis >= 0 && idxVorbis + 16 <= bytes.byteLength) {
      const ch = Math.max(1, bytes[idxVorbis + 11]);
      const sr = view.getUint32(idxVorbis + 12, true);
      if (sr >= 8000) {
        return { sampleRate: sr, sourceChannels: ch, durationSec: null };
      }
    }
  }

  // 4. MP3 (skip ID3v2 tag if present, scan for valid MPEG frame sync)
  const lowerName = filename.toLowerCase();
  let scanStart = 0;
  if (ascii(0, 3) === 'ID3' && bytes.byteLength >= 10) {
    const id3Size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    scanStart = Math.min(bytes.byteLength, 10 + id3Size);
  }
  if (lowerName.endsWith('.mp3') || scanStart > 0 || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    for (let i = scanStart; i + 4 <= bytes.byteLength; i++) {
      if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
        const versionBits = (bytes[i + 1] >> 3) & 0x03;
        const layerBits = (bytes[i + 1] >> 1) & 0x03;
        const srIdx = (bytes[i + 2] >> 2) & 0x03;
        const channelMode = (bytes[i + 3] >> 6) & 0x03;
        const rates = MPEG_SAMPLERATES[versionBits];
        if (layerBits !== 0 && rates && srIdx < 3) {
          return {
            sampleRate: rates[srIdx],
            sourceChannels: channelMode === 3 ? 1 : 2,
            durationSec: null,
          };
        }
      }
    }
  }

  return fallback;
}

function findAsciiBytes(bytes: Uint8Array, needle: string): number {
  const nLen = needle.length;
  const max = Math.min(bytes.byteLength - nLen, 512);
  for (let i = 0; i <= max; i++) {
    let ok = true;
    for (let j = 0; j < nLen; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

export interface ChunkTimeWindow {
  index: number;
  startSec: number;
  durationSec: number;
}

/**
 * Splits a track into bounded 20-second chunk windows (960,000 frames @ 48 kHz:
 * exact multiple of 1,536 AC3 & 512 DTS frames) so large files convert with < 25 MB peak RAM.
 */
export function computeChunkWindows(
  totalDurationSec: number,
  chunkDurationSec = 20,
  maxDurationSec = 1800,
): ChunkTimeWindow[] {
  const safeDur = Math.max(0.1, Math.min(maxDurationSec, Number.isFinite(totalDurationSec) && totalDurationSec > 0 ? totalDurationSec : chunkDurationSec));
  const windows: ChunkTimeWindow[] = [];
  let startSec = 0;
  let index = 0;
  while (startSec < safeDur - 0.005) {
    const dur = Math.min(chunkDurationSec, safeDur - startSec);
    windows.push({
      index,
      startSec: Number(startSec.toFixed(3)),
      durationSec: Number(dur.toFixed(3)),
    });
    startSec += dur;
    index++;
  }
  return windows;
}

/**
 * Chooses a frame-aligned chunk duration (multiples of 4s @ 48 kHz = exact multiples of
 * 1,536 AC3 frames and 512 DTS frames). Standard tracks (<= 20 MB up to 30 min) use 60s
 * blocks, larger tracks (<= 80 MB) use 40s blocks, and huge lossless/6ch streams use 20s
 * blocks to stay memory-safe while cutting per-chunk FFmpeg startup/seek overhead dramatically.
 */
export function computeAdaptiveChunkDurationSec(
  sourceSizeBytes: number,
  durationSec: number,
  isDiscrete6Ch = false,
): number {
  const mb = sourceSizeBytes / (1024 * 1024);
  if (isDiscrete6Ch) {
    return durationSec > 0 && durationSec <= 240 && mb <= 32 ? 40 : 20;
  }
  if (mb <= 20 && durationSec > 0 && durationSec <= 1800) {
    return 60;
  }
  if (mb <= 80 && durationSec > 0 && durationSec <= 1800) {
    return 40;
  }
  return 20;
}

const FAST_INPUT_SEEK_FORMATS = new Set(['wav', 'flac', 'm4a', 'mp4', 'aiff']);

export function isFastInputSeekFormat(ext: string): boolean {
  return FAST_INPUT_SEEK_FORMATS.has(ext.toLowerCase());
}

/**
 * Writes a valid 44-byte RIFF/WAVE PCM16 stereo header for assembled multi-chunk 8D WAV blobs.
 */
export function buildStereoWavHeaderBytes(pcmDataBytes: number, sampleRate = 48000): Uint8Array {
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(off + i, s.charCodeAt(i));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcmDataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcmDataBytes, true);
  return new Uint8Array(buf);
}

export function buildFfmpegChunkDecodeArgs(options: {
  inputPath: string;
  outputWavPath: string;
  startSec: number;
  durationSec: number;
  targetSampleRate?: number;
  decodeChannels?: number;
  inputExt?: string;
}): string[] {
  const {
    inputPath,
    outputWavPath,
    startSec,
    durationSec,
    targetSampleRate = 48000,
    decodeChannels = 2,
    inputExt = '',
  } = options;

  // Input seeking (-ss before -i) is sample-exact & instant for WAV/FLAC/M4A/MP4/AIFF;
  // output seeking guarantees frame-exact continuity for VBR MP3/OGG/AAC without Xing TOCs.
  const useFastInputSeek = isFastInputSeekFormat(inputExt);

  if (useFastInputSeek) {
    return [
      '-y',
      '-ss',
      String(startSec),
      '-t',
      String(durationSec),
      '-i',
      inputPath,
      '-vn',
      '-ar',
      String(targetSampleRate),
      '-ac',
      String(decodeChannels),
      '-c:a',
      'pcm_s16le',
      outputWavPath,
    ];
  }

  return [
    '-y',
    '-i',
    inputPath,
    '-ss',
    String(startSec),
    '-t',
    String(durationSec),
    '-vn',
    '-ar',
    String(targetSampleRate),
    '-ac',
    String(decodeChannels),
    '-c:a',
    'pcm_s16le',
    outputWavPath,
  ];
}
