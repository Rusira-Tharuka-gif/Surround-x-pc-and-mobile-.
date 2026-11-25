import { Capacitor } from '@capacitor/core';
import type { ConversionResult, ExportFormat, SpatialContainerFormat } from './audioTypes';
import { BackgroundConversionPlugin } from './backgroundConversion';

export interface NativeSaveStartResult {
  transferId: string;
}

export interface NativeSaveFinishResult {
  savedPath: string;
  contentUri: string;
  shareUri?: string;
  locationLabel: string;
  sizeBytes: number;
}

export interface NativeFileExportPlugin {
  beginSaveOutput(options: {
    filename: string;
    mimeType: string;
    totalBytes: number;
  }): Promise<NativeSaveStartResult>;
  appendSaveChunk(options: {
    transferId: string;
    base64Chunk: string;
  }): Promise<{ bytesWritten: number }>;
  finishSaveOutput(options: {
    transferId: string;
    filename: string;
    mimeType: string;
  }): Promise<NativeSaveFinishResult>;
  abortSaveOutput(options: { transferId: string }): Promise<void>;
  shareOutputFile(options: {
    contentUri: string;
    filename: string;
    mimeType: string;
  }): Promise<void>;
  openOutputFile(options: {
    contentUri: string;
    filename: string;
    mimeType: string;
  }): Promise<void>;
}

const NativeFileExport: NativeFileExportPlugin = BackgroundConversionPlugin;

export type DownloadStatusState =
  | 'idle'
  | 'saving'
  | 'downloaded'
  | 'saved-native'
  | 'shared'
  | 'blocked'
  | 'error';

export interface DownloadExecutionOutcome {
  status: Exclude<DownloadStatusState, 'idle' | 'saving'>;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  message: string;
  savedPath?: string;
  nativeContentUri?: string;
  nativeShareUri?: string;
  canShare: boolean;
  canOpen: boolean;
}

export interface DownloadCapabilities {
  isAndroidNative: boolean;
  isWebView: boolean;
  isIOS: boolean;
  isMobileBrowser: boolean;
  downloadAttrSupported: boolean;
  hasSaveFilePicker: boolean;
  shouldAttemptAutoDownload: boolean;
}

export interface DownloadEnvironmentProbe {
  userAgent?: string;
  isNativeAndroid?: boolean;
  downloadAttrSupported?: boolean;
  hasSaveFilePicker?: boolean;
  userActivationActive?: boolean | null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ac3: 'audio/ac3',
  dts: 'audio/vnd.dts',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

const FALLBACK_EXT_BY_FORMAT: Record<ExportFormat, string> = {
  ac3: 'ac3',
  dts: 'dts',
  flac: 'flac',
  '8d-spatial': 'mp3',
};

const NATIVE_CHUNK_BYTES = 768 * 1024; // 768 KB (exact multiple of 3 for clean Base64 framing)

export function isAndroidNativeRuntime(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export function sanitizeDownloadFilename(
  filename: string,
  fallbackExtension = 'ac3',
): string {
  const leaf = (filename || '').split(/[\\/]/).pop() || '';
  const cleaned = leaf
    .replace(/[\u0000-\u001f<>:"|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  const safeExt = fallbackExtension.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'ac3';
  if (!cleaned) {
    return `Surround_X_Output.${safeExt}`;
  }
  if (!/\.[a-zA-Z0-9]{2,6}$/.test(cleaned)) {
    return `${cleaned}.${safeExt}`;
  }
  return cleaned;
}

export function resolveExportMimeType(
  format: ExportFormat,
  spatialContainer: SpatialContainerFormat = 'mp3',
  filename?: string,
): string {
  switch (format) {
    case 'ac3':
      return 'audio/ac3';
    case 'dts':
      return 'audio/vnd.dts';
    case 'flac':
      return 'audio/flac';
    case '8d-spatial':
      if (spatialContainer === 'wav') return 'audio/wav';
      if (spatialContainer === 'mp3') return 'audio/mpeg';
      break;
  }
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop() || '';
    if (MIME_BY_EXTENSION[ext]) {
      return MIME_BY_EXTENSION[ext];
    }
  }
  return 'application/octet-stream';
}

export function validateDownloadPayload(
  blob: Blob | null | undefined,
  filename: string,
  format: ExportFormat = 'ac3',
  spatialContainer: SpatialContainerFormat = 'mp3',
):
  | { ok: true; blob: Blob; sizeBytes: number; filename: string; mimeType: string }
  | { ok: false; error: string } {
  if (!blob || !(blob instanceof Blob)) {
    return {
      ok: false,
      error: 'Output file buffer is unavailable. Please run the conversion again.',
    };
  }
  if (!Number.isFinite(blob.size) || blob.size <= 0) {
    return {
      ok: false,
      error: 'Converted output is empty (0 bytes). Download aborted to prevent saving a corrupt file.',
    };
  }

  const fallbackExt =
    format === '8d-spatial' ? spatialContainer : FALLBACK_EXT_BY_FORMAT[format] || 'ac3';
  const cleanFilename = sanitizeDownloadFilename(filename, fallbackExt);
  const mimeType = resolveExportMimeType(format, spatialContainer, cleanFilename);
  const normalizedBlob = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });

  return {
    ok: true,
    blob: normalizedBlob,
    sizeBytes: normalizedBlob.size,
    filename: cleanFilename,
    mimeType,
  };
}

export function detectDownloadCapabilities(
  probe?: DownloadEnvironmentProbe,
): DownloadCapabilities {
  const isAndroidNative = probe?.isNativeAndroid ?? isAndroidNativeRuntime();
  const ua =
    probe?.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');
  const isIOS = /iPad|iPhone|iPod/i.test(ua);
  const isMobileBrowser = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const isWebView =
    isAndroidNative ||
    /; wv\b/i.test(ua) ||
    (/\bAndroid\b/i.test(ua) && /\bVersion\/\d+\.\d+/i.test(ua)) ||
    /\b(FBAN|FBAV|Instagram|Line|MicroMessenger|Snapchat)\b/i.test(ua) ||
    (isIOS && !/Safari\//i.test(ua));

  const downloadAttrSupported =
    probe?.downloadAttrSupported ??
    (typeof document !== 'undefined'
      ? 'download' in document.createElement('a')
      : true);

  const hasSaveFilePicker =
    probe?.hasSaveFilePicker ??
    (typeof window !== 'undefined' &&
      typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker ===
        'function');

  const userActivationActive =
    probe?.userActivationActive !== undefined
      ? probe.userActivationActive
      : typeof navigator !== 'undefined' &&
          'userActivation' in navigator &&
          navigator.userActivation
        ? Boolean(navigator.userActivation.isActive)
        : null;

  let shouldAttemptAutoDownload = true;
  if (isAndroidNative) {
    // Native Capacitor Android writes directly via MediaStore/Downloads in chunks
    shouldAttemptAutoDownload = true;
  } else if (isWebView || !downloadAttrSupported) {
    shouldAttemptAutoDownload = false;
  } else if (isMobileBrowser && userActivationActive === false) {
    // Mobile Chrome / Safari often silently block async anchor clicks once transient activation expires
    shouldAttemptAutoDownload = false;
  }

  return {
    isAndroidNative,
    isWebView,
    isIOS,
    isMobileBrowser,
    downloadAttrSupported,
    hasSaveFilePicker,
    shouldAttemptAutoDownload,
  };
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function canShareFilesInBrowser(blob: Blob, filename: string, mimeType: string): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      return false;
    }
    if (typeof File === 'undefined' || typeof navigator.canShare !== 'function') {
      return false;
    }
    const file = new File([blob], filename, { type: mimeType });
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export interface DownloadAdapter {
  capabilities: DownloadCapabilities;
  nativeExport: NativeFileExportPlugin;
  triggerAnchorDownload: (url: string, filename: string, mimeType: string) => void;
  createObjectUrl: (blob: Blob) => string;
  canWebShare: (blob: Blob, filename: string, mimeType: string) => boolean;
}

function createDefaultDownloadAdapter(): DownloadAdapter {
  return {
    capabilities: detectDownloadCapabilities(),
    nativeExport: NativeFileExport,
    triggerAnchorDownload: (url: string, filename: string, mimeType: string) => {
      if (typeof document === 'undefined') {
        throw new Error('Document environment is unavailable for browser download.');
      }
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.type = mimeType;
      anchor.rel = 'noopener noreferrer';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      window.setTimeout(() => {
        try {
          anchor.remove();
        } catch {
          // Ignore cleanup error
        }
      }, 1500);
    },
    createObjectUrl: (blob: Blob) => URL.createObjectURL(blob),
    canWebShare: canShareFilesInBrowser,
  };
}

function formatReadableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function saveBlobViaNativePlugin(
  blob: Blob,
  filename: string,
  mimeType: string,
  nativeExport: NativeFileExportPlugin = NativeFileExport,
  onProgress?: (pct: number) => void,
): Promise<NativeSaveFinishResult> {
  const { transferId } = await nativeExport.beginSaveOutput({
    filename,
    mimeType,
    totalBytes: blob.size,
  });

  try {
    let offset = 0;
    while (offset < blob.size) {
      const end = Math.min(blob.size, offset + NATIVE_CHUNK_BYTES);
      const buf = await blob.slice(offset, end).arrayBuffer();
      const base64Chunk = uint8ArrayToBase64(new Uint8Array(buf));
      await nativeExport.appendSaveChunk({ transferId, base64Chunk });
      offset = end;
      onProgress?.(Math.min(99, Math.round((offset / blob.size) * 100)));
    }
    const finished = await nativeExport.finishSaveOutput({
      transferId,
      filename,
      mimeType,
    });
    onProgress?.(100);
    return finished;
  } catch (err) {
    await nativeExport.abortSaveOutput({ transferId }).catch(() => undefined);
    throw err;
  }
}

export async function executeDownloadWithAdapter(
  result: Pick<ConversionResult, 'blob' | 'url' | 'outputFilename' | 'format'> & {
    spatialContainer?: SpatialContainerFormat;
  },
  options: {
    isAuto?: boolean;
    spatialContainer?: SpatialContainerFormat;
    onNativeSaveProgress?: (pct: number) => void;
    adapter?: DownloadAdapter;
  } = {},
): Promise<DownloadExecutionOutcome> {
  const spatialContainer: SpatialContainerFormat =
    options.spatialContainer ??
    (result.outputFilename.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3');

  const validated = validateDownloadPayload(
    result.blob,
    result.outputFilename,
    result.format,
    spatialContainer,
  );
  if (!validated.ok) {
    return {
      status: 'error',
      filename: result.outputFilename || 'output',
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
      message: validated.error,
      canShare: false,
      canOpen: false,
    };
  }

  const adapter = options.adapter ?? createDefaultDownloadAdapter();
  const caps = adapter.capabilities;
  const { blob, filename, mimeType, sizeBytes } = validated;
  const webShareReady = adapter.canWebShare(blob, filename, mimeType);

  if (caps.isAndroidNative) {
    try {
      const saved = await saveBlobViaNativePlugin(
        blob,
        filename,
        mimeType,
        adapter.nativeExport,
        options.onNativeSaveProgress,
      );
      return {
        status: 'saved-native',
        filename,
        mimeType,
        sizeBytes: saved.sizeBytes || sizeBytes,
        savedPath: saved.savedPath,
        nativeContentUri: saved.contentUri,
        nativeShareUri: saved.shareUri || saved.contentUri,
        message: `Saved ${filename} (${formatReadableSize(sizeBytes)}) to ${saved.locationLabel}.`,
        canShare: true,
        canOpen: true,
      };
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Unable to save file to Android Downloads folder.';
      return {
        status: 'error',
        filename,
        mimeType,
        sizeBytes,
        message: `Android download failed: ${msg} Use Share / Save or retry Download File.`,
        canShare: true,
        canOpen: false,
      };
    }
  }

  if (options.isAuto && !caps.shouldAttemptAutoDownload) {
    return {
      status: 'blocked',
      filename,
      mimeType,
      sizeBytes,
      message: caps.isWebView
        ? `In-app WebView blocked automatic blob download for ${filename}. Tap "Download File" or use Share / Open below.`
        : `Mobile browser blocked automatic download after conversion. Tap "Download File" below to save ${filename} (${formatReadableSize(sizeBytes)}).`,
      canShare: webShareReady,
      canOpen: true,
    };
  }

  try {
    const objectUrl =
      result.url && result.url.startsWith('blob:') && blob === result.blob
        ? result.url
        : adapter.createObjectUrl(blob);

    adapter.triggerAnchorDownload(objectUrl, filename, mimeType);
    return {
      status: 'downloaded',
      filename,
      mimeType,
      sizeBytes,
      message: options.isAuto
        ? `Downloading ${filename} (${formatReadableSize(sizeBytes)}). If it does not start, tap Download File below.`
        : `Download triggered for ${filename} (${formatReadableSize(sizeBytes)}).`,
      canShare: webShareReady,
      canOpen: true,
    };
  } catch (err) {
    const reason =
      err instanceof Error && err.message ? err.message : 'Browser blocked file download.';
    return {
      status: 'error',
      filename,
      mimeType,
      sizeBytes,
      message: `Download failed (${reason}). Use "Download File", "Save As / Share", or "Open File" below.`,
      canShare: webShareReady,
      canOpen: true,
    };
  }
}

export async function triggerReliableDownload(
  result: ConversionResult,
  options: {
    isAuto?: boolean;
    spatialContainer?: SpatialContainerFormat;
    onNativeSaveProgress?: (pct: number) => void;
  } = {},
): Promise<DownloadExecutionOutcome> {
  return executeDownloadWithAdapter(result, options);
}

export async function shareOrSaveOutputFallback(
  result: ConversionResult,
  options: {
    spatialContainer?: SpatialContainerFormat;
    nativeContentUri?: string;
    onNativeUriCreated?: (uris: { contentUri: string; shareUri?: string; savedPath?: string }) => void;
  } = {},
): Promise<{ ok: boolean; status: 'shared' | 'downloaded' | 'cancelled' | 'error'; message: string }> {
  const spatialContainer: SpatialContainerFormat =
    options.spatialContainer ??
    (result.outputFilename.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3');

  const validated = validateDownloadPayload(
    result.blob,
    result.outputFilename,
    result.format,
    spatialContainer,
  );
  if (!validated.ok) {
    return { ok: false, status: 'error', message: validated.error };
  }

  const { blob, filename, mimeType } = validated;

  if (isAndroidNativeRuntime()) {
    try {
      let targetUri = options.nativeContentUri;
      if (!targetUri) {
        const saved = await saveBlobViaNativePlugin(blob, filename, mimeType, NativeFileExport);
        targetUri = saved.shareUri || saved.contentUri;
        options.onNativeUriCreated?.({
          contentUri: saved.contentUri,
          shareUri: saved.shareUri,
          savedPath: saved.savedPath,
        });
      }
      await NativeFileExport.shareOutputFile({
        contentUri: targetUri,
        filename,
        mimeType,
      });
      return {
        ok: true,
        status: 'shared',
        message: `Opened Android Share / Save sheet for ${filename}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to open Android Share sheet.';
      return { ok: false, status: 'error', message: msg };
    }
  }

  // Try File System Access API (showSaveFilePicker) if available on Chromium/Android/Desktop
  const picker =
    typeof window !== 'undefined'
      ? (
          window as unknown as {
            showSaveFilePicker?: (opts: {
              suggestedName?: string;
              types?: { description: string; accept: Record<string, string[]> }[];
            }) => Promise<{
              createWritable: () => Promise<{
                write: (data: Blob) => Promise<void>;
                close: () => Promise<void>;
              }>;
            }>;
          }
        ).showSaveFilePicker
      : undefined;

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      const file = new File([blob], filename, { type: mimeType });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: filename,
          text: `Surround X converted audio: ${filename}`,
          files: [file],
        });
        return {
          ok: true,
          status: 'shared',
          message: `Shared / saved ${filename}.`,
        };
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          ok: false,
          status: 'cancelled',
          message: 'Share dialog closed before saving.',
        };
      }
      // Fall through to showSaveFilePicker / direct link
    }
  }

  if (typeof picker === 'function') {
    try {
      const ext = `.${filename.split('.').pop() || 'ac3'}`;
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'Audio File', accept: { [mimeType]: [ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return {
        ok: true,
        status: 'downloaded',
        message: `Saved ${filename} to your chosen folder.`,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          ok: false,
          status: 'cancelled',
          message: 'Save dialog cancelled.',
        };
      }
      const msg = err instanceof Error ? err.message : 'Save picker failed.';
      return { ok: false, status: 'error', message: msg };
    }
  }

  return {
    ok: false,
    status: 'error',
    message: 'System Share / Save As is unavailable in this browser. Tap "Download File" or "Open File".',
  };
}

export async function openNativeOutputFile(
  result: ConversionResult,
  options: {
    spatialContainer?: SpatialContainerFormat;
    nativeContentUri?: string;
    onNativeUriCreated?: (uris: { contentUri: string; shareUri?: string; savedPath?: string }) => void;
  } = {},
): Promise<{ ok: boolean; message: string }> {
  if (!isAndroidNativeRuntime()) {
    return {
      ok: false,
      message: 'Native Android open is only available inside the Android app.',
    };
  }

  const spatialContainer: SpatialContainerFormat =
    options.spatialContainer ??
    (result.outputFilename.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3');

  const validated = validateDownloadPayload(
    result.blob,
    result.outputFilename,
    result.format,
    spatialContainer,
  );
  if (!validated.ok) {
    return { ok: false, message: validated.error };
  }

  try {
    let targetUri = options.nativeContentUri;
    if (!targetUri) {
      const saved = await saveBlobViaNativePlugin(
        validated.blob,
        validated.filename,
        validated.mimeType,
        NativeFileExport,
      );
      targetUri = saved.contentUri;
      options.onNativeUriCreated?.({
        contentUri: saved.contentUri,
        shareUri: saved.shareUri,
        savedPath: saved.savedPath,
      });
    }
    await NativeFileExport.openOutputFile({
      contentUri: targetUri,
      filename: validated.filename,
      mimeType: validated.mimeType,
    });
    return { ok: true, message: `Opened ${validated.filename} in system player.` };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : 'No compatible media app found to open this file directly. Try Share / Save.';
    return { ok: false, message: msg };
  }
}
