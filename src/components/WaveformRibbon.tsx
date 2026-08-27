import { memo, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface WaveformRibbonProps {
  /** animating (voice activity) */
  active?: boolean;
  /** frozen, amber tint */
  held?: boolean;
  /** flat-ish, red tint, low amplitude */
  muted?: boolean;
  /** base amplitude 0–1 (default 1) */
  amplitude?: number;
  /** explicit height in px */
  height?: number;
  /** extra boost 0–1, e.g. hover teaser on the idle hero strip */
  boost?: number;
  /** explicit tint override (otherwise derived from held/muted) */
  tint?: 'signal' | 'amber' | 'danger';
  className?: string;
}

const BAR_COUNT = 36;

const TINTS = {
  signal: ['#2EE6A8', '#134E3F'],
  amber: ['#FFB224', '#6B4A0E'],
  danger: ['#FF5C6C', '#6E2530'],
} as const;

/**
 * Canvas waveform ribbon — 36 bars, pseudo-audio (layered sines + noise),
 * single rAF loop, gradient bars on transparent background.
 */
function WaveformRibbonInner({
  active = false,
  held = false,
  muted = false,
  amplitude = 1,
  height = 64,
  boost = 0,
  tint,
  className,
}: WaveformRibbonProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ active, held, muted, amplitude, boost, tint });

  useEffect(() => {
    propsRef.current = { active, held, muted, amplitude, boost, tint };
  }, [active, held, muted, amplitude, boost, tint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let t = 0;
    let currentAmp = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const w = canvas.clientWidth || 1;
      canvas.width = w * dpr;
      canvas.height = height * dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const { active: isActive, held: isHeld, muted: isMuted, amplitude: base, boost: bst, tint: tintOverride } = propsRef.current;

      // amplitude target: muted → 15%, inactive → 12% idle wave, else full
      const target = isMuted ? 0.15 * base : isActive ? base : 0.12 * base + bst * 0.3;
      currentAmp += (target - currentAmp) * 0.08;
      // hold freezes time; idle drifts slowly; active is lively
      if (!isHeld) t += isActive ? 0.09 : 0.028;

      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const tint = tintOverride ? TINTS[tintOverride] : isMuted ? TINTS.danger : isHeld ? TINTS.amber : TINTS.signal;
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, tint[0]);
      grad.addColorStop(1, tint[1]);
      ctx.fillStyle = grad;

      const gap = (3 * dpr);
      const barW = Math.max(2 * dpr, W / BAR_COUNT - gap);
      const mid = H / 2;

      for (let i = 0; i < BAR_COUNT; i++) {
        const phase = i * 0.35;
        const v =
          Math.abs(
            Math.sin(t * 1.3 + phase) * 0.55 +
            Math.sin(t * 2.1 + i * 0.13) * 0.3 +
            Math.sin(t * 3.7 + i * 0.53) * 0.15
          );
        const jitter = isActive && !isHeld ? Math.abs(Math.sin(t * 11 + i * 2.7)) * 0.18 : 0;
        const mag = Math.max(0.04, (v + jitter) * currentAmp);
        const h = Math.max(2 * dpr, mag * H * 0.92);
        const x = i * (barW + gap);
        const y = mid - h / 2;
        const r = barW / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, r);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [height]);

  return (
    <canvas
      ref={canvasRef}
      className={cn('block w-full', className)}
      style={{ height, width: '100%' }}
    />
  );
}

const WaveformRibbon = memo(WaveformRibbonInner);
export default WaveformRibbon;
