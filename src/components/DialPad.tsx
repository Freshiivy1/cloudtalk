import { useRef } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { playDTMFTone } from '@/lib/telephony';

export interface DialPadKey {
  digit: string;
  letters: string;
}

export const DIALPAD_KEYS: DialPadKey[] = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

export interface DialPadProps {
  /** called for every key press (after the DTMF tone plays) */
  onPress: (digit: string) => void;
  /** long-pressing 0 produces '+' for international numbers (e.g. +61) */
  onPlus?: () => void;
  /** key diameter in px (default 72) */
  size?: number;
  /** disable the mount stagger-pop (e.g. inside the DTMF overlay) */
  noEntrance?: boolean;
  className?: string;
}

/**
 * 4×3 grid of circular dial keys with T9 captions. Press: scale 0.92 +
 * signal-dim flash + WebAudio DTMF tone. Keys stagger-pop on first mount.
 * Long-press 0 (≥500ms) enters the international '+' prefix.
 */
export default function DialPad({ onPress, onPlus, size = 72, noEntrance = false, className }: DialPadProps) {
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);

  const handleDown = (key: DialPadKey) => {
    if (key.digit !== '0' || !onPlus) return;
    longFired.current = false;
    pressTimer.current = setTimeout(() => {
      longFired.current = true;
      onPlus();
    }, 500);
  };
  const handleUp = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <div className={cn('grid grid-cols-3 gap-4', className)} style={{ width: size * 3 + 32 }}>
      {DIALPAD_KEYS.map((key, i) => (
        <motion.button
          key={key.digit}
          type="button"
          initial={noEntrance ? false : { scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={
            noEntrance
              ? undefined
              : { type: 'spring', stiffness: 300, damping: 20, delay: 0.2 + i * 0.03 }
          }
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.92 }}
          onPointerDown={() => handleDown(key)}
          onPointerUp={handleUp}
          onPointerLeave={handleUp}
          onClick={() => {
            if (longFired.current) {
              longFired.current = false;
              return; // long-press already emitted '+'
            }
            playDTMFTone(key.digit);
            onPress(key.digit);
          }}
          className={cn(
            'group flex cursor-pointer flex-col items-center justify-center rounded-full border border-line',
            'bg-ink-800 transition-colors duration-150',
            'hover:border-signal hover:bg-ink-700 active:bg-signal-dim'
          )}
          style={{ width: size, height: size }}
        >
          <span className="font-mono text-2xl font-medium leading-none text-text-hi group-active:text-signal">
            {key.digit}
          </span>
          {key.letters && (
            <span className="mt-1 text-[9px] font-medium tracking-[0.18em] text-text-low">
              {key.letters}
            </span>
          )}
        </motion.button>
      ))}
    </div>
  );
}
