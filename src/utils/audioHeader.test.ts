import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFfmpegChunkDecodeArgs,
  buildStereoWavHeaderBytes,
  computeAdaptiveChunkDurationSec,
  computeChunkWindows,
  isFastInputSeekFormat,
  parseAudioHeaderBytes,
} from './audioHeader';
import { createDemoStereoWavBuffer } from './channelMath';

test('parseAudioHeaderBytes reads WAV sampleRate, channels, and exact duration from header slice', () => {
  const wav = createDemoStereoWavBuffer(6, 48000);
  const slice = wav.subarray(0, 1024);
  const parsed = parseAudioHeaderBytes(slice, 'test.wav', wav.byteLength);

  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.sourceChannels, 2);
  assert.ok(parsed.durationSec !== null && Math.abs(parsed.durationSec - 6) < 0.05);
});

test('parseAudioHeaderBytes reads FLAC STREAMINFO metadata accurately', () => {
  const buf = new Uint8Array(64);
  // "fLaC"
  buf[0] = 0x66;
  buf[1] = 0x4c;
  buf[2] = 0x61;
  buf[3] = 0x43;
  // STREAMINFO block (type 0, length 34)
  buf[4] = 0x80;
  // At offset 18..21: sampleRate = 96000 (20 bits), channels = 6 (bits = 5), bps = 24 (bits = 23)
  // 96000 = 0x17700 -> upper 16 bits in bytes 18..19 = 0x17, 0x70; low 4 bits = 0x0; ch-1=5 (101b) -> byte 20 = 0x0A
  buf[18] = 0x17;
  buf[19] = 0x70;
  buf[20] = 0x0a;
  // totalSamples = 96000 * 10 = 960000 = 0x000EA600
  buf[21] = 0x70; // bps low + totalSamplesHigh=0
  buf[22] = 0x00;
  buf[23] = 0x0e;
  buf[24] = 0xa6;
  buf[25] = 0x00;

  const parsed = parseAudioHeaderBytes(buf, 'concert.flac', 200_000_000);
  assert.equal(parsed.sampleRate, 96000);
  assert.equal(parsed.sourceChannels, 6);
  assert.ok(parsed.durationSec !== null && Math.abs(parsed.durationSec - 10) < 0.01);
});

test('computeChunkWindows splits long durations into bounded 20s slices without gaps', () => {
  const windows = computeChunkWindows(65, 20, 1800);
  assert.equal(windows.length, 4);
  assert.deepEqual(windows[0], { index: 0, startSec: 0, durationSec: 20 });
  assert.deepEqual(windows[1], { index: 1, startSec: 20, durationSec: 20 });
  assert.deepEqual(windows[2], { index: 2, startSec: 40, durationSec: 20 });
  assert.deepEqual(windows[3], { index: 3, startSec: 60, durationSec: 5 });
});

test('buildStereoWavHeaderBytes and buildFfmpegChunkDecodeArgs produce valid outputs', () => {
  const hdr = buildStereoWavHeaderBytes(96000 * 4, 48000);
  assert.equal(hdr.byteLength, 44);
  const view = new DataView(hdr.buffer);
  assert.equal(view.getUint32(40, true), 96000 * 4);

  const wavArgs = buildFfmpegChunkDecodeArgs({
    inputPath: '/input/big.wav',
    outputWavPath: 'dec.wav',
    startSec: 20,
    durationSec: 20,
    inputExt: 'wav',
  });
  assert.equal(wavArgs.indexOf('-ss') < wavArgs.indexOf('-i'), true);

  const mp3Args = buildFfmpegChunkDecodeArgs({
    inputPath: '/input/song.mp3',
    outputWavPath: 'dec.wav',
    startSec: 20,
    durationSec: 20,
    inputExt: 'mp3',
  });
  assert.equal(mp3Args.indexOf('-ss') > mp3Args.indexOf('-i'), true);
});

test('computeAdaptiveChunkDurationSec picks fast frame-aligned windows for small files and 20s for large files', () => {
  const smallChunk = computeAdaptiveChunkDurationSec(4 * 1024 * 1024, 180, false);
  assert.equal(smallChunk, 60);
  assert.equal((smallChunk * 48000) % 1536, 0);
  assert.equal((smallChunk * 48000) % 512, 0);

  const mediumChunk = computeAdaptiveChunkDurationSec(25 * 1024 * 1024, 300, false);
  assert.equal(mediumChunk, 40);
  assert.equal((mediumChunk * 48000) % 1536, 0);
  assert.equal((mediumChunk * 48000) % 512, 0);

  const longCompactMp3Chunk = computeAdaptiveChunkDurationSec(18 * 1024 * 1024, 960, false);
  assert.equal(longCompactMp3Chunk, 60);

  const longHighBitrateMp3Chunk = computeAdaptiveChunkDurationSec(38 * 1024 * 1024, 960, false);
  assert.equal(longHighBitrateMp3Chunk, 40);

  const largeChunk = computeAdaptiveChunkDurationSec(120 * 1024 * 1024, 1200, false);
  assert.equal(largeChunk, 20);

  assert.equal(isFastInputSeekFormat('flac'), true);
  assert.equal(isFastInputSeekFormat('mp3'), false);
});
