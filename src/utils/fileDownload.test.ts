import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDownloadCapabilities,
  executeDownloadWithAdapter,
  resolveExportMimeType,
  sanitizeDownloadFilename,
  uint8ArrayToBase64,
  validateDownloadPayload,
  type DownloadAdapter,
} from './fileDownload';
import type { ConversionResult } from './audioTypes';

function makeDummyResult(overrides: Partial<ConversionResult> = {}): ConversionResult {
  const bytes = new Uint8Array([0x0b, 0x77, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
  const blob = new Blob([bytes], { type: 'audio/ac3' });
  return {
    blob,
    url: 'blob:https://surroundx.local/1234',
    outputFilename: 'My_Track_5.1.ac3',
    sizeBytes: bytes.byteLength,
    format: 'ac3',
    codecLabel: '448 kbps AC3',
    bitrateKbps: 448,
    sampleRate: 48000,
    channels: 6,
    elapsedMs: 420,
    usedCustomMix: true,
    ...overrides,
  };
}

test('sanitizeDownloadFilename removes path traversal and invalid filesystem characters while preserving extension', () => {
  assert.equal(sanitizeDownloadFilename('../../bad:name*?.ac3', 'ac3'), 'bad_name_.ac3');
  assert.equal(sanitizeDownloadFilename('   ', 'dts'), 'Surround_X_Output.dts');
  assert.equal(sanitizeDownloadFilename('Track Name 5.1.flac', 'flac'), 'Track_Name_5.1.flac');
  assert.equal(sanitizeDownloadFilename('NoExtension', 'wav'), 'NoExtension.wav');
});

test('resolveExportMimeType returns proper MIME types for AC3, DTS, FLAC, and 8D MP3/WAV', () => {
  assert.equal(resolveExportMimeType('ac3'), 'audio/ac3');
  assert.equal(resolveExportMimeType('dts'), 'audio/vnd.dts');
  assert.equal(resolveExportMimeType('flac'), 'audio/flac');
  assert.equal(resolveExportMimeType('8d-spatial', 'mp3'), 'audio/mpeg');
  assert.equal(resolveExportMimeType('8d-spatial', 'wav'), 'audio/wav');
});

test('validateDownloadPayload rejects missing or 0-byte blobs and validates non-empty output', () => {
  const emptyCheck = validateDownloadPayload(new Blob([], { type: 'audio/ac3' }), 'track_5.1.ac3', 'ac3');
  assert.equal(emptyCheck.ok, false);
  if (!emptyCheck.ok) {
    assert.match(emptyCheck.error, /empty \(0 bytes\)/i);
  }

  const missingCheck = validateDownloadPayload(null, 'track_5.1.ac3', 'ac3');
  assert.equal(missingCheck.ok, false);

  const valid = validateDownloadPayload(
    new Blob([new Uint8Array([1, 2, 3, 4])], { type: '' }),
    'track_5.1.dts',
    'dts',
  );
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.sizeBytes, 4);
    assert.equal(valid.mimeType, 'audio/vnd.dts');
    assert.equal(valid.filename, 'track_5.1.dts');
  }
});

test('detectDownloadCapabilities handles desktop, mobile browser, WebView, and Capacitor Android accurately', () => {
  const desktop = detectDownloadCapabilities({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
    isNativeAndroid: false,
    downloadAttrSupported: true,
    userActivationActive: false,
  });
  assert.equal(desktop.isWebView, false);
  assert.equal(desktop.shouldAttemptAutoDownload, true);

  const mobileInactive = detectDownloadCapabilities({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0.0.0 Mobile Safari/537.36',
    isNativeAndroid: false,
    downloadAttrSupported: true,
    userActivationActive: false,
  });
  assert.equal(mobileInactive.isMobileBrowser, true);
  assert.equal(mobileInactive.isWebView, false);
  assert.equal(mobileInactive.shouldAttemptAutoDownload, false);

  const genericWebView = detectDownloadCapabilities({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Version/4.0 Chrome/125.0 Mobile Safari/537.36',
    isNativeAndroid: false,
    downloadAttrSupported: true,
    userActivationActive: true,
  });
  assert.equal(genericWebView.isWebView, true);
  assert.equal(genericWebView.shouldAttemptAutoDownload, false);

  const capacitorAndroid = detectDownloadCapabilities({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; wv) Chrome/125.0 Mobile Safari/537.36',
    isNativeAndroid: true,
    downloadAttrSupported: true,
    userActivationActive: false,
  });
  assert.equal(capacitorAndroid.isAndroidNative, true);
  assert.equal(capacitorAndroid.shouldAttemptAutoDownload, true);
});

test('executeDownloadWithAdapter streams chunked bytes natively on Android Capacitor without anchor blob failures', async () => {
  const payload = new Uint8Array(1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

  const chunks: string[] = [];
  let finishedMeta: { filename: string; mimeType: string } | null = null;

  const adapter: DownloadAdapter = {
    capabilities: detectDownloadCapabilities({ isNativeAndroid: true, userAgent: 'Android wv' }),
    nativeExport: {
      beginSaveOutput: async () => ({ transferId: 'tx_1' }),
      appendSaveChunk: async ({ base64Chunk }) => {
        chunks.push(base64Chunk);
        return { bytesWritten: 1024 };
      },
      finishSaveOutput: async ({ filename, mimeType }) => {
        finishedMeta = { filename, mimeType };
        return {
          savedPath: `Downloads/Surround X/${filename}`,
          contentUri: 'content://media/external/downloads/99',
          shareUri: 'content://com.surroundx.studio.fileprovider/exports_cache/out.ac3',
          locationLabel: 'Downloads/Surround X',
          sizeBytes: payload.byteLength,
        };
      },
      abortSaveOutput: async () => undefined,
      shareOutputFile: async () => undefined,
      openOutputFile: async () => undefined,
    },
    triggerAnchorDownload: () => {
      throw new Error('Should not use blob anchor download on native Android');
    },
    createObjectUrl: () => 'blob:unused',
    canWebShare: () => true,
  };

  const result = makeDummyResult({
    blob: new Blob([payload], { type: 'audio/ac3' }),
    outputFilename: 'Cinema_Track_5.1.ac3',
    sizeBytes: payload.byteLength,
  });

  const outcome = await executeDownloadWithAdapter(result, { isAuto: true, adapter });
  assert.equal(outcome.status, 'saved-native');
  assert.equal(outcome.filename, 'Cinema_Track_5.1.ac3');
  assert.equal(outcome.mimeType, 'audio/ac3');
  assert.equal(outcome.nativeContentUri, 'content://media/external/downloads/99');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], uint8ArrayToBase64(payload));
  assert.deepEqual(finishedMeta, { filename: 'Cinema_Track_5.1.ac3', mimeType: 'audio/ac3' });
});

test('executeDownloadWithAdapter surfaces blocked status and errors cleanly without silent failures', async () => {
  let clicked = false;
  const blockedMobileAdapter: DownloadAdapter = {
    capabilities: detectDownloadCapabilities({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1 Mobile/15E148',
      isNativeAndroid: false,
      downloadAttrSupported: true,
      userActivationActive: false,
    }),
    nativeExport: {} as DownloadAdapter['nativeExport'],
    triggerAnchorDownload: () => {
      clicked = true;
    },
    createObjectUrl: () => 'blob:https://surroundx.local/abc',
    canWebShare: () => true,
  };

  // Auto-download on mobile without user gesture reports blocked with Share/Manual fallback
  const autoBlocked = await executeDownloadWithAdapter(makeDummyResult(), {
    isAuto: true,
    adapter: blockedMobileAdapter,
  });
  assert.equal(autoBlocked.status, 'blocked');
  assert.equal(autoBlocked.canShare, true);
  assert.equal(clicked, false);
  assert.match(autoBlocked.message, /Download File/i);

  // Manual click executes anchor download reliably
  const manualOk = await executeDownloadWithAdapter(makeDummyResult(), {
    isAuto: false,
    adapter: blockedMobileAdapter,
  });
  assert.equal(manualOk.status, 'downloaded');
  assert.equal(clicked, true);

  // Empty 0-byte blob returns error cleanly
  const emptyFail = await executeDownloadWithAdapter(
    makeDummyResult({ blob: new Blob([], { type: 'audio/ac3' }), sizeBytes: 0 }),
    { isAuto: false, adapter: blockedMobileAdapter },
  );
  assert.equal(emptyFail.status, 'error');
  assert.match(emptyFail.message, /empty/i);
});
