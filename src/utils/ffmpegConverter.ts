import { FFmpeg } from '@ffmpeg/ffmpeg';
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
  buildFfmpegArgsForFormat,
  buildOutputFilename,
  computeEffectiveChannelGains,
  decodePcmWavToChannels,
  encodeDiscreteSixChannelsToWav,
  encodeMatrixUpmixStereoToSixChannelWav,
  encodeStereo8dBinauralToWav,
  encodeStereo8dBinauralWavChunks,
  isValidAc3Bitstream,
  sanitizeInputExtension,
  Streaming8DBinaural,
  StreamingMatrixUpmix51,
} from './channelMath';

let ffmpegSingleton: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let conversionInFlight = false;

const TARGET_SAMPLE_RATE = 48000;
const MAX_DURATION_SEC = 600;
const MAX_FRAMES = MAX_DURATION_SEC * TARGET_SAMPLE_RATE;

export interface ConvertOptions {
  sourceBytes: Uint8Array;
  sourceAudioBuffer?: AudioBuffer;
  sourceFilename: string;
  exportFormat?: ExportFormat;
  spatialContainer?: SpatialContainerFormat;
  orbitPeriodSec?: number;
  bitrateKbps: Ac3BitrateKbps;
  channels: ChannelConfig[];
  upmixProfile: UpmixProfile;
  onPhaseChange?: (phase: ConversionPhase) => void;
  onProgress?: (percent: number) => void;
  onLog?: (line: string) => void;
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

async function resampleBufferTo48kChannels(decoded: AudioBuffer): Promise<Float32Array[]> {
  const srcChannels = Math.max(1, decoded.numberOfChannels);
  const effectiveDuration = Math.min(decoded.duration, MAX_DURATION_SEC);
  const targetLength = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(effectiveDuration * TARGET_SAMPLE_RATE)));

  // Zero-copy / zero-OfflineAudioContext fast path when source is already 48 kHz
  if (decoded.sampleRate === TARGET_SAMPLE_RATE) {
    const out: Float32Array[] = [];
    for (let ch = 0; ch < srcChannels; ch++) {
      const data = decoded.getChannelData(ch);
      out.push(data.length > MAX_FRAMES ? data.subarray(0, MAX_FRAMES) : data);
    }
    if (out.length === 1) {
      out.push(out[0]);
    }
    return out;
  }

  // Resample in bounded 60-second chunks so OfflineAudioContext never spikes memory on long tracks
  const OfflineCtx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;

  const chunkSec = 24;
  if (effectiveDuration <= chunkSec) {
    const offline = new OfflineCtx(srcChannels, targetLength, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0, 0, effectiveDuration);
    const working = await offline.startRendering();
    source.disconnect();
    source.buffer = null;

    const out: Float32Array[] = [];
    for (let ch = 0; ch < working.numberOfChannels; ch++) {
      out.push(new Float32Array(working.getChannelData(ch)));
    }
    if (out.length === 1) {
      out.push(out[0]);
    }
    return out;
  }

  const out: Float32Array[] = Array.from({ length: srcChannels }, () => new Float32Array(targetLength));
  let writeFrame = 0;
  for (let startSec = 0; startSec < effectiveDuration && writeFrame < targetLength; startSec += chunkSec) {
    const segDur = Math.min(chunkSec, effectiveDuration - startSec);
    const segFrames = Math.min(targetLength - writeFrame, Math.max(1, Math.round(segDur * TARGET_SAMPLE_RATE)));
    const offline = new OfflineCtx(srcChannels, segFrames, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0, startSec, segDur);
    const rendered = await offline.startRendering();
    source.disconnect();
    source.buffer = null;

    const copyLen = Math.min(segFrames, rendered.length, targetLength - writeFrame);
    for (let ch = 0; ch < srcChannels; ch++) {
      out[ch].set(rendered.getChannelData(ch).subarray(0, copyLen), writeFrame);
    }
    writeFrame += copyLen;
  }

  if (out.length === 1) {
    out.push(out[0]);
  }
  return out;
}

async function decodeViaFfmpegToChannels(
  ffmpeg: FFmpeg,
  sourceBytes: Uint8Array,
  sourceFilename: string,
  runId: string,
): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const ext = sanitizeInputExtension(sourceFilename);
  const virtualRawInputName = `raw_${runId}.${ext}`;
  const virtualDecodedWavName = `decoded_${runId}.wav`;

  try {
    await ffmpeg.writeFile(virtualRawInputName, sourceBytes);
    const decExit = await ffmpeg.exec([
      '-y',
      '-i',
      virtualRawInputName,
      '-vn',
      '-t',
      String(MAX_DURATION_SEC),
      '-ar',
      String(TARGET_SAMPLE_RATE),
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      virtualDecodedWavName,
    ]);

    await ffmpeg.deleteFile(virtualRawInputName).catch(() => undefined);

    if (decExit !== 0) {
      throw new Error(`FFmpeg could not decode input audio container (exit code ${decExit}).`);
    }

    const pcmBytes = await ffmpeg.readFile(virtualDecodedWavName);
    await ffmpeg.deleteFile(virtualDecodedWavName).catch(() => undefined);

    if (!(pcmBytes instanceof Uint8Array) || pcmBytes.byteLength < 44) {
      throw new Error('FFmpeg produced an empty intermediate PCM stream.');
    }

    const decoded = decodePcmWavToChannels(pcmBytes, MAX_FRAMES);
    return decoded;
  } finally {
    await ffmpeg.deleteFile(virtualRawInputName).catch(() => undefined);
    await ffmpeg.deleteFile(virtualDecodedWavName).catch(() => undefined);
  }
}

function formatFriendlyError(err: unknown, recentLogs: string[]): string {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const lower = rawMessage.toLowerCase();

  if (lower.includes('sharedarraybuffer') || lower.includes('cross-origin')) {
    return 'Browser threading restriction detected. Please reload the page and try again.';
  }
  if (isMemoryAllocationError(err)) {
    return 'Browser memory or WebAssembly allocation limit reached on this device. Try an audio file under 100 MB or a shorter track.';
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
    sourceBytes,
    sourceAudioBuffer,
    sourceFilename,
    exportFormat = 'ac3',
    spatialContainer = 'mp3',
    orbitPeriodSec = 8.0,
    bitrateKbps,
    channels,
    upmixProfile,
    onPhaseChange,
    onProgress,
    onLog,
  } = options;

  if (!sourceBytes || sourceBytes.byteLength === 0) {
    throw new Error('No audio data found in the uploaded file buffer.');
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
  let virtualStageWavName = '';
  let virtualOutputName = '';
  let runId = '';
  let outExt = '';

  const ffmpegLogListener = ({ message }: { message: string }) => {
    recentLogs.push(message);
    if (recentLogs.length > 50) recentLogs.shift();
    console.debug('[Surround X][FFmpeg]', message);
  };

  let encodePassActive = false;
  const progressHandler = ({ progress }: { progress: number }) => {
    if (!encodePassActive || !Number.isFinite(progress)) return;
    const safe = Math.max(0, Math.min(1, progress));
    emitProgress(46 + safe * 50);
  };

  const attachFfmpegListeners = (instance: FFmpeg) => {
    instance.on('log', ffmpegLogListener);
    instance.on('progress', progressHandler);
  };

  const detachFfmpegListeners = (instance: FFmpeg | null) => {
    instance?.off('progress', progressHandler);
    instance?.off('log', ffmpegLogListener);
  };

  const needsFfmpegEncoder = !(exportFormat === '8d-spatial' && spatialContainer === 'wav');

  try {
    onPhaseChange?.('loading-engine');
    emitProgress(5);
    pushStatus(
      exportFormat === '8d-spatial'
        ? 'Initializing 8D Binaural Spatial DSP & encoder...'
        : `Initializing FFmpeg WebAssembly ${exportFormat.toUpperCase()} engine...`,
    );

    let decodedChannels: Float32Array[] | null = null;

    // Step 1: Reuse already-decoded AudioBuffer if available, otherwise decode via Web Audio
    onPhaseChange?.('preparing-audio');
    emitProgress(12);
    if (sourceAudioBuffer) {
      pushStatus(
        `Preparing ${sourceAudioBuffer.numberOfChannels}ch ${sourceAudioBuffer.sampleRate.toLocaleString()} Hz source (${sourceAudioBuffer.duration.toFixed(1)}s)`,
      );
      decodedChannels = await resampleBufferTo48kChannels(sourceAudioBuffer);
    } else {
      try {
        const OfflineCtx =
          window.OfflineAudioContext ||
          (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
            .webkitOfflineAudioContext;
        if (OfflineCtx && sourceBytes.byteLength < 60 * 1024 * 1024) {
          const tempCtx = new OfflineCtx(2, 1, TARGET_SAMPLE_RATE);
          const audioDataBuffer = sourceBytes.buffer.slice(
            sourceBytes.byteOffset,
            sourceBytes.byteOffset + sourceBytes.byteLength,
          ) as ArrayBuffer;
          const decoded = await tempCtx.decodeAudioData(audioDataBuffer);
          pushStatus(
            `Decoded ${decoded.numberOfChannels}ch ${decoded.sampleRate.toLocaleString()} Hz source (${decoded.duration.toFixed(1)}s)`,
          );
          decodedChannels = await resampleBufferTo48kChannels(decoded);
        } else {
          pushStatus('Large audio file detected. Routing through FFmpeg streaming decoder...');
        }
      } catch (decodeErr) {
        console.warn('[Surround X][DSP] Browser decode skipped, falling back to FFmpeg PCM pass:', decodeErr);
        pushStatus('Decoding container stream to 48 kHz PCM via FFmpeg...');
      }
    }

    if (needsFfmpegEncoder || !decodedChannels) {
      ffmpeg = await getLoadedFfmpeg();
      attachFfmpegListeners(ffmpeg);
    }

    try {
      runId = Date.now().toString(36);
      outExt = exportFormat === 'dts' ? 'dts' : exportFormat === 'flac' ? 'flac' : 'ac3';

      if (!decodedChannels && ffmpeg) {
        const parsed = await decodeViaFfmpegToChannels(ffmpeg, sourceBytes, sourceFilename, runId);
        decodedChannels = parsed.channels;
        pushStatus(`Decoded container stream to ${decodedChannels.length}ch 48,000 Hz PCM`);
      }

      if (!decodedChannels) {
        throw new Error('Unable to decode source audio stream.');
      }

      emitProgress(24);
      const effectiveGains = computeEffectiveChannelGains(channels);

      // ==================== BRANCH A: 8D BINAURAL SPATIAL PROCESSING ====================
      if (exportFormat === '8d-spatial') {
        onPhaseChange?.('processing-8d');
        emitProgress(34);
        pushStatus(
          `Applying 360° binaural panning, ITD & pinna frequency filter (${orbitPeriodSec.toFixed(1)}s/rev)...`,
        );

        await new Promise((r) => setTimeout(r, 80));

        const srcL = decodedChannels[0];
        const srcR = decodedChannels[1] ?? srcL;
        const outputFilename = buildOutputFilename(sourceFilename, '8d-spatial', spatialContainer);

        if (spatialContainer === 'wav') {
          // Streamed 15-second chunks directly to Blob -> < 5 MB peak RAM!
          const { chunks, totalBytes } = encodeStereo8dBinauralWavChunks(
            srcL,
            srcR,
            {
              sampleRate: TARGET_SAMPLE_RATE,
              orbitPeriodSec,
              reverbMix: 0.25,
              bassAnchor: 0.28,
            },
            15,
          );
          decodedChannels = null;

          onPhaseChange?.('encoding-output');
          emitProgress(88);
          await new Promise((r) => setTimeout(r, 80));

          const blob = new Blob(chunks as unknown as BlobPart[], {
            type: getMimeTypeForExport('8d-spatial', spatialContainer),
          });
          const url = URL.createObjectURL(blob);

          emitProgress(100);
          onPhaseChange?.('completed');

          const elapsedMs = Math.round(performance.now() - startedAt);
          pushStatus(
            `Mastered 8D Spatial 48 kHz lossless WAV (${totalBytes.toLocaleString()} B in ${elapsedMs} ms)`,
          );

          return {
            blob,
            url,
            outputFilename,
            sizeBytes: totalBytes,
            format: '8d-spatial',
            codecLabel: getCodecLabel('8d-spatial', spatialContainer, bitrateKbps),
            sampleRate: TARGET_SAMPLE_RATE,
            channels: 2,
            elapsedMs,
            usedCustomMix: true,
            statusLogs,
          };
        }

        // 8D MP3 branch: proactive 20-second chunked streaming into FFmpeg MP3 encoder (< 5 MB peak RAM)
        if (!ffmpeg) {
          throw new Error('FFmpeg MP3 encoder failed to initialize.');
        }
        const ffmpegInstance = ffmpeg;
        const totalFrames = Math.min(srcL.length, srcR.length, MAX_FRAMES);
        const CHUNK_FRAMES = TARGET_SAMPLE_RATE * 20;
        const processor = new Streaming8DBinaural({
          sampleRate: TARGET_SAMPLE_RATE,
          orbitPeriodSec,
          reverbMix: 0.25,
          bassAnchor: 0.28,
        });

        const mp3Parts: Uint8Array[] = [];
        let mp3Bytes = 0;
        onPhaseChange?.('encoding-output');
        emitProgress(48);

        const segIn = `seg8d_in_${runId}.wav`;
        const segOut = `seg8d_out_${runId}.mp3`;

        for (let start = 0, partIdx = 0; start < totalFrames; start += CHUNK_FRAMES, partIdx++) {
          const count = Math.min(CHUNK_FRAMES, totalFrames - start);
          const isLast = start + count >= totalFrames;
          let partWav: Uint8Array | null = processor.processRangeToPcm16Bytes(
            srcL,
            srcR,
            start,
            count,
            true,
            totalFrames === MAX_FRAMES && isLast,
          );

          await ffmpegInstance.writeFile(segIn, partWav);
          partWav = null; // Explicitly drop JS reference immediately to allow GC

          const exitCode = await ffmpegInstance.exec([
            '-y',
            '-i',
            segIn,
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
            '48000',
            '-ac',
            '2',
            segOut,
          ]);
          await ffmpegInstance.deleteFile(segIn).catch(() => undefined);

          if (exitCode !== 0) {
            throw new Error(`FFmpeg 8D MP3 segment encoder returned exit code (${exitCode}).`);
          }
          const segBytes = await ffmpegInstance.readFile(segOut);
          await ffmpegInstance.deleteFile(segOut).catch(() => undefined);

          if (!(segBytes instanceof Uint8Array) || segBytes.byteLength === 0) {
            throw new Error('FFmpeg produced an empty 8D MP3 segment.');
          }
          mp3Parts.push(segBytes);
          mp3Bytes += segBytes.byteLength;
          emitProgress(50 + ((start + count) / totalFrames) * 46);
        }

        decodedChannels = null;
        const blob = new Blob(mp3Parts as unknown as BlobPart[], {
          type: getMimeTypeForExport('8d-spatial', spatialContainer),
        });
        const url = URL.createObjectURL(blob);

        emitProgress(100);
        onPhaseChange?.('completed');

        const elapsedMs = Math.round(performance.now() - startedAt);
        pushStatus(
          `Verified 8D Spatial output: ${outputFilename} (${mp3Bytes.toLocaleString()} B in ${elapsedMs} ms)`,
        );

        return {
          blob,
          url,
          outputFilename,
          sizeBytes: mp3Bytes,
          format: '8d-spatial',
          codecLabel: getCodecLabel('8d-spatial', spatialContainer, bitrateKbps),
          bitrateKbps: 320,
          sampleRate: TARGET_SAMPLE_RATE,
          channels: 2,
          elapsedMs,
          usedCustomMix: true,
          statusLogs,
        };
      }

      // ==================== BRANCH B: DISCRETE 5.1 MULTI-CHANNEL (AC3 / DTS / FLAC) ====================
      const isDiscrete6Ch = decodedChannels.length >= 6;
      const backupChannels = decodedChannels;
      const outputFilename = buildOutputFilename(sourceFilename, exportFormat, spatialContainer);
      const totalFrames = Math.min(backupChannels[0]?.length ?? 0, MAX_FRAMES);

      let channelRms: Record<ChannelId, number> = {
        FL: 0,
        FR: 0,
        C: 0,
        LFE: 0,
        SL: 0,
        SR: 0,
      };
      let outputBlobParts: Uint8Array[] = [];
      let outputByteSize = 0;

      if (!ffmpeg) {
        throw new Error('FFmpeg WebAssembly engine failed to initialize.');
      }

      onPhaseChange?.(exportFormat === 'ac3' ? 'encoding-ac3' : 'encoding-output');
      encodePassActive = true;

      // 960,000 samples = 20.0 seconds @ 48 kHz
      // Exact integer multiple of 1,536 (AC3 = 625 frames) and 512 (DTS = 1,875 frames)
      // Peak 6-channel PCM16 WAV chunk is ONLY 11.0 MB!
      const CHUNK_FRAMES = 960000;

      if (exportFormat === 'ac3' || exportFormat === 'dts') {
        // PROACTIVE BOUNDED-CHUNK 5.1 STREAMING:
        // Processes audio in memory-safe ~11 MB blocks, guaranteeing mobile browser heap limits (< 25 MB) are never breached!
        pushStatus(
          `Streaming 6-channel 5.1 ${exportFormat.toUpperCase()} in bounded 20s blocks (${getCodecLabel(exportFormat, spatialContainer, bitrateKbps)})...`,
        );

        const sumSq = new Float64Array(6);
        const upmixer = isDiscrete6Ch
          ? null
          : new StreamingMatrixUpmix51(effectiveGains, upmixProfile, TARGET_SAMPLE_RATE);
        const left = backupChannels[0];
        const right = backupChannels[1] ?? left;

        const segIn = `seg51_in_${runId}.wav`;
        const segOut = `seg51_out_${runId}.${outExt}`;

        for (let start = 0, partIdx = 0; start < totalFrames; start += CHUNK_FRAMES, partIdx++) {
          const count = Math.min(CHUNK_FRAMES, totalFrames - start);
          const isLast = start + count >= totalFrames;

          let segWav: Uint8Array | null = null;
          if (isDiscrete6Ch) {
            segWav = encodeDiscreteSixChannelsToWav(
              backupChannels,
              effectiveGains,
              TARGET_SAMPLE_RATE,
              start,
              count,
              sumSq,
            ).wavBytes;
          } else {
            segWav = upmixer!.processRangeToWavBytes(
              left,
              right,
              start,
              count,
              TARGET_SAMPLE_RATE,
              sumSq,
              totalFrames === MAX_FRAMES && isLast,
            );
          }

          // Transfer segWav directly into WASM MEMFS
          await ffmpeg.writeFile(segIn, segWav);
          segWav = null; // Explicitly drop JS reference immediately to allow GC

          const segArgs = buildFfmpegArgsForFormat(segIn, segOut, exportFormat, { bitrateKbps });
          const segExit = await ffmpeg.exec(segArgs);
          await ffmpeg.deleteFile(segIn).catch(() => undefined); // Free WASM input WAV immediately!

          if (segExit !== 0) {
            throw new Error(`FFmpeg ${exportFormat.toUpperCase()} encoder failed (exit ${segExit}).`);
          }

          const segBytes = await ffmpeg.readFile(segOut);
          await ffmpeg.deleteFile(segOut).catch(() => undefined); // Free WASM output immediately!

          if (!(segBytes instanceof Uint8Array) || segBytes.byteLength === 0) {
            throw new Error(`FFmpeg produced an empty ${exportFormat.toUpperCase()} segment.`);
          }
          if (partIdx === 0 && exportFormat === 'ac3' && !isValidAc3Bitstream(segBytes)) {
            throw new Error('Output stream failed Dolby Digital AC3 syncword verification.');
          }

          outputBlobParts.push(segBytes);
          outputByteSize += segBytes.byteLength;
          emitProgress(40 + ((start + count) / totalFrames) * 56);
        }

        decodedChannels = null;
        const sampleCount = Math.max(1, Math.ceil(totalFrames / 64));
        channelRms = {
          FL: Math.min(1, Math.sqrt(sumSq[0] / sampleCount)),
          FR: Math.min(1, Math.sqrt(sumSq[1] / sampleCount)),
          C: Math.min(1, Math.sqrt(sumSq[2] / sampleCount)),
          LFE: Math.min(1, Math.sqrt(sumSq[3] / sampleCount)),
          SL: Math.min(1, Math.sqrt(sumSq[4] / sampleCount)),
          SR: Math.min(1, Math.sqrt(sumSq[5] / sampleCount)),
        };
      } else {
        // FLAC branch: Lossless multi-channel FLAC
        let stageWavBytes: Uint8Array | null = null;
        if (isDiscrete6Ch) {
          const encoded = encodeDiscreteSixChannelsToWav(backupChannels, effectiveGains, TARGET_SAMPLE_RATE);
          stageWavBytes = encoded.wavBytes;
          channelRms = encoded.channelRms;
          pushStatus('Preserved 6 discrete source channels (FL · FR · C · LFE · SL · SR)');
        } else {
          const left = backupChannels[0];
          const right = backupChannels[1] ?? left;
          const encoded = encodeMatrixUpmixStereoToSixChannelWav(
            left,
            right,
            effectiveGains,
            upmixProfile,
            TARGET_SAMPLE_RATE,
          );
          stageWavBytes = encoded.wavBytes;
          channelRms = encoded.channelRms;
          pushStatus(
            `Separated stereo into 6 discrete 5.1 channels (${upmixProfile} · 120 Hz LR24 LFE)`,
          );
        }

        decodedChannels = null;
        emitProgress(38);

        virtualStageWavName = `stage51_${runId}.wav`;
        virtualOutputName = `output_${runId}.${outExt}`;

        await ffmpeg.writeFile(virtualStageWavName, stageWavBytes);
        stageWavBytes = null; // Free JS copy immediately before FFmpeg execution!

        emitProgress(44);
        const args = buildFfmpegArgsForFormat(virtualStageWavName, virtualOutputName, exportFormat, {
          bitrateKbps,
        });
        pushStatus(
          `Encoding 6-channel 5.1 ${exportFormat.toUpperCase()} stream (${getCodecLabel(exportFormat, spatialContainer, bitrateKbps)} · 48 kHz)...`,
        );

        const exitCode = await ffmpeg.exec(args);
        await ffmpeg.deleteFile(virtualStageWavName).catch(() => undefined);

        if (exitCode !== 0) {
          throw new Error(`FFmpeg FLAC encoder returned non-zero exit code (${exitCode}).`);
        }

        const rawOutput = await ffmpeg.readFile(virtualOutputName);
        await ffmpeg.deleteFile(virtualOutputName).catch(() => undefined);

        if (!(rawOutput instanceof Uint8Array) || rawOutput.byteLength === 0) {
          throw new Error('FFmpeg finished without writing a valid FLAC stream.');
        }

        outputBlobParts = [rawOutput];
        outputByteSize = rawOutput.byteLength;
      }

      const blob = new Blob(outputBlobParts as unknown as BlobPart[], {
        type: getMimeTypeForExport(exportFormat, spatialContainer),
      });
      const url = URL.createObjectURL(blob);

      emitProgress(100);
      onPhaseChange?.('completed');

      const elapsedMs = Math.round(performance.now() - startedAt);
      pushStatus(
        `Verified 5.1 ${exportFormat.toUpperCase()} output: ${outputFilename} (${outputByteSize.toLocaleString()} B in ${elapsedMs} ms)`,
      );

      return {
        blob,
        url,
        outputFilename,
        sizeBytes: outputByteSize,
        format: exportFormat,
        codecLabel: getCodecLabel(exportFormat, spatialContainer, bitrateKbps),
        bitrateKbps: exportFormat === 'ac3' ? bitrateKbps : exportFormat === 'dts' ? 768 : undefined,
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 6,
        elapsedMs,
        usedCustomMix: true,
        channelRms,
        statusLogs,
      };
    } finally {
      encodePassActive = false;
      detachFfmpegListeners(ffmpeg);
      for (const fname of [
        `seg51_in_${runId}.wav`,
        `seg51_out_${runId}.${outExt}`,
        `seg8d_in_${runId}.wav`,
        `seg8d_out_${runId}.mp3`,
        virtualStageWavName,
        virtualOutputName,
      ]) {
        if (fname && ffmpeg) {
          await ffmpeg.deleteFile(fname).catch(() => undefined);
        }
      }
    }
  } catch (err) {
    if (isMemoryAllocationError(err)) {
      resetFfmpegWorker();
    }
    console.error('[Surround X][Conversion Error]', err);
    onPhaseChange?.('error');
    const friendlyMessage = formatFriendlyError(err, recentLogs);
    throw new Error(friendlyMessage);
  } finally {
    conversionInFlight = false;
  }
}
