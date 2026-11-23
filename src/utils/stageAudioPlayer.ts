import type { ChannelConfig, ChannelId, ExportFormat, UpmixProfile } from './audioTypes';
import {
  computeBassBeatIntensity,
  computeEffectiveChannelGains,
  extractTrackEnergyProfile,
  get8dAzimuthDegrees,
  wrapAzimuth180,
  wrapAzimuth360,
  type TrackEnergyFrame,
} from './channelMath';

export type ChannelLevels = Record<ChannelId, number> & {
  lfeBeat: number;
  orbitAngleDeg?: number;
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

export async function inspectAudioBufferMetadata(bytes: Uint8Array): Promise<{
  durationSec: number;
  sampleRate: number;
  sourceChannels: number;
  audioBuffer: AudioBuffer | null;
  energyProfile: TrackEnergyFrame[];
}> {
  const OfflineCtx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;

  if (!OfflineCtx || bytes.byteLength > 75 * 1024 * 1024) {
    console.info('[Surround X][Audio Inspect] Skipping full browser preview decode due to file size or memory constraint.');
    return {
      durationSec: 180,
      sampleRate: 48000,
      sourceChannels: 2,
      audioBuffer: null,
      energyProfile: [],
    };
  }

  try {
    const ctx = new OfflineCtx(2, 1, 48000);
    const audioDataBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const decoded = await ctx.decodeAudioData(audioDataBuffer);
    const left = decoded.getChannelData(0);
    const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
    const energyProfile = extractTrackEnergyProfile(left, right, 48);

    return {
      durationSec: decoded.duration,
      sampleRate: decoded.sampleRate,
      sourceChannels: decoded.numberOfChannels,
      audioBuffer: decoded,
      energyProfile,
    };
  } catch (err) {
    console.warn('[Surround X][Audio Inspect] Browser preview decode skipped or memory limit reached:', err);
    return {
      durationSec: 0,
      sampleRate: 48000,
      sourceChannels: 2,
      audioBuffer: null,
      energyProfile: [],
    };
  }
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
  private sourceNode: AudioBufferSourceNode | null = null;
  private busGains: BusNodes | null = null;
  private leftAnalyser: AnalyserNode | null = null;
  private rightAnalyser: AnalyserNode | null = null;
  private lowAnalyser: AnalyserNode | null = null;
  private centerAnalyser: AnalyserNode | null = null;
  private slAnalyser: AnalyserNode | null = null;
  private srAnalyser: AnalyserNode | null = null;
  // Real-time Web Audio 8D Binaural rotation nodes
  private binauralPanNode: StereoPannerNode | null = null;
  private binauralPinnaFilter: BiquadFilterNode | null = null;
  private binauralDelayL: DelayNode | null = null;
  private binauralDelayR: DelayNode | null = null;
  // Active graph tracking for clean mobile GC & anti-click shutdown
  private activeMasterSum: GainNode | null = null;
  private activeCleanupNodes: AudioNode[] = [];
  private rafId: number | null = null;
  private buffer: AudioBuffer | null = null;
  private startOffset = 0;
  private startedAt = 0;
  private isPlaying = false;
  private playbackEnded = false;
  private bassMovingAvg = 0;
  private bassBeatState = 0;
  // Reusable analyser buffers cleared to zero/silence whenever playback stops or ends
  private readonly bufL = new Uint8Array(new ArrayBuffer(512));
  private readonly bufR = new Uint8Array(new ArrayBuffer(512));
  private readonly bufCenter = new Uint8Array(new ArrayBuffer(512));
  private readonly bufSL = new Uint8Array(new ArrayBuffer(512));
  private readonly bufSR = new Uint8Array(new ArrayBuffer(512));
  private readonly bufLowTime = new Uint8Array(new ArrayBuffer(2048));
  private readonly bufLowFreq = new Uint8Array(new ArrayBuffer(1024));
  private channels: ChannelConfig[] = [];
  private upmixProfile: UpmixProfile = 'cinema-pro';
  private exportFormat: ExportFormat = 'ac3';
  private orbitPeriodSec = 8.0;
  private orbitPhaseBase = 0;
  private orbitPhaseRefTime = 0;
  private onLevelsCallback?: (levels: ChannelLevels) => void;
  private onTimeCallback?: (currentSec: number, playing: boolean) => void;
  private onOrbitAngleCallback?: (angleDeg: number) => void;

  setBuffer(buffer: AudioBuffer | null) {
    this.stop();
    this.buffer = buffer;
    this.startOffset = 0;
    this.playbackEnded = false;
    this.clearAnalyserData();
    this.onTimeCallback?.(0, false);
  }

  getBuffer(): AudioBuffer | null {
    return this.buffer;
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

    // Seamlessly rebuild Web Audio graph if user toggles between 5.1 Surround and 8D Spatial mid-playback
    if (formatChanged && this.isPlaying) {
      const currentPos = this.ctx ? Math.max(0, this.ctx.currentTime - this.startedAt) : 0;
      void this.seek(currentPos);
    }
  }

  setCallbacks(
    onLevels: (levels: ChannelLevels) => void,
    onTime: (currentSec: number, playing: boolean) => void,
    onOrbitAngle?: (angleDeg: number) => void,
  ) {
    this.onLevelsCallback = onLevels;
    this.onTimeCallback = onTime;
    this.onOrbitAngleCallback = onOrbitAngle;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    return this.ctx;
  }

  async togglePlay(): Promise<boolean> {
    if (!this.buffer) return false;
    if (this.isPlaying) {
      this.pause();
      return false;
    }
    await this.play();
    return true;
  }

  async seek(targetSec: number) {
    if (!this.buffer) return;
    const clamped = Math.max(0, Math.min(this.buffer.duration, targetSec));
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.stopSourceOnly();
      this.isPlaying = false;
      this.cancelMeterLoop();
    } else {
      this.clearAnalyserData();
    }
    this.startOffset = clamped;
    this.onTimeCallback?.(clamped, wasPlaying);
    if (wasPlaying) {
      await this.play();
    }
  }

  async play() {
    if (!this.buffer || this.isPlaying) return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;

    const chCount = this.buffer.numberOfChannels;
    const splitter = ctx.createChannelSplitter(Math.max(2, chCount));

    // Inline per-channel AnalyserNodes wired directly in the live playback path
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

    // 2048-pt FFT at 48 kHz = 23.4 Hz/bin -> resolves 20-125 Hz sub-bass drops with full 0 dBFS headroom
    lowAnalyser.fftSize = 2048;
    lowAnalyser.minDecibels = -80;
    lowAnalyser.maxDecibels = -2;

    leftAnalyser.smoothingTimeConstant = 0.58;
    rightAnalyser.smoothingTimeConstant = 0.58;
    centerAnalyser.smoothingTimeConstant = 0.6;
    slAnalyser.smoothingTimeConstant = 0.62;
    srAnalyser.smoothingTimeConstant = 0.62;
    lowAnalyser.smoothingTimeConstant = 0.36;

    // Sub-bass LFE crossover: sharp 4th-order 110 Hz Linkwitz-Riley low-pass filter (80-120 Hz sub-bass)
    const lfeFilter1 = ctx.createBiquadFilter();
    lfeFilter1.type = 'lowpass';
    lfeFilter1.frequency.value = 110;
    lfeFilter1.Q.value = Math.SQRT1_2;

    const lfeFilter2 = ctx.createBiquadFilter();
    lfeFilter2.type = 'lowpass';
    lfeFilter2.frequency.value = 110;
    lfeFilter2.Q.value = Math.SQRT1_2;

    // True mono sum (L + R) * 0.5 feeding LFE sub-bass crossover
    const monoSum = ctx.createGain();
    monoSum.gain.value = 0.5;

    // Surround ambient band-limiting (110 Hz HPF removes dry kick/bass, 13.5 kHz LPF keeps warm spatial air)
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

    // Discrete 6-bus spatial routing with real per-channel Mute/Solo/Gain
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

    // Safely inspect hardware destination channel capacity (e.g. 2ch mobile vs 6ch 5.1 AVR)
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
      // Fallback gracefully on browsers with read-only destination channelCount (e.g. mobile iOS Safari)
    }

    const masterSum = ctx.createGain();
    try {
      masterSum.channelCount = useDiscreteSixOut ? 6 : 2;
      masterSum.channelCountMode = 'explicit';
      masterSum.channelInterpretation = useDiscreteSixOut ? 'discrete' : 'speakers';
    } catch {
      // Ignore if browser clamps channel properties
    }
    const nowStart = ctx.currentTime;
    masterSum.gain.setValueAtTime(0.0001, nowStart);
    masterSum.gain.linearRampToValueAtTime(0.85, nowStart + 0.02);
    masterSum.connect(ctx.destination);

    source.connect(splitter);
    const leftIdx = 0;
    const rightIdx = chCount > 1 ? 1 : 0;

    this.binauralPanNode = null;
    this.binauralPinnaFilter = null;
    this.binauralDelayL = null;
    this.binauralDelayR = null;
    const cleanupNodes: AudioNode[] = [
      source,
      splitter,
      masterSum,
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
        // Discrete 6-channel hardware mapping: [0: FL, 1: FR, 2: C, 3: LFE, 4: SL, 5: SR]
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
        // Stereo-safe downmix for mobile/desktop 2ch outputs without channel overflow or clicking
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
      // ==================== LIVE WEB AUDIO 8D BINAURAL SPATIAL GRAPH ====================
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
      // 1ms safe baseline delay prevents mobile WebKit/Chromium DelayNode 0ms interpolation clicks
      const itdL = ctx.createDelay(0.02);
      itdL.delayTime.value = 0.001;
      const itdR = ctx.createDelay(0.02);
      itdR.delayTime.value = 0.001;

      // Subtle concert hall early reflection bus
      const hallDelayL = ctx.createDelay(0.1);
      hallDelayL.delayTime.value = 0.023;
      const hallDelayR = ctx.createDelay(0.1);
      hallDelayR.delayTime.value = 0.037;
      const hallDamp = ctx.createBiquadFilter();
      hallDamp.type = 'lowpass';
      hallDamp.frequency.value = 4200;
      const hallGain = ctx.createGain();
      hallGain.gain.value = 0.24;

      // Grounded sub-bass anchor (<115 Hz) wired through lowAnalyser
      splitter.connect(monoSum, leftIdx);
      splitter.connect(monoSum, rightIdx);
      monoSum.connect(lfeFilter1);
      lfeFilter1.connect(lfeFilter2);
      lfeFilter2.connect(lowAnalyser);

      // Main 8D orbital chain
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

      // Analyzers for visual surround sweep cues
      itdL.connect(slAnalyser);
      itdR.connect(srAnalyser);
      pinnaFilter.connect(centerAnalyser);

      if (useDiscreteSixOut) {
        // Route 8D orbit directly into all 6 physical speaker buses (FL, FR, C, LFE, SL, SR)
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

        // Diffuse room reflections
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
    } else if (chCount >= 6) {
      // Discrete 5.1 source routing through inline per-channel analyzers
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
      // Phase-Matched 3-Band LR4 (150 Hz & 6.5 kHz) Matrix Routing for Stereo Source:
      // - Center (C): Strictly isolates centered 150 Hz - 6.5 kHz primary lead vocals
      // - Front L/R (FL/FR): Preserves 100% of <150 Hz beats/kick, >6.5 kHz air/echoes, and stereo instruments/reverb
      //   while canceling ~92% of centered vocals so lead vocals never muddy or overpower Front L/R
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

      // 1. Center Channel (C): 0.5 * (L_vocal + R_vocal) -> pure lead vocals (150 Hz - 6.5 kHz)
      const vocalMonoSum = ctx.createGain();
      vocalMonoSum.gain.value = 0.5;
      lVocal.output.connect(vocalMonoSum);
      rVocal.output.connect(vocalMonoSum);
      vocalMonoSum.connect(centerAnalyser);
      centerAnalyser.connect(busGains.C);

      // 2. Front Towers (FL/FR): Phase-coherent vocal cancellation (-0.92 * vocalMonoSum) inside 150 Hz-6.5 kHz,
      //    leaving 100% of <150 Hz beats, >6.5 kHz cymbals/echoes, and stereo instruments/reverb intact
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

      // 3. Subwoofer (LFE): monoSum -> 4th-order 120 Hz LPF -> lowAnalyser -> busGains.LFE
      splitter.connect(monoSum, leftIdx);
      splitter.connect(monoSum, rightIdx);
      monoSum.connect(lfeFilter1);
      lfeFilter1.connect(lfeFilter2);
      lfeFilter2.connect(lowAnalyser);
      lowAnalyser.connect(busGains.LFE);

      // 4. Pure Ambient & Reverb Rear Surrounds (SL/SR):
      //    Strict stereo difference decoding S = (L - R) cancels centered dry vocals & mono beats 100%,
      //    never duplicating Front L/R directly. Processed through decorrelated All-Pass diffusers,
      //    Haas precedence delays (14ms/22ms), and damped multi-tap hall reverb/echoes (36ms/62ms SL, 44ms/74ms SR).
      const rightInverter = ctx.createGain();
      rightInverter.gain.value = -1.0;
      splitter.connect(rightInverter, rightIdx);

      const sideDiffSum = ctx.createGain();
      sideDiffSum.gain.value = 0.92;
      splitter.connect(sideDiffSum, leftIdx);
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

      // SL chain: +S -> 110Hz HPF -> 13.5kHz LPF -> AllPass -> (14ms Haas + 36ms/62ms warm echo) -> slAnalyser -> busGains.SL
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

      // SR chain: -S -> 110Hz HPF -> 13.5kHz LPF -> AllPass -> (22ms Haas + 44ms/74ms warm echo) -> srAnalyser -> busGains.SR
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

    const offset = this.startOffset >= this.buffer.duration ? 0 : this.startOffset;
    source.start(0, offset);

    this.sourceNode = source;
    this.busGains = busGains;
    this.leftAnalyser = leftAnalyser;
    this.rightAnalyser = rightAnalyser;
    this.lowAnalyser = lowAnalyser;
    this.centerAnalyser = centerAnalyser;
    this.slAnalyser = slAnalyser;
    this.srAnalyser = srAnalyser;
    this.startedAt = ctx.currentTime - offset;
    this.orbitPhaseBase = ((offset / this.orbitPeriodSec) % 1 + 1) % 1;
    this.orbitPhaseRefTime = ctx.currentTime;
    this.isPlaying = true;
    this.playbackEnded = false;
    this.bassMovingAvg = 0;
    this.bassBeatState = 0;

    source.onended = () => {
      if (this.sourceNode === source) {
        this.playbackEnded = true;
        this.isPlaying = false;
        this.startOffset = 0;
        this.sourceNode = null;
        this.busGains = null;
        this.cancelMeterLoop();
        this.clearAnalyserData();
        this.onTimeCallback?.(0, false);
      }
    };

    this.startMeterLoop();
  }

  pause() {
    if (!this.isPlaying || !this.ctx) return;
    this.startOffset = Math.max(0, this.ctx.currentTime - this.startedAt);
    this.stopSourceOnly();
    this.busGains = null;
    this.isPlaying = false;
    this.cancelMeterLoop();
    this.clearAnalyserData();
    this.onTimeCallback?.(this.startOffset, false);
  }

  stop() {
    this.stopSourceOnly();
    this.busGains = null;
    this.isPlaying = false;
    this.playbackEnded = false;
    this.startOffset = 0;
    this.cancelMeterLoop();
    this.clearAnalyserData();
    this.onTimeCallback?.(0, false);
  }

  private stopSourceOnly() {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null;
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch {
        // Ignore already stopped source
      }
      this.sourceNode = null;
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
    this.binauralPanNode = null;
    this.binauralPinnaFilter = null;
    this.binauralDelayL = null;
    this.binauralDelayR = null;
  }

  private clearAnalyserData() {
    // 128 is digital silence in unsigned 8-bit time-domain data; 0 is silence in frequency bins
    this.bufL.fill(128);
    this.bufR.fill(128);
    this.bufCenter.fill(128);
    this.bufSL.fill(128);
    this.bufSR.fill(128);
    this.bufLowTime.fill(128);
    this.bufLowFreq.fill(0);
    this.bassMovingAvg = 0;
    this.bassBeatState = 0;
    this.onLevelsCallback?.({ ...ZERO_LEVELS });
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
    // Blend RMS body (70%) + instantaneous peak transient (30%) so beats & subtle phrases pop
    const rawLevel = (rms * 0.72 + maxAbs * 0.28) * boost;
    if (rawLevel <= 0.004) return 0;
    // Soft-knee perceptual compression boosts quiet/subtle signals while smoothly preventing clipping
    return Math.min(0.98, Math.pow(Math.min(1.35, rawLevel), 0.72) * 0.88);
  }

  private computeSubBassSpectrum(
    analyser: AnalyserNode | null,
    freqData: Uint8Array<ArrayBuffer>,
  ): number {
    if (!analyser) return 0;
    analyser.getByteFrequencyData(freqData);
    // With 2048-pt FFT @ 48kHz (~23.4 Hz/bin), bins 1..5 cover 23 Hz - 125 Hz sub-bass!
    let peak = 0;
    let sum = 0;
    for (let b = 1; b <= 5; b++) {
      const v = freqData[b] ?? 0;
      if (v > peak) peak = v;
      sum += v;
    }
    const avg = sum / 5;
    const blended = (peak * 0.62 + avg * 0.38) / 255;
    // Low noise gate (0.04) + responsive exponent makes subtle & heavy bass drops punch cleanly
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
        this.playbackEnded ||
        !this.ctx ||
        !this.buffer ||
        !this.sourceNode ||
        this.ctx.state !== 'running'
      ) {
        this.rafId = null;
        this.clearAnalyserData();
        return;
      }

      const elapsed = Math.max(0, this.ctx.currentTime - this.startedAt);
      if (elapsed >= this.buffer.duration) {
        this.playbackEnded = true;
        this.isPlaying = false;
        this.startOffset = 0;
        this.rafId = null;
        this.clearAnalyserData();
        this.onTimeCallback?.(0, false);
        return;
      }

      // Cap AnalyserNode FFT/time-domain polling to ~40Hz (24ms) to avoid 120Hz mobile CPU saturation
      if (frameNowMs - lastPollMs >= 24) {
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
          // 1ms safe base delay avoids 0ms interpolation clicks on mobile browsers
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
          };
          this.onLevelsCallback?.(levels);
        }
      }

      // Throttle React timeline state updates to ~5 Hz (200ms) or integer second boundary to stop 60Hz full-tree re-renders
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
    const panner = ctx.createStereoPanner();

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

    panner.pan.setValueAtTime(panMap[channelId], now);

    const chGains = computeEffectiveChannelGains(this.channels);
    const targetGain = Math.min(0.32, 0.16 * chGains[channelId]);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, targetGain), now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.38);
  }

  dispose() {
    this.stop();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
  }
}
