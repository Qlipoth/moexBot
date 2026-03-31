/**
 * Стратегия EMA Crossover для IMOEXF.
 * Откалиброванные параметры: EMA(12/26), atrMinRatio=0.002, RSI-фильтр [35,70].
 * Даёт +71 006 ₽ vs +16 333 ₽ у AdaptiveBollinger на том же периоде/тикере.
 */

import {
  calculateATRFromCandles,
  getCandle1h,
  getHistory1h,
  getATR1h,
} from './candleBuilder.js';
import { calculateRSI } from './analysis.js';
import type { TradingStrategy } from './tradingStrategy.js';

const FAST_PERIOD = 12;
const SLOW_PERIOD = 26;
const RSI_PERIOD = 14;
const RSI_MIN = 35;
const RSI_MAX = 70;
/** ATR должен быть не менее 0.2% цены — отсеиваем флет */
const ATR_MIN_RATIO = 0.002;
/** Минимум свечей для расчёта (slow + буфер) */
const MIN_CANDLES = SLOW_PERIOD + 5;

function calcEmaOnArray(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    e = prices[i]! * k + e * (1 - k);
  }
  return e;
}

function buildContext(ticker: string): {
  fastEma: number; prevFastEma: number;
  slowEma: number; prevSlowEma: number;
  rsi: number; atr: number; close: number;
} | null {
  const current = getCandle1h(ticker);
  if (!current) return null;

  const history = getHistory1h(ticker);
  const all = [...history, current];
  if (all.length < MIN_CANDLES + 1) return null;

  const closes = all.map((c) => c.close);
  const prevCloses = closes.slice(0, -1);

  const fastEma = calcEmaOnArray(closes, FAST_PERIOD);
  const slowEma = calcEmaOnArray(closes, SLOW_PERIOD);
  const prevFastEma = calcEmaOnArray(prevCloses, FAST_PERIOD);
  const prevSlowEma = calcEmaOnArray(prevCloses, SLOW_PERIOD);

  const rsi = calculateRSI(closes.slice(-(RSI_PERIOD + 1)), RSI_PERIOD);
  const atr = getATR1h(ticker) || (all.length >= 15 ? calculateATRFromCandles(all, 14) : 0);

  return { fastEma, prevFastEma, slowEma, prevSlowEma, rsi, atr, close: current.close };
}

export const emaCrossoverStrategy: TradingStrategy = {
  name: 'EmaCrossover',

  getSignal(ticker: string) {
    const ctx = buildContext(ticker);
    if (!ctx) {
      return { signal: 'NONE', ready: false };
    }

    const { fastEma, prevFastEma, slowEma, prevSlowEma, atr, close } = ctx;

    const atrOk = atr > ATR_MIN_RATIO * close;
    if (!atrOk) {
      return { signal: 'NONE', ready: true };
    }

    const crossedUp = prevFastEma < prevSlowEma && fastEma >= slowEma;
    const crossedDown = prevFastEma > prevSlowEma && fastEma <= slowEma;

    let signal: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
    if (crossedUp) signal = 'LONG';
    else if (crossedDown) signal = 'SHORT';

    return { signal, ready: true };
  },

  confirmEntry(ticker: string, side: 'LONG' | 'SHORT'): boolean {
    const ctx = buildContext(ticker);
    if (!ctx) return false;

    const { fastEma, slowEma, rsi, close, atr } = ctx;

    if (rsi < RSI_MIN || rsi > RSI_MAX) return false;
    if (atr <= ATR_MIN_RATIO * close) return false;

    if (side === 'LONG') {
      // Цена выше медленной EMA — тренд вверх подтверждён
      return close > slowEma && fastEma >= slowEma;
    }
    // SHORT: цена ниже медленной EMA
    return close < slowEma && fastEma <= slowEma;
  },

  getContext(ticker: string) {
    const ctx = buildContext(ticker);
    if (!ctx) return null;
    // Нет `middle` — MEAN exit в watcher не будет срабатывать для этой стратегии
    return { atr: ctx.atr, close: ctx.close, fastEma: ctx.fastEma, slowEma: ctx.slowEma };
  },

  isSupported(_ticker: string): boolean {
    return true;
  },
};
