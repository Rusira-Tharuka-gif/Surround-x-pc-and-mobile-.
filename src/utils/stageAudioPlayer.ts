import type { ChannelConfig, ChannelId, ExportFormat, UpmixProfile } from './audioTypes';
import { parseAudioHeaderBytes } from './audioHeader';
import {
  computeBassBeatIntensity,
  computeEffectiveChannelGains,
  DISCRETE_51_CHANNEL_INDEX,
  get8dAzimuthDegrees,
  wrapAzimuth180,
  wrapAzimuth360,
} from './channelMath';
import { extractLogFrequencyBands, STUDIO_BAND_COUNT } from './waveMath';

export type ChannelLevels = Record<ChannelId, number> & {
  lfeBeat: number;
  orbitAngleDeg?: number;
  spectrum?: Float32Array;
};

export const ZERO_LEVELS: ChannelLevels = {
  FL: 0,
  FR: 0,
  C: 0,
  LFE: 0,
  SL: 0,
  SR: 0,
  lfeBeat: 0,
};

export interface LoadedTrackStreamInfo {
  durationSec: number;
  sampleRate: number;
  sourceChannels: number;
}

interface BusNodes {
  FL: GainNode;
  FR: GainNode;
  C: GainNode;
  LFE: GainNode;
  SL: GainNode;
  SR: GainNode;
}

export class StageAudioPlayer {
  private ctx: AudioContext | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private objectUrl: string | null = null;
  private loadNonce = 0;

  private trackDurationSec = 0;
  private trackSampleRate = 48000;
  private trackChannels = 2;
  private hasLoadedTrack = false;

  private busGains: BusNodes | null = null;
  private leftAnalyser: AnalyserNode | null = null;
  private rightAnalyser: AnalyserNode | null = null;
  private lowAnalyser: AnalyserNode | null = null;
  private centerAnalyser: AnalyserNode | null = null;
  private slAnalyser: AnalyserNode | null = null;
  private srAnalyser: AnalyserNode | null = null;
  private spectrumAnalyser: AnalyserNode | null = null;

  // Real-time Web Audio 8D Binaural rotation nodes
  private binauralPanNode: StereoPannerNode | null = null;
  private binauralPinnaFilter: BiquadFilterNode | null = null;
  private binauralDelayL: DelayNode | null = null;
  private binauralDelayR: DelayNode | null = null;

  // Active downstream graph tracking for seamless format switches & clean shutdown
  private activeMasterSum: GainNode | null = null;
  private activeCleanupNodes: AudioNode[] = [];
  private graphBuiltForFormat: ExportFormat | null = null;
  private graphBuiltForChannels = 0;

  private rafId: number | null = null;
  private isPlaying = false;
  private bassMovingAvg = 0;
  private bassBeatState = 0;

  // Reusable analyser buffers cleared to silence whenever playback stops or pauses
  private readonly bufL = new Uint8Array(new ArrayBuffer(512));
  private readonly bufR = new Uint8Array(new ArrayBuffer(512));
  private readonly bufCenter = new Uint8Array(new ArrayBuffer(512));
  private readonly bufSL = new Uint8Array(new ArrayBuffer(512));
  private readonly bufSR = new Uint8Array(new ArrayBuffer(512));
  private readonly bufLowTime = new Uint8Array(new ArrayBuffer(2048));
  private readonly bufLowFreq = new Uint8Array(new ArrayBuffer(1024));
  private readonly bufSpectrumFreq = new Uint8Array(new ArrayBuffer(1024));
  private readonly spectrumBands = new Float32Array(STUDIO_BAND_COUNT);

  private channels: ChannelConfig[] = [];
  private upmixProfile: UpmixProfile = 'cinema-pro';
  private exportFormat: ExportFormat = 'ac3';
  private orbitPeriodSec = 8.0;
  private orbitPhaseBase = 0;
  private orbitPhaseRefTime = 0;

  private onLevelsCallback?: (levels: ChannelLevels) => void;
  private onTimeCallback?: (currentSec: number, playing: boolean) => void;
  private onOrbitAngleCallback?: (angleDeg: number) => void;
  private onLoadStateCallback?: (loading: boolean, statusText?: string) => void;

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    return this.ctx;
  }

  private ensureMediaElement(): HTMLAudioElement {
    if (!this.audioEl) {
      const el = document.createElement('audio');
      el.preload = 'metadata';
      el.crossOrigin = 'anonymous';
      el.setAttribute('playsinline', '');
      el.addEventListener('ended', () => {
        if (this.audioEl === el) {
          this.isPlaying = false;
          this.cancelMeterLoop();
          this.clearAnalyserData();
          try {
            el.currentTime = 0;
          } catch {
            // Ignore seek reset errors
          }
          this.onTimeCallback?.(0, false);
        }
      });
      this.audioEl = el;
    }
    return this.audioEl;
  }

  private ensureMediaSource(ctx: AudioContext): MediaElementAudioSourceNode {
    const el = this.ensureMediaElement();
    if (!this.mediaSource) {
      this.mediaSource = ctx.createMediaElementSource(el);
    }
    return this.mediaSource;
  }

  private revokeCurrentUrl() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /**
   * Instantly attaches a File or Blob for streaming HTMLAudioElement playback with zero
   * full-file AudioContext.decodeAudioData buffering, reading only <= 64 KB for header specs.
   */
  async loadAudioFile(
    source: File | Blob,
    filenameHint = 'audio',
  ): Promise<LoadedTrackStreamInfo> {
    const nonce = ++this.loadNonce;
    this.stop();
    this.hasLoadedTrack = false;
    this.onLoadStateCallback?.(true, 'Initializing streaming audio pipeline...');

    // Read only the first 64 KB slice for container sample-rate/channel inspection
    let headerInfo = { sampleRate: 48000, sourceChannels: 2, durationSec: null as number | null };
    try {
      const sliceLen = Math.min(source.size, 65536);
      if (sliceLen > 0) {
        const headerBuf = await source.slice(0, sliceLen).arrayBuffer();
        if (nonce !== this.loadNonce) {
          throw new Error('Track load superseded');
        }
        headerInfo = parseAudioHeaderBytes(
          new Uint8Array(headerBuf),
          filenameHint,
          source.size,
        );
      }
    } catch (err) {
      if (nonce !== this.loadNonce) throw err;
      // Fallback safely to metadata element below
    }

    const el = this.ensureMediaElement();
    el.pause();
    this.revokeCurrentUrl();

    const nextUrl = URL.createObjectURL(source);
    this.objectUrl = nextUrl;

    const metaDuration = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('canplay', onCanPlay);
        el.removeEventListener('error', onErr);
        window.clearTimeout(timer);
      };

      const finishWithDuration = (dur: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(dur);
      };

      const onMeta = () => {
        if (Number.isFinite(el.duration) && el.duration > 0) {
          finishWithDuration(el.duration);
        }
      };

      const onCanPlay = () => {
        if (Number.isFinite(el.duration) && el.duration > 0) {
          finishWithDuration(el.duration);
        } else {
          finishWithDuration(headerInfo.durationSec ?? 0);
        }
      };

      const onErr = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (headerInfo.durationSec && headerInfo.durationSec > 0) {
          resolve(headerInfo.durationSec);
        } else {
          reject(new Error('Browser audio decoder could not stream this container.'));
        }
      };

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const dur =
          Number.isFinite(el.duration) && el.duration > 0
            ? el.duration
            : (headerInfo.durationSec ?? 0);
        resolve(dur);
      }, 6000);

      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('canplay', onCanPlay);
      el.addEventListener('error', onErr);

      el.src = nextUrl;
      el.load();
    });

    if (nonce !== this.loadNonce) {
      throw new Error('Track load superseded');
    }

    const resolvedDuration =
      Number.isFinite(metaDuration) && metaDuration > 0
        ? metaDuration
        : (headerInfo.durationSec ?? 0);

    this.trackDurationSec = resolvedDuration;
    this.trackSampleRate = headerInfo.sampleRate || 48000;
    this.trackChannels = Math.max(1, headerInfo.sourceChannels || 2);
    this.hasLoadedTrack = true;

    this.onLoadStateCallback?.(false);
    this.onTimeCallback?.(0, false);

    return {
      durationSec: this.trackDurationSec,
      sampleRate: this.trackSampleRate,
      sourceChannels: this.trackChannels,
    };
  }

  getTrackDurationSec(): number {
    return this.trackDurationSec;
  }

  private applyBusGains(ctx: AudioContext, busGains: BusNodes) {
    const gains = computeEffectiveChannelGains(this.channels);
    const centerScale =
      this.upmixProfile === 'direct-discrete' ? 0.55 : this.upmixProfile === 'ambient-hall' ? 0.42 : 0.48;
    const frontScale =
      this.upmixProfile === 'direct-discrete' ? 0.92 : this.upmixProfile === 'ambient-hall' ? 0.78 : 0.85;
    const surroundScale =
      this.upmixProfile === 'direct-discrete' ? 0.68 : this.upmixProfile === 'ambient-hall' ? 0.96 : 0.85;
    const lfeScale =
      this.upmixProfile === 'cinema-pro' ? 0.85 : this.upmixProfile === 'ambient-hall' ? 0.65 : 0.55;

    const now = ctx.currentTime;
    busGains.FL.gain.setTargetAtTime(gains.FL * frontScale, now, 0.02);
    busGains.FR.gain.setTargetAtTime(gains.FR * frontScale, now, 0.02);
    busGains.C.gain.setTargetAtTime(gains.C * centerScale, now, 0.02);
    busGains.LFE.gain.setTargetAtTime(gains.LFE * lfeScale, now, 0.02);
    busGains.SL.gain.setTargetAtTime(gains.SL * surroundScale, now, 0.02);
    busGains.SR.gain.setTargetAtTime(gains.SR * surroundScale, now, 0.02);
  }

  updateMixConfig(
    channels: ChannelConfig[],
    upmixProfile: UpmixProfile,
    exportFormat: ExportFormat = this.exportFormat,
    orbitPeriodSec: number = this.orbitPeriodSec,
  ) {
    const formatChanged = this.exportFormat !== exportFormat;
    const nextPeriod = Math.max(2.0, orbitPeriodSec);
    if (this.isPlaying && this.ctx && nextPeriod !== this.orbitPeriodSec) {
      const now = this.ctx.currentTime;
      this.orbitPhaseBase =
        (((this.orbitPhaseBase + Math.max(0, now - this.orbitPhaseRefTime) / this.orbitPeriodSec) % 1) + 1) % 1;
      this.orbitPhaseRefTime = now;
    }
    this.channels = channels;
    this.upmixProfile = upmixProfile;
    this.exportFormat = exportFormat;
    this.orbitPeriodSec = nextPeriod;

    if (this.busGains && this.ctx) {
      this.applyBusGains(this.ctx, this.busGains);
    }

    // Seamlessly rebuild downstream spatial graph if toggling 5.1 <-> 8D mid-stream without interrupting audioEl
    if (formatChanged && this.ctx && this.mediaSource && this.activeMasterSum) {
      this.rebuildSpatialGraph(this.ctx);
    }
  }

  setCallbacks(
    onLevels: (levels: ChannelLevels) => void,
    onTime: (currentSec: number, playing: boolean) => void,
    onOrbitAngle?: (angleDeg: number) => void,
    onLoadState?: (loading: boolean, statusText?: string) => void,
  ) {
    this.onLevelsCallback = onLevels;
    this.onTimeCallback = onTime;
    this.onOrbitAngleCallback = onOrbitAngle;
    this.onLoadStateCallback = onLoadState;
  }

  async togglePlay(): Promise<boolean> {
    if (!this.hasLoadedTrack) return false;
    if (this.isPlaying) {
      this.pause();
      return false;
    }
    await this.play();
    return true;
  }

  async seek(targetSec: number) {
    if (!this.hasLoadedTrack || !this.audioEl) return;
    const maxDur =
      Number.isFinite(this.audioEl.duration) && this.audioEl.duration > 0
        ? this.audioEl.duration
        : this.trackDurationSec;
    const clamped = Math.max(0, maxDur > 0 ? Math.min(maxDur, targetSec) : targetSec);
    try {
      this.audioEl.currentTime = clamped;
    } catch {
      // Ignore seek before metadata settles
    }
    if (!this.isPlaying) {
      this.clearAnalyserData();
    } else if (this.ctx) {
      this.orbitPhaseBase = (((clamped / this.orbitPeriodSec) % 1) + 1) % 1;
      this.orbitPhaseRefTime = this.ctx.currentTime;
    }
    this.onTimeCallback?.(clamped, this.isPlaying);
  }

  private tearDownSpatialGraph() {
    if (this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch {
        // Ignore if not connected
      }
    }
    if (this.activeMasterSum) {
      try {
        this.activeMasterSum.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.activeMasterSum = null;
    }
    for (const node of this.activeCleanupNodes) {
      try {
        node.disconnect();
      } catch {
        // Ignore already disconnected node
      }
    }
    this.activeCleanupNodes = [];
    this.busGains = null;
    this.leftAnalyser = null;
    this.rightAnalyser = null;
    this.lowAnalyser = null;
    this.centerAnalyser = null;
    this.slAnalyser = null;
    this.srAnalyser = null;
    this.spectrumAnalyser = null;
    this.binauralPanNode = null;
    this.binauralPinnaFilter = null;
    this.binauralDelayL = null;
    this.binauralDelayR = null;
    this.graphBuiltForFormat = null;
    this.graphBuiltForChannels = 0;
  }

  private rebuildSpatialGraph(ctx: AudioContext) {
    this.tearDownSpatialGraph();

    const sourceNode = this.ensureMediaSource(ctx);
    const chCount = Math.max(2, this.trackChannels);
    const splitter = ctx.createChannelSplitter(chCount);
    try {
      splitter.channelCount = chCount;
      splitter.channelCountMode = 'explicit';
      splitter.channelInterpretation = 'discrete';
    } catch {
      // Safe fallback on mobile browsers
    }

    // Inline per-channel AnalyserNodes wired directly in the live stream path
    const leftAnalyser = ctx.createAnalyser();
    const rightAnalyser = ctx.createAnalyser();
    const lowAnalyser = ctx.createAnalyser();
    const centerAnalyser = ctx.createAnalyser();
    const slAnalyser = ctx.createAnalyser();
    const srAnalyser = ctx.createAnalyser();

    leftAnalyser.fftSize = 512;
    rightAnalyser.fftSize = 512;
    centerAnalyser.fftSize = 512;
    slAnalyser.fftSize = 512;
    srAnalyser.fftSize = 512;

    lowAnalyser.fftSize = 2048;
    lowAnalyser.minDecibels = -80;
    lowAnalyser.maxDecibels = -2;

    leftAnalyser.smoothingTimeConstant = 0.58;
    rightAnalyser.smoothingTimeConstant = 0.58;
    centerAnalyser.smoothingTimeConstant = 0.6;
    slAnalyser.smoothingTimeConstant = 0.62;
    srAnalyser.smoothingTimeConstant = 0.62;
    lowAnalyser.smoothingTimeConstant = 0.36;

    // Sub-bass LFE crossover: 4th-order 110 Hz Linkwitz-Riley LPF
    const lfeFilter1 = ctx.createBiquadFilter();
    lfeFilter1.type = 'lowpass';
    lfeFilter1.frequency.value = 110;
    lfeFilter1.Q.value = Math.SQRT1_2;

    const lfeFilter2 = ctx.createBiquadFilter();
    lfeFilter2.type = 'lowpass';
    lfeFilter2.frequency.value = 110;
    lfeFilter2.Q.value = Math.SQRT1_2;

    const monoSum = ctx.createGain();
    monoSum.gain.value = 0.5;

    const slDelay = ctx.createDelay(0.15);
    slDelay.delayTime.value = 0.014;
    const srDelay = ctx.createDelay(0.15);
    srDelay.delayTime.value = 0.022;

    const slHp = ctx.createBiquadFilter();
    slHp.type = 'highpass';
    slHp.frequency.value = 110;
    const slLp = ctx.createBiquadFilter();
    slLp.type = 'lowpass';
    slLp.frequency.value = 13500;

    const srHp = ctx.createBiquadFilter();
    srHp.type = 'highpass';
    srHp.frequency.value = 110;
    const srLp = ctx.createBiquadFilter();
    srLp.type = 'lowpass';
    srLp.frequency.value = 13500;

    const busGains: BusNodes = {
      FL: ctx.createGain(),
      FR: ctx.createGain(),
      C: ctx.createGain(),
      LFE: ctx.createGain(),
      SL: ctx.createGain(),
      SR: ctx.createGain(),
    };
    this.applyBusGains(ctx, busGains);

    const panFL = ctx.createStereoPanner();
    panFL.pan.value = -0.85;
    const panFR = ctx.createStereoPanner();
    panFR.pan.value = 0.85;
    const panC = ctx.createStereoPanner();
    panC.pan.value = 0;
    const panLFE = ctx.createStereoPanner();
    panLFE.pan.value = 0;
    const panSL = ctx.createStereoPanner();
    panSL.pan.value = -0.95;
    const panSR = ctx.createStereoPanner();
    panSR.pan.value = 0.95;

    const maxDestCh = ctx.destination.maxChannelCount || 2;
    const useDiscreteSixOut = maxDestCh >= 6;
    try {
      if (useDiscreteSixOut) {
        ctx.destination.channelCount = 6;
        ctx.destination.channelCountMode = 'explicit';
        ctx.destination.channelInterpretation = 'discrete';
      } else {
        ctx.destination.channelCount = Math.max(1, Math.min(2, maxDestCh));
        ctx.destination.channelCountMode = 'explicit';
        ctx.destination.channelInterpretation = 'speakers';
      }
    } catch {
      // Safe fallback on mobile browsers
    }

    const masterSum = ctx.createGain();
    try {
      masterSum.channelCount = useDiscreteSixOut ? 6 : 2;
      masterSum.channelCountMode = 'explicit';
      masterSum.channelInterpretation = useDiscreteSixOut ? 'discrete' : 'speakers';
    } catch {
      // Safe fallback
    }
    const nowStart = ctx.currentTime;
    masterSum.gain.setValueAtTime(0.0001, nowStart);
    masterSum.gain.linearRampToValueAtTime(0.85, nowStart + 0.02);

    let outputLimiter: AudioNode;
    if (useDiscreteSixOut) {
      // Per-channel soft peak limiter preserving discrete 6-channel topology (DynamicsCompressorNode clamps to 2ch)
      const curveLen = 1025;
      const limiterCurve = new Float32Array(curveLen);
      for (let i = 0; i < curveLen; i++) {
        const x = (i / (curveLen - 1)) * 2 - 1;
        limiterCurve[i] = Math.abs(x) <= 0.88 ? x : Math.tanh(x / 0.95) * 0.95;
      }
      const shaper = ctx.createWaveShaper();
      shaper.curve = limiterCurve;
      shaper.oversample = 'none';
      try {
        shaper.channelCount = 6;
        shaper.channelCountMode = 'explicit';
        shaper.channelInterpretation = 'discrete';
      } catch {
        // Safe fallback
      }
      masterSum.connect(shaper);
      shaper.connect(ctx.destination);
      outputLimiter = shaper;
    } else {
      const safetyLimiter = ctx.createDynamicsCompressor();
      safetyLimiter.threshold.setValueAtTime(-1.5, nowStart);
      safetyLimiter.knee.setValueAtTime(6, nowStart);
      safetyLimiter.ratio.setValueAtTime(12, nowStart);
      safetyLimiter.attack.setValueAtTime(0.002, nowStart);
      safetyLimiter.release.setValueAtTime(0.08, nowStart);
      masterSum.connect(safetyLimiter);
      safetyLimiter.connect(ctx.destination);
      outputLimiter = safetyLimiter;
    }

    // Full-band logarithmic visualizer tap connected directly to live media stream
    const spectrumAnalyser = ctx.createAnalyser();
    spectrumAnalyser.fftSize = 2048;
    spectrumAnalyser.minDecibels = -84;
    spectrumAnalyser.maxDecibels = -6;
    spectrumAnalyser.smoothingTimeConstant = 0.48; // Snappy real-time transient, bass drop, and beat response

    sourceNode.connect(splitter);
    sourceNode.connect(spectrumAnalyser);
    const leftIdx = 0;
    const rightIdx = this.trackChannels > 1 ? 1 : 0;

    const cleanupNodes: AudioNode[] = [
      splitter,
      spectrumAnalyser,
      masterSum,
      outputLimiter,
      monoSum,
      lfeFilter1,
      lfeFilter2,
      slDelay,
      srDelay,
      slHp,
      slLp,
      srHp,
      srLp,
      leftAnalyser,
      rightAnalyser,
      lowAnalyser,
      centerAnalyser,
      slAnalyser,
      srAnalyser,
      busGains.FL,
      busGains.FR,
      busGains.C,
      busGains.LFE,
      busGains.SL,
      busGains.SR,
    ];

    const routeBusOutputs = () => {
      if (useDiscreteSixOut) {
        const sixMerger = ctx.createChannelMerger(6);
        try {
          sixMerger.channelCount = 6;
          sixMerger.channelCountMode = 'explicit';
          sixMerger.channelInterpretation = 'discrete';
        } catch {
          // Safe fallback
        }
        busGains.FL.connect(sixMerger, 0, 0);
        busGains.FR.connect(sixMerger, 0, 1);
        busGains.C.connect(sixMerger, 0, 2);
        busGains.LFE.connect(sixMerger, 0, 3);
        busGains.SL.connect(sixMerger, 0, 4);
        busGains.SR.connect(sixMerger, 0, 5);
        sixMerger.connect(masterSum);
        cleanupNodes.push(sixMerger);
      } else {
        const stereoMerger = ctx.createChannelMerger(2);
        try {
          stereoMerger.channelCount = 2;
          stereoMerger.channelCountMode = 'explicit';
        } catch {
          // Safe fallback
        }
        const splitPan = (p: StereoPannerNode) => {
          const sp = ctx.createChannelSplitter(2);
          p.connect(sp);
          sp.connect(stereoMerger, 0, 0);
          sp.connect(stereoMerger, 1, 1);
          cleanupNodes.push(p, sp);
        };
        busGains.FL.connect(panFL);
        busGains.FR.connect(panFR);
        busGains.C.connect(panC);
        busGains.LFE.connect(panLFE);
        busGains.SL.connect(panSL);
        busGains.SR.connect(panSR);
        splitPan(panFL);
        splitPan(panFR);
        splitPan(panC);
        splitPan(panLFE);
        splitPan(panSL);
        splitPan(panSR);
        stereoMerger.connect(masterSum);
        cleanupNodes.push(stereoMerger);
      }
    };

    if (this.exportFormat === '8d-spatial') {
      const orbitSum = ctx.createGain();
      orbitSum.gain.value = 0.72;

      const pinnaFilter = ctx.createBiquadFilter();
      pinnaFilter.type = 'lowpass';
      pinnaFilter.frequency.value = 12000;
      pinnaFilter.Q.value = 0.7;

      const stereoPanner = ctx.createStereoPanner();
      stereoPanner.pan.value = 0;

      const binauralSplit = ctx.createChannelSplitter(2);
      const binauralMerge = ctx.createChannelMerger(2);
      const itdL = ctx.createDelay(0.02);
      itdL.delayTime.value = 0.001;
      const itdR = ctx.createDelay(0.02);
      itdR.delayTime.value = 0.001;

      const hallDelayL = ctx.createDelay(0.1);
      hallDelayL.delayTime.value = 0.023;
      const hallDelayR = ctx.createDelay(0.1);
      hallDelayR.delayTime.value = 0.037;
      const hallDamp = ctx.createBiquadFilter();
      hallDamp.type = 'lowpass';
      hallDamp.frequency.value = 4200;
      const hallGain = ctx.createGain();
      hallGain.gain.value = 0.24;

      splitter.connect(monoSum, leftIdx);
      splitter.connect(monoSum, rightIdx);
      monoSum.connect(lfeFilter1);
      lfeFilter1.connect(lfeFilter2);
      lfeFilter2.connect(lowAnalyser);

      splitter.connect(leftAnalyser, leftIdx);
      splitter.connect(rightAnalyser, rightIdx);
      leftAnalyser.connect(orbitSum);
      rightAnalyser.connect(orbitSum);

      orbitSum.connect(pinnaFilter);
      pinnaFilter.connect(stereoPanner);
      stereoPanner.connect(binauralSplit);

      binauralSplit.connect(itdL, 0);
      binauralSplit.connect(itdR, 1);
      itdL.connect(binauralMerge, 0, 0);
      itdR.connect(binauralMerge, 0, 1);

      itdL.connect(slAnalyser);
      itdR.connect(srAnalyser);
      pinnaFilter.connect(centerAnalyser);

      if (useDiscreteSixOut) {
        pinnaFilter.connect(busGains.FL);
        pinnaFilter.connect(busGains.FR);
        pinnaFilter.connect(busGains.C);
        lowAnalyser.connect(busGains.LFE);
        pinnaFilter.connect(busGains.SL);
        pinnaFilter.connect(busGains.SR);
        routeBusOutputs();
      } else {
        const subGain = ctx.createGain();
        subGain.gain.value = 0.38;
        lowAnalyser.connect(subGain);
        subGain.connect(masterSum);
        binauralMerge.connect(masterSum);

        pinnaFilter.connect(hallDamp);
        hallDamp.connect(hallDelayL);
        hallDamp.connect(hallDelayR);
        hallDelayL.connect(hallGain);
        hallDelayR.connect(hallGain);
        hallGain.connect(masterSum);
        cleanupNodes.push(subGain);
      }

      this.binauralPanNode = stereoPanner;
      this.binauralPinnaFilter = pinnaFilter;
      this.binauralDelayL = itdL;
      this.binauralDelayR = itdR;
      cleanupNodes.push(
        orbitSum,
        pinnaFilter,
        stereoPanner,
        binauralSplit,
        binauralMerge,
        itdL,
        itdR,
        hallDelayL,
        hallDelayR,
        hallDamp,
        hallGain,
      );
    } else if (this.trackChannels >= 6) {
      splitter.connect(leftAnalyser, 0);
      leftAnalyser.connect(busGains.FL);

      splitter.connect(rightAnalyser, 1);
      rightAnalyser.connect(busGains.FR);

      splitter.connect(centerAnalyser, 2);
      centerAnalyser.connect(busGains.C);

      splitter.connect(lfeFilter1, 3);
      lfeFilter1.connect(lowAnalyser);
      lowAnalyser.connect(busGains.LFE);

      splitter.connect(slAnalyser, 4);
      slAnalyser.connect(busGains.SL);

      splitter.connect(srAnalyser, 5);
      srAnalyser.connect(busGains.SR);

      routeBusOutputs();
    } else {
      const createLR4Pair = (
        type: BiquadFilterType,
        frequency: number,
      ): { input: BiquadFilterNode; output: BiquadFilterNode } => {
        const b1 = ctx.createBiquadFilter();
        b1.type = type;
        b1.frequency.value = frequency;
        b1.Q.value = Math.SQRT1_2;
        const b2 = ctx.createBiquadFilter();
        b2.type = type;
        b2.frequency.value = frequency;
        b2.Q.value = Math.SQRT1_2;
        b1.connect(b2);
        cleanupNodes.push(b1, b2);
        return { input: b1, output: b2 };
      };

      const lLow = createLR4Pair('lowpass', 150);
      const lAbove = createLR4Pair('highpass', 150);
      const lVocal = createLR4Pair('lowpass', 6500);
      const lAir = createLR4Pair('highpass', 6500);

      const rLow = createLR4Pair('lowpass', 150);
      const rAbove = createLR4Pair('highpass', 150);
      const rVocal = createLR4Pair('lowpass', 6500);
      const rAir = createLR4Pair('highpass', 6500);

      splitter.connect(lLow.input, leftIdx);
      splitter.connect(lAbove.input, leftIdx);
      lAbove.output.connect(lVocal.input);
      lAbove.output.connect(lAir.input);

      splitter.connect(rLow.input, rightIdx);
      splitter.connect(rAbove.input, rightIdx);
      rAbove.output.connect(rVocal.input);
      rAbove.output.connect(rAir.input);

      const vocalMonoSum = ctx.createGain();
      vocalMonoSum.gain.value = 0.5;
      lVocal.output.connect(vocalMonoSum);
      rVocal.output.connect(vocalMonoSum);
      vocalMonoSum.connect(centerAnalyser);
      centerAnalyser.connect(busGains.C);

      const vocalCancelGain = ctx.createGain();
      vocalCancelGain.gain.value = -0.92;
      vocalMonoSum.connect(vocalCancelGain);

      const frontLSum = ctx.createGain();
      frontLSum.gain.value = 1.0;
      lLow.output.connect(frontLSum);
      lAir.output.connect(frontLSum);
      lVocal.output.connect(frontLSum);
      vocalCancelGain.connect(frontLSum);
      frontLSum.connect(leftAnalyser);
      leftAnalyser.connect(busGains.FL);

      const frontRSum = ctx.createGain();
      frontRSum.gain.value = 1.0;
      rLow.output.connect(frontRSum);
      rAir.output.connect(frontRSum);
      rVocal.output.connect(frontRSum);
      vocalCancelGain.connect(frontRSum);
      frontRSum.connect(rightAnalyser);
      rightAnalyser.connect(busGains.FR);

      splitter.connect(monoSum, leftIdx);
      splitter.connect(monoSum, rightIdx);
      monoSum.connect(lfeFilter1);
      lfeFilter1.connect(lfeFilter2);
      lfeFilter2.connect(lowAnalyser);
      lowAnalyser.connect(busGains.LFE);

      // Extract surround side difference from >150 Hz LR4-filtered L/R so <150 Hz bass stays isolated in LFE
      const rightInverter = ctx.createGain();
      rightInverter.gain.value = -1.0;
      rAbove.output.connect(rightInverter);

      const sideDiffSum = ctx.createGain();
      sideDiffSum.gain.value = 0.92;
      lAbove.output.connect(sideDiffSum);
      rightInverter.connect(sideDiffSum);

      const srInverter = ctx.createGain();
      srInverter.gain.value = -1.0;
      sideDiffSum.connect(srInverter);

      const slAllPass = ctx.createBiquadFilter();
      slAllPass.type = 'allpass';
      slAllPass.frequency.value = 680;
      slAllPass.Q.value = 0.8;

      const srAllPass = ctx.createBiquadFilter();
      srAllPass.type = 'allpass';
      srAllPass.frequency.value = 1120;
      srAllPass.Q.value = 0.8;

      const slDirectGain = ctx.createGain();
      slDirectGain.gain.value = 0.78;
      const srDirectGain = ctx.createGain();
      srDirectGain.gain.value = 0.78;

      const slEchoDamp = ctx.createBiquadFilter();
      slEchoDamp.type = 'lowpass';
      slEchoDamp.frequency.value = 3800;
      const srEchoDamp = ctx.createBiquadFilter();
      srEchoDamp.type = 'lowpass';
      srEchoDamp.frequency.value = 3800;

      const slEchoTap1 = ctx.createDelay(0.15);
      slEchoTap1.delayTime.value = 0.036;
      const slEchoGain1 = ctx.createGain();
      slEchoGain1.gain.value = 0.36;

      const slEchoTap2 = ctx.createDelay(0.15);
      slEchoTap2.delayTime.value = 0.062;
      const slEchoGain2 = ctx.createGain();
      slEchoGain2.gain.value = 0.22;

      const srEchoTap1 = ctx.createDelay(0.15);
      srEchoTap1.delayTime.value = 0.044;
      const srEchoGain1 = ctx.createGain();
      srEchoGain1.gain.value = 0.36;

      const srEchoTap2 = ctx.createDelay(0.15);
      srEchoTap2.delayTime.value = 0.074;
      const srEchoGain2 = ctx.createGain();
      srEchoGain2.gain.value = 0.22;

      sideDiffSum.connect(slHp);
      slHp.connect(slLp);
      slLp.connect(slAllPass);

      slAllPass.connect(slDelay);
      slDelay.connect(slDirectGain);
      slDirectGain.connect(slAnalyser);

      slAllPass.connect(slEchoDamp);
      slEchoDamp.connect(slEchoTap1);
      slEchoTap1.connect(slEchoGain1);
      slEchoGain1.connect(slAnalyser);
      slEchoDamp.connect(slEchoTap2);
      slEchoTap2.connect(slEchoGain2);
      slEchoGain2.connect(slAnalyser);
      slAnalyser.connect(busGains.SL);

      srInverter.connect(srHp);
      srHp.connect(srLp);
      srLp.connect(srAllPass);

      srAllPass.connect(srDelay);
      srDelay.connect(srDirectGain);
      srDirectGain.connect(srAnalyser);

      srAllPass.connect(srEchoDamp);
      srEchoDamp.connect(srEchoTap1);
      srEchoTap1.connect(srEchoGain1);
      srEchoGain1.connect(srAnalyser);
      srEchoDamp.connect(srEchoTap2);
      srEchoTap2.connect(srEchoGain2);
      srEchoGain2.connect(srAnalyser);
      srAnalyser.connect(busGains.SR);

      routeBusOutputs();
      cleanupNodes.push(
        vocalMonoSum,
        vocalCancelGain,
        frontLSum,
        frontRSum,
        rightInverter,
        sideDiffSum,
        srInverter,
        slAllPass,
        srAllPass,
        slDirectGain,
        srDirectGain,
        slEchoDamp,
        srEchoDamp,
        slEchoTap1,
        slEchoGain1,
        slEchoTap2,
        slEchoGain2,
        srEchoTap1,
        srEchoGain1,
        srEchoTap2,
        srEchoGain2,
      );
    }

    this.activeMasterSum = masterSum;
    this.activeCleanupNodes = cleanupNodes;
    this.busGains = busGains;
    this.leftAnalyser = leftAnalyser;
    this.rightAnalyser = rightAnalyser;
    this.lowAnalyser = lowAnalyser;
    this.centerAnalyser = centerAnalyser;
    this.slAnalyser = slAnalyser;
    this.srAnalyser = srAnalyser;
    this.spectrumAnalyser = spectrumAnalyser;
    this.graphBuiltForFormat = this.exportFormat;
    this.graphBuiltForChannels = this.trackChannels;
  }

  async play() {
    if (!this.hasLoadedTrack || !this.audioEl || this.isPlaying) return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (
      !this.activeMasterSum ||
      this.graphBuiltForFormat !== this.exportFormat ||
      this.graphBuiltForChannels !== this.trackChannels
    ) {
      this.rebuildSpatialGraph(ctx);
    }

    const pos = this.audioEl.currentTime || 0;
    this.orbitPhaseBase = (((pos / this.orbitPeriodSec) % 1) + 1) % 1;
    this.orbitPhaseRefTime = ctx.currentTime;
    this.bassMovingAvg = 0;
    this.bassBeatState = 0;

    await this.audioEl.play();
    this.isPlaying = true;
    this.onTimeCallback?.(pos, true);
    this.startMeterLoop();
  }

  pause() {
    if (!this.isPlaying || !this.audioEl) return;
    this.audioEl.pause();
    const pos = this.audioEl.currentTime || 0;
    this.isPlaying = false;
    this.cancelMeterLoop();
    this.clearAnalyserData();
    this.onTimeCallback?.(pos, false);
  }

  stop() {
    if (this.audioEl) {
      this.audioEl.pause();
      try {
        this.audioEl.currentTime = 0;
      } catch {
        // Ignore seek reset before source is loaded
      }
    }
    this.isPlaying = false;
    this.cancelMeterLoop();
    this.clearAnalyserData();
    this.onTimeCallback?.(0, false);
  }

  private clearAnalyserData() {
    this.bufL.fill(128);
    this.bufR.fill(128);
    this.bufCenter.fill(128);
    this.bufSL.fill(128);
    this.bufSR.fill(128);
    this.bufLowTime.fill(128);
    this.bufLowFreq.fill(0);
    this.bufSpectrumFreq.fill(0);
    this.spectrumBands.fill(0);
    this.bassMovingAvg = 0;
    this.bassBeatState = 0;
    this.onLevelsCallback?.({ ...ZERO_LEVELS, spectrum: this.spectrumBands });
  }

  private cancelMeterLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private computeRms(analyser: AnalyserNode | null, data: Uint8Array<ArrayBuffer>, boost = 3.6): number {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(data);
    let sumSq = 0;
    let maxAbs = 0;
    const len = data.length;
    const step = len >= 512 ? 2 : 1;
    let count = 0;
    for (let i = 0; i < len; i += step) {
      const normalized = (data[i] - 128) / 128;
      const absVal = normalized < 0 ? -normalized : normalized;
      if (absVal > maxAbs) maxAbs = absVal;
      sumSq += normalized * normalized;
      count++;
    }
    if (count === 0) return 0;
    const rms = Math.sqrt(sumSq / count);
    const rawLevel = (rms * 0.72 + maxAbs * 0.28) * boost;
    if (rawLevel <= 0.004) return 0;
    return Math.min(0.98, Math.pow(Math.min(1.35, rawLevel), 0.72) * 0.88);
  }

  private computeSubBassSpectrum(
    analyser: AnalyserNode | null,
    freqData: Uint8Array<ArrayBuffer>,
  ): number {
    if (!analyser) return 0;
    analyser.getByteFrequencyData(freqData);
    let peak = 0;
    let sum = 0;
    for (let b = 1; b <= 5; b++) {
      const v = freqData[b] ?? 0;
      if (v > peak) peak = v;
      sum += v;
    }
    const avg = sum / 5;
    const blended = (peak * 0.62 + avg * 0.38) / 255;
    const gated = Math.max(0, (blended - 0.04) / 0.96);
    return Math.min(0.98, Math.pow(Math.min(1.25, gated * 1.48), 0.78));
  }

  private startMeterLoop() {
    this.cancelMeterLoop();

    let lastPollMs = 0;
    let lastTimeEmitMs = 0;
    let lastSecondBucket = -1;

    const tick = (frameNowMs: number) => {
      if (
        !this.isPlaying ||
        !this.ctx ||
        !this.audioEl ||
        this.audioEl.paused ||
        this.audioEl.ended ||
        this.ctx.state !== 'running'
      ) {
        this.rafId = null;
        this.clearAnalyserData();
        return;
      }

      const elapsed = Math.max(0, this.audioEl.currentTime || 0);

      if (frameNowMs - lastPollMs >= 20) {
        lastPollMs = frameNowMs;

        const rmsL = this.computeRms(this.leftAnalyser, this.bufL, 4.6);
        const rmsR = this.computeRms(this.rightAnalyser, this.bufR, 4.6);
        const rmsCenter = this.computeRms(this.centerAnalyser, this.bufCenter, 4.8);
        const rmsSL = this.computeRms(this.slAnalyser, this.bufSL, 6.2);
        const rmsSR = this.computeRms(this.srAnalyser, this.bufSR, 6.2);
        const rmsLow = this.computeRms(this.lowAnalyser, this.bufLowTime, 3.4);
        const subSpec = this.computeSubBassSpectrum(this.lowAnalyser, this.bufLowFreq);

        const gains = computeEffectiveChannelGains(this.channels);
        const centerWeight = this.upmixProfile === 'direct-discrete' ? 0.85 : 1.0;
        const surroundWeight = this.upmixProfile === 'ambient-hall' ? 1.15 : 0.96;

        const combinedLow = rmsLow * 0.58 + subSpec * 0.42;
        const rawBass = Math.min(0.98, combinedLow * Math.min(1.35, gains.LFE));
        const beatRes = computeBassBeatIntensity(rawBass, this.bassMovingAvg, this.bassBeatState);
        this.bassMovingAvg = beatRes.nextAvg;
        this.bassBeatState = beatRes.beat;

        if (this.spectrumAnalyser) {
          this.spectrumAnalyser.getByteFrequencyData(this.bufSpectrumFreq);
          extractLogFrequencyBands(
            this.bufSpectrumFreq,
            this.ctx.sampleRate || 48000,
            this.spectrumAnalyser.fftSize,
            this.spectrumBands,
          );
        } else {
          this.spectrumBands.fill(0);
        }

        if (
          this.exportFormat === '8d-spatial' &&
          this.binauralPanNode &&
          this.binauralPinnaFilter &&
          this.binauralDelayL &&
          this.binauralDelayR
        ) {
          const now = this.ctx.currentTime;
          const progress =
            this.orbitPhaseBase + Math.max(0, now - this.orbitPhaseRefTime) / this.orbitPeriodSec;
          const azimuthDeg = get8dAzimuthDegrees(progress);
          const azimuthRad = (azimuthDeg * Math.PI) / 180;
          const pan = Math.sin(azimuthRad);
          const depth = Math.cos(azimuthRad);

          this.binauralPanNode.pan.setTargetAtTime(pan * 0.94, now, 0.015);
          const cutoff = 3800 + 11700 * ((depth + 1) * 0.5);
          this.binauralPinnaFilter.frequency.setTargetAtTime(cutoff, now, 0.02);
          this.binauralDelayL.delayTime.setTargetAtTime(0.001 + Math.max(0, pan) * 0.00062, now, 0.015);
          this.binauralDelayR.delayTime.setTargetAtTime(0.001 + Math.max(0, -pan) * 0.00062, now, 0.015);

          const orbitAngleDeg = wrapAzimuth360(azimuthDeg);
          this.onOrbitAngleCallback?.(orbitAngleDeg);

          const computeSpeakerProximity = (currentDeg: number, targetDeg: number, apertureDeg = 75): number => {
            const diff = Math.abs(wrapAzimuth180(currentDeg - targetDeg));
            if (diff >= apertureDeg) return 0;
            const norm = diff / apertureDeg;
            return Math.pow(Math.cos(norm * Math.PI * 0.5), 2);
          };

          const baseEnergy = Math.max(0.2, (rmsL + rmsR) * 0.55);
          const wC = computeSpeakerProximity(azimuthDeg, 0, 65);
          const wFL = computeSpeakerProximity(azimuthDeg, -30, 65);
          const wSL = computeSpeakerProximity(azimuthDeg, -110, 75);
          const wSR = computeSpeakerProximity(azimuthDeg, 110, 75);
          const wFR = computeSpeakerProximity(azimuthDeg, 30, 65);

          const orbitalLevels: ChannelLevels = {
            FL: Math.min(1, baseEnergy * (0.15 + 0.85 * wFL) * gains.FL),
            FR: Math.min(1, baseEnergy * (0.15 + 0.85 * wFR) * gains.FR),
            C: Math.min(1, baseEnergy * (0.15 + 0.85 * wC) * gains.C),
            LFE: rawBass,
            SL: Math.min(1, baseEnergy * (0.15 + 0.85 * wSL) * gains.SL),
            SR: Math.min(1, baseEnergy * (0.15 + 0.85 * wSR) * gains.SR),
            lfeBeat: gains.LFE <= 0.001 ? 0 : beatRes.beat,
            orbitAngleDeg,
            spectrum: this.spectrumBands,
          };

          if (this.busGains && (this.ctx.destination.maxChannelCount || 2) >= 6) {
            this.busGains.FL.gain.setTargetAtTime((0.15 + 0.85 * wFL) * gains.FL, now, 0.015);
            this.busGains.FR.gain.setTargetAtTime((0.15 + 0.85 * wFR) * gains.FR, now, 0.015);
            this.busGains.C.gain.setTargetAtTime((0.15 + 0.85 * wC) * gains.C, now, 0.015);
            this.busGains.LFE.gain.setTargetAtTime(0.85 * gains.LFE, now, 0.015);
            this.busGains.SL.gain.setTargetAtTime((0.15 + 0.85 * wSL) * gains.SL, now, 0.015);
            this.busGains.SR.gain.setTargetAtTime((0.15 + 0.85 * wSR) * gains.SR, now, 0.015);
          }

          this.onLevelsCallback?.(orbitalLevels);
        } else {
          const levels: ChannelLevels = {
            FL: Math.min(1, rmsL * gains.FL),
            FR: Math.min(1, rmsR * gains.FR),
            C: Math.min(1, rmsCenter * centerWeight * gains.C),
            LFE: rawBass,
            SL: Math.min(1, rmsSL * surroundWeight * gains.SL),
            SR: Math.min(1, rmsSR * surroundWeight * gains.SR),
            lfeBeat: gains.LFE <= 0.001 ? 0 : beatRes.beat,
            spectrum: this.spectrumBands,
          };
          this.onLevelsCallback?.(levels);
        }
      }

      const secBucket = Math.floor(elapsed);
      if (frameNowMs - lastTimeEmitMs >= 200 || secBucket !== lastSecondBucket) {
        lastTimeEmitMs = frameNowMs;
        lastSecondBucket = secBucket;
        this.onTimeCallback?.(elapsed, true);
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  async playChannelCalibrationTone(channelId: ChannelId) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const freqMap: Record<ChannelId, number> = {
      FL: 440,
      C: 523.25,
      FR: 440,
      LFE: 65,
      SL: 349.23,
      SR: 349.23,
    };

    const panMap: Record<ChannelId, number> = {
      FL: -0.8,
      C: 0,
      FR: 0.8,
      LFE: 0,
      SL: -0.95,
      SR: 0.95,
    };

    osc.type = channelId === 'LFE' ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freqMap[channelId], now);

    const chGains = computeEffectiveChannelGains(this.channels);
    const targetGain = Math.min(0.32, 0.16 * chGains[channelId]);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, targetGain), now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);

    osc.connect(gain);

    const maxDestCh = ctx.destination.maxChannelCount || 2;
    let routeNode: AudioNode;
    if (maxDestCh >= 6) {
      try {
        ctx.destination.channelCount = 6;
        ctx.destination.channelCountMode = 'explicit';
        ctx.destination.channelInterpretation = 'discrete';
      } catch {
        // Safe fallback on mobile browsers
      }
      const merger = ctx.createChannelMerger(6);
      try {
        merger.channelCount = 6;
        merger.channelCountMode = 'explicit';
        merger.channelInterpretation = 'discrete';
      } catch {
        // Safe fallback
      }
      gain.connect(merger, 0, DISCRETE_51_CHANNEL_INDEX[channelId]);
      merger.connect(ctx.destination);
      routeNode = merger;
    } else {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(panMap[channelId], now);
      gain.connect(panner);
      panner.connect(ctx.destination);
      routeNode = panner;
    }

    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
        routeNode.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    };

    osc.start(now);
    osc.stop(now + 0.38);
  }

  dispose() {
    this.stop();
    this.tearDownSpatialGraph();
    if (this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch {
        // Ignore disconnect error
      }
      this.mediaSource = null;
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl.load();
      this.audioEl = null;
    }
    this.revokeCurrentUrl();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
  }
}
