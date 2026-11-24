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
  computeChunkWindows,
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
const MAX_DURATION_SEC = 1800; // 30 minutes via streaming 20s chunks

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
  onProgress?: (percent: number) => void;
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
  ): Promise<{ outBuffer: ArrayBuffer; byteLength: number }> {
    const wavBuf =
      wavBytes.byteOffset === 0 && wavBytes.byteLength === wavBytes.buffer.byteLength
        ? (wavBytes.buffer as ArrayBuffer)
        : (wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength) as ArrayBuffer);

    return this.call<{ outBuffer: ArrayBuffer; byteLength: number }>(
      'processChunk',
      { wavBuffer: wavBuf, applyEndFade, emitRawStereoPcm },
      [wavBuf],
    );
  }

  finish(): Promise<{ channelRms: Record<ChannelId, number> }> {
    return this.call<{ channelRms: Record<ChannelId, number> }>('finish');
  }

  terminate() {
    for (const [, entry] of this.pending) {
      entry.reject(new Error('Spatial DSP worker terminated'));
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
  let highestProgress = 0;

  const emitProgress = (pct: number) => {
    const clamped = Math.max(highestProgress, Math.min(100, Math.round(pct)));
    highestProgress = clamped;
    onProgress?.(clamped);
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

    onPhaseChange?.('loading-engine');
    emitProgress(4);
    pushStatus(
      exportFormat === '8d-spatial'
        ? 'Initializing WASM streaming decoder & 8D DSP worker...'
        : `Initializing FFmpeg WASM & ${exportFormat.toUpperCase()} streaming worker...`,
    );

    ffmpeg = await getLoadedFfmpeg();
    throwIfCancelled();
    attachFfmpegListeners(ffmpeg);
    dspWorker = new DspWorkerClient();

    runId = Date.now().toString(36);
    const ext = sanitizeInputExtension(sourceFilename);
    outExt = exportFormat === 'dts' ? 'dts' : exportFormat === 'flac' ? 'flac' : 'ac3';

    onPhaseChange?.('preparing-audio');
    emitProgress(10);

    // Zero-RAM WORKERFS stream mount (falls back to MEMFS only if WORKERFS unavailable)
    let inputPath = '';
    const workerMountPath = `/in_${runId}`;
    const safeMountFileName = `src_${runId}.${ext}`;
    const fileToMount =
      sourceFile instanceof File
        ? sourceFile
        : sourceFile instanceof Blob
          ? sourceFile
          : new Blob([sourceBytes as unknown as BlobPart]);

    let mountedViaWorkerFs = false;
    try {
      await ffmpeg.createDir(workerMountPath);
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
        `Mounted stream directly via WORKERFS (${(fileToMount.size / (1024 * 1024)).toFixed(1)} MB zero-copy)`,
      );
    } catch (mountErr) {
      console.warn('[Surround X][WORKERFS] Falling back to MEMFS write:', mountErr);
      fallbackRawName = `raw_${runId}.${ext}`;
      const bytesToWrite =
        sourceBytes ?? new Uint8Array(await fileToMount.arrayBuffer());
      await ffmpeg.writeFile(fallbackRawName, bytesToWrite);
      inputPath = fallbackRawName;
    }

    // Probe stream metadata if browser metadata duration wasn't already resolved
    let resolvedDurationSec = durationSec;
    let resolvedSourceChannels = sourceChannels;
    if (resolvedDurationSec <= 0) {
      await ffmpeg.exec(['-i', inputPath]).catch(() => 1);
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

    const is8dMode = exportFormat === '8d-spatial';
    const isDiscrete6Ch = !is8dMode && resolvedSourceChannels >= 6;
    const decodeChannels = isDiscrete6Ch ? 6 : 2;
    const windows = computeChunkWindows(
      resolvedDurationSec,
      CHUNK_DURATION_SEC,
      MAX_DURATION_SEC,
    );
    const effectiveGains = computeEffectiveChannelGains(channels);

    pushStatus(
      `Streaming ${windows.length} ${windows.length === 1 ? 'block' : 'blocks'} (${Math.round(resolvedDurationSec)}s · ${decodeChannels}ch @ 48 kHz)${mountedViaWorkerFs ? '' : ' [MEMFS]'}`,
    );

    await dspWorker.init({
      mode: is8dMode ? '8d' : '5.1',
      isDiscrete6Ch,
      effectiveGains,
      upmixProfile,
      sampleRate: TARGET_SAMPLE_RATE,
      orbitPeriodSec,
    });

    emitProgress(16);

    if (is8dMode) {
      onPhaseChange?.('processing-8d');
    } else if (exportFormat === 'ac3') {
      onPhaseChange?.('encoding-ac3');
    } else {
      onPhaseChange?.('encoding-output');
    }

    chunkDecWav = `dec_${runId}.wav`;
    chunkSegIn = `seg_in_${runId}.wav`;
    chunkSegOut = `seg_out_${runId}.${is8dMode ? 'mp3' : outExt}`;

    const outputBlobParts: Uint8Array[] = [];
    let outputByteSize = 0;
    let totalRawPcmBytes = 0;

    for (let i = 0; i < windows.length; i++) {
      throwIfCancelled();
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

      const decExit = await ffmpeg.exec(decArgs);
      if (decExit !== 0) {
        if (i > 0) {
          await ffmpeg.deleteFile(chunkDecWav).catch(() => undefined);
          break;
        }
        throw new Error(`FFmpeg could not decode input audio container (exit code ${decExit}).`);
      }

      const rawWavBytes = await ffmpeg.readFile(chunkDecWav);
      await ffmpeg.deleteFile(chunkDecWav).catch(() => undefined);

      if (!(rawWavBytes instanceof Uint8Array) || rawWavBytes.byteLength <= 44) {
        if (i > 0) break;
        throw new Error('FFmpeg produced an empty intermediate PCM stream.');
      }

      const shouldFadeEnd = isLast && resolvedDurationSec >= MAX_DURATION_SEC - 1;
      const emitRawPcm = is8dMode && spatialContainer === 'wav';

      // Process chunk EQ + 5.1 upmix or 8D spatial off main thread via Transferable buffers
      const workerRes = await dspWorker.processChunk(rawWavBytes, shouldFadeEnd, emitRawPcm);
      if (workerRes.byteLength === 0) {
        if (i > 0) break;
        throw new Error('Spatial DSP worker returned an empty audio block.');
      }

      const processedBytes = new Uint8Array(workerRes.outBuffer, 0, workerRes.byteLength);

      if (is8dMode && spatialContainer === 'wav') {
        outputBlobParts.push(processedBytes);
        totalRawPcmBytes += processedBytes.byteLength;
      } else if (is8dMode) {
        await ffmpeg.writeFile(chunkSegIn, processedBytes);
        const encExit = await ffmpeg.exec([
          '-y',
          '-i',
          chunkSegIn,
          '-vn',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '320k',
          '-write_xing',
          '0',
          '-id3v2_version',
          '0',
          '-ar',
          String(TARGET_SAMPLE_RATE),
          '-ac',
          '2',
          chunkSegOut,
        ]);
        await ffmpeg.deleteFile(chunkSegIn).catch(() => undefined);

        if (encExit !== 0) {
          throw new Error(`FFmpeg 8D MP3 segment encoder returned exit code (${encExit}).`);
        }

        const mp3Seg = await ffmpeg.readFile(chunkSegOut);
        await ffmpeg.deleteFile(chunkSegOut).catch(() => undefined);
        if (!(mp3Seg instanceof Uint8Array) || mp3Seg.byteLength === 0) {
          throw new Error('FFmpeg produced an empty 8D MP3 segment.');
        }
        outputBlobParts.push(mp3Seg);
        outputByteSize += mp3Seg.byteLength;
      } else if (exportFormat === 'flac') {
        await ffmpeg.writeFile(chunkSegIn, processedBytes);
        const flacSegName = `flac_${runId}_${i}.flac`;
        const encArgs = buildFfmpegArgsForFormat(chunkSegIn, flacSegName, 'flac', { bitrateKbps });
        const encExit = await ffmpeg.exec(encArgs);
        await ffmpeg.deleteFile(chunkSegIn).catch(() => undefined);

        if (encExit !== 0) {
          throw new Error(`FFmpeg FLAC segment encoder returned exit code (${encExit}).`);
        }
        flacSegmentFiles.push(flacSegName);
      } else {
        // 5.1 AC3 / DTS bounded chunk encoding (~11 MB WAV -> compact bitstream segment)
        await ffmpeg.writeFile(chunkSegIn, processedBytes);
        const encArgs = buildFfmpegArgsForFormat(chunkSegIn, chunkSegOut, exportFormat, {
          bitrateKbps,
        });
        const encExit = await ffmpeg.exec(encArgs);
        await ffmpeg.deleteFile(chunkSegIn).catch(() => undefined);

        if (encExit !== 0) {
          throw new Error(`FFmpeg ${exportFormat.toUpperCase()} encoder failed (exit ${encExit}).`);
        }

        const segOutBytes = await ffmpeg.readFile(chunkSegOut);
        await ffmpeg.deleteFile(chunkSegOut).catch(() => undefined);

        if (!(segOutBytes instanceof Uint8Array) || segOutBytes.byteLength === 0) {
          throw new Error(`FFmpeg produced an empty ${exportFormat.toUpperCase()} segment.`);
        }
        if (i === 0 && exportFormat === 'ac3' && !isValidAc3Bitstream(segOutBytes)) {
          throw new Error('Output stream failed Dolby Digital AC3 syncword verification.');
        }

        outputBlobParts.push(segOutBytes);
        outputByteSize += segOutBytes.byteLength;
      }

      const progressSpan = exportFormat === 'flac' ? 68 : 78;
      emitProgress(16 + ((i + 1) / windows.length) * progressSpan);
      // Yield cleanly via MessageChannel (never clamped to 1s in background) so UI & Cancel stay responsive
      await yieldToEventLoop();
    }
    throwIfCancelled();

    onPhaseChange?.('encoding-output');

    if (exportFormat === 'flac') {
      if (flacSegmentFiles.length === 0) {
        throw new Error('FFmpeg finished without writing any FLAC audio blocks.');
      }
      if (flacSegmentFiles.length === 1) {
        const singleBytes = await ffmpeg.readFile(flacSegmentFiles[0]);
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
        await ffmpeg.writeFile(flacListFile, new TextEncoder().encode(concatManifest));

        const concatExit = await ffmpeg.exec([
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          flacListFile,
          '-c:a',
          'flac',
          '-ar',
          String(TARGET_SAMPLE_RATE),
          '-ac',
          '6',
          virtualOutputName,
        ]);

        for (const f of flacSegmentFiles) {
          await ffmpeg.deleteFile(f).catch(() => undefined);
        }
        await ffmpeg.deleteFile(flacListFile).catch(() => undefined);

        if (concatExit !== 0) {
          throw new Error(`FFmpeg FLAC assembly failed (exit ${concatExit}).`);
        }

        const mergedFlac = await ffmpeg.readFile(virtualOutputName);
        await ffmpeg.deleteFile(virtualOutputName).catch(() => undefined);
        if (!(mergedFlac instanceof Uint8Array) || mergedFlac.byteLength === 0) {
          throw new Error('FFmpeg produced an empty assembled FLAC file.');
        }
        outputBlobParts.push(mergedFlac);
        outputByteSize = mergedFlac.byteLength;
      }
    }

    const { channelRms } = await dspWorker.finish();
    emitProgress(97);

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

    emitProgress(100);
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
    if (ffmpeg) {
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
      ]) {
        if (fname) {
          await ffmpeg.deleteFile(fname).catch(() => undefined);
        }
      }
    }
    conversionInFlight = false;
  }
}
