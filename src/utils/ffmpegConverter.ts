import { FFFSType, FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import type {
  Ac3BitrateKbps,
  ChannelConfig,
  ChannelId,
  ConversionPhase,
  ConversionResult,
  ExportFormat,
  SpatialContainerFormat,
  UpmixProfile,
} from './audioTypes';
import {
  buildFfmpegChunkDecodeArgs,
  buildStereoWavHeaderBytes,
  computeAdaptiveChunkDurationSec,
  computeChunkWindows,
  isFastInputSeekFormat,
} from './audioHeader';
import {
  buildFfmpegArgsForFormat,
  buildOutputFilename,
  computeEffectiveChannelGains,
  isValidAc3Bitstream,
  sanitizeInputExtension,
} from './channelMath';

import { createAbortError, isAbortError } from './backgroundConversion';

let ffmpegSingleton: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let conversionInFlight = false;

const TARGET_SAMPLE_RATE = 48000;
const CHUNK_DURATION_SEC = 20;
const MAX_DURATION_SEC = 1800; // 30 minutes via streaming chunks
const MEMFS_FAST_WRITE_MAX_BYTES = 64 * 1024 * 1024;

function isLikelyMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const mc = new MessageChannel();
      mc.port1.onmessage = () => {
        mc.port1.close();
        mc.port2.close();
        resolve();
      };
      mc.port2.postMessage(null);
    });
  }
  return Promise.resolve();
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export interface ConvertOptions {
  sourceFile?: File | Blob;
  sourceBytes?: Uint8Array;
  durationSec?: number;
  sourceChannels?: number;
  sourceFilename: string;
  exportFormat?: ExportFormat;
  spatialContainer?: SpatialContainerFormat;
  orbitPeriodSec?: number;
  bitrateKbps: Ac3BitrateKbps;
  channels: ChannelConfig[];
  upmixProfile: UpmixProfile;
  signal?: AbortSignal;
  onPhaseChange?: (phase: ConversionPhase) => void;
  onProgress?: (percent: number, estimatedRemainingMs?: number | null) => void;
  onLog?: (line: string) => void;
}

class DspWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL('../workers/spatialDsp.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const { id, ok, result, error } = event.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) {
        entry.resolve(result);
      } else {
        entry.reject(new Error(error || 'Spatial DSP worker error'));
      }
    };
    this.worker.onerror = (err) => {
      const msg = err.message || 'Spatial DSP worker crashed';
      for (const [, entry] of this.pending) {
        entry.reject(new Error(msg));
      }
      this.pending.clear();
    };
  }

  private call<T>(type: string, payload?: unknown, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
      });
      this.worker.postMessage(payload !== undefined ? { id, type, payload } : { id, type }, transfer);
    });
  }

  init(payload: {
    mode: '5.1' | '8d';
    isDiscrete6Ch: boolean;
    effectiveGains: Record<ChannelId, number>;
    upmixProfile: UpmixProfile;
    sampleRate: number;
    orbitPeriodSec: number;
  }): Promise<void> {
    return this.call<void>('init', payload);
  }

  processChunk(
    wavBytes: Uint8Array,
    applyEndFade: boolean,
    emitRawStereoPcm = false,
    isLastChunk = true,
  ): Promise<{ outBuffer: ArrayBuffer; byteLength: number }> {
    const wavBuf =
      wavBytes.byteOffset === 0 && wavBytes.byteLength === wavBytes.buffer.byteLength
        ? (wavBytes.buffer as ArrayBuffer)
        : (wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength) as ArrayBuffer);

    return this.call<{ outBuffer: ArrayBuffer; byteLength: number }>(
      'processChunk',
      { wavBuffer: wavBuf, applyEndFade, emitRawStereoPcm, isLastChunk },
      [wavBuf],
    );
  }

  processFloatChunk(
    leftSlice: Float32Array,
    rightSlice: Float32Array,
    applyEndFade: boolean,
    emitRawStereoPcm = false,
    isLastChunk = true,
  ): Promise<{ outBuffer: ArrayBuffer; byteLength: number }> {
    const leftBuf =
      leftSlice.byteOffset === 0 && leftSlice.byteLength === leftSlice.buffer.byteLength
        ? (leftSlice.buffer as ArrayBuffer)
        : (leftSlice.buffer.slice(
            leftSlice.byteOffset,
            leftSlice.byteOffset + leftSlice.byteLength,
          ) as ArrayBuffer);
    const rightBuf =
      rightSlice.byteOffset === 0 && rightSlice.byteLength === rightSlice.buffer.byteLength
        ? (rightSlice.buffer as ArrayBuffer)
        : (rightSlice.buffer.slice(
            rightSlice.byteOffset,
            rightSlice.byteOffset + rightSlice.byteLength,
          ) as ArrayBuffer);

    return this.call<{ outBuffer: ArrayBuffer; byteLength: number }>(
      'processFloatChunk',
      { leftBuffer: leftBuf, rightBuffer: rightBuf, applyEndFade, emitRawStereoPcm, isLastChunk },
      [leftBuf, rightBuf],
    );
  }

  finish(): Promise<{ channelRms: Record<ChannelId, number> }> {
    return this.call<{ channelRms: Record<ChannelId, number> }>('finish');
  }

  terminate() {
    for (const [, entry] of this.pending) {
      entry.reject(createAbortError('Spatial DSP worker terminated'));
    }
    this.pending.clear();
    this.worker.terminate();
  }
}

function resetFfmpegWorker(): void {
  try {
    ffmpegSingleton?.terminate();
  } catch {
    // Ignore termination errors
  }
  ffmpegSingleton = null;
  loadPromise = null;
}

function isMemoryAllocationError(err: unknown): boolean {
  const msg = (err instanceof Error ? `${err.name} ${err.message}` : String(err)).toLowerCase();
  return (
    msg.includes('array buffer allocation failed') ||
    msg.includes('allocation failed') ||
    msg.includes('memory') ||
    msg.includes('oom') ||
    msg.includes('out of bounds') ||
    msg.includes('rangeerror')
  );
}

async function getLoadedFfmpeg(): Promise<FFmpeg> {
  if (ffmpegSingleton?.loaded) {
    return ffmpegSingleton;
  }
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    const baseURL = `${window.location.origin}/ffmpeg`;
    console.info('[Surround X][FFmpeg] Loading local WASM core from', baseURL);

    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    ]);

    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegSingleton = ffmpeg;
    console.info('[Surround X][FFmpeg] Core initialized successfully');
    return ffmpeg;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    ffmpegSingleton = null;
    throw err;
  }
}

/**
 * Quietly pre-loads and compiles the local FFmpeg WASM core in the background
 * when a track is selected so conversion starts immediately on click.
 */
export function warmupFfmpegEngine(): void {
  if (typeof window === 'undefined' || ffmpegSingleton?.loaded || loadPromise) {
    return;
  }
  void getLoadedFfmpeg().catch(() => undefined);
}

async function decodeStereoFastViaWebAudio(
  sourceBlob: Blob,
  targetSampleRate: number,
  requireStereoOrMono: boolean,
  maxDurationSec: number,
  signal?: AbortSignal,
): Promise<{ left: Float32Array; right: Float32Array; durationSec: number } | null> {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  let tempCtx: AudioContext | null = null;
  try {
    const encodedBuf = await raceWithAbort(sourceBlob.arrayBuffer(), signal);
    if (signal?.aborted) return null;

    tempCtx = new AudioCtx({ sampleRate: targetSampleRate });
    const decoded = await raceWithAbort(tempCtx.decodeAudioData(encodedBuf), signal);
    if (signal?.aborted) return null;

    if (requireStereoOrMono && decoded.numberOfChannels >= 6) {
      return null;
    }
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > maxDurationSec) {
      return null;
    }

    let finalBuffer = decoded;
    if (decoded.sampleRate !== targetSampleRate && typeof OfflineAudioContext !== 'undefined') {
      const targetFrames = Math.max(1, Math.round(decoded.duration * targetSampleRate));
      const outChannels = decoded.numberOfChannels >= 2 ? 2 : 1;
      const offline = new OfflineAudioContext(outChannels, targetFrames, targetSampleRate);
      const srcNode = offline.createBufferSource();
      srcNode.buffer = decoded;
      srcNode.connect(offline.destination);
      srcNode.start(0);
      finalBuffer = await raceWithAbort(offline.startRendering(), signal);
      if (signal?.aborted) return null;
    }

    const left = finalBuffer.getChannelData(0);
    const right =
      finalBuffer.numberOfChannels >= 2
        ? finalBuffer.getChannelData(1)
        : new Float32Array(left);

    return {
      left,
      right,
      durationSec: finalBuffer.duration,
    };
  } catch {
    return null;
  } finally {
    if (tempCtx && tempCtx.state !== 'closed') {
      await tempCtx.close().catch(() => undefined);
    }
  }
}

function parseProbeMetadataFromLogs(lines: string[]): {
  durationSec: number | null;
  sourceChannels: number | null;
} {
  let durationSec: number | null = null;
  let sourceChannels: number | null = null;

  for (const line of lines) {
    const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (durMatch) {
      const h = Number(durMatch[1]);
      const m = Number(durMatch[2]);
      const s = Number(durMatch[3]);
      if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) {
        durationSec = h * 3600 + m * 60 + s;
      }
    }
    if (/Stream\s+#\d+:\d+.*Audio:/i.test(line)) {
      if (/\b5\.1|\b6 channels\b|\b7\.1/i.test(line)) {
        sourceChannels = 6;
      } else if (/\bmono\b|\b1 channels\b/i.test(line)) {
        sourceChannels = 1;
      } else if (/\bstereo\b|\b2 channels\b/i.test(line)) {
        sourceChannels = 2;
      }
    }
  }

  return { durationSec, sourceChannels };
}

function formatFriendlyError(err: unknown, recentLogs: string[]): string {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const lower = rawMessage.toLowerCase();

  if (lower.includes('sharedarraybuffer') || lower.includes('cross-origin')) {
    return 'Browser threading restriction detected. Please reload the page and try again.';
  }
  if (isMemoryAllocationError(err)) {
    return 'Browser memory or WebAssembly allocation limit reached on this device. Try a shorter track or close background tabs.';
  }
  if (lower.includes('invalid data') || lower.includes('could not find codec') || lower.includes('moov atom')) {
    return 'Unable to decode this audio container. Please verify the file is a valid MP3, WAV, FLAC, M4A, AAC, or OGG audio track.';
  }

  const errorLog = [...recentLogs]
    .reverse()
    .find((line) => /error|invalid|failed|unable|not found/i.test(line));

  if (errorLog) {
    return `Audio conversion failed: ${errorLog}`;
  }
  return rawMessage || 'Unexpected audio encoding error occurred. Check browser console for details.';
}

function getMimeTypeForExport(
  format: ExportFormat,
  spatialContainer: SpatialContainerFormat,
): string {
  switch (format) {
    case 'ac3':
      return 'audio/ac3';
    case 'dts':
      return 'audio/vnd.dts';
    case 'flac':
      return 'audio/flac';
    case '8d-spatial':
      return spatialContainer === 'wav' ? 'audio/wav' : 'audio/mpeg';
  }
}

function getCodecLabel(
  format: ExportFormat,
  spatialContainer: SpatialContainerFormat,
  bitrateKbps: Ac3BitrateKbps,
): string {
  switch (format) {
    case 'ac3':
      return `${bitrateKbps} kbps AC3`;
    case 'dts':
      return '768 kbps DTS';
    case 'flac':
      return 'Lossless FLAC';
    case '8d-spatial':
      return spatialContainer === 'wav' ? '8D Binaural WAV' : '320 kbps 8D MP3';
  }
}

export async function convertAudioToAc3(options: ConvertOptions): Promise<ConversionResult> {
  const {
    sourceFile,
    sourceBytes,
    durationSec = 0,
    sourceChannels = 2,
    sourceFilename,
    exportFormat = 'ac3',
    spatialContainer = 'mp3',
    orbitPeriodSec = 8.0,
    bitrateKbps,
    channels,
    upmixProfile,
    signal,
    onPhaseChange,
    onProgress,
    onLog,
  } = options;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const hasValidFile = sourceFile && sourceFile.size > 0;
  const hasValidBytes = sourceBytes && sourceBytes.byteLength > 0;
  if (!hasValidFile && !hasValidBytes) {
    throw new Error('No audio source provided for conversion.');
  }
  if (conversionInFlight) {
    throw new Error('Another conversion is already in progress. Please wait for it to finish.');
  }

  conversionInFlight = true;
  const startedAt = performance.now();
  const recentLogs: string[] = [];
  const statusLogs: string[] = [];
  let highestProgress = -1;
  let lastProgressEmitAt = 0;

  const emitProgress = (pct: number, estimatedRemainingMs?: number | null) => {
    const clamped = Math.max(highestProgress, Math.min(100, Math.round(pct)));
    const now = performance.now();
    if (
      clamped === highestProgress &&
      (estimatedRemainingMs == null || now - lastProgressEmitAt < 400)
    ) {
      return;
    }
    highestProgress = clamped;
    lastProgressEmitAt = now;
    onProgress?.(clamped, estimatedRemainingMs);
  };

  const pushStatus = (line: string) => {
    statusLogs.push(line);
    onLog?.(line);
  };

  let ffmpeg: FFmpeg | null = null;
  let dspWorker: DspWorkerClient | null = null;
  let mountDir = '';
  let fallbackRawName = '';
  let runId = '';
  let outExt = '';
  const flacSegmentFiles: string[] = [];
  const tempDecodeSegmentFiles: string[] = [];
  let flacListFile = '';
  let virtualOutputName = '';
  let chunkDecWav = '';
  let chunkSegIn = '';
  let chunkSegOut = '';

  const ffmpegLogListener = ({ message }: { message: string }) => {
    recentLogs.push(message);
    if (recentLogs.length > 60) recentLogs.shift();
    console.debug('[Surround X][FFmpeg]', message);
  };

  const attachFfmpegListeners = (instance: FFmpeg) => {
    instance.on('log', ffmpegLogListener);
  };

  const detachFfmpegListeners = (instance: FFmpeg | null) => {
    instance?.off('log', ffmpegLogListener);
  };

  let abortListener: (() => void) | null = null;

  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw createAbortError();
    }
  };

  try {
    abortListener = () => {
      try {
        dspWorker?.terminate();
      } catch {
        // Ignore worker termination error
      }
      resetFfmpegWorker();
    };
    signal?.addEventListener('abort', abortListener, { once: true });

    const is8dMode = exportFormat === '8d-spatial';
    const is8dWavDirect = is8dMode && spatialContainer === 'wav';
    const mobileDevice = isLikelyMobileDevice();
    const fastWebAudioMaxBytes = mobileDevice ? 24 * 1024 * 1024 : 48 * 1024 * 1024;
    const fastWebAudioMaxDurationSec = mobileDevice ? 600 : 1080;

    const fileToMount =
      sourceFile instanceof File
        ? sourceFile
        : sourceFile instanceof Blob
          ? sourceFile
          : new Blob([sourceBytes as unknown as BlobPart]);
    const ext = sanitizeInputExtension(sourceFilename);
    outExt = exportFormat === 'dts' ? 'dts' : exportFormat === 'flac' ? 'flac' : 'ac3';
    runId = Date.now().toString(36);

    const alwaysNativeBitstream = ext === 'ac3' || ext === 'dts';
    const canTryFastDecode =
      fileToMount.size > 0 &&
      fileToMount.size <= fastWebAudioMaxBytes &&
      (durationSec <= 0 || durationSec <= fastWebAudioMaxDurationSec) &&
      (is8dMode || (sourceChannels < 6 && !alwaysNativeBitstream));

    onPhaseChange?.('loading-engine');
    emitProgress(4);
    pushStatus(
      canTryFastDecode
        ? `Initializing fast decoder & ${exportFormat.toUpperCase()} worker...`
        : exportFormat === '8d-spatial'
          ? 'Initializing linear WASM decoder & 8D DSP worker...'
          : `Initializing FFmpeg WASM & ${exportFormat.toUpperCase()} streaming worker...`,
    );

    dspWorker = new DspWorkerClient();
    const fastDecodePromise = canTryFastDecode
      ? decodeStereoFastViaWebAudio(
          fileToMount,
          TARGET_SAMPLE_RATE,
          !is8dMode,
          fastWebAudioMaxDurationSec,
          signal,
        )
      : Promise.resolve(null);
    const ffmpegPromise =
      is8dWavDirect && canTryFastDecode
        ? Promise.resolve(null)
        : raceWithAbort(getLoadedFfmpeg(), signal);

    const [fastAudioInitial, loadedFfmpeg] = await Promise.all([fastDecodePromise, ffmpegPromise]);
    let fastAudio = fastAudioInitial;
    throwIfCancelled();

    if (loadedFfmpeg) {
      ffmpeg = loadedFfmpeg;
      attachFfmpegListeners(ffmpeg);
    } else if (!fastAudio) {
      ffmpeg = await raceWithAbort(getLoadedFfmpeg(), signal);
      throwIfCancelled();
      attachFfmpegListeners(ffmpeg);
    }

    onPhaseChange?.('preparing-audio');
    emitProgress(12);

    const outputBlobParts: Uint8Array[] = [];
    let outputByteSize = 0;
    let totalRawPcmBytes = 0;
    let encodedBlockCount = 0;

    const encodeProcessedBlock = async (
      processedBytes: Uint8Array,
      blockIndex: number,
    ): Promise<void> => {
      throwIfCancelled();
      if (is8dWavDirect) {
        outputBlobParts.push(processedBytes);
        totalRawPcmBytes += processedBytes.byteLength;
        encodedBlockCount++;
        return;
      }

      if (!ffmpeg) {
        ffmpeg = await raceWithAbort(getLoadedFfmpeg(), signal);
        attachFfmpegListeners(ffmpeg);
      }

      if (is8dMode) {
        await ffmpeg.writeFile(chunkSegIn, processedBytes, { signal });
        const encExit = await ffmpeg.exec(
          [
            '-y',
            '-i',
            chunkSegIn,
            '-vn',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '320k',
            '-compression_level',
            '5',
            '-write_xing',
            '0',
            '-id3v2_version',
            '0',
            '-ar',
            String(TARGET_SAMPLE_RATE),
            '-ac',
            '2',
            chunkSegOut,
          ],
          -1,
          { signal },
        );
        await ffmpeg.deleteFile(chunkSegIn).catch(() => undefined);

        if (encExit !== 0) {
          throw new Error(`FFmpeg 8D MP3 segment encoder returned exit code (${encExit}).`);
        }

        const mp3Seg = await ffmpeg.readFile(chunkSegOut, 'binary', { signal });
        await ffmpeg.deleteFile(chunkSegOut).catch(() => undefined);
        if (!(mp3Seg instanceof Uint8Array) || mp3Seg.byteLength === 0) {
          throw new Error('FFmpeg produced an empty 8D MP3 segment.');
        }
        outputBlobParts.push(mp3Seg);
        outputByteSize += mp3Seg.byteLength;
        encodedBlockCount++;
        return;
      }

      if (exportFormat === 'flac') {
        await ffmpeg.writeFile(chunkSegIn, processedBytes, { signal });
        const flacSegName = `flac_${runId}_${blockIndex}.flac`;
        const encArgs = buildFfmpegArgsForFormat(chunkSegIn, flacSegName, 'flac', { bitrateKbps });
        const encExit = await ffmpeg.exec(encArgs, -1, { signal });
        await ffmpeg.deleteFile(chunkSegIn).catch(() => undefined);

        if (encExit !== 0) {
          throw new Error(`FFmpeg FLAC segment encoder returned exit code (${encExit}).`);
        }
        flacSegmentFiles.push(flacSegName);
        encodedBlockCount++;
        return;
      }

      // 5.1 AC3 / DTS bounded chunk encoding
      await ffmpeg.writeFile(chunkSegIn, processedBytes, { signal });
      const encArgs = buildFfmpegArgsForFormat(chunkSegIn, chunkSegOut, exportFormat, {
        bitrateKbps,
      });
      const encExit = await ffmpeg.exec(encArgs, -1, { signal });
      await ffmpeg.deleteFile(chunkSegIn).catch(() => undefined);

      if (encExit !== 0) {
        throw new Error(`FFmpeg ${exportFormat.toUpperCase()} encoder failed (exit ${encExit}).`);
      }

      const segOutBytes = await ffmpeg.readFile(chunkSegOut, 'binary', { signal });
      await ffmpeg.deleteFile(chunkSegOut).catch(() => undefined);

      if (!(segOutBytes instanceof Uint8Array) || segOutBytes.byteLength === 0) {
        throw new Error(`FFmpeg produced an empty ${exportFormat.toUpperCase()} segment.`);
      }
      if (encodedBlockCount === 0 && exportFormat === 'ac3' && !isValidAc3Bitstream(segOutBytes)) {
        throw new Error('Output stream failed Dolby Digital AC3 syncword verification.');
      }

      outputBlobParts.push(segOutBytes);
      outputByteSize += segOutBytes.byteLength;
      encodedBlockCount++;
    };

    if (fastAudio) {
      const resolvedDurationSec = fastAudio.durationSec;
      const totalFrames = Math.min(
        fastAudio.left.length,
        fastAudio.right.length,
        MAX_DURATION_SEC * TARGET_SAMPLE_RATE,
      );
      const effectiveGains = computeEffectiveChannelGains(channels);
      const chunkDurationSec = computeAdaptiveChunkDurationSec(
        fileToMount.size,
        resolvedDurationSec,
        false,
      );
      const chunkFrames = Math.max(4096, Math.round(chunkDurationSec * TARGET_SAMPLE_RATE));
      const totalChunks = Math.max(1, Math.ceil(totalFrames / chunkFrames));

      pushStatus(
        `Fast-decoded ${(fileToMount.size / (1024 * 1024)).toFixed(1)} MB (${resolvedDurationSec.toFixed(1)}s @ 48 kHz) · ${totalChunks} ${totalChunks === 1 ? 'block' : 'blocks'}`,
      );

      await raceWithAbort(
        dspWorker.init({
          mode: is8dMode ? '8d' : '5.1',
          isDiscrete6Ch: false,
          effectiveGains,
          upmixProfile,
          sampleRate: TARGET_SAMPLE_RATE,
          orbitPeriodSec,
        }),
        signal,
      );

      emitProgress(20);

      if (is8dMode) {
        onPhaseChange?.('processing-8d');
      } else if (exportFormat === 'ac3') {
        onPhaseChange?.('encoding-ac3');
      } else {
        onPhaseChange?.('encoding-output');
      }

      chunkSegIn = `seg_in_${runId}.wav`;
      chunkSegOut = `seg_out_${runId}.${is8dMode ? 'mp3' : outExt}`;

      const startFastChunkDsp = (chunkIdx: number) => {
        const startFrame = chunkIdx * chunkFrames;
        const endFrame = Math.min(totalFrames, startFrame + chunkFrames);
        const isLast = chunkIdx === totalChunks - 1;
        const shouldFadeEnd = isLast && resolvedDurationSec >= MAX_DURATION_SEC - 1;
        return dspWorker!.processFloatChunk(
          fastAudio!.left.subarray(startFrame, endFrame),
          fastAudio!.right.subarray(startFrame, endFrame),
          shouldFadeEnd,
          is8dWavDirect,
          isLast,
        );
      };

      const progressSpan = exportFormat === 'flac' ? 66 : 74;
      let emaBlockMs = 0;
      let pendingDspPromise: Promise<{ outBuffer: ArrayBuffer; byteLength: number }> | null =
        startFastChunkDsp(0);

      for (let i = 0; i < totalChunks; i++) {
        throwIfCancelled();
        const blockStart = performance.now();
        const workerRes = await raceWithAbort(pendingDspPromise!, signal);
        pendingDspPromise = i + 1 < totalChunks ? startFastChunkDsp(i + 1) : null;

        if (workerRes.byteLength === 0) {
          if (i < totalChunks - 1 || encodedBlockCount > 0) {
            continue;
          }
          throw new Error('Spatial DSP worker returned an empty audio block.');
        }

        const processedBytes = new Uint8Array(workerRes.outBuffer, 0, workerRes.byteLength);
        await encodeProcessedBlock(processedBytes, i);

        const blockElapsed = performance.now() - blockStart;
        emaBlockMs = emaBlockMs === 0 ? blockElapsed : emaBlockMs * 0.65 + blockElapsed * 0.35;
        const remainingBlocks = totalChunks - (i + 1);
        const flacTailMs = exportFormat === 'flac' ? 1200 : 0;
        const estRemainingMs =
          remainingBlocks > 0 ? Math.max(500, Math.round(emaBlockMs * remainingBlocks + flacTailMs)) : 0;

        emitProgress(20 + ((i + 1) / totalChunks) * progressSpan, estRemainingMs);
        await yieldToEventLoop();
      }
      fastAudio = null;
      throwIfCancelled();
    } else {
      if (!ffmpeg) {
        ffmpeg = await raceWithAbort(getLoadedFfmpeg(), signal);
        throwIfCancelled();
        attachFfmpegListeners(ffmpeg);
      }

      let inputPath = '';
      const workerMountPath = `/in_${runId}`;
      const safeMountFileName = `src_${runId}.${ext}`;
      let mountedViaWorkerFs = false;

      if (fileToMount.size <= MEMFS_FAST_WRITE_MAX_BYTES) {
        try {
          fallbackRawName = `raw_${runId}.${ext}`;
          const memBytes = sourceBytes
            ? sourceBytes.slice()
            : new Uint8Array(await raceWithAbort(fileToMount.arrayBuffer(), signal));
          await ffmpeg.writeFile(fallbackRawName, memBytes, { signal });
          inputPath = fallbackRawName;
          pushStatus(
            `Loaded ${(fileToMount.size / (1024 * 1024)).toFixed(1)} MB directly into WASM MEMFS for high-speed decoding`,
          );
        } catch (memWriteErr) {
          if (isAbortError(memWriteErr) || signal?.aborted) throw createAbortError();
          fallbackRawName = '';
        }
      }

      if (!inputPath) {
        try {
          await ffmpeg.createDir(workerMountPath, { signal });
          if (fileToMount instanceof File) {
            await ffmpeg.mount(FFFSType.WORKERFS, { files: [fileToMount] }, workerMountPath);
            inputPath = `${workerMountPath}/${fileToMount.name}`;
          } else {
            await ffmpeg.mount(
              FFFSType.WORKERFS,
              { blobs: [{ name: safeMountFileName, data: fileToMount }] },
              workerMountPath,
            );
            inputPath = `${workerMountPath}/${safeMountFileName}`;
          }
          mountDir = workerMountPath;
          mountedViaWorkerFs = true;
          pushStatus(
            `Mounted stream via WORKERFS (${(fileToMount.size / (1024 * 1024)).toFixed(1)} MB zero-copy)`,
          );
        } catch (mountErr) {
          console.warn('[Surround X][WORKERFS] Falling back to MEMFS write:', mountErr);
          fallbackRawName = `raw_${runId}.${ext}`;
          const bytesToWrite = sourceBytes
            ? sourceBytes.slice()
            : new Uint8Array(await raceWithAbort(fileToMount.arrayBuffer(), signal));
          await ffmpeg.writeFile(fallbackRawName, bytesToWrite, { signal });
          inputPath = fallbackRawName;
        }
      }

      // Probe stream metadata if browser metadata duration wasn't already resolved
      let resolvedDurationSec = durationSec;
      let resolvedSourceChannels = sourceChannels;
      if (resolvedDurationSec <= 0) {
        await ffmpeg.exec(['-i', inputPath], -1, { signal }).catch(() => 1);
        throwIfCancelled();
        const probed = parseProbeMetadataFromLogs(recentLogs);
        if (probed.durationSec && probed.durationSec > 0) {
          resolvedDurationSec = probed.durationSec;
        }
        if (probed.sourceChannels && probed.sourceChannels > 0) {
          resolvedSourceChannels = probed.sourceChannels;
        }
      }
      if (resolvedDurationSec <= 0) {
        resolvedDurationSec = CHUNK_DURATION_SEC;
      }

      const effectiveDurationSec = Math.min(MAX_DURATION_SEC, resolvedDurationSec);
      const isDiscrete6Ch = !is8dMode && resolvedSourceChannels >= 6;
      const decodeChannels = isDiscrete6Ch ? 6 : 2;
      const adaptiveChunkSec = computeAdaptiveChunkDurationSec(
        fileToMount.size,
        effectiveDurationSec,
        isDiscrete6Ch,
      );
      const windows = computeChunkWindows(
        effectiveDurationSec,
        adaptiveChunkSec,
        MAX_DURATION_SEC,
      );
      const effectiveGains = computeEffectiveChannelGains(channels);

      await raceWithAbort(
        dspWorker.init({
          mode: is8dMode ? '8d' : '5.1',
          isDiscrete6Ch,
          effectiveGains,
          upmixProfile,
          sampleRate: TARGET_SAMPLE_RATE,
          orbitPeriodSec,
        }),
        signal,
      );

      chunkDecWav = `dec_${runId}.wav`;
      chunkSegIn = `seg_in_${runId}.wav`;
      chunkSegOut = `seg_out_${runId}.${is8dMode ? 'mp3' : outExt}`;

      const useLinearSegmentedPass = windows.length > 1 && !isFastInputSeekFormat(ext);

      if (useLinearSegmentedPass) {
        // O(N) linear single-pass demux/decode into compact segments (eliminates O(N^2) output seeking)
        const useFlacSegments = effectiveDurationSec > 480 || isDiscrete6Ch;
        const segExt = useFlacSegments ? 'flac' : 'wav';
        const segPrefix = `segdec_${runId}_`;
        const segPattern = `${segPrefix}%03d.${segExt}`;

        pushStatus(
          `Decoding ${Math.round(effectiveDurationSec)}s ${ext.toUpperCase()} linearly in single pass (${adaptiveChunkSec}s ${useFlacSegments ? 'FLAC-0' : 'PCM'} segments · ${decodeChannels}ch @ 48 kHz)...`,
        );
        emitProgress(15);

        const segPassStart = performance.now();
        const segProgressListener = ({ progress, time }: { progress?: number; time?: number }) => {
          let frac = 0;
          if (typeof time === 'number' && Number.isFinite(time) && time > 0) {
            frac = Math.min(1, time / 1_000_000 / Math.max(1, effectiveDurationSec));
          } else if (typeof progress === 'number' && Number.isFinite(progress) && progress > 0 && progress <= 1) {
            frac = progress;
          }
          if (frac > 0.02) {
            const elapsedSeg = performance.now() - segPassStart;
            const estDecodeRemMs = (elapsedSeg / frac) * (1 - frac);
            const estEncodeMs = Math.max(2000, elapsedSeg * (is8dWavDirect ? 0.5 : 1.8));
            emitProgress(15 + frac * 19, Math.round(estDecodeRemMs + estEncodeMs));
          }
        };

        ffmpeg.on('progress', segProgressListener);
        let segExit = 0;
        try {
          const segArgs = [
            '-y',
            '-i',
            inputPath,
            '-vn',
            '-t',
            String(Math.ceil(effectiveDurationSec) + 2),
            '-ar',
            String(TARGET_SAMPLE_RATE),
            '-ac',
            String(decodeChannels),
            '-c:a',
            useFlacSegments ? 'flac' : 'pcm_s16le',
            ...(useFlacSegments ? ['-compression_level', '0'] : []),
            '-f',
            'segment',
            '-segment_time',
            String(adaptiveChunkSec),
            '-reset_timestamps',
            '1',
            segPattern,
          ];
          segExit = await ffmpeg.exec(segArgs, -1, { signal });
        } finally {
          ffmpeg.off('progress', segProgressListener);
        }
        throwIfCancelled();

        // Free source file immediately after single-pass decode to minimize peak MEMFS usage
        if (fallbackRawName) {
          await ffmpeg.deleteFile(fallbackRawName).catch(() => undefined);
          fallbackRawName = '';
        }
        if (mountDir) {
          await ffmpeg.unmount(mountDir).catch(() => undefined);
          await ffmpeg.deleteDir(mountDir).catch(() => undefined);
          mountDir = '';
        }

        if (segExit !== 0) {
          throw new Error(`FFmpeg could not decode input audio container (exit code ${segExit}).`);
        }

        const dirEntries = await ffmpeg.listDir('.', { signal });
        const segFiles = dirEntries
          .filter((entry) => !entry.isDir && entry.name.startsWith(segPrefix))
          .map((entry) => entry.name)
          .sort();
        tempDecodeSegmentFiles.push(...segFiles);

        if (segFiles.length === 0) {
          throw new Error('FFmpeg linear decoder produced no audio segments.');
        }

        if (is8dMode) {
          onPhaseChange?.('processing-8d');
        } else if (exportFormat === 'ac3') {
          onPhaseChange?.('encoding-ac3');
        } else {
          onPhaseChange?.('encoding-output');
        }
        emitProgress(35);

        const progressSpan = exportFormat === 'flac' ? 53 : 60;
        let emaStepMs = 0;
        let prevProcessedBytes: Uint8Array | null = null;
        let prevIdx = -1;

        for (let i = 0; i < segFiles.length; i++) {
          throwIfCancelled();
          const stepStart = performance.now();
          const segName = segFiles[i];
          const isLast = i === segFiles.length - 1;

          let rawWavBytes: Uint8Array;
          if (useFlacSegments) {
            const decExit = await ffmpeg.exec(
              [
                '-y',
                '-i',
                segName,
                '-ar',
                String(TARGET_SAMPLE_RATE),
                '-ac',
                String(decodeChannels),
                '-c:a',
                'pcm_s16le',
                chunkDecWav,
              ],
              -1,
              { signal },
            );
            await ffmpeg.deleteFile(segName).catch(() => undefined);
            if (decExit !== 0) {
              throw new Error(`FFmpeg intermediate segment decode failed (exit code ${decExit}).`);
            }
            const readRes = await ffmpeg.readFile(chunkDecWav, 'binary', { signal });
            await ffmpeg.deleteFile(chunkDecWav).catch(() => undefined);
            if (!(readRes instanceof Uint8Array) || readRes.byteLength <= 44) {
              if (i === 0) {
                throw new Error('FFmpeg produced an empty intermediate PCM stream.');
              }
              rawWavBytes = new Uint8Array(0);
            } else {
              rawWavBytes = readRes;
            }
          } else {
            const readRes = await ffmpeg.readFile(segName, 'binary', { signal });
            await ffmpeg.deleteFile(segName).catch(() => undefined);
            if (!(readRes instanceof Uint8Array) || readRes.byteLength <= 44) {
              if (i === 0) {
                throw new Error('FFmpeg produced an empty intermediate PCM stream.');
              }
              rawWavBytes = new Uint8Array(0);
            } else {
              rawWavBytes = readRes;
            }
          }

          const shouldFadeEnd = isLast && resolvedDurationSec >= MAX_DURATION_SEC - 1;
          const emitRawPcm = is8dMode && spatialContainer === 'wav';

          // Overlap DSP worker on segment i concurrently with FFmpeg encoding of segment i-1
          const currentDspPromise = dspWorker.processChunk(
            rawWavBytes,
            shouldFadeEnd,
            emitRawPcm,
            isLast,
          );
          const prevEncodePromise: Promise<void> = prevProcessedBytes
            ? encodeProcessedBlock(prevProcessedBytes, prevIdx)
            : Promise.resolve();

          const [, workerRes]: [void, { outBuffer: ArrayBuffer; byteLength: number }] =
            await raceWithAbort(Promise.all([prevEncodePromise, currentDspPromise]), signal);
          prevProcessedBytes = null;

          if (workerRes.byteLength > 0) {
            prevProcessedBytes = new Uint8Array(workerRes.outBuffer, 0, workerRes.byteLength);
            prevIdx = i;
          } else if (isLast && encodedBlockCount === 0) {
            throw new Error('Spatial DSP worker returned an empty audio block.');
          }

          const stepElapsed = performance.now() - stepStart;
          emaStepMs = emaStepMs === 0 ? stepElapsed : emaStepMs * 0.65 + stepElapsed * 0.35;
          const remainingSteps = segFiles.length - (i + 1);
          const tailMs = (prevProcessedBytes ? emaStepMs : 0) + (exportFormat === 'flac' ? 1200 : 0);
          const estRemainingMs = Math.max(500, Math.round(emaStepMs * remainingSteps + tailMs));

          emitProgress(35 + ((i + 0.5) / segFiles.length) * progressSpan, estRemainingMs);
          await yieldToEventLoop();
        }

        if (prevProcessedBytes) {
          await encodeProcessedBlock(prevProcessedBytes, prevIdx);
          prevProcessedBytes = null;
        }
        emitProgress(35 + progressSpan, exportFormat === 'flac' ? 1000 : 0);
        throwIfCancelled();
      } else {
        // O(1) input-seek path (WAV / FLAC / M4A / MP4 / AIFF) or single-block short stream
        pushStatus(
          `Streaming ${windows.length} ${windows.length === 1 ? 'block' : 'blocks'} (${Math.round(effectiveDurationSec)}s · ${decodeChannels}ch @ 48 kHz)${mountedViaWorkerFs ? ' [WORKERFS]' : ' [MEMFS]'}`,
        );
        emitProgress(16);

        if (is8dMode) {
          onPhaseChange?.('processing-8d');
        } else if (exportFormat === 'ac3') {
          onPhaseChange?.('encoding-ac3');
        } else {
          onPhaseChange?.('encoding-output');
        }

        const progressSpan = exportFormat === 'flac' ? 68 : 78;
        let emaStepMs = 0;
        let prevProcessedBytes: Uint8Array | null = null;
        let prevIdx = -1;

        for (let i = 0; i < windows.length; i++) {
          throwIfCancelled();
          const stepStart = performance.now();
          const win = windows[i];
          const isLast = i === windows.length - 1;
          const decodeDur = isLast ? win.durationSec + 8 : win.durationSec;

          const decArgs = buildFfmpegChunkDecodeArgs({
            inputPath,
            outputWavPath: chunkDecWav,
            startSec: win.startSec,
            durationSec: decodeDur,
            targetSampleRate: TARGET_SAMPLE_RATE,
            decodeChannels,
            inputExt: ext,
          });

          const decExit = await ffmpeg.exec(decArgs, -1, { signal });
          if (decExit !== 0) {
            if (i > 0) {
              await ffmpeg.deleteFile(chunkDecWav).catch(() => undefined);
              break;
            }
            throw new Error(`FFmpeg could not decode input audio container (exit code ${decExit}).`);
          }

          const rawWavBytes = await ffmpeg.readFile(chunkDecWav, 'binary', { signal });
          await ffmpeg.deleteFile(chunkDecWav).catch(() => undefined);

          if (!(rawWavBytes instanceof Uint8Array) || rawWavBytes.byteLength <= 44) {
            if (i > 0) {
              if (prevProcessedBytes) {
                await encodeProcessedBlock(prevProcessedBytes, prevIdx);
                prevProcessedBytes = null;
              }
              break;
            }
            throw new Error('FFmpeg produced an empty intermediate PCM stream.');
          }

          const shouldFadeEnd = isLast && resolvedDurationSec >= MAX_DURATION_SEC - 1;
          const emitRawPcm = is8dMode && spatialContainer === 'wav';

          // Overlap DSP worker on block i concurrently with FFmpeg encoding of block i-1
          const currentDspPromise = dspWorker.processChunk(
            rawWavBytes,
            shouldFadeEnd,
            emitRawPcm,
            isLast,
          );
          const prevEncodePromise: Promise<void> = prevProcessedBytes
            ? encodeProcessedBlock(prevProcessedBytes, prevIdx)
            : Promise.resolve();

          const [, workerRes]: [void, { outBuffer: ArrayBuffer; byteLength: number }] =
            await raceWithAbort(Promise.all([prevEncodePromise, currentDspPromise]), signal);
          prevProcessedBytes = null;

          if (workerRes.byteLength > 0) {
            prevProcessedBytes = new Uint8Array(workerRes.outBuffer, 0, workerRes.byteLength);
            prevIdx = i;
          } else if (isLast && encodedBlockCount === 0) {
            throw new Error('Spatial DSP worker returned an empty audio block.');
          }

          const stepElapsed = performance.now() - stepStart;
          emaStepMs = emaStepMs === 0 ? stepElapsed : emaStepMs * 0.65 + stepElapsed * 0.35;
          const remainingSteps = windows.length - (i + 1);
          const tailMs = (prevProcessedBytes ? emaStepMs : 0) + (exportFormat === 'flac' ? 1200 : 0);
          const estRemainingMs = Math.max(500, Math.round(emaStepMs * remainingSteps + tailMs));

          emitProgress(16 + ((i + 0.5) / windows.length) * progressSpan, estRemainingMs);
          await yieldToEventLoop();
        }

        if (prevProcessedBytes) {
          await encodeProcessedBlock(prevProcessedBytes, prevIdx);
          prevProcessedBytes = null;
        }
        emitProgress(16 + progressSpan, exportFormat === 'flac' ? 1000 : 0);
        throwIfCancelled();
      }
    }

    if (encodedBlockCount === 0) {
      throw new Error('Conversion finished without producing any encoded audio blocks.');
    }

    onPhaseChange?.('encoding-output');

    if (exportFormat === 'flac') {
      if (!ffmpeg) {
        ffmpeg = await raceWithAbort(getLoadedFfmpeg(), signal);
        attachFfmpegListeners(ffmpeg);
      }
      if (flacSegmentFiles.length === 0) {
        throw new Error('FFmpeg finished without writing any FLAC audio blocks.');
      }
      if (flacSegmentFiles.length === 1) {
        const singleBytes = await ffmpeg.readFile(flacSegmentFiles[0], 'binary', { signal });
        await ffmpeg.deleteFile(flacSegmentFiles[0]).catch(() => undefined);
        if (!(singleBytes instanceof Uint8Array) || singleBytes.byteLength === 0) {
          throw new Error('FFmpeg produced an empty FLAC stream.');
        }
        outputBlobParts.push(singleBytes);
        outputByteSize = singleBytes.byteLength;
      } else {
        flacListFile = `flist_${runId}.txt`;
        virtualOutputName = `output_${runId}.flac`;
        const concatManifest = flacSegmentFiles.map((f) => `file '${f}'`).join('\n');
        await ffmpeg.writeFile(flacListFile, new TextEncoder().encode(concatManifest), { signal });

        const concatExit = await ffmpeg.exec(
          [
            '-y',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            flacListFile,
            '-c:a',
            'flac',
            '-compression_level',
            '2',
            '-ar',
            String(TARGET_SAMPLE_RATE),
            '-ac',
            '6',
            virtualOutputName,
          ],
          -1,
          { signal },
        );

        for (const f of flacSegmentFiles) {
          await ffmpeg.deleteFile(f).catch(() => undefined);
        }
        await ffmpeg.deleteFile(flacListFile).catch(() => undefined);

        if (concatExit !== 0) {
          throw new Error(`FFmpeg FLAC assembly failed (exit ${concatExit}).`);
        }

        const mergedFlac = await ffmpeg.readFile(virtualOutputName, 'binary', { signal });
        await ffmpeg.deleteFile(virtualOutputName).catch(() => undefined);
        if (!(mergedFlac instanceof Uint8Array) || mergedFlac.byteLength === 0) {
          throw new Error('FFmpeg produced an empty assembled FLAC file.');
        }
        outputBlobParts.push(mergedFlac);
        outputByteSize = mergedFlac.byteLength;
      }
    }

    const { channelRms } = await raceWithAbort(dspWorker.finish(), signal);
    emitProgress(97, 300);

    const outputFilename = buildOutputFilename(sourceFilename, exportFormat, spatialContainer);
    let finalBlobParts = outputBlobParts;
    if (is8dMode && spatialContainer === 'wav') {
      const header = buildStereoWavHeaderBytes(totalRawPcmBytes, TARGET_SAMPLE_RATE);
      finalBlobParts = [header, ...outputBlobParts];
      outputByteSize = header.byteLength + totalRawPcmBytes;
    }

    const blob = new Blob(finalBlobParts as unknown as BlobPart[], {
      type: getMimeTypeForExport(exportFormat, spatialContainer),
    });
    const url = URL.createObjectURL(blob);

    emitProgress(100, 0);
    onPhaseChange?.('completed');

    const elapsedMs = Math.round(performance.now() - startedAt);
    pushStatus(
      `Verified ${is8dMode ? '8D Spatial' : `5.1 ${exportFormat.toUpperCase()}`} output: ${outputFilename} (${outputByteSize.toLocaleString()} B in ${elapsedMs} ms)`,
    );

    return {
      blob,
      url,
      outputFilename,
      sizeBytes: outputByteSize,
      format: exportFormat,
      codecLabel: getCodecLabel(exportFormat, spatialContainer, bitrateKbps),
      bitrateKbps:
        exportFormat === 'ac3'
          ? bitrateKbps
          : exportFormat === 'dts'
            ? 768
            : is8dMode && spatialContainer === 'mp3'
              ? 320
              : undefined,
      sampleRate: TARGET_SAMPLE_RATE,
      channels: is8dMode ? 2 : 6,
      elapsedMs,
      usedCustomMix: true,
      channelRms: is8dMode ? undefined : channelRms,
      statusLogs,
    };
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) {
      resetFfmpegWorker();
      onPhaseChange?.('idle');
      throw createAbortError();
    }
    if (isMemoryAllocationError(err)) {
      resetFfmpegWorker();
    }
    console.error('[Surround X][Conversion Error]', err);
    onPhaseChange?.('error');
    const friendlyMessage = formatFriendlyError(err, recentLogs);
    throw new Error(friendlyMessage);
  } finally {
    if (abortListener) {
      signal?.removeEventListener('abort', abortListener);
    }
    dspWorker?.terminate();
    detachFfmpegListeners(ffmpeg);
    if (ffmpeg && ffmpeg.loaded && !signal?.aborted) {
      if (mountDir) {
        await ffmpeg.unmount(mountDir).catch(() => undefined);
        await ffmpeg.deleteDir(mountDir).catch(() => undefined);
      }
      for (const fname of [
        fallbackRawName,
        chunkDecWav,
        chunkSegIn,
        chunkSegOut,
        flacListFile,
        virtualOutputName,
        ...flacSegmentFiles,
        ...tempDecodeSegmentFiles,
      ]) {
        if (fname) {
          await ffmpeg.deleteFile(fname).catch(() => undefined);
        }
      }
    }
    conversionInFlight = false;
  }
}
