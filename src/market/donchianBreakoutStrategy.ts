/**
 * Стратегия пробоя канала Дончиана (DonchianBreakout) для фьючерсов MOEX.
 * LONG при пробое верхней границы, SHORT — при пробое нижней.
 * Фильтр флета по ATR, подтверждение по RSI.
 */

import { getHistory1h, getCandle1h, getATR1h } from './candleBuilder.js';
import { calculateRSI } from './analysis.js';

const CHANNEL_PERIOD = 20;
const ATR_MIN_RATIO = 0.003;
const RSI_PERIOD = 14;
const WINDOW_SIZE = 30;
const MIN_CANDLES = CHANNEL_PERIOD + 5;

interface TickerState {
  highs: number[];
  lows: number[];
  closes: number[];
}

const stateMap = new Map<string, TickerState>();

function updateState(ticker: string): TickerState {
  const history = getHistory1h(ticker);
  const current = getCandle1h(ticker);
  const all = current ? [...history, current] : history;
  const window = all.slice(-WINDOW_SIZE);
  const state: TickerState = {
    highs: window.map((c) => c.high),
    lows: window.map((c) => c.low),
    closes: window.map((c) => c.close),
  };
  stateMap.set(ticker, state);
  return state;
}

/** Последние CHANNEL_PERIOD элементов окна без текущей (последней) свечи */
function lookbackSlice<T>(arr: T[]): T[] {
  return arr.slice(-CHANNEL_PERIOD - 1, -1);
}

function computeChannel(state: TickerState): { channelHigh: number; channelLow: number } | null {
  const lookbackHighs = lookbackSlice(state.highs);
  const lookbackLows = lookbackSlice(state.lows);
  if (lookbackHighs.length < CHANNEL_PERIOD) return null;
  return {
    channelHigh: Math.max(...lookbackHighs),
    channelLow: Math.min(...lookbackLows),
  };
}

function computeRsi(state: TickerState): number {
  const closes = state.closes.slice(-(RSI_PERIOD + 1));
  if (closes.length < RSI_PERIOD + 1) return 50;
  return calculateRSI(closes, RSI_PERIOD);
}

export const donchianBreakoutStrategy = {
  getSignal(
    ticker: string
  ): { signal: 'LONG' | 'SHORT' | 'NONE'; ready: boolean; reason?: string } {
    const state = updateState(ticker);
    const current = getCandle1h(ticker);

    if (!current) {
      return { signal: 'NONE', ready: false, reason: 'Нет данных' };
    }

    if (state.closes.length < MIN_CANDLES) {
      return { signal: 'NONE', ready: false, reason: 'Недостаточно данных' };
    }

    const atr = getATR1h(ticker);
    const close = current.close;

    if (!Number.isFinite(atr) || atr <= 0 || atr < close * ATR_MIN_RATIO) {
      return { signal: 'NONE', ready: true, reason: 'ATR слишком мал (флет)' };
    }

    const channel = computeChannel(state);
    if (!channel) {
      return { signal: 'NONE', ready: false, reason: 'Недостаточно данных для канала' };
    }

    const { channelHigh, channelLow } = channel;

    if (close > channelHigh) {
      return { signal: 'LONG', ready: true };
    }
    if (close < channelLow) {
      return { signal: 'SHORT', ready: true };
    }
    return { signal: 'NONE', ready: true };
  },

  confirmEntry(ticker: string, side: 'LONG' | 'SHORT'): boolean {
    const state = stateMap.get(ticker);
    if (!state) return false;

    const current = getCandle1h(ticker);
    if (!current) return false;

    if (state.closes.length < MIN_CANDLES) return false;

    const channel = computeChannel(state);
    if (!channel) return false;

    const { channelHigh, channelLow } = channel;
    const close = current.close;
    const rsi = computeRsi(state);

    if (side === 'LONG') {
      return close > channelHigh && rsi < 80;
    }
    if (side === 'SHORT') {
      return close < channelLow && rsi > 20;
    }
    return false;
  },

  getContext(
    ticker: string
  ): { channelHigh: number; channelLow: number; close: number; atr: number } | null {
    const existing = stateMap.get(ticker);
    const state = existing ?? updateState(ticker);

    const current = getCandle1h(ticker);
    if (!current) return null;

    if (state.closes.length < MIN_CANDLES) return null;

    const channel = computeChannel(state);
    if (!channel) return null;

    return {
      channelHigh: channel.channelHigh,
      channelLow: channel.channelLow,
      close: current.close,
      atr: getATR1h(ticker),
    };
  },
};
