import type { ChannelId, UpmixProfile } from '../utils/audioTypes';
import {
  decodePcmWavToChannels,
  encodeDiscreteSixChannelsToWav,
  Streaming8DBinaural,
  StreamingMatrixUpmix51,
} from '../utils/channelMath';

interface WorkerInitPayload {
  mode: '5.1' | '8d';
  isDiscrete6Ch: boolean;
  effectiveGains: Record<ChannelId, number>;
  upmixProfile: UpmixProfile;
  sampleRate: number;
  orbitPeriodSec: number;
}

interface WorkerProcessPayload {
  wavBuffer: ArrayBuffer;
  applyEndFade: boolean;
  emitRawStereoPcm?: boolean;
  isLastChunk?: boolean;
}

interface WorkerProcessFloatPayload {
  leftBuffer: ArrayBuffer;
  rightBuffer: ArrayBuffer;
  applyEndFade: boolean;
  emitRawStereoPcm?: boolean;
  isLastChunk?: boolean;
}

type WorkerRequest =
  | { id: number; type: 'init'; payload: WorkerInitPayload }
  | { id: number; type: 'processChunk'; payload: WorkerProcessPayload }
  | { id: number; type: 'processFloatChunk'; payload: WorkerProcessFloatPayload }
  | { id: number; type: 'finish' };

let sessionMode: '5.1' | '8d' = '5.1';
let sessionDiscrete6Ch = false;
let sessionSampleRate = 48000;
let sessionGains: Record<ChannelId, number> = {
  FL: 1,
  FR: 1,
  C: 1,
  LFE: 1,
  SL: 1,
  SR: 1,
};
let sessionUpmix: StreamingMatrixUpmix51 | null = null;
let session8d: Streaming8DBinaural | null = null;
let sumSq = new Float64Array(6);
let totalProcessedFrames = 0;
let carryLeft: Float32Array | null = null;
let carryRight: Float32Array | null = null;
let carryDiscrete: Float32Array[] | null = null;

function concatFloat32(prev: Float32Array | null, next: Float32Array): Float32Array {
  if (!prev || prev.length === 0) return next;
  if (next.length === 0) return prev;
  const merged = new Float32Array(prev.length + next.length);
  merged.set(prev, 0);
  merged.set(next, prev.length);
  return merged;
}

function resetState() {
  sessionUpmix = null;
  session8d = null;
  sumSq = new Float64Array(6);
  totalProcessedFrames = 0;
  carryLeft = null;
  carryRight = null;
  carryDiscrete = null;
}

const workerScope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, type } = event.data;
  try {
    if (type === 'init') {
      resetState();
      const p = event.data.payload;
      sessionMode = p.mode;
      sessionDiscrete6Ch = p.isDiscrete6Ch;
      sessionSampleRate = p.sampleRate;
      sessionGains = p.effectiveGains;

      if (p.mode === '8d') {
        session8d = new Streaming8DBinaural({
          sampleRate: p.sampleRate,
          orbitPeriodSec: p.orbitPeriodSec,
          reverbMix: 0.25,
          bassAnchor: 0.28,
        });
      } else if (!p.isDiscrete6Ch) {
        sessionUpmix = new StreamingMatrixUpmix51(
          p.effectiveGains,
          p.upmixProfile,
          p.sampleRate,
        );
      }

      self.postMessage({ id, ok: true });
      return;
    }

    if (type === 'processFloatChunk') {
      const {
        leftBuffer,
        rightBuffer,
        applyEndFade,
        emitRawStereoPcm,
        isLastChunk = true,
      } = event.data.payload;
      const left = concatFloat32(carryLeft, new Float32Array(leftBuffer));
      const right = concatFloat32(carryRight, new Float32Array(rightBuffer));
      const totalFrames = Math.min(left.length, right.length);
      const frameAlign = sessionMode === '8d' && !emitRawStereoPcm ? 4608 : 1536;

      let emitFrames = totalFrames;
      if (!isLastChunk) {
        emitFrames = Math.floor(totalFrames / frameAlign) * frameAlign;
        if (emitFrames < totalFrames) {
          carryLeft = left.slice(emitFrames, totalFrames);
          carryRight = right.slice(emitFrames, totalFrames);
        } else {
          carryLeft = null;
          carryRight = null;
        }
      } else {
        carryLeft = null;
        carryRight = null;
      }

      if (emitFrames === 0) {
        const empty = new Uint8Array(0);
        workerScope.postMessage({ id, ok: true, result: { outBuffer: empty.buffer, byteLength: 0 } }, [
          empty.buffer,
        ]);
        return;
      }

      totalProcessedFrames += emitFrames;

      if (sessionMode === '8d') {
        if (!session8d) {
          throw new Error('8D binaural processor not initialized in DSP worker.');
        }
        const outBytes = session8d.processRangeToPcm16Bytes(
          left,
          right,
          0,
          emitFrames,
          !emitRawStereoPcm,
          applyEndFade,
        );
        const outBuf = outBytes.buffer as ArrayBuffer;
        workerScope.postMessage(
          { id, ok: true, result: { outBuffer: outBuf, byteLength: outBytes.byteLength } },
          [outBuf],
        );
        return;
      }

      if (!sessionUpmix) {
        throw new Error('5.1 matrix processor not initialized in DSP worker.');
      }
      const wavOut = sessionUpmix.processRangeToWavBytes(
        left,
        right,
        0,
        emitFrames,
        sessionSampleRate,
        sumSq,
        applyEndFade,
      );
      const outBuf = wavOut.buffer as ArrayBuffer;
      workerScope.postMessage(
        { id, ok: true, result: { outBuffer: outBuf, byteLength: wavOut.byteLength } },
        [outBuf],
      );
      return;
    }

    if (type === 'processChunk') {
      const { wavBuffer, applyEndFade, emitRawStereoPcm, isLastChunk = true } = event.data.payload;
      const decoded =
        wavBuffer.byteLength === 0
          ? { sampleRate: sessionSampleRate, channels: [] as Float32Array[] }
          : decodePcmWavToChannels(new Uint8Array(wavBuffer));
      const rawFrames = decoded.channels[0]?.length ?? 0;

      if (sessionMode !== '8d' && sessionDiscrete6Ch) {
        const mergedCh: Float32Array[] = [];
        let totalFrames = Number.POSITIVE_INFINITY;
        for (let ch = 0; ch < 6; ch++) {
          const prev = carryDiscrete?.[ch] ?? null;
          const cur = decoded.channels[ch] ?? new Float32Array(rawFrames);
          const m = concatFloat32(prev, cur);
          mergedCh.push(m);
          if (m.length < totalFrames) totalFrames = m.length;
        }
        if (!Number.isFinite(totalFrames)) totalFrames = 0;

        let emitFrames = totalFrames;
        if (!isLastChunk) {
          emitFrames = Math.floor(totalFrames / 1536) * 1536;
          if (emitFrames < totalFrames) {
            carryDiscrete = mergedCh.map((arr) => arr.slice(emitFrames, totalFrames));
          } else {
            carryDiscrete = null;
          }
        } else {
          carryDiscrete = null;
        }

        if (emitFrames === 0) {
          const empty = new Uint8Array(0);
          workerScope.postMessage({ id, ok: true, result: { outBuffer: empty.buffer, byteLength: 0 } }, [
            empty.buffer,
          ]);
          return;
        }

        totalProcessedFrames += emitFrames;
        const wavOut = encodeDiscreteSixChannelsToWav(
          mergedCh,
          sessionGains,
          sessionSampleRate,
          0,
          emitFrames,
          sumSq,
        ).wavBytes;
        const outBuf = wavOut.buffer as ArrayBuffer;
        workerScope.postMessage(
          { id, ok: true, result: { outBuffer: outBuf, byteLength: wavOut.byteLength } },
          [outBuf],
        );
        return;
      }

      const left = concatFloat32(carryLeft, decoded.channels[0] ?? new Float32Array(0));
      const right = concatFloat32(
        carryRight,
        decoded.channels[1] ?? decoded.channels[0] ?? new Float32Array(0),
      );
      const totalFrames = Math.min(left.length, right.length);
      const frameAlign = sessionMode === '8d' && !emitRawStereoPcm ? 4608 : 1536;

      let emitFrames = totalFrames;
      if (!isLastChunk) {
        emitFrames = Math.floor(totalFrames / frameAlign) * frameAlign;
        if (emitFrames < totalFrames) {
          carryLeft = left.slice(emitFrames, totalFrames);
          carryRight = right.slice(emitFrames, totalFrames);
        } else {
          carryLeft = null;
          carryRight = null;
        }
      } else {
        carryLeft = null;
        carryRight = null;
      }

      if (emitFrames === 0) {
        const empty = new Uint8Array(0);
        workerScope.postMessage({ id, ok: true, result: { outBuffer: empty.buffer, byteLength: 0 } }, [
          empty.buffer,
        ]);
        return;
      }

      totalProcessedFrames += emitFrames;

      if (sessionMode === '8d') {
        if (!session8d) {
          throw new Error('8D binaural processor not initialized in DSP worker.');
        }
        const outBytes = session8d.processRangeToPcm16Bytes(
          left,
          right,
          0,
          emitFrames,
          !emitRawStereoPcm,
          applyEndFade,
        );
        const outBuf = outBytes.buffer as ArrayBuffer;
        workerScope.postMessage(
          { id, ok: true, result: { outBuffer: outBuf, byteLength: outBytes.byteLength } },
          [outBuf],
        );
        return;
      }

      if (!sessionUpmix) {
        throw new Error('5.1 matrix processor not initialized in DSP worker.');
      }
      const wavOut = sessionUpmix.processRangeToWavBytes(
        left,
        right,
        0,
        emitFrames,
        sessionSampleRate,
        sumSq,
        applyEndFade,
      );

      const outBuf = wavOut.buffer as ArrayBuffer;
      workerScope.postMessage(
        { id, ok: true, result: { outBuffer: outBuf, byteLength: wavOut.byteLength } },
        [outBuf],
      );
      return;
    }

    if (type === 'finish') {
      const sampleCount = Math.max(1, Math.ceil(totalProcessedFrames / 64));
      const channelRms: Record<ChannelId, number> = {
        FL: Math.min(1, Math.sqrt(sumSq[0] / sampleCount)),
        FR: Math.min(1, Math.sqrt(sumSq[1] / sampleCount)),
        C: Math.min(1, Math.sqrt(sumSq[2] / sampleCount)),
        LFE: Math.min(1, Math.sqrt(sumSq[3] / sampleCount)),
        SL: Math.min(1, Math.sqrt(sumSq[4] / sampleCount)),
        SR: Math.min(1, Math.sqrt(sumSq[5] / sampleCount)),
      };
      resetState();
      self.postMessage({ id, ok: true, result: { channelRms } });
      return;
    }
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
