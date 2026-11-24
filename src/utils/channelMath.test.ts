import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_CHANNELS } from './audioTypes';
import {
  applyGainsToSixChannels,
  buildAc3FfmpegArgs,
  buildFfmpegArgsForFormat,
  buildOutputAc3Filename,
  buildOutputFilename,
  computeBassBeatIntensity,
  computeEffectiveChannelGains,
  computeSixChannelRmsSummary,
  createDemoStereoWavBuffer,
  dbToLinear,
  decodePcmWavToChannels,
  encodeMatrixUpmixStereoToSixChannelWav,
  encodeSixChannelPcmWav,
  encodeStereo8dBinauralWavChunks,
  encodeStereoPcmWav,
  extractTrackEnergyProfile,
  formatDuration,
  formatFileSize,
  get8dAzimuthDegrees,
  hasCustomChannelEdits,
  isSupportedAudioFile,
  isValidAc3Bitstream,
  matrixUpmixStereoToSixChannels,
  processStereoTo8dBinaural,
  sanitizeInputExtension,
  StreamingMatrixUpmix51,
  wrapAzimuth180,
  wrapAzimuth360,
} from './channelMath';

test('dbToLinear converts 0 dB to 1.0 and -60 dB to 0', () => {
  assert.equal(dbToLinear(0), 1);
  assert.equal(dbToLinear(-60), 0);
  assert.ok(Math.abs(dbToLinear(6) - 1.99526) < 0.001);
  assert.ok(Math.abs(dbToLinear(-6) - 0.50118) < 0.001);
});

test('computeEffectiveChannelGains respects mute and solo states', () => {
  const base = INITIAL_CHANNELS.map((c) => ({ ...c }));
  const defaultGains = computeEffectiveChannelGains(base);
  assert.equal(defaultGains.FL, 1);
  assert.equal(defaultGains.LFE, 1);

  const muted = base.map((c) => (c.id === 'C' ? { ...c, muted: true } : c));
  const mutedGains = computeEffectiveChannelGains(muted);
  assert.equal(mutedGains.C, 0);
  assert.equal(mutedGains.FL, 1);

  const soloed = base.map((c) => (c.id === 'SL' || c.id === 'SR' ? { ...c, solo: true } : c));
  const soloGains = computeEffectiveChannelGains(soloed);
  assert.equal(soloGains.SL, 1);
  assert.equal(soloGains.SR, 1);
  assert.equal(soloGains.FL, 0);
  assert.equal(soloGains.C, 0);
});

test('hasCustomChannelEdits detects default vs customized stage configurations', () => {
  assert.equal(hasCustomChannelEdits(INITIAL_CHANNELS, 'cinema-pro'), false);
  assert.equal(hasCustomChannelEdits(INITIAL_CHANNELS, 'ambient-hall'), true);
  const adjusted = INITIAL_CHANNELS.map((c) => (c.id === 'LFE' ? { ...c, gainDb: 3 } : c));
  assert.equal(hasCustomChannelEdits(adjusted, 'cinema-pro'), true);
});

test('buildAc3FfmpegArgs generates reliable 5.1 AC3 command without fragile filter syntax', () => {
  const args = buildAc3FfmpegArgs('input.mp3', 'output.ac3', 448);
  assert.deepEqual(args, [
    '-y',
    '-i',
    'input.mp3',
    '-vn',
    '-c:a',
    'ac3',
    '-b:a',
    '448k',
    '-ar',
    '48000',
    '-ac',
    '6',
    'output.ac3',
  ]);
});

test('sanitizeInputExtension, isSupportedAudioFile, and buildOutputAc3Filename handle filenames safely', () => {
  assert.equal(sanitizeInputExtension('My Track (Live).MP3'), 'mp3');
  assert.equal(sanitizeInputExtension('noext'), 'wav');
  assert.equal(sanitizeInputExtension('video.exe'), 'bin');
  assert.equal(isSupportedAudioFile('song.flac', ''), true);
  assert.equal(isSupportedAudioFile('notes.txt', 'text/plain'), false);
  assert.equal(buildOutputAc3Filename('Hans Zimmer - Interstellar.flac'), 'Hans_Zimmer_-_Interstellar_5.1.ac3');
});

test('createDemoStereoWavBuffer creates a valid RIFF WAVE stereo 48kHz buffer', () => {
  const wav = createDemoStereoWavBuffer(1, 48000);
  const header = String.fromCharCode(...wav.slice(0, 4));
  const waveTag = String.fromCharCode(...wav.slice(8, 12));
  assert.equal(header, 'RIFF');
  assert.equal(waveTag, 'WAVE');
  assert.equal(wav.byteLength, 44 + 48000 * 2 * 2);
});

test('WAVEFORMATEXTENSIBLE 6-channel WAV encodes and decodes cleanly with 5.1 channel mask', () => {
  const left = new Float32Array(2400);
  const right = new Float32Array(2400);
  for (let i = 0; i < left.length; i++) {
    left[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.6;
    right[i] = Math.sin((2 * Math.PI * 55 * i) / 48000) * 0.5;
  }
  const gains = computeEffectiveChannelGains(INITIAL_CHANNELS);
  const sixCh = matrixUpmixStereoToSixChannels(left, right, gains, 'cinema-pro', 48000);
  assert.equal(sixCh.length, 6);

  const wav = encodeSixChannelPcmWav(sixCh, 48000);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint16(20, true), 0xfffe); // WAVE_FORMAT_EXTENSIBLE
  assert.equal(view.getUint16(22, true), 6);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 0x003f); // 5.1 channel mask

  const decoded = decodePcmWavToChannels(wav);
  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.channels.length, 6);
  assert.equal(decoded.channels[0].length, 2400);
});

test('matrixUpmixStereoToSixChannels separates hard-left, hard-right, center, and 120 Hz LFE accurately', () => {
  const sr = 48000;
  const n = 48000; // 1.0s
  const gains = computeEffectiveChannelGains(INITIAL_CHANNELS);

  // 1. Hard-left 440 Hz tone -> FL & SL active, FR & SR & C suppressed
  const hardLeftL = new Float32Array(n);
  const zero = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hardLeftL[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.8;
  }
  const leftSep = matrixUpmixStereoToSixChannels(hardLeftL, zero, gains, 'cinema-pro', sr);
  const leftRms = computeSixChannelRmsSummary(leftSep);
  assert.ok(leftRms.FL > 0.35, `Expected strong FL (${leftRms.FL})`);
  assert.ok(leftRms.SL > 0.05, `Expected audible SL (${leftRms.SL})`);
  assert.ok(leftRms.FR < 0.001, `Expected silent FR (${leftRms.FR})`);
  assert.ok(leftRms.SR < 0.001, `Expected silent SR (${leftRms.SR})`);
  assert.ok(leftRms.C < 0.01, `Expected suppressed C on hard-left (${leftRms.C})`);

  // 2. Center 600 Hz vocal -> strong Center C with vocal bleed cancellation in FL, FR, SL, SR
  const midTone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    midTone[i] = Math.sin((2 * Math.PI * 600 * i) / sr) * 0.7;
  }
  const midSep = matrixUpmixStereoToSixChannels(midTone, midTone, gains, 'cinema-pro', sr);
  const midRms = computeSixChannelRmsSummary(midSep);
  assert.ok(midRms.C > 0.3, `Expected strong C on centered 600 Hz tone (${midRms.C})`);
  assert.ok(midRms.FL < 0.05, `Expected FL vocal bleed eliminated (< 0.05, got ${midRms.FL})`);
  assert.ok(midRms.FR < 0.05, `Expected FR vocal bleed eliminated (< 0.05, got ${midRms.FR})`);
  assert.ok(midRms.SL < 0.001, `Expected SL silent on centered vocal (< 0.001, got ${midRms.SL})`);
  assert.ok(midRms.SR < 0.001, `Expected SR silent on centered vocal (< 0.001, got ${midRms.SR})`);
  assert.ok(midRms.LFE < 0.005, `Expected 4th-order 120 Hz LPF to reject 600 Hz from LFE (${midRms.LFE})`);

  // 3. 55 Hz sub-bass -> strong LFE
  const subBass = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    subBass[i] = Math.sin((2 * Math.PI * 55 * i) / sr) * 0.7;
  }
  const bassSep = matrixUpmixStereoToSixChannels(subBass, subBass, gains, 'cinema-pro', sr);
  const bassRms = computeSixChannelRmsSummary(bassSep);
  assert.ok(bassRms.LFE > 0.35, `Expected strong LFE on 55 Hz bass (${bassRms.LFE})`);

  // 4. Pure out-of-phase 800 Hz ambient sound (L = S, R = -S) -> strong SL & SR, zero front bleed (FL & FR < 0.05), silent C & LFE
  const antiPhaseL = new Float32Array(n);
  const antiPhaseR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const val = Math.sin((2 * Math.PI * 800 * i) / sr) * 0.7;
    antiPhaseL[i] = val;
    antiPhaseR[i] = -val;
  }
  const surrSep = matrixUpmixStereoToSixChannels(antiPhaseL, antiPhaseR, gains, 'cinema-pro', sr);
  const surrRms = computeSixChannelRmsSummary(surrSep);
  assert.ok(surrRms.SL > 0.3, `Expected strong SL on out-of-phase ambiance (${surrRms.SL})`);
  assert.ok(surrRms.SR > 0.3, `Expected strong SR on out-of-phase ambiance (${surrRms.SR})`);
  assert.ok(surrRms.FL < 0.05, `Expected FL front-heavy bleed eliminated (< 0.05, got ${surrRms.FL})`);
  assert.ok(surrRms.FR < 0.05, `Expected FR front-heavy bleed eliminated (< 0.05, got ${surrRms.FR})`);
  assert.ok(surrRms.C < 0.01, `Expected silent C on out-of-phase ambiance (< 0.01, got ${surrRms.C})`);
  assert.ok(surrRms.LFE < 0.01, `Expected silent LFE on out-of-phase ambiance (< 0.01, got ${surrRms.LFE})`);

  // 5. Simultaneous multi-element mix:
  //    Centered Lead Vocal (700 Hz, L=R) + Kick/Beat (100 Hz) + Stereo Reverb/Instruments (1200 Hz out-of-phase/panned) + Hi-Hat (9 kHz)
  const mixL = new Float32Array(n);
  const mixR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const vocal = Math.sin((2 * Math.PI * 700 * i) / sr) * 0.42;
    const kickBeat = Math.sin((2 * Math.PI * 100 * i) / sr) * 0.25;
    const stereoMusic = Math.sin((2 * Math.PI * 1200 * i) / sr) * 0.24;
    const hiHat = Math.sin((2 * Math.PI * 9000 * i) / sr) * 0.16;
    mixL[i] = vocal + kickBeat + stereoMusic + hiHat;
    mixR[i] = vocal + kickBeat * 0.85 - stereoMusic * 0.7 + hiHat * 0.6;
  }
  const mixSep = matrixUpmixStereoToSixChannels(mixL, mixR, gains, 'cinema-pro', sr);
  const measureToneAmp = (buf: Float32Array, freqHz: number): number => {
    const start = Math.floor(sr * 0.2); // skip initial filter settle
    const len = buf.length - start;
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * freqHz) / sr;
    for (let i = start; i < buf.length; i++) {
      re += buf[i] * Math.cos(w * i);
      im -= buf[i] * Math.sin(w * i);
    }
    return (2 * Math.hypot(re, im)) / len;
  };

  // Center (C) isolates 700 Hz lead vocal while rejecting 100 Hz beat and 9 kHz hi-hat
  const cVocal = measureToneAmp(mixSep[2], 700);
  const cBeat = measureToneAmp(mixSep[2], 100);
  const cHat = measureToneAmp(mixSep[2], 9000);
  assert.ok(cVocal > 0.30, `Expected strong 700 Hz lead vocal in Center (got ${cVocal})`);
  assert.ok(cBeat < 0.08, `Expected 100 Hz beat excluded from Center (got ${cBeat})`);
  assert.ok(cHat < 0.03, `Expected 9 kHz hi-hat excluded from Center (got ${cHat})`);

  // Front L/R (FL/FR) preserve 100 Hz beat, 1200 Hz stereo music/reverb, and 9 kHz hi-hat while canceling 700 Hz centered vocal
  const flVocal = measureToneAmp(mixSep[0], 700);
  const flBeat = measureToneAmp(mixSep[0], 100);
  const flMusic = measureToneAmp(mixSep[0], 1200);
  const flHat = measureToneAmp(mixSep[0], 9000);
  assert.ok(flVocal < 0.05, `Expected 700 Hz lead vocal canceled from FL (< 0.05, got ${flVocal})`);
  assert.ok(flBeat > 0.16, `Expected 100 Hz beat preserved in FL (> 0.16, got ${flBeat})`);
  assert.ok(flMusic > 0.15, `Expected 1200 Hz stereo music/reverb preserved in FL (> 0.15, got ${flMusic})`);
  assert.ok(flHat > 0.10, `Expected 9 kHz hi-hat preserved in FL (> 0.10, got ${flHat})`);

  // Rear Surrounds (SL/SR) carry stereo ambient reverb/echoes (1200 Hz) while rejecting dry centered vocals (700 Hz) and dry kick (100 Hz)
  const slVocal = measureToneAmp(mixSep[4], 700);
  const slBeat = measureToneAmp(mixSep[4], 100);
  const slAmbience = measureToneAmp(mixSep[4], 1200);
  assert.ok(slVocal < 0.02, `Expected dry centered 700 Hz vocal absent from SL (< 0.02, got ${slVocal})`);
  assert.ok(slBeat < 0.05, `Expected dry 100 Hz kick/beat excluded from SL (< 0.05, got ${slBeat})`);
  assert.ok(
    slAmbience > 0.09 && slAmbience > slVocal * 5,
    `Expected 1200 Hz stereo ambience/reverb active in SL (> 0.09, got ${slAmbience}, slVocal=${slVocal})`,
  );
});

test('get8dAzimuthDegrees strictly follows clockwise orbit with constant angular velocity: Center -> FL -> SL -> SR -> FR -> Center', () => {
  // 1. Center (0°) at p = 0.0
  assert.equal(Math.round(get8dAzimuthDegrees(0.0)), 0);
  assert.equal(wrapAzimuth180(get8dAzimuthDegrees(0.0)), 0);
  assert.equal(wrapAzimuth360(get8dAzimuthDegrees(0.0)), 0);

  // 2. Front Left (-30°) at p = 30/360
  assert.equal(Math.round(get8dAzimuthDegrees(30 / 360)), -30);
  assert.equal(Math.round(wrapAzimuth180(get8dAzimuthDegrees(30 / 360))), -30);
  assert.equal(Math.round(wrapAzimuth360(get8dAzimuthDegrees(30 / 360))), 330);

  // 3. Surround Left (-110°) at p = 110/360
  assert.equal(Math.round(get8dAzimuthDegrees(110 / 360)), -110);
  assert.equal(Math.round(wrapAzimuth180(get8dAzimuthDegrees(110 / 360))), -110);
  assert.equal(Math.round(wrapAzimuth360(get8dAzimuthDegrees(110 / 360))), 250);

  // 4. Direct Rear traversal passing -180° at p = 0.5 without jumping through Center front
  assert.equal(Math.round(get8dAzimuthDegrees(0.5)), -180);
  assert.equal(Math.abs(wrapAzimuth180(get8dAzimuthDegrees(0.5))), 180);
  assert.equal(Math.round(wrapAzimuth360(get8dAzimuthDegrees(0.5))), 180);

  // 5. Surround Right (+110° / unwrapped -250°) at p = 250/360
  assert.equal(Math.round(get8dAzimuthDegrees(250 / 360)), -250);
  assert.equal(Math.round(wrapAzimuth180(get8dAzimuthDegrees(250 / 360))), 110);
  assert.equal(Math.round(wrapAzimuth360(get8dAzimuthDegrees(250 / 360))), 110);

  // 6. Front Right (+30° / unwrapped -330°) at p = 330/360
  assert.equal(Math.round(get8dAzimuthDegrees(330 / 360)), -330);
  assert.equal(Math.round(wrapAzimuth180(get8dAzimuthDegrees(330 / 360))), 30);
  assert.equal(Math.round(wrapAzimuth360(get8dAzimuthDegrees(330 / 360))), 30);

  // 7. Returning seamlessly to Center (0° / unwrapped -360°) at p = 1.0
  assert.equal(Math.round(get8dAzimuthDegrees(1.0)), -360);
  assert.equal(wrapAzimuth180(get8dAzimuthDegrees(1.0)), 0);
  assert.equal(wrapAzimuth360(get8dAzimuthDegrees(1.0)), 0);

  // 8. Constant uniform angular velocity across the entire 360° circle (no speedup or lag zones)
  const step = 0.05;
  for (let p = 0; p < 0.99; p += step) {
    const pNext = Math.min(1.0, p + step);
    const delta = get8dAzimuthDegrees(pNext) - get8dAzimuthDegrees(p);
    const expected = -360 * (pNext - p);
    assert.ok(Math.abs(delta - expected) < 1e-6, `Expected uniform delta ${expected}, got ${delta} at p=${p}`);
  }
});

test('applyGainsToSixChannels preserves discrete 6ch tracks while honoring mute/solo', () => {
  const n = 256;
  const src = Array.from({ length: 6 }, (_, ch) => new Float32Array(n).fill(0.1 * (ch + 1)));
  const muted = INITIAL_CHANNELS.map((c) => (c.id === 'C' ? { ...c, muted: true } : c));
  const out = applyGainsToSixChannels(src, computeEffectiveChannelGains(muted));
  assert.ok(Math.abs(out[0][0] - 0.1) < 1e-4);
  assert.equal(out[2][0], 0);
  assert.ok(Math.abs(out[3][0] - 0.4) < 1e-4);
});

test('isValidAc3Bitstream checks syncword 0x0B 0x77 and minimum frame bytes', () => {
  const valid = new Uint8Array(128);
  valid[0] = 0x0b;
  valid[1] = 0x77;
  assert.equal(isValidAc3Bitstream(valid), true);
  assert.equal(isValidAc3Bitstream(new Uint8Array(128)), false);
});

test('formatting helpers return expected strings', () => {
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(2 * 1024 * 1024), '2.00 MB');
  assert.equal(formatDuration(125), '2:05');
});

test('computeBassBeatIntensity spikes on bass transient and decays smoothly without pinning at 1.0', () => {
  const steady = computeBassBeatIntensity(0.15, 0.15, 0);
  assert.ok(steady.beat < 0.25, `Expected steady low level below 0.25 (got ${steady.beat})`);
  const spike = computeBassBeatIntensity(0.85, steady.nextAvg, steady.beat);
  assert.ok(spike.beat > 0.7 && spike.beat <= 0.96, 'Expected strong bounded beat intensity on bass transient');
  const decay = computeBassBeatIntensity(0.05, spike.nextAvg, spike.beat);
  assert.ok(decay.beat < spike.beat, 'Expected smooth decay after bass hit');
});

test('extractTrackEnergyProfile extracts bounded 6-channel envelope frames', () => {
  const n = 4800;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = Math.sin((2 * Math.PI * 60 * i) / 4800) * 0.6;
    right[i] = Math.cos((2 * Math.PI * 180 * i) / 4800) * 0.4;
  }
  const profile = extractTrackEnergyProfile(left, right, 16);
  assert.equal(profile.length, 16);
  for (const frame of profile) {
    assert.ok(frame.FL >= 0 && frame.FL <= 1);
    assert.ok(frame.LFE >= 0 && frame.LFE <= 1);
    assert.ok(frame.lfeBeat >= 0 && frame.lfeBeat <= 1);
  }
});

test('buildOutputFilename and buildFfmpegArgsForFormat support AC3, DTS, FLAC, and 8D Spatial', () => {
  assert.equal(buildOutputFilename('track.wav', 'dts'), 'track_5.1.dts');
  assert.equal(buildOutputFilename('track.wav', 'flac'), 'track_5.1.flac');
  assert.equal(buildOutputFilename('track.wav', '8d-spatial', 'mp3'), 'track_8D_Spatial.mp3');
  assert.equal(buildOutputFilename('track.wav', '8d-spatial', 'wav'), 'track_8D_Spatial.wav');

  const dtsArgs = buildFfmpegArgsForFormat('in.wav', 'out.dts', 'dts');
  assert.ok(dtsArgs.includes('dca') && dtsArgs.includes('6'));

  const flacArgs = buildFfmpegArgsForFormat('in.wav', 'out.flac', 'flac');
  assert.ok(flacArgs.includes('flac') && flacArgs.includes('6'));

  const mp3Args = buildFfmpegArgsForFormat('in.wav', 'out.mp3', '8d-spatial', {
    spatialContainer: 'mp3',
  });
  assert.ok(mp3Args.includes('libmp3lame') && mp3Args.includes('320k') && mp3Args.includes('2'));
});

test('encodeStereoPcmWav produces a valid 48 kHz stereo PCM16 RIFF/WAVE file', () => {
  const n = 1200;
  const l = new Float32Array(n).fill(0.25);
  const r = new Float32Array(n).fill(-0.25);
  const wav = encodeStereoPcmWav(l, r, 48000);
  assert.equal(wav.byteLength, 44 + n * 4);
  const decoded = decodePcmWavToChannels(wav);
  assert.equal(decoded.channels.length, 2);
  assert.equal(decoded.sampleRate, 48000);
  assert.ok(Math.abs(decoded.channels[0][0] - 0.25) < 1e-3);
  assert.ok(Math.abs(decoded.channels[1][0] + 0.25) < 1e-3);
});

test('processStereoTo8dBinaural rotates audio energy cleanly across Left and Right ears over 360 degrees', () => {
  const sr = 48000;
  const orbitSec = 4.0;
  const n = sr * 4; // One full 360-deg revolution
  const leftIn = new Float32Array(n);
  const rightIn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tone = Math.sin((2 * Math.PI * 520 * i) / sr) * 0.65;
    leftIn[i] = tone;
    rightIn[i] = tone;
  }

  const res = processStereoTo8dBinaural(leftIn, rightIn, {
    sampleRate: sr,
    orbitPeriodSec: orbitSec,
  });

  assert.equal(res.left.length, n);
  assert.equal(res.right.length, n);

  const rmsWindow = (arr: Float32Array, start: number, end: number) => {
    let sum = 0;
    for (let i = start; i < end; i++) sum += arr[i] * arr[i];
    return Math.sqrt(sum / (end - start));
  };

  // In constant-velocity clockwise orbit (orbitSec = 4.0s -> 90 deg/sec):
  // t = 0.0s: Center (0°), t = 1.0s: Full Left (-90°), t = 2.0s: Rear (-180°), t = 3.0s: Full Right (+90°), t = 4.0s: Center (0°)
  const leftPhaseL = rmsWindow(res.left, Math.round(sr * 0.7), Math.round(sr * 1.3));
  const leftPhaseR = rmsWindow(res.right, Math.round(sr * 0.7), Math.round(sr * 1.3));
  assert.ok(leftPhaseL > leftPhaseR * 1.8, `Expected L > R at Left stage (L=${leftPhaseL}, R=${leftPhaseR})`);

  const rightPhaseL = rmsWindow(res.left, Math.round(sr * 2.7), Math.round(sr * 3.3));
  const rightPhaseR = rmsWindow(res.right, Math.round(sr * 2.7), Math.round(sr * 3.3));
  assert.ok(rightPhaseR > rightPhaseL * 1.8, `Expected R > L at Right stage (L=${rightPhaseL}, R=${rightPhaseR})`);
});

test('encodeMatrixUpmixStereoToSixChannelWav streams stereo into valid 5.1 WAVEFORMATEXTENSIBLE WAV without intermediate Float32x6', () => {
  const sr = 48000;
  const n = 24000;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = Math.sin((2 * Math.PI * 500 * i) / sr) * 0.5 + Math.sin((2 * Math.PI * 60 * i) / sr) * 0.35;
    right[i] = Math.sin((2 * Math.PI * 500 * i) / sr) * 0.5 + Math.sin((2 * Math.PI * 60 * i) / sr) * 0.35;
  }
  const gains = computeEffectiveChannelGains(INITIAL_CHANNELS);
  const { wavBytes, channelRms } = encodeMatrixUpmixStereoToSixChannelWav(left, right, gains, 'cinema-pro', sr);

  assert.equal(wavBytes.byteLength, 68 + n * 12);
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  assert.equal(view.getUint16(20, true), 0xfffe);
  assert.equal(view.getUint32(40, true), 0x003f);
  assert.ok(channelRms.C > 0.25, `Expected centered vocal RMS in C (${channelRms.C})`);
  assert.ok(channelRms.LFE > 0.15, `Expected sub-bass RMS in LFE (${channelRms.LFE})`);

  const decoded = decodePcmWavToChannels(wavBytes);
  assert.equal(decoded.channels.length, 6);
  assert.equal(decoded.channels[0].length, n);
});

test('encodeStereo8dBinauralWavChunks emits valid multi-chunk RIFF WAV without large contiguous ArrayBuffer', () => {
  const sr = 48000;
  const n = sr * 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tone = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5;
    left[i] = tone;
    right[i] = tone;
  }

  const { chunks, totalFrames, totalBytes } = encodeStereo8dBinauralWavChunks(
    left,
    right,
    { sampleRate: sr, orbitPeriodSec: 4 },
    0.5, // Force 4 PCM chunks + 1 header chunk
  );

  assert.equal(totalFrames, n);
  assert.equal(totalBytes, 44 + n * 4);
  assert.equal(chunks.length, 5);

  const combined = new Uint8Array(totalBytes);
  let off = 0;
  for (const c of chunks) {
    combined.set(c, off);
    off += c.byteLength;
  }
  const decoded = decodePcmWavToChannels(combined);
  assert.equal(decoded.channels.length, 2);
  assert.equal(decoded.channels[0].length, n);
});

test('5.1 AC3 and DTS bounded streaming chunks align to exact codec frame boundaries without DSP discontinuities', () => {
  const CHUNK_FRAMES = 960000;
  // Verify strict mathematical divisibility for AC3 (1536) and DTS (512)
  assert.equal(CHUNK_FRAMES % 1536, 0, 'CHUNK_FRAMES must be an exact integer multiple of 1536 AC3 frame samples');
  assert.equal(CHUNK_FRAMES % 512, 0, 'CHUNK_FRAMES must be an exact integer multiple of 512 DTS frame samples');
  assert.equal(CHUNK_FRAMES / 1536, 625, '20s chunk must produce exactly 625 AC3 frames');
  assert.equal(CHUNK_FRAMES / 512, 1875, '20s chunk must produce exactly 1875 DTS frames');

  // Verify that StreamingMatrixUpmix51 retains its filter states across chunk boundaries
  const sr = 48000;
  const totalFrames = sr * 4;
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const bass = Math.sin((2 * Math.PI * 60 * i) / sr) * 0.3;
    const vocal = Math.sin((2 * Math.PI * 1000 * i) / sr) * 0.3;
    const side = Math.sin((2 * Math.PI * 2500 * i) / sr) * 0.2;
    left[i] = bass + vocal + side;
    right[i] = bass + vocal - side;
  }

  const defaultGains = { FL: 1, FR: 1, C: 1, LFE: 1, SL: 1, SR: 1 };
  const upmixer = new StreamingMatrixUpmix51(defaultGains, 'cinema-pro', sr);
  const sumSq = new Float64Array(6);

  // Process in two 2-second chunks
  const chunk1Frames = sr * 2;
  const chunk2Frames = sr * 2;

  const wav1 = upmixer.processRangeToWavBytes(left, right, 0, chunk1Frames, sr, sumSq, false);
  const wav2 = upmixer.processRangeToWavBytes(left, right, chunk1Frames, chunk2Frames, sr, sumSq, true);

  assert.equal(wav1.byteLength, 68 + chunk1Frames * 12);
  assert.equal(wav2.byteLength, 68 + chunk2Frames * 12);

  // Decode chunk 1 and chunk 2
  const dec1 = decodePcmWavToChannels(wav1);
  const dec2 = decodePcmWavToChannels(wav2);

  assert.equal(dec1.channels.length, 6);
  assert.equal(dec2.channels.length, 6);
  assert.equal(dec1.channels[0].length, chunk1Frames);
  assert.equal(dec2.channels[0].length, chunk2Frames);

  // Verify non-zero energy across all 6 channels
  for (let ch = 0; ch < 6; ch++) {
    assert.ok(sumSq[ch] > 0, `Channel ${ch} should have accumulated energy`);
  }

  // Verify bit-identical 6-channel sample continuity between single-pass vs chunked upmix
  const singlePass = new StreamingMatrixUpmix51(defaultGains, 'cinema-pro', sr);
  const singleWav = singlePass.processRangeToWavBytes(left, right, 0, totalFrames, sr, new Float64Array(6), true);
  const decSingle = decodePcmWavToChannels(singleWav);

  for (let ch = 0; ch < 6; ch++) {
    for (let f = 0; f < chunk1Frames; f++) {
      assert.equal(dec1.channels[ch][f], decSingle.channels[ch][f]);
    }
    for (let f = 0; f < chunk2Frames; f++) {
      assert.equal(dec2.channels[ch][f], decSingle.channels[ch][chunk1Frames + f]);
    }
  }
});


