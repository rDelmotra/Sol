/** Ask bar pure helpers: waveform geometry and the caption text. Tested in ask-bar.test.ts. */
import type { AnalyticAnswer } from '../../store/types';

export const WAVE_BARS = 48;
export const WAVE_IDLE_MS = 1600;
export const WAVE_ACTIVE_MS = 700;

export const ASK_HINT = '“ask the catalog…” · press SPACE';

export interface WaveBar {
  /** Resting height, px: 4 + 14 · cos envelope (tallest in the middle). */
  height: number;
  /** Animation delay, ms. */
  delayMs: number;
}

export function waveBars(count = WAVE_BARS): WaveBar[] {
  return Array.from({ length: count }, (_, i) => {
    const mid = (i - count / 2) / (count / 2);
    return { height: 4 + Math.cos(mid * Math.PI * 0.5) * 14, delayMs: (i * 40) % 900 };
  });
}

export interface AskCaption {
  text: string;
  error: boolean;
}

export function askCaption(answer: Pick<AnalyticAnswer, 'status' | 'question' | 'interpretation' | 'message'> | null): AskCaption {
  if (answer?.status === 'compiling') return { text: 'COMPILING…', error: false };
  if (answer?.status === 'ready') return { text: `“${answer.question}” → ${answer.interpretation ?? 'ready'}`, error: false };
  if (answer?.status === 'error') return { text: answer.message ?? 'Ask failed', error: true };
  return { text: ASK_HINT, error: false };
}
