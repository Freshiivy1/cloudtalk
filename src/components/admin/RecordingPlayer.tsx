import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtDuration } from './controls';

/**
 * Seekable recording waveform — static violet amplitude envelope (precomputed
 * pseudo-data seeded by call id), played portion fills brighter, playhead
 * sweep + progress timer drive an honest simulated playback (no real audio).
 */
const BAR_COUNT = 72;

function seededEnvelope(seed: number): number[] {
  // deterministic pseudo-random amplitude envelope
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const wave = Math.sin(i * 0.22) * 0.25 + Math.sin(i * 0.061 + 1.7) * 0.35;
    const speech = rnd() * 0.55;
    const pause = rnd() < 0.12 ? 0.15 : 1; // occasional speech pauses
    bars.push(Math.max(0.08, Math.min(1, (0.35 + wave + speech) * pause)));
  }
  return bars;
}

function SeekableWaveform({
  bars,
  progress, // 0..1
  onSeek,
}: {
  bars: number[];
  progress: number;
  onSeek: (p: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 1;
    const h = 96;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const gap = 2 * dpr;
    const barW = Math.max(2 * dpr, canvas.width / BAR_COUNT - gap);
    const mid = canvas.height / 2;
    const playedBars = progress * BAR_COUNT;

    for (let i = 0; i < BAR_COUNT; i++) {
      const v = bars[i];
      const bh = Math.max(2 * dpr, v * canvas.height * 0.86);
      const played = i < playedBars;
      const grad = ctx.createLinearGradient(0, mid - bh / 2, 0, mid + bh / 2);
      if (played) {
        grad.addColorStop(0, '#9B8CFF');
        grad.addColorStop(1, 'rgba(155,140,255,0.35)');
        ctx.globalAlpha = 1;
      } else {
        grad.addColorStop(0, 'rgba(155,140,255,0.55)');
        grad.addColorStop(1, 'rgba(155,140,255,0.12)');
        ctx.globalAlpha = 0.3;
      }
      ctx.fillStyle = grad;
      const x = i * (canvas.width / BAR_COUNT);
      ctx.beginPath();
      ctx.roundRect(x, mid - bh / 2, barW, bh, barW / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // playhead — 2px white line with glow
    const px = progress * canvas.width;
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.8)';
    ctx.shadowBlur = 6 * dpr;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(px - dpr, 0, 2 * dpr, canvas.height);
    ctx.restore();
  }, [bars, progress]);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      onSeek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
    },
    [onSeek]
  );

  return (
    <div
      ref={trackRef}
      className="relative h-24 cursor-pointer select-none"
      onPointerDown={(e) => {
        setDragging(true);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        seekFromEvent(e.clientX);
      }}
      onPointerMove={(e) => dragging && seekFromEvent(e.clientX)}
      onPointerUp={() => setDragging(false)}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: 96 }} />
    </div>
  );
}

const SeekableWaveformMemo = memo(SeekableWaveform);

export default function RecordingPlayer({
  callId,
  durationSec,
}: {
  callId: number;
  durationSec: number;
}) {
  const bars = useMemo(() => seededEnvelope(callId), [callId]);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0); // seconds
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);

  const total = Math.max(1, durationSec);

  /* progress timer — the honest simulated playback engine */
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setPosition((p) => {
        const next = p + 0.1 * speed;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, [playing, speed, total]);

  /* keyboard transport: space play/pause, ←→ seek 10s */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => (position >= total ? p : !p));
      } else if (e.key === 'ArrowLeft') {
        setPosition((p) => Math.max(0, p - 10));
      } else if (e.key === 'ArrowRight') {
        setPosition((p) => Math.min(total, p + 10));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [position, total]);

  const togglePlay = () => {
    if (position >= total) setPosition(0);
    setPlaying((p) => !p);
  };

  return (
    <div className="rounded-[14px] border border-violet/30 bg-ink-800 p-4">
      <SeekableWaveformMemo bars={bars} progress={position / total} onSeek={(p) => setPosition(p * total)} />

      {/* transport row */}
      <div className="mt-3 flex items-center gap-3">
        <motion.button
          whileTap={{ scale: 1.05 }}
          onClick={togglePlay}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-violet text-ink-950 shadow-glow-violet transition-transform"
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
        </motion.button>

        <button
          onClick={() => setPosition((p) => Math.max(0, p - 10))}
          className="rounded-full p-2 text-text-mid transition-colors hover:bg-ink-700 hover:text-violet"
          title="Back 10s"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          onClick={() => setPosition((p) => Math.min(total, p + 10))}
          className="rounded-full p-2 text-text-mid transition-colors hover:bg-ink-700 hover:text-violet"
          title="Forward 10s"
        >
          <RotateCw className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-1 rounded-full border border-line bg-ink-700 p-0.5">
          {([1, 1.5, 2] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={cn(
                'rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors',
                speed === s ? 'bg-violet/20 text-violet' : 'text-text-low hover:text-text-mid'
              )}
            >
              {s}×
            </button>
          ))}
        </div>

        <span className="ml-auto font-mono text-[13px] text-text-hi">
          {fmtDuration(Math.floor(position))} <span className="text-text-low">/ {fmtDuration(total)}</span>
        </span>
      </div>

      {/* honesty caption */}
      <div className="mt-3 flex items-center gap-1.5 rounded-[10px] border border-line bg-ink-900/60 px-2.5 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-violet" />
        <span className="text-[11px] leading-4 text-text-low">
          Simulated recording — real media arrives with the telephony provider.
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Simulated .wav export — a generated 1s tone blob (works offline, clearly  */
/* a placeholder until real media lands with the telephony provider).        */
/* ------------------------------------------------------------------------- */

export function downloadSimulatedWav(filename: string) {
  const sampleRate = 8000;
  const seconds = 1;
  const n = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 2) * 0.4;
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  const blob = new Blob([buffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
