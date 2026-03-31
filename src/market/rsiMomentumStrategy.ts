/**
 * Стратегия RSI Momentum — выход RSI из зон экстремума с трендовым фильтром EMA(20).
 * LONG: RSI(14) пересекает 35 снизу вверх + цена выше EMA.
 * SHORT: RSI(14) пересекает 65 сверху вниз + цена ниже EMA.
 */

import { getCandle1h, getHistory1h, getATR1h } from './candleBuilder.js';
import { calculateRSI } from './analysis.js';

const RSI_PERIOD = 14;
const EMA_PERIOD = 20;
const RSI_LONG_LEVEL = 35;
const RSI_SHORT_LEVEL = 65;
const ATR_MIN_RATIO = 0.002;
const MIN_CANDLES = 25;

interface RsiMomentumState {
  closes: number[];
  prevRsi: number | null;
  ema20: number | null;
}

const strategyState = new Map<string, RsiMomentumState>();

function computeEma(closes: number[], period: number): number {
  const k = 2 / (period + 1);
  return closes.reduce((ema, close, i) => (i === 0 ? close : close * k + ema * (1 - k)), 0);
}

interface ComputedData {
  closes: number[];
  currentRsi: number;
  prevRsiForCross: number | null;
  ema20: number;
  emaBias: number;
  close: number;
  atr: number;
}

function computeData(ticker: string): ComputedData | null {
  const current = getCandle1h(ticker);
  if (!current) return null;

  const history = getHistory1h(ticker);
  const allCloses = [...history.map((c) => c.close), current.close];

  if (allCloses.length < MIN_CANDLES) return null;

  let state = strategyState.get(ticker);
  if (!state) {
    state = { closes: allCloses, prevRsi: null, ema20: null };
    strategyState.set(ticker, state);
  } else {
    state.closes = allCloses;
  }

  const ema20 = computeEma(allCloses, EMA_PERIOD);
  state.ema20 = ema20;

  const currentRsi = calculateRSI(allCloses.slice(-(RSI_PERIOD + 2)), RSI_PERIOD);

  const prevSlice = allCloses.slice(0, -1);
  const prevRsiForCross =
    prevSlice.length >= RSI_PERIOD + 1
      ? calculateRSI(prevSlice.slice(-(RSI_PERIOD + 2)), RSI_PERIOD)
      : null;

  state.prevRsi = currentRsi;

  const close = current.close;
  const atr = getATR1h(ticker);
  const emaBias = ema20 > 0 ? (close - ema20) / ema20 : 0;

  return { closes: allCloses, currentRsi, prevRsiForCross, ema20, emaBias, close, atr };
}

export const rsiMomentumStrategy = {
  getSignal(
    ticker: string
  ): { signal: 'LONG' | 'SHORT' | 'NONE'; ready: boolean; reason?: string } {
    const data = computeData(ticker);
    if (!data) return { signal: 'NONE', ready: false, reason: 'Not enough data' };

    const { currentRsi, prevRsiForCross, emaBias, close, atr } = data;

    if (!Number.isFinite(atr) || atr < ATR_MIN_RATIO * close) {
      return { signal: 'NONE', ready: true, reason: 'ATR too small' };
    }

    if (prevRsiForCross === null) {
      return { signal: 'NONE', ready: true, reason: 'Waiting for previous RSI' };
    }

    if (prevRsiForCross < RSI_LONG_LEVEL && currentRsi >= RSI_LONG_LEVEL && emaBias > 0) {
      return { signal: 'LONG', ready: true };
    }

    if (prevRsiForCross > RSI_SHORT_LEVEL && currentRsi <= RSI_SHORT_LEVEL && emaBias < 0) {
      return { signal: 'SHORT', ready: true };
    }

    return { signal: 'NONE', ready: true };
  },

  confirmEntry(ticker: string, side: 'LONG' | 'SHORT'): boolean {
    const data = computeData(ticker);
    if (!data) return false;

    const { currentRsi, emaBias } = data;

    if (side === 'LONG') {
      return currentRsi >= 33 && emaBias > -0.002;
    }
    if (side === 'SHORT') {
      return currentRsi <= 67 && emaBias < 0.002;
    }
    return false;
  },

  getContext(
    ticker: string
  ): { rsi: number; ema20: number; emaBias: number; close: number; atr: number } | null {
    const data = computeData(ticker);
    if (!data) return null;

    const { currentRsi, ema20, emaBias, close, atr } = data;
    return { rsi: currentRsi, ema20, emaBias, close, atr };
  },
};
