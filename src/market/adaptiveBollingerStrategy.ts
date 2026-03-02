/**
 * Стратегия Bollinger Bands для точек входа (по образцу byBitBot).
 * LONG у нижней полосы, SHORT у верхней; использует 1h свечи.
 */

import {
  calculateATRFromCandles,
  getCandle1h,
  getConsecutiveBlock1h,
  getHistory1h,
} from './candleBuilder.js';
import { calculateRSI } from './analysis.js';

export type AdaptiveSignal = 'LONG' | 'SHORT' | 'NONE';

const BB_PERIOD = 20;
const BB_STD = 2;
const EMA_PERIOD = 20;
const RSI_LONG_PERIOD = 14;
const RSI_NEUTRAL = 50;
const RSI_DEADBAND = 5;
const SIGNAL_THRESHOLD = 50;
const SCORE_GAP = 15;
const MIN_BAND_DISTANCE = 0.005;
const BAND_SLIPPAGE_TOLERANCE = 0.002;
/** Порог NARROW CHANNEL по тикеру (p10 по истории 1h за 30 дней). Обновить: pnpm run calibrate */
const MIN_BOLLINGER_WIDTH_BY_TICKER: Record<string, number> = {
  GLDRUBF: 0.01135,
  IMOEXF: 0.00446,
  USDRUBF: 0.00473,
  SBERF: 0.00398,
  GAZPF: 0.00641,
};
const DEFAULT_MIN_BOLLINGER_WIDTH_PCT = 0.005;

interface BollingerContext {
  upper: number;
  lower: number;
  middle: number;
  ema: number;
  rsiLong: number;
  close: number;
  atr: number;
  candles: { open: number; close: number }[];
}

export interface AdaptiveSignalResult {
  ready: boolean;
  signal: AdaptiveSignal;
  entrySignal: string;
  longScore: number;
  shortScore: number;
  details: Record<string, unknown>;
}

function sma(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function std(v: number[], m: number): number {
  return Math.sqrt(
    v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(v.length, 1)
  );
}

function ema(v: number[], p: number): number {
  const k = 2 / (p + 1);
  return v.reduce((a, c, i) => (i === 0 ? c : c * k + a * (1 - k)), 0);
}

function buildContext(ticker: string): BollingerContext | null {
  const current = getCandle1h(ticker);
  if (!current) return null;
  const minLen = RSI_LONG_PERIOD + BB_PERIOD;
  let block = getConsecutiveBlock1h(ticker);
  if (block.length < minLen) {
    const history = getHistory1h(ticker);
    const all = [...history, current];
    if (all.length < minLen) return null;
    block = all.slice(-minLen);
  }
  const closes = block.map((c) => c.close);
  const bbSample = closes.slice(-BB_PERIOD);
  const mid = sma(bbSample);
  const sd = std(bbSample, mid);
  const rsiLong = calculateRSI(
    closes.slice(-(RSI_LONG_PERIOD + 1)),
    RSI_LONG_PERIOD
  );
  const candles = block.map((c) => ({ open: c.open, close: c.close }));
  const atr = block.length >= 15 ? calculateATRFromCandles(block, 14) : 0;
  return {
    upper: mid + sd * BB_STD,
    lower: mid - sd * BB_STD,
    middle: mid,
    ema: ema(closes, EMA_PERIOD),
    rsiLong,
    close: current.close,
    atr,
    candles,
  };
}

function getBandDistance(ctx: BollingerContext): number {
  return ctx.middle > 0 ? Math.abs(ctx.close - ctx.middle) / ctx.middle : 0;
}

function getEmaBias(ctx: BollingerContext): number {
  return ctx.ema > 0 ? (ctx.close - ctx.ema) / ctx.ema : 0;
}

const EMA_TREND_TOLERANCE = 0.003;

export const adaptiveBollingerStrategy = {
  getContext(ticker: string): BollingerContext | null {
    return buildContext(ticker);
  },

  getSignal(ticker: string): AdaptiveSignalResult {
    const ctx = buildContext(ticker);
    if (!ctx) {
      return {
        ready: false,
        signal: 'NONE',
        entrySignal: 'NO DATA',
        longScore: 0,
        shortScore: 0,
        details: {},
      };
    }
    const { close, upper, lower, middle, rsiLong } = ctx;
    const distancePct = getBandDistance(ctx);
    const emaBias = getEmaBias(ctx);
    const bandWidthPct =
      middle > 0 ? (upper - lower) / middle : 0;
    const minWidth =
      MIN_BOLLINGER_WIDTH_BY_TICKER[ticker] ?? DEFAULT_MIN_BOLLINGER_WIDTH_PCT;

    if (bandWidthPct < minWidth) {
      return {
        ready: true,
        signal: 'NONE',
        entrySignal: 'NARROW CHANNEL',
        longScore: 0,
        shortScore: 0,
        details: { rsiLong, distancePct, emaBias, bandWidthPct },
      };
    }

    const allowLong = rsiLong <= RSI_NEUTRAL - RSI_DEADBAND;
    const allowShort = rsiLong >= RSI_NEUTRAL + RSI_DEADBAND;

    const longScore = Math.min(
      100,
      (close <= lower * (1 + BAND_SLIPPAGE_TOLERANCE) ? 35 : 0) +
        (allowLong ? 20 : 0) +
        (distancePct >= MIN_BAND_DISTANCE ? 10 : 0) +
        (emaBias <= -EMA_TREND_TOLERANCE ? 20 : 0)
    );

    const shortScore = Math.min(
      100,
      (close >= upper * (1 - BAND_SLIPPAGE_TOLERANCE) ? 35 : 0) +
        (allowShort ? 20 : 0) +
        (distancePct >= MIN_BAND_DISTANCE ? 10 : 0) +
        (emaBias >= EMA_TREND_TOLERANCE ? 20 : 0)
    );

    let signal: AdaptiveSignal = 'NONE';
    if (
      longScore >= SIGNAL_THRESHOLD &&
      longScore - shortScore >= SCORE_GAP
    ) {
      signal = 'LONG';
    } else if (
      shortScore >= SIGNAL_THRESHOLD &&
      shortScore - longScore >= SCORE_GAP
    ) {
      signal = 'SHORT';
    }

    return {
      ready: true,
      signal,
      entrySignal: signal === 'NONE' ? 'NO SETUP' : signal,
      longScore,
      shortScore,
      details: {
        rsiLong,
        distancePct,
        emaBias,
        allowLong,
        allowShort,
      },
    };
  },

  confirmEntry(
    ticker: string,
    signal: AdaptiveSignal
  ): boolean {
    if (signal === 'NONE') return false;
    const ctx = buildContext(ticker);
    if (!ctx) return false;
    const distancePct = getBandDistance(ctx);
    const emaBias = getEmaBias(ctx);
    const bandWidthPct =
      ctx.middle > 0 ? (ctx.upper - ctx.lower) / ctx.middle : 0;
    const minWidth =
      MIN_BOLLINGER_WIDTH_BY_TICKER[ticker] ?? DEFAULT_MIN_BOLLINGER_WIDTH_PCT;
    if (bandWidthPct < minWidth) return false;

    if (signal === 'LONG') {
      return (
        ctx.close <= ctx.lower * (1 + BAND_SLIPPAGE_TOLERANCE) &&
        distancePct >= MIN_BAND_DISTANCE * 0.8 &&
        emaBias <= -EMA_TREND_TOLERANCE
      );
    }
    if (signal === 'SHORT') {
      return (
        ctx.close >= ctx.upper * (1 - BAND_SLIPPAGE_TOLERANCE) &&
        distancePct >= MIN_BAND_DISTANCE * 0.8 &&
        emaBias >= EMA_TREND_TOLERANCE
      );
    }
    return false;
  },

  isSupported(_ticker: string): boolean {
    return true;
  },
};
