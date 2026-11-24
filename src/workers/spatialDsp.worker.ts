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
}

interface WorkerProcessFloatPayload {
  leftBuffer: ArrayBuffer;
  rightBuffer: ArrayBuffer;
  applyEndFade: boolean;
  emitRawStereoPcm?: boolean;
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

function resetState() {
  sessionUpmix = null;
  session8d = null;
  sumSq = new Float64Array(6);
  totalProcessedFrames = 0;
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
      const { leftBuffer, rightBuffer, applyEndFade, emitRawStereoPcm } = event.data.payload;
      const left = new Float32Array(leftBuffer);
      const right = new Float32Array(rightBuffer);
      const frameCount = Math.min(left.length, right.length);

      if (frameCount === 0) {
        const empty = new Uint8Array(0);
        workerScope.postMessage({ id, ok: true, result: { outBuffer: empty.buffer, byteLength: 0 } }, [
          empty.buffer,
        ]);
        return;
      }

      totalProcessedFrames += frameCount;

      if (sessionMode === '8d') {
        if (!session8d) {
          throw new Error('8D binaural processor not initialized in DSP worker.');
        }
        const outBytes = session8d.processRangeToPcm16Bytes(
          left,
          right,
          0,
          frameCount,
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
        frameCount,
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
      const { wavBuffer, applyEndFade, emitRawStereoPcm } = event.data.payload;
      const decoded = decodePcmWavToChannels(new Uint8Array(wavBuffer));
      const frameCount = decoded.channels[0]?.length ?? 0;

      if (frameCount === 0) {
        const empty = new Uint8Array(0);
        workerScope.postMessage({ id, ok: true, result: { outBuffer: empty.buffer, byteLength: 0 } }, [
          empty.buffer,
        ]);
        return;
      }

      totalProcessedFrames += frameCount;

      if (sessionMode === '8d') {
        if (!session8d) {
          throw new Error('8D binaural processor not initialized in DSP worker.');
        }
        const left = decoded.channels[0];
        const right = decoded.channels[1] ?? left;
        const outBytes = session8d.processRangeToPcm16Bytes(
          left,
          right,
          0,
          frameCount,
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

      let wavOut: Uint8Array;
      if (sessionDiscrete6Ch) {
        wavOut = encodeDiscreteSixChannelsToWav(
          decoded.channels,
          sessionGains,
          sessionSampleRate,
          0,
          frameCount,
          sumSq,
        ).wavBytes;
      } else {
        if (!sessionUpmix) {
          throw new Error('5.1 matrix processor not initialized in DSP worker.');
        }
        const left = decoded.channels[0];
        const right = decoded.channels[1] ?? left;
        wavOut = sessionUpmix.processRangeToWavBytes(
          left,
          right,
          0,
          frameCount,
          sessionSampleRate,
          sumSq,
          applyEndFade,
        );
      }

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
