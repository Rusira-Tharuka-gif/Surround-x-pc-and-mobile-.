import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  AlertCircle,
  BellRing,
  CheckCircle2,
  Download,
  FileAudio,
  Loader2,
  Pause,
  Play,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  INITIAL_CHANNELS,
  type Ac3BitrateKbps,
  type AudioTrackMetadata,
  type ChannelConfig,
  type ChannelId,
  type ConversionPhase,
  type ConversionResult,
  type ExportFormat,
  type SpatialContainerFormat,
  type UpmixProfile,
} from '../utils/audioTypes';
import {
  clampGainDb,
  createDemoStereoWavBuffer,
  formatDuration,
  formatFileSize,
  isSupportedAudioFile,
  type TrackEnergyFrame,
} from '../utils/channelMath';
import { convertAudioToAc3 } from '../utils/ffmpegConverter';
import {
  backgroundConversionManager,
  clearJobSnapshot,
  getRuntimeEnvironmentLabel,
  isAbortError,
  type ConversionAlertState,
} from '../utils/backgroundConversion';
import {
  StageAudioPlayer,
  ZERO_LEVELS,
  type ChannelLevels,
} from '../utils/stageAudioPlayer';
import { AcousticStageMonitor, type StageActivityMode } from './AcousticStageMonitor';
import { Spatial8DRadar } from './Spatial8DRadar';
import { CreativeThinkingCard } from './CreativeThinkingCard';

interface ConverterStudioProps {
  demoRequestKey?: number;
  onReturnWelcome: () => void;
}

const FORMAT_OPTIONS: { value: ExportFormat; label: string; sub: string }[] = [
  { value: 'ac3', label: 'AC3', sub: '5.1 Dolby' },
  { value: 'dts', label: 'DTS', sub: '5.1 768k' },
  { value: 'flac', label: 'FLAC', sub: '5.1 Lossless' },
  { value: '8d-spatial', label: '8D Spatial', sub: '.mp3 / .wav' },
];

const BITRATE_OPTIONS: { value: Ac3BitrateKbps; label: string }[] = [
  { value: 384, label: '384 kbps' },
  { value: 448, label: '448 kbps' },
  { value: 640, label: '640 kbps' },
];

const UPMIX_OPTIONS: { value: UpmixProfile; label: string }[] = [
  { value: 'cinema-pro', label: 'Cinema Pro' },
  { value: 'ambient-hall', label: 'Ambient Hall' },
  { value: 'direct-discrete', label: 'Direct Discrete' },
];

const SPATIAL_CONTAINER_OPTIONS: { value: SpatialContainerFormat; label: string }[] = [
  { value: 'mp3', label: 'MP3 · 320 kbps' },
  { value: 'wav', label: 'WAV · Lossless' },
];

const ORBIT_SPEED_OPTIONS: { value: number; label: string }[] = [
  { value: 12, label: 'Slow (12s)' },
  { value: 8, label: 'Medium (8s)' },
  { value: 4.5, label: 'Fast (4.5s)' },
];

const PHASE_LABELS: Record<ConversionPhase, string> = {
  idle: 'Ready',
  'loading-engine': 'Initializing WASM spatial audio engine...',
  'preparing-audio': 'Preparing 48 kHz audio buffer...',
  'processing-8d': 'Rendering 360° 8D binaural spatial rotation...',
  'encoding-ac3': 'Encoding 5.1 AC3 surround stream...',
  'encoding-output': 'Encoding final spatial audio stream...',
  completed: 'Spatial audio mastering complete',
  error: 'Conversion encountered an error',
};

export function ConverterStudio({
  demoRequestKey = 0,
  onReturnWelcome,
}: ConverterStudioProps) {
  const [channels, setChannels] = useState<ChannelConfig[]>(() =>
    INITIAL_CHANNELS.map((c) => ({ ...c })),
  );
  const [selectedChannel, setSelectedChannel] = useState<ChannelId>('FL');
  const [activeSweepChannel, setActiveSweepChannel] = useState<ChannelId | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('ac3');
  const [spatialContainer, setSpatialContainer] = useState<SpatialContainerFormat>('mp3');
  const [orbitPeriodSec, setOrbitPeriodSec] = useState<number>(8);
  const [orbitAngleDeg, setOrbitAngleDeg] = useState<number | null>(null);
  const [upmixProfile, setUpmixProfile] = useState<UpmixProfile>('cinema-pro');
  const [bitrateKbps, setBitrateKbps] = useState<Ac3BitrateKbps>(448);

  const [sourceFile, setSourceFile] = useState<File | Blob | null>(null);
  const [trackMeta, setTrackMeta] = useState<AudioTrackMetadata | null>(null);
  const [isLoadingTrack, setIsLoadingTrack] = useState(false);
  const [loadingStatusText, setLoadingStatusText] = useState('Initializing audio stream...');
  const [emblemFailed, setEmblemFailed] = useState(false);
  const [energyProfile] = useState<TrackEnergyFrame[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTimeSec, setPlaybackTimeSec] = useState(0);
  const liveLevelsRef = useRef<ChannelLevels>({ ...ZERO_LEVELS });

  const [phase, setPhase] = useState<ConversionPhase>('idle');
  const [progressPct, setProgressPct] = useState(0);
  const [conversionLogs, setConversionLogs] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conversionResult, setConversionResult] = useState<ConversionResult | null>(null);
  const [alertToast, setAlertToast] = useState<ConversionAlertState | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const playerRef = useRef<StageAudioPlayer | null>(null);
  const sweepTimerRef = useRef<number | null>(null);
  const toneTimerRef = useRef<number | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const lastAngleEmitRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const currentPhaseRef = useRef<ConversionPhase>('idle');
  const runtimeEnv = getRuntimeEnvironmentLabel();

  // Initialize Web Audio Stage Player once
  useEffect(() => {
    const player = new StageAudioPlayer();
    player.setCallbacks(
      (nextLevels) => {
        liveLevelsRef.current = nextLevels;
      },
      (currentSec, playing) => {
        setPlaybackTimeSec(currentSec);
        setIsPlaying(playing);
        if (!playing) {
          liveLevelsRef.current = { ...ZERO_LEVELS };
          setOrbitAngleDeg(null);
        }
      },
      (deg) => {
        const now = performance.now();
        if (now - lastAngleEmitRef.current > 45) {
          lastAngleEmitRef.current = now;
          setOrbitAngleDeg(deg);
        }
      },
      (loading, text) => {
        setIsLoadingTrack(loading);
        if (text) setLoadingStatusText(text);
      },
    );
    playerRef.current = player;

    return () => {
      abortControllerRef.current?.abort();
      if (sweepTimerRef.current !== null) {
        window.clearTimeout(sweepTimerRef.current);
      }
      if (toneTimerRef.current !== null) {
        window.clearTimeout(toneTimerRef.current);
      }
      player.dispose();
      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current);
      }
    };
  }, []);

  // Sync stage mix configuration & 8D binaural mode to live player
  useEffect(() => {
    playerRef.current?.updateMixConfig(channels, upmixProfile, exportFormat, orbitPeriodSec);
  }, [channels, upmixProfile, exportFormat, orbitPeriodSec]);

  const loadSourceIntoStudio = useCallback(
    async (fileOrBlob: File | Blob, name: string, mimeType: string, isDemo = false) => {
      try {
        setErrorMessage(null);
        setAlertToast(null);
        clearJobSnapshot();
        setPhase('idle');
        currentPhaseRef.current = 'idle';
        setProgressPct(0);
        setConversionLogs([]);
        setIsLoadingTrack(true);
        setLoadingStatusText('Reading audio stream metadata...');

        if (resultUrlRef.current) {
          URL.revokeObjectURL(resultUrlRef.current);
          resultUrlRef.current = null;
        }
        setConversionResult(null);

        setSourceFile(fileOrBlob);
        setTrackMeta({
          name,
          sizeBytes: fileOrBlob.size,
          mimeType,
          durationSec: 0,
          sampleRate: 48000,
          sourceChannels: 2,
          isDemo,
        });

        const streamInfo = await playerRef.current?.loadAudioFile(fileOrBlob, name);
        if (streamInfo) {
          setTrackMeta({
            name,
            sizeBytes: fileOrBlob.size,
            mimeType,
            durationSec: streamInfo.durationSec,
            sampleRate: streamInfo.sampleRate,
            sourceChannels: streamInfo.sourceChannels,
            isDemo,
          });
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'Track load superseded') return;
        console.error('[Surround X][Load Audio Error]', err);
        setIsLoadingTrack(false);
        setErrorMessage(
          err instanceof Error ? err.message : 'Unable to initialize streaming playback for this audio file.',
        );
      } finally {
        setIsLoadingTrack(false);
      }
    },
    [],
  );

  const handleLoadDemoTrack = useCallback(async () => {
    const demoWav = createDemoStereoWavBuffer(8, 48000);
    const demoBlob = new Blob([demoWav as unknown as BlobPart], { type: 'audio/wav' });
    await loadSourceIntoStudio(demoBlob, 'Forest_Theater_Demo_Stereo.wav', 'audio/wav', true);
  }, [loadSourceIntoStudio]);

  useEffect(() => {
    if (demoRequestKey > 0) {
      void handleLoadDemoTrack();
    }
  }, [demoRequestKey, handleLoadDemoTrack]);

  const handleFileObject = useCallback(
    async (file: File) => {
      if (!file) return;
      if (!isSupportedAudioFile(file.name, file.type)) {
        setErrorMessage(
          `Unsupported file format (${file.name}). Please select an MP3, WAV, FLAC, AAC, M4A, OGG, OPUS, or WebM audio file.`,
        );
        return;
      }
      if (file.size === 0) {
        setErrorMessage('The selected file is empty (0 bytes). Please choose a valid audio file.');
        return;
      }
      await loadSourceIntoStudio(file, file.name, file.type || 'audio/mpeg', false);
    },
    [loadSourceIntoStudio],
  );

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFileObject(file);
    }
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleFileObject(file);
    }
  };

  const handleTogglePlayback = async () => {
    if (!playerRef.current) return;
    await playerRef.current.togglePlay();
  };

  const handleUpdateGain = (id: ChannelId, gainDb: number) => {
    const clamped = clampGainDb(gainDb);
    setChannels((prev) => prev.map((ch) => (ch.id === id ? { ...ch, gainDb: clamped } : ch)));
  };

  const handleToggleMute = (id: ChannelId) => {
    setChannels((prev) => prev.map((ch) => (ch.id === id ? { ...ch, muted: !ch.muted } : ch)));
  };

  const handleToggleSolo = (id: ChannelId) => {
    setChannels((prev) => prev.map((ch) => (ch.id === id ? { ...ch, solo: !ch.solo } : ch)));
  };

  const handleResetChannels = () => {
    setChannels(INITIAL_CHANNELS.map((c) => ({ ...c })));
    setUpmixProfile('cinema-pro');
  };

  const handleTriggerCalibrationTone = (id: ChannelId) => {
    void playerRef.current?.playChannelCalibrationTone(id);
    if (sweepTimerRef.current === null) {
      if (toneTimerRef.current !== null) {
        window.clearTimeout(toneTimerRef.current);
      }
      setActiveSweepChannel(id);
      toneTimerRef.current = window.setTimeout(() => {
        setActiveSweepChannel(null);
        toneTimerRef.current = null;
      }, 380);
    }
  };

  const handleRunSweep = () => {
    if (sweepTimerRef.current !== null) {
      window.clearTimeout(sweepTimerRef.current);
      sweepTimerRef.current = null;
      setActiveSweepChannel(null);
      return;
    }

    const order: ChannelId[] = ['FL', 'C', 'FR', 'SR', 'SL', 'LFE'];
    let idx = 0;

    const step = () => {
      if (idx >= order.length) {
        setActiveSweepChannel(null);
        sweepTimerRef.current = null;
        return;
      }
      const chId = order[idx];
      setActiveSweepChannel(chId);
      setSelectedChannel(chId);
      void playerRef.current?.playChannelCalibrationTone(chId);
      idx += 1;
      sweepTimerRef.current = window.setTimeout(step, 460);
    };

    step();
  };

  const handleCancelConversion = () => {
    if (!abortControllerRef.current) return;
    setConversionLogs((prev) => [...prev.slice(-4), 'Cancelling conversion and releasing buffers...']);
    abortControllerRef.current.abort();
  };

  const handleConvert = async () => {
    if (!sourceFile || !trackMeta) {
      setErrorMessage('Please upload an audio file or load the demo stereo track first.');
      return;
    }

    setErrorMessage(null);
    setAlertToast(null);
    setConversionLogs([]);
    setProgressPct(0);
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    setConversionResult(null);

    const jobId = `job_${Date.now().toString(36)}`;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    activeJobIdRef.current = jobId;
    currentPhaseRef.current = 'loading-engine';

    const formatLabel =
      exportFormat === '8d-spatial'
        ? `8D Spatial (.${spatialContainer})`
        : `5.1 ${exportFormat.toUpperCase()}`;

    backgroundConversionManager.startJob({
      jobId,
      filename: trackMeta.name,
      formatLabel,
      phaseLabel: PHASE_LABELS['loading-engine'],
    });

    try {
      const result = await convertAudioToAc3({
        sourceFile,
        durationSec: trackMeta.durationSec,
        sourceChannels: trackMeta.sourceChannels,
        sourceFilename: trackMeta.name,
        exportFormat,
        spatialContainer,
        orbitPeriodSec,
        bitrateKbps,
        channels,
        upmixProfile,
        signal: controller.signal,
        onPhaseChange: (nextPhase) => {
          currentPhaseRef.current = nextPhase;
          setPhase(nextPhase);
        },
        onProgress: (pct) => {
          setProgressPct(pct);
          backgroundConversionManager.updateProgress({
            jobId,
            filename: trackMeta.name,
            formatLabel,
            phaseLabel: PHASE_LABELS[currentPhaseRef.current] || 'Processing audio...',
            progressPct: pct,
          });
        },
        onLog: (line) => {
          setConversionLogs((prev) => [...prev.slice(-5), line]);
        },
      });

      resultUrlRef.current = result.url;
      setConversionResult(result);
      const completedAlert = backgroundConversionManager.completeJob({
        jobId,
        filename: trackMeta.name,
        outputFilename: result.outputFilename,
        formatLabel: result.codecLabel,
        sizeLabel: formatFileSize(result.sizeBytes),
      });
      setAlertToast(completedAlert);
    } catch (err) {
      const cancelled = controller.signal.aborted || isAbortError(err);
      const msg =
        err instanceof Error
          ? err.message
          : 'Audio conversion failed. Please verify the file and try again.';

      const failAlert = backgroundConversionManager.failJob({
        jobId,
        filename: trackMeta.name,
        errorMessage: msg,
        cancelled,
      });

      if (cancelled) {
        currentPhaseRef.current = 'idle';
        setPhase('idle');
        setProgressPct(0);
        setConversionLogs((prev) => [...prev.slice(-4), 'Conversion cancelled cleanly.']);
      } else {
        setErrorMessage(msg);
      }
      setAlertToast(failAlert);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (activeJobIdRef.current === jobId) {
        activeJobIdRef.current = null;
      }
    }
  };

  const isConverting =
    phase === 'loading-engine' ||
    phase === 'preparing-audio' ||
    phase === 'processing-8d' ||
    phase === 'encoding-ac3' ||
    phase === 'encoding-output';

  const activityMode: StageActivityMode = activeSweepChannel
    ? 'sweeping'
    : isConverting
      ? 'converting'
      : isPlaying
        ? 'playing'
        : trackMeta
          ? 'loaded'
          : 'idle';

  return (
    <div className="relative z-10 min-h-[100dvh] w-full max-w-full overflow-x-hidden flex flex-col" data-testid="converter-studio">
      {/* Floating Pop-Up Conversion Alert Toast */}
      {alertToast && (
        <div
          role="status"
          aria-live="polite"
          data-testid="conversion-popup-alert"
          className={`fixed bottom-5 right-4 z-50 w-[calc(100vw-2rem)] max-w-sm rounded-2xl p-4 backdrop-blur-xl shadow-2xl border transition-all ${
            alertToast.kind === 'completed'
              ? 'bg-[#091820]/95 border-emerald-400/55 shadow-[0_12px_40px_-8px_rgba(16,185,129,0.45)]'
              : alertToast.kind === 'cancelled'
                ? 'bg-[#0B111C]/95 border-slate-500/45 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.65)]'
                : 'bg-[#1D0B12]/95 border-rose-400/55 shadow-[0_12px_40px_-8px_rgba(244,63,94,0.4)]'
          }`}
        >
          <div className="flex items-start gap-3">
            {alertToast.kind === 'completed' ? (
              <BellRing className="w-5 h-5 text-emerald-300 shrink-0 mt-0.5" aria-hidden="true" />
            ) : alertToast.kind === 'cancelled' ? (
              <AlertCircle className="w-5 h-5 text-slate-300 shrink-0 mt-0.5" aria-hidden="true" />
            ) : (
              <AlertCircle className="w-5 h-5 text-rose-300 shrink-0 mt-0.5" aria-hidden="true" />
            )}

            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-white">{alertToast.title}</p>
              <p className="text-[11px] text-slate-200/90 mt-1 leading-relaxed break-words">
                {alertToast.body}
              </p>

              {alertToast.kind === 'completed' && conversionResult && (
                <div className="mt-2.5 flex items-center gap-2">
                  <a
                    href={conversionResult.url}
                    download={conversionResult.outputFilename}
                    className="hardware-cta-primary inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Save Output</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      document.querySelector('[data-testid="conversion-result"]')?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'nearest',
                      });
                      setAlertToast(null);
                    }}
                    className="hardware-btn px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-cyan-100 hover:text-white cursor-pointer"
                  >
                    View File
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setAlertToast(null)}
              aria-label="Dismiss conversion notification"
              className="text-slate-400 hover:text-white p-1 rounded-lg cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Three-Zone Top Bar */}
      <header className="w-full border-b border-cyan-400/20 bg-[#07090E]/82 backdrop-blur-md">
        <div className="max-w-[1380px] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3 sm:gap-8 min-w-0">
          <button
            type="button"
            onClick={onReturnWelcome}
            className="flex items-center gap-2.5 text-left cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-cyan-300 rounded-lg"
          >
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg hardware-badge overflow-hidden shrink-0">
              {!emblemFailed ? (
                <img
                  src="/assets/aistudio/surround_x_emblem.png"
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={() => setEmblemFailed(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="font-display text-sm font-bold text-[#00F0FF]">X</span>
              )}
            </span>
            <span className="font-display text-lg font-semibold tracking-tight text-white">
              Surround X
            </span>
          </button>

          <nav
            aria-label="Studio sections"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300"
          >
            <a
              href="#source-deck"
              className="hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
            >
              Source Audio
            </a>
            <a
              href="#encoding-rack"
              className="hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
            >
              AC3 Encoding
            </a>
            <a
              href="#stage-monitor"
              className="hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
            >
              Stage Monitor
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => void handleLoadDemoTrack()}
              disabled={isConverting}
              className="hardware-btn px-3.5 sm:px-4 py-2 rounded-lg text-xs font-semibold text-cyan-100 hover:text-white disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-cyan-300"
            >
              Load Demo Track
            </button>
          </div>
        </div>
      </header>

      {/* Main Studio Workspace */}
      <main className="flex-1 w-full max-w-[1380px] mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-5 min-w-0">
        <div className="mb-4 flex flex-col sm:flex-row sm:items-end justify-between gap-2 min-w-0">
          <div className="min-w-0">
            <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-white">
              5.1 AC3 Mastering Console
            </h1>
            <p className="text-xs sm:text-sm text-slate-300/85 mt-0.5">
              Upload stereo or multichannel audio, calibrate the 6-channel stage, and encode to 48 kHz Dolby Digital AC3.
            </p>
          </div>
        </div>

        <div className="studio-workspace-grid grid grid-cols-1 lg:grid-cols-12 gap-5 items-start w-full min-w-0">
          {/* Left Column: Source Input, Audition & AC3 Encoding */}
          <div className="studio-column lg:col-span-5 flex flex-col gap-4 w-full min-w-0">
            {/* Source Audio Dropzone Card */}
            <section
              id="source-deck"
              aria-label="Source Audio Input"
              className="glass-panel rounded-2xl p-4 sm:p-5 flex flex-col gap-3.5 w-full min-w-0 overflow-hidden"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 min-w-0">
                <h2 className="font-display text-lg font-semibold text-white">Source Audio</h2>
                <span className="text-[11px] sm:text-xs font-mono text-slate-300/80">
                  MP3 · WAV · FLAC · AAC · OGG
                </span>
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`rounded-xl border border-dashed p-4 text-center transition-colors ${
                  isDragging
                    ? 'border-[#00F0FF] bg-cyan-500/15 shadow-[0_0_24px_-6px_rgba(0,240,255,0.35)]'
                    : 'border-cyan-400/25 bg-[#07090E]/65 hover:border-cyan-300/50 shadow-[inset_0_2px_8px_rgba(0,0,0,0.65)]'
                }`}
              >
                <input
                  ref={fileInputRef}
                  id="audio-file-input"
                  type="file"
                  accept="audio/*,.mp3,.wav,.flac,.aac,.m4a,.ogg,.opus,.webm,.mp4"
                  onChange={handleFileInputChange}
                  className="hidden"
                  tabIndex={-1}
                />

                <UploadCloud
                  className="w-6 h-6 text-cyan-300 mx-auto mb-1.5"
                  aria-hidden="true"
                />

                <p className="text-xs sm:text-sm font-medium text-slate-100 mb-0.5">
                  Drop an audio file here, or browse local storage
                </p>
                <p className="text-[11px] text-slate-400 mb-3">
                  Instant streaming playback · Memory-safe 15 MB–250 MB+ WASM conversion
                </p>

                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="hardware-cta-primary inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-cyan-300"
                  >
                    <FileAudio className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Select Audio File</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleLoadDemoTrack()}
                    disabled={isConverting}
                    className="hardware-btn inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-cyan-100 hover:text-white cursor-pointer whitespace-nowrap"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-[#00F0FF]" aria-hidden="true" />
                    <span>Use Demo Stereo WAV</span>
                  </button>
                </div>
              </div>

              {/* Loaded Track Details & Live Stage Audition */}
              {trackMeta ? (
                <div className="glass-subpanel rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className="text-sm font-semibold text-white truncate"
                        title={trackMeta.name}
                      >
                        {trackMeta.name}
                      </p>
                      <p className="text-xs font-mono text-slate-300/85 mt-0.5 tabular-nums flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>{formatFileSize(trackMeta.sizeBytes)}</span>
                        <span className="text-cyan-400/60" aria-hidden="true">·</span>
                        <span>{trackMeta.sampleRate.toLocaleString()} Hz</span>
                        <span className="text-cyan-400/60" aria-hidden="true">·</span>
                        <span>
                          {trackMeta.sourceChannels === 1
                            ? 'Mono'
                            : trackMeta.sourceChannels === 2
                              ? 'Stereo (2.0)'
                              : `${trackMeta.sourceChannels} Channels`}
                        </span>
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleTogglePlayback()}
                      disabled={isLoadingTrack}
                      aria-label={isPlaying ? 'Pause stage audition' : 'Play stage audition'}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer shrink-0 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                        isPlaying
                          ? 'hardware-pill-active-cyan text-white'
                          : 'hardware-btn text-cyan-100 hover:text-white'
                      }`}
                    >
                      {isLoadingTrack ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 text-[#00F0FF] animate-spin" aria-hidden="true" />
                          <span>Loading...</span>
                        </>
                      ) : isPlaying ? (
                        <>
                          <Pause className="w-3.5 h-3.5 text-[#00F0FF]" aria-hidden="true" />
                          <span>Pause</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5 text-[#00F0FF]" aria-hidden="true" />
                          <span>Audition</span>
                        </>
                      )}
                    </button>
                  </div>

                  {isLoadingTrack && (
                    <div
                      className="flex items-center gap-2 rounded-lg bg-[#07090E]/85 border border-cyan-400/25 px-3 py-2 text-xs text-cyan-200"
                      data-testid="track-metadata-loading"
                    >
                      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-[#00F0FF]" aria-hidden="true" />
                      <span>{loadingStatusText}</span>
                    </div>
                  )}

                  {/* Interactive Playback Progress Scrubber */}
                  <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                    <span className="font-mono text-[11px] tabular-nums text-cyan-200 w-9 shrink-0">
                      {formatDuration(playbackTimeSec)}
                    </span>
                    <div className="flex-1 min-w-0 flex items-center">
                      <label htmlFor="playback-scrub" className="sr-only">
                        Playback timeline position
                      </label>
                      <input
                        id="playback-scrub"
                        type="range"
                        min={0}
                        max={Math.max(1, trackMeta.durationSec)}
                        step={0.1}
                        value={Math.min(trackMeta.durationSec || 0, playbackTimeSec)}
                        disabled={trackMeta.durationSec <= 0}
                        onChange={(e) => {
                          const sec = Number(e.target.value);
                          setPlaybackTimeSec(sec);
                          void playerRef.current?.seek(sec);
                        }}
                        className="studio-scrub w-full min-w-0"
                      />
                    </div>
                    <span className="font-mono text-[11px] tabular-nums text-slate-400 w-9 text-right shrink-0">
                      {formatDuration(trackMeta.durationSec)}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-300/75 px-1">
                  No track loaded yet. Select an audio file or load the built-in stereo demo track to preview the Acoustic Stage Monitor and encode to 5.1 AC3.
                </p>
              )}
            </section>

            {/* Encoding & Export Rack */}
            <section
              id="encoding-rack"
              aria-label="Spatial Encoding and Format Settings"
              className="glass-panel rounded-2xl p-4 sm:p-5 flex flex-col gap-3.5 w-full min-w-0 overflow-hidden"
            >
              <div>
                <h2 className="font-display text-lg font-semibold text-white">
                  {exportFormat === '8d-spatial'
                    ? '8D Spatial Audio Processor'
                    : `5.1 ${exportFormat.toUpperCase()} Encoding Profile`}
                </h2>
                <p className="text-xs font-mono text-emerald-200/85 mt-1">
                  {exportFormat === '8d-spatial'
                    ? `Mode: 360° Binaural (.${spatialContainer}) · ${orbitPeriodSec}s orbit · 48 kHz`
                    : exportFormat === 'ac3'
                      ? `Codec: ac3 · ${bitrateKbps} kbps · 48 kHz · 5.1 (6ch)`
                      : exportFormat === 'dts'
                        ? 'Codec: dca · 768 kbps · 48 kHz · 5.1 (6ch)'
                        : 'Codec: flac · Lossless · 48 kHz · 5.1 (6ch)'}
                </p>
              </div>

              {/* Export / Processing Format Selector (AC3, DTS, FLAC, 8D Spatial) */}
              <div>
                <span className="block text-xs font-medium text-slate-200 mb-2">
                  Export &amp; Processing Format
                </span>
                <div
                  className="hardware-pill-track grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 rounded-xl"
                  role="group"
                  aria-label="Output audio format"
                >
                  {FORMAT_OPTIONS.map((opt) => {
                    const selected = exportFormat === opt.value;
                    const is8dOpt = opt.value === '8d-spatial';
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setExportFormat(opt.value)}
                        disabled={isConverting}
                        aria-pressed={selected}
                        data-testid={`format-btn-${opt.value}`}
                        className={`py-2 px-1.5 rounded-lg text-center transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                          selected
                            ? is8dOpt
                              ? 'hardware-pill-active-violet text-white'
                              : 'hardware-pill-active-cyan text-white'
                            : 'border border-transparent text-slate-300 hover:text-white hover:bg-white/[0.03]'
                        }`}
                      >
                        <span className="block font-mono text-xs font-semibold leading-tight">
                          {opt.label}
                        </span>
                        <span className="block font-mono text-[10px] text-slate-300/80 mt-0.5 leading-tight">
                          {opt.sub}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {exportFormat === '8d-spatial' ? (
                <div className="flex flex-col gap-3.5" data-testid="spatial-8d-controls">
                  {/* 8D Output Container (.mp3 / .wav) */}
                  <div>
                    <span className="block text-xs font-medium text-slate-200 mb-2">
                      8D Audio Container
                    </span>
                    <div className="hardware-pill-track grid grid-cols-2 gap-2 p-1 rounded-xl">
                      {SPATIAL_CONTAINER_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setSpatialContainer(opt.value)}
                          disabled={isConverting}
                          aria-pressed={spatialContainer === opt.value}
                          data-testid={`container-btn-${opt.value}`}
                          className={`py-2 px-2 rounded-lg text-xs font-mono font-medium transition-all cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                            spatialContainer === opt.value
                              ? 'hardware-pill-active-cyan text-white'
                              : 'border border-transparent text-slate-300 hover:text-white hover:bg-white/[0.03]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 360-Degree Orbit Speed */}
                  <div>
                    <span className="block text-xs font-medium text-slate-200 mb-2">
                      360° Rotation Speed
                    </span>
                    <div className="hardware-pill-track grid grid-cols-3 gap-1.5 sm:gap-2 p-1 rounded-xl">
                      {ORBIT_SPEED_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setOrbitPeriodSec(opt.value)}
                          disabled={isConverting}
                          aria-pressed={orbitPeriodSec === opt.value}
                          className={`py-2 px-1 rounded-lg text-[10px] sm:text-[11px] font-mono font-medium transition-all cursor-pointer min-w-0 truncate focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                            orbitPeriodSec === opt.value
                              ? 'hardware-pill-active-violet text-white'
                              : 'border border-transparent text-slate-300 hover:text-white hover:bg-white/[0.03]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Spinning 8D Binaural Radar Indicator */}
                  <Spatial8DRadar
                    active={isPlaying || isConverting}
                    isConverting={isConverting}
                    orbitPeriodSec={orbitPeriodSec}
                    liveAngleDeg={isPlaying ? orbitAngleDeg : null}
                  />
                </div>
              ) : (
                <>
                  {/* AC3 Bitrate selector */}
                  {exportFormat === 'ac3' && (
                    <div>
                      <span className="block text-xs font-medium text-slate-200 mb-2">
                        Target AC3 Bitrate
                      </span>
                      <div className="hardware-pill-track grid grid-cols-3 gap-1.5 sm:gap-2 p-1 rounded-xl">
                        {BITRATE_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setBitrateKbps(opt.value)}
                            disabled={isConverting}
                            aria-pressed={bitrateKbps === opt.value}
                            className={`py-2 px-1 sm:px-2 rounded-lg text-[11px] sm:text-xs font-mono font-medium transition-all cursor-pointer min-w-0 truncate focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                              bitrateKbps === opt.value
                                ? 'hardware-pill-active-cyan text-white'
                                : 'border border-transparent text-slate-300 hover:text-white hover:bg-white/[0.03]'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Spatial Upmix Profile */}
                  <div>
                    <span className="block text-xs font-medium text-slate-200 mb-2">
                      Spatial Upmix Matrix
                    </span>
                    <div className="hardware-pill-track grid grid-cols-3 gap-1.5 sm:gap-2 p-1 rounded-xl">
                      {UPMIX_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setUpmixProfile(opt.value)}
                          disabled={isConverting}
                          aria-pressed={upmixProfile === opt.value}
                          className={`py-2 px-1 sm:px-2 rounded-lg text-[10px] sm:text-xs font-medium transition-all cursor-pointer min-w-0 truncate focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                            upmixProfile === opt.value
                              ? 'hardware-pill-active-emerald text-white'
                              : 'border border-transparent text-slate-300 hover:text-white hover:bg-white/[0.03]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Primary Convert CTA */}
              <button
                type="button"
                onClick={() => void handleConvert()}
                disabled={!sourceFile || isLoadingTrack || isConverting}
                data-testid="convert-primary-btn"
                className="hardware-cta-primary w-full py-3.5 px-5 rounded-xl font-semibold text-sm disabled:opacity-45 disabled:cursor-not-allowed active:scale-[0.99] flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-2 focus-visible:outline-cyan-300"
              >
                {isConverting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>
                      {exportFormat === '8d-spatial'
                        ? `Rendering 8D Spatial (.${spatialContainer})...`
                        : `Converting to 5.1 ${exportFormat.toUpperCase()}...`}
                    </span>
                  </>
                ) : (
                  <span>
                    {exportFormat === '8d-spatial'
                      ? `Convert to 8D Spatial (.${spatialContainer})`
                      : `Convert to 5.1 ${exportFormat.toUpperCase()}`}
                  </span>
                )}
              </button>

              {/* Progress Bar, Cancel Control, Active 8D Spinning Radar & User-Facing Status Log */}
              {(isConverting || phase === 'completed') && (
                <div className="glass-subpanel rounded-xl p-3.5 flex flex-col gap-2.5">
                  {isConverting && exportFormat === '8d-spatial' && (
                    <Spatial8DRadar
                      compact
                      active
                      isConverting
                      orbitPeriodSec={orbitPeriodSec}
                    />
                  )}
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-cyan-100 font-medium min-w-0 truncate">
                      {PHASE_LABELS[phase]}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono tabular-nums text-cyan-300 font-semibold">
                        {progressPct}%
                      </span>
                      {isConverting && (
                        <button
                          type="button"
                          onClick={handleCancelConversion}
                          aria-label="Cancel audio conversion"
                          data-testid="cancel-conversion-btn"
                          className="hardware-btn px-2 py-1 rounded-md text-[11px] font-medium text-rose-200 hover:text-white hover:border-rose-400/50 cursor-pointer"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-900 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-[width] duration-200"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  {isConverting && (
                    <p className="text-[11px] text-cyan-200/75 leading-snug">
                      {runtimeEnv === 'windows-desktop'
                        ? 'Background tray execution active — safe to minimize or close to tray while converting.'
                        : runtimeEnv === 'android-native'
                          ? 'Background service active — safe to switch apps; a pop-up alert will notify you on completion.'
                          : 'Off-thread streaming active — a browser alert will notify you when complete.'}
                    </p>
                  )}
                  {conversionLogs.length > 0 && (
                    <ul
                      aria-label="Conversion status log"
                      className="mt-0.5 space-y-1 text-[11px] font-mono text-slate-300/90 leading-snug"
                      data-testid="conversion-status-log"
                    >
                      {conversionLogs.map((entry, idx) => (
                        <li key={`${idx}-${entry}`} className="break-words">
                          <span className="text-emerald-400/90 mr-1.5">›</span>
                          {entry}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* User-Friendly Error State */}
              {errorMessage && (
                <div
                  role="alert"
                  className="rounded-xl bg-rose-950/60 border border-rose-400/45 p-4 flex items-start gap-3 text-rose-100"
                >
                  <AlertCircle className="w-5 h-5 text-rose-300 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-rose-200">Conversion Failed</p>
                    <p className="text-xs text-rose-100/90 mt-1 leading-relaxed">{errorMessage}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setErrorMessage(null)}
                    aria-label="Dismiss conversion error"
                    className="text-rose-200 hover:text-white p-1 rounded cursor-pointer"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              )}

              {/* Download Ready Result & Channel Verification */}
              {conversionResult && (
                <div
                  className="rounded-xl bg-[#09151C]/90 backdrop-blur-md border border-emerald-400/45 shadow-[0_0_28px_-8px_rgba(52,211,153,0.3)] p-4 flex flex-col gap-3"
                  data-testid="conversion-result"
                >
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2
                      className="w-5 h-5 text-emerald-300 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white truncate">
                        {conversionResult.outputFilename}
                      </p>
                      <p className="text-xs font-mono text-emerald-200/85 mt-0.5 tabular-nums flex flex-wrap items-center gap-x-2">
                        <span>{formatFileSize(conversionResult.sizeBytes)}</span>
                        <span className="text-cyan-400/60" aria-hidden="true">·</span>
                        <span>{conversionResult.codecLabel}</span>
                        <span className="text-cyan-400/60" aria-hidden="true">·</span>
                        <span>48,000 Hz</span>
                        <span className="text-cyan-400/60" aria-hidden="true">·</span>
                        <span>
                          {conversionResult.format === '8d-spatial'
                            ? '360° 8D Binaural'
                            : '5.1 Discrete'}
                        </span>
                      </p>
                    </div>
                  </div>

                  {conversionResult.channelRms && (
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 pt-1" aria-label="Encoded 5.1 channel RMS activity">
                      {(['FL', 'FR', 'C', 'LFE', 'SL', 'SR'] as ChannelId[]).map((chId) => {
                        const val = conversionResult.channelRms?.[chId] ?? 0;
                        const pct = Math.min(100, Math.round(val * 260));
                        const barColor =
                          chId === 'LFE'
                            ? 'bg-emerald-400'
                            : chId === 'C'
                              ? 'bg-amber-400'
                              : chId === 'SL' || chId === 'SR'
                                ? 'bg-violet-400'
                                : 'bg-[#00F0FF]';
                        return (
                          <div
                            key={chId}
                            className="rounded-lg bg-[#07090E]/90 border border-slate-700/60 px-1.5 py-1.5 text-center shadow-inner"
                          >
                            <span className="block font-mono text-[10px] font-semibold text-slate-200">
                              {chId}
                            </span>
                            <div className="h-1 w-full rounded-full bg-slate-900 mt-1 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${barColor}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <a
                    href={conversionResult.url}
                    download={conversionResult.outputFilename}
                    className="hardware-cta-primary w-full py-2.5 px-4 rounded-lg font-semibold text-xs flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-cyan-300"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    <span>
                      {conversionResult.format === '8d-spatial'
                        ? 'Download 8D Spatial Audio'
                        : `Download 5.1 ${conversionResult.format.toUpperCase()} File`}
                    </span>
                  </a>
                </div>
              )}
            </section>
          </div>

          {/* Right Column: Interactive 6-Channel Acoustic Stage Monitor */}
          <div className="studio-column lg:col-span-7 w-full min-w-0">
            <AcousticStageMonitor
              channels={channels}
              liveLevelsRef={liveLevelsRef}
              energyProfile={energyProfile}
              activityMode={activityMode}
              spatialMode={exportFormat}
              selectedChannel={selectedChannel}
              activeSweepChannel={activeSweepChannel}
              onSelectChannel={setSelectedChannel}
              onUpdateGain={handleUpdateGain}
              onToggleMute={handleToggleMute}
              onToggleSolo={handleToggleSolo}
              onTriggerCalibrationTone={handleTriggerCalibrationTone}
              onRunSweep={handleRunSweep}
              onResetChannels={handleResetChannels}
            />
          </div>
        </div>

        {/* Creative Thinking & Appreciation Card */}
        <CreativeThinkingCard />
      </main>
    </div>
  );
}
