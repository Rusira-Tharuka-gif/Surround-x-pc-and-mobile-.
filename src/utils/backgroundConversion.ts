import { Capacitor, registerPlugin } from '@capacitor/core';

export type BackgroundJobStatus = 'idle' | 'converting' | 'completed' | 'error' | 'cancelled';

export interface SurroundDesktopBridge {
  platform: string;
  isElectron: boolean;
  notifyConversionState?: (state: {
    status: BackgroundJobStatus;
    filename?: string;
    progressPct?: number;
    outputFilename?: string;
    formatLabel?: string;
    sizeLabel?: string;
    message?: string;
  }) => void;
  showWindow?: () => Promise<void>;
}

interface BackgroundConversionNativePlugin {
  ensureNotificationPermission(): Promise<{ granted: boolean }>;
  startConversion(options: {
    jobId: string;
    filename: string;
    phaseLabel: string;
    progress: number;
  }): Promise<void>;
  updateProgress(options: {
    jobId: string;
    filename: string;
    phaseLabel: string;
    progress: number;
  }): Promise<void>;
  completeConversion(options: {
    jobId: string;
    title: string;
    body: string;
  }): Promise<void>;
  failConversion(options: {
    jobId: string;
    title: string;
    body: string;
    cancelled: boolean;
  }): Promise<void>;
}

const BackgroundConversionPlugin = registerPlugin<BackgroundConversionNativePlugin>(
  'BackgroundConversion',
);

export interface ConversionAlertState {
  id: string;
  kind: 'completed' | 'error' | 'cancelled';
  title: string;
  body: string;
  outputFilename?: string;
  timestamp: number;
}

export interface JobSnapshot {
  jobId: string;
  status: BackgroundJobStatus;
  filename: string;
  outputFilename?: string;
  formatLabel?: string;
  sizeLabel?: string;
  progressPct: number;
  message?: string;
  updatedAt: number;
}

const SNAPSHOT_STORAGE_KEY = 'surroundx.background.job.v1';

export function createAbortError(message = 'Audio conversion was cancelled.'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { name?: string; message?: string };
  return (
    record.name === 'AbortError' ||
    (typeof record.message === 'string' && /conversion was cancelled/i.test(record.message))
  );
}

export function buildConversionNotificationCopy(params: {
  kind: 'completed' | 'error' | 'cancelled';
  filename: string;
  outputFilename?: string;
  formatLabel?: string;
  sizeLabel?: string;
  errorMessage?: string;
}): { title: string; body: string } {
  const { kind, filename, outputFilename, formatLabel, sizeLabel, errorMessage } = params;

  if (kind === 'completed') {
    const targetName = outputFilename || filename || 'Audio file';
    const details = [sizeLabel, formatLabel].filter(Boolean).join(' · ');
    return {
      title: 'Surround X — Conversion Complete',
      body: details
        ? `${targetName} (${details}) is ready to access and play.`
        : `${targetName} is ready to access and play.`,
    };
  }

  if (kind === 'cancelled') {
    return {
      title: 'Surround X — Conversion Cancelled',
      body: filename ? `Stopped processing ${filename}.` : 'Audio conversion was cancelled.',
    };
  }

  return {
    title: 'Surround X — Conversion Failed',
    body: errorMessage || `Unable to finish converting ${filename || 'audio file'}.`,
  };
}

export function shouldEmitProgressUpdate(params: {
  prevProgress: number;
  nextProgress: number;
  prevTimestampMs: number;
  nextTimestampMs: number;
  minStepPct?: number;
  minIntervalMs?: number;
}): boolean {
  const {
    prevProgress,
    nextProgress,
    prevTimestampMs,
    nextTimestampMs,
    minStepPct = 2,
    minIntervalMs = 450,
  } = params;

  const clampedNext = Math.max(0, Math.min(100, Math.round(nextProgress)));
  const clampedPrev = Math.max(0, Math.min(100, Math.round(prevProgress)));

  if (clampedNext <= clampedPrev) return false;
  if (clampedNext === 100 && clampedPrev < 100) return true;
  if (clampedNext - clampedPrev >= minStepPct) return true;
  if (nextTimestampMs - prevTimestampMs >= minIntervalMs) return true;
  return false;
}

export function serializeJobSnapshot(snapshot: JobSnapshot): string {
  return JSON.stringify(snapshot);
}

export function parseJobSnapshot(raw: string | null | undefined): JobSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<JobSnapshot>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.jobId !== 'string') {
      return null;
    }
    return {
      jobId: parsed.jobId,
      status:
        parsed.status === 'converting' ||
        parsed.status === 'completed' ||
        parsed.status === 'error' ||
        parsed.status === 'cancelled'
          ? parsed.status
          : 'idle',
      filename: typeof parsed.filename === 'string' ? parsed.filename : '',
      outputFilename: typeof parsed.outputFilename === 'string' ? parsed.outputFilename : undefined,
      formatLabel: typeof parsed.formatLabel === 'string' ? parsed.formatLabel : undefined,
      sizeLabel: typeof parsed.sizeLabel === 'string' ? parsed.sizeLabel : undefined,
      progressPct: Number.isFinite(parsed.progressPct) ? Number(parsed.progressPct) : 0,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveJobSnapshot(snapshot: JobSnapshot): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SNAPSHOT_STORAGE_KEY, serializeJobSnapshot(snapshot));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function loadJobSnapshot(): JobSnapshot | null {
  try {
    if (typeof sessionStorage !== 'undefined') {
      return parseJobSnapshot(sessionStorage.getItem(SNAPSHOT_STORAGE_KEY));
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

export function clearJobSnapshot(): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(SNAPSHOT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

function getDesktopBridge(): SurroundDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as { surroundDesktop?: SurroundDesktopBridge };
  return win.surroundDesktop?.isElectron ? win.surroundDesktop : null;
}

function isAndroidNative(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export function getRuntimeEnvironmentLabel(): 'windows-desktop' | 'android-native' | 'web' {
  if (getDesktopBridge()) return 'windows-desktop';
  if (isAndroidNative()) return 'android-native';
  return 'web';
}

class BackgroundConversionManager {
  private activeJobId: string | null = null;
  private lastEmitPct = -1;
  private lastEmitTime = 0;
  private alertedJobIds = new Set<string>();

  startJob(params: {
    jobId: string;
    filename: string;
    formatLabel: string;
    phaseLabel: string;
  }): void {
    const { jobId, filename, formatLabel, phaseLabel } = params;
    this.activeJobId = jobId;
    this.lastEmitPct = 0;
    this.lastEmitTime = Date.now();

    saveJobSnapshot({
      jobId,
      status: 'converting',
      filename,
      formatLabel,
      progressPct: 0,
      updatedAt: Date.now(),
    });

    const desktop = getDesktopBridge();
    if (desktop?.notifyConversionState) {
      desktop.notifyConversionState({
        status: 'converting',
        filename,
        progressPct: 0,
        formatLabel,
      });
    }

    if (isAndroidNative()) {
      void BackgroundConversionPlugin.ensureNotificationPermission().catch(() => undefined);
      void BackgroundConversionPlugin.startConversion({
        jobId,
        filename,
        phaseLabel,
        progress: 0,
      }).catch(() => undefined);
    } else if (
      !desktop &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    ) {
      void Notification.requestPermission().catch(() => undefined);
    }
  }

  updateProgress(params: {
    jobId: string;
    filename: string;
    formatLabel: string;
    phaseLabel: string;
    progressPct: number;
  }): void {
    const { jobId, filename, formatLabel, phaseLabel, progressPct } = params;
    if (this.activeJobId !== jobId) return;

    const now = Date.now();
    if (
      !shouldEmitProgressUpdate({
        prevProgress: this.lastEmitPct,
        nextProgress: progressPct,
        prevTimestampMs: this.lastEmitTime,
        nextTimestampMs: now,
      })
    ) {
      return;
    }

    const rounded = Math.max(0, Math.min(100, Math.round(progressPct)));
    this.lastEmitPct = rounded;
    this.lastEmitTime = now;

    saveJobSnapshot({
      jobId,
      status: 'converting',
      filename,
      formatLabel,
      progressPct: rounded,
      updatedAt: now,
    });

    const desktop = getDesktopBridge();
    if (desktop?.notifyConversionState) {
      desktop.notifyConversionState({
        status: 'converting',
        filename,
        progressPct: rounded,
        formatLabel,
      });
    }

    if (isAndroidNative()) {
      void BackgroundConversionPlugin.updateProgress({
        jobId,
        filename,
        phaseLabel,
        progress: rounded,
      }).catch(() => undefined);
    }
  }

  completeJob(params: {
    jobId: string;
    filename: string;
    outputFilename: string;
    formatLabel: string;
    sizeLabel: string;
  }): ConversionAlertState {
    const { jobId, filename, outputFilename, formatLabel, sizeLabel } = params;
    const copy = buildConversionNotificationCopy({
      kind: 'completed',
      filename,
      outputFilename,
      formatLabel,
      sizeLabel,
    });

    if (this.activeJobId === jobId) {
      this.activeJobId = null;
    }

    saveJobSnapshot({
      jobId,
      status: 'completed',
      filename,
      outputFilename,
      formatLabel,
      sizeLabel,
      progressPct: 100,
      message: copy.body,
      updatedAt: Date.now(),
    });

    if (!this.alertedJobIds.has(jobId)) {
      this.alertedJobIds.add(jobId);

      const desktop = getDesktopBridge();
      if (desktop?.notifyConversionState) {
        desktop.notifyConversionState({
          status: 'completed',
          filename,
          outputFilename,
          formatLabel,
          sizeLabel,
          progressPct: 100,
        });
      } else if (isAndroidNative()) {
        void BackgroundConversionPlugin.completeConversion({
          jobId,
          title: copy.title,
          body: copy.body,
        }).catch(() => undefined);
      } else {
        this.showWebBackgroundNotification(copy.title, copy.body);
      }
    }

    return {
      id: jobId,
      kind: 'completed',
      title: copy.title,
      body: copy.body,
      outputFilename,
      timestamp: Date.now(),
    };
  }

  failJob(params: {
    jobId: string;
    filename: string;
    errorMessage: string;
    cancelled: boolean;
  }): ConversionAlertState {
    const { jobId, filename, errorMessage, cancelled } = params;
    const copy = buildConversionNotificationCopy({
      kind: cancelled ? 'cancelled' : 'error',
      filename,
      errorMessage,
    });

    if (this.activeJobId === jobId) {
      this.activeJobId = null;
    }

    saveJobSnapshot({
      jobId,
      status: cancelled ? 'cancelled' : 'error',
      filename,
      progressPct: 0,
      message: copy.body,
      updatedAt: Date.now(),
    });

    if (!this.alertedJobIds.has(jobId)) {
      this.alertedJobIds.add(jobId);

      const desktop = getDesktopBridge();
      if (desktop?.notifyConversionState) {
        desktop.notifyConversionState({
          status: cancelled ? 'cancelled' : 'error',
          filename,
          progressPct: 0,
          message: copy.body,
        });
      } else if (isAndroidNative()) {
        void BackgroundConversionPlugin.failConversion({
          jobId,
          title: copy.title,
          body: copy.body,
          cancelled,
        }).catch(() => undefined);
      } else if (!cancelled) {
        this.showWebBackgroundNotification(copy.title, copy.body);
      }
    }

    return {
      id: jobId,
      kind: cancelled ? 'cancelled' : 'error',
      title: copy.title,
      body: copy.body,
      timestamp: Date.now(),
    };
  }

  private showWebBackgroundNotification(title: string, body: string): void {
    try {
      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        typeof document !== 'undefined' &&
        document.visibilityState !== 'visible'
      ) {
        const notif = new Notification(title, {
          body,
          icon: '/assets/aistudio/surround_x_emblem.png',
          tag: 'surroundx-conversion-alert',
        });
        notif.onclick = () => {
          window.focus();
          notif.close();
        };
      }
    } catch {
      // Ignore Web Notification restrictions
    }
  }
}

export const backgroundConversionManager = new BackgroundConversionManager();
