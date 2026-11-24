import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversionNotificationCopy,
  computeConversionTelemetry,
  createAbortError,
  isAbortError,
  parseJobSnapshot,
  serializeJobSnapshot,
  shouldEmitProgressUpdate,
  type JobSnapshot,
} from './backgroundConversion';

test('buildConversionNotificationCopy formats completion, cancellation, and error alerts clearly', () => {
  const ok = buildConversionNotificationCopy({
    kind: 'completed',
    filename: 'concert.flac',
    outputFilename: 'concert_5.1.ac3',
    formatLabel: '448 kbps AC3',
    sizeLabel: '18.4 MB',
  });
  assert.equal(ok.title, 'Surround X — Conversion Complete');
  assert.match(ok.body, /concert_5\.1\.ac3/);
  assert.match(ok.body, /18\.4 MB · 448 kbps AC3/);
  assert.match(ok.body, /ready to access and play/i);

  const cancelled = buildConversionNotificationCopy({
    kind: 'cancelled',
    filename: 'concert.flac',
  });
  assert.equal(cancelled.title, 'Surround X — Conversion Cancelled');
  assert.match(cancelled.body, /concert\.flac/);

  const err = buildConversionNotificationCopy({
    kind: 'error',
    filename: 'broken.mp3',
    errorMessage: 'Corrupt stream header',
  });
  assert.equal(err.title, 'Surround X — Conversion Failed');
  assert.equal(err.body, 'Corrupt stream header');
});

test('shouldEmitProgressUpdate throttles redundant ticks while emitting milestones cleanly', () => {
  assert.equal(
    shouldEmitProgressUpdate({
      prevProgress: 10,
      nextProgress: 10,
      prevTimestampMs: 1000,
      nextTimestampMs: 1200,
    }),
    false,
  );
  assert.equal(
    shouldEmitProgressUpdate({
      prevProgress: 10,
      nextProgress: 11,
      prevTimestampMs: 1000,
      nextTimestampMs: 1150,
    }),
    false,
  );
  assert.equal(
    shouldEmitProgressUpdate({
      prevProgress: 10,
      nextProgress: 12,
      prevTimestampMs: 1000,
      nextTimestampMs: 1150,
    }),
    true,
  );
  assert.equal(
    shouldEmitProgressUpdate({
      prevProgress: 10,
      nextProgress: 11,
      prevTimestampMs: 1000,
      nextTimestampMs: 1600,
    }),
    true,
  );
  assert.equal(
    shouldEmitProgressUpdate({
      prevProgress: 99,
      nextProgress: 100,
      prevTimestampMs: 1000,
      nextTimestampMs: 1010,
    }),
    true,
  );
});

test('serializeJobSnapshot and parseJobSnapshot round-trip safely and reject malformed payloads', () => {
  const snap: JobSnapshot = {
    jobId: 'job-42',
    status: 'completed',
    filename: 'symphony.wav',
    outputFilename: 'symphony_5.1.ac3',
    formatLabel: '640 kbps AC3',
    sizeLabel: '24.2 MB',
    progressPct: 100,
    message: 'Done',
    updatedAt: 1700000000000,
  };

  const parsed = parseJobSnapshot(serializeJobSnapshot(snap));
  assert.deepEqual(parsed, snap);
  assert.equal(parseJobSnapshot(null), null);
  assert.equal(parseJobSnapshot('{not valid json'), null);
  assert.equal(parseJobSnapshot(JSON.stringify({ status: 'completed' })), null);
});

test('createAbortError and isAbortError identify cancelled conversions accurately', () => {
  const abortErr = createAbortError();
  assert.equal(isAbortError(abortErr), true);
  assert.equal(isAbortError(new Error('FFmpeg crash')), false);
  assert.equal(isAbortError(null), false);
});

test('computeConversionTelemetry formats elapsed and remaining ETA cleanly', () => {
  const early = computeConversionTelemetry(6, 300);
  assert.equal(early.elapsedLabel, '0:00');
  assert.equal(early.etaLabel, 'Estimating...');

  const mid = computeConversionTelemetry(50, 4000);
  assert.equal(mid.elapsedLabel, '0:04');
  assert.equal(mid.etaLabel, '~0:04 left');

  const done = computeConversionTelemetry(100, 2450);
  assert.equal(done.elapsedLabel, '0:02');
  assert.equal(done.etaLabel, '2.5s total');
});
