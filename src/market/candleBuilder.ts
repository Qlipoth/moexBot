/**
 * Состояние свечей по тикерам (1h для стратегии Bollinger), по образцу byBitBot.
 */

import type { HistoricalCandleInput } from '../core/investClient.js';

interface Candle {
  /** Час в UTC (timestamp / 3600000) для детекции разрывов при не 24/7 торговле */
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Максимальный разрыв между свечами (в часах), чтобы считать их последовательными. Больше = выходной/ночь. */
const MAX_CONSECUTIVE_GAP_HOURS = 2;

interface SymbolCandleState {
  current: Candle | null;
  history: Candle[];
  atr: number;
  avgVolume: number;
}

const candleState1h: Record<string, SymbolCandleState> = {};
const HISTORY_LIMIT_1H = 250;

export function initSymbol1h(ticker: string): void {
  if (!candleState1h[ticker]) {
    candleState1h[ticker] = {
      current: null,
      history: [],
      atr: 0,
      avgVolume: 0,
    };
  }
}

export function calculateATRFromCandles(
  candles: Candle[],
  period: number = 14
): number {
  if (candles.length < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    tr.push(
      Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      )
    );
  }
  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }
  return atr;
}

/**
 * Синхронизирует 1h свечи для тикера (как в byBitBot). Вызывается из watcher перед getSignal.
 */
export function ingest1hCandles(
  ticker: string,
  candles: HistoricalCandleInput[]
): void {
  initSymbol1h(ticker);
  const state = candleState1h[ticker]!;
  state.history = [];
  state.current = null;
  for (const c of candles) {
    if (state.current) {
      state.history.push(state.current);
      if (state.history.length >= HISTORY_LIMIT_1H) state.history.shift();
    }
    state.current = {
      minute: Math.floor(c.timestamp / 3600000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    };
  }
  const all1h = state.current ? [...state.history, state.current] : state.history;
  state.atr =
    all1h.length >= 15 ? calculateATRFromCandles(all1h, 14) : 0;
  const lastVols = state.history.slice(-14).map((h) => h.volume);
  state.avgVolume =
    lastVols.length > 0
      ? lastVols.reduce((a, b) => a + b, 0) / lastVols.length
      : 0;
}

export function getCandle1h(ticker: string): Candle | null {
  return candleState1h[ticker]?.current ?? null;
}

/** Время закрытия последней 1h свечи (мс). Нужно для проверки «устаревшего» сигнала (выходные, перерыв торгов). */
export function getLastCandleTimestamp1h(ticker: string): number | null {
  const current = candleState1h[ticker]?.current;
  if (!current) return null;
  return (current.minute + 1) * 3600000;
}

export function getHistory1h(ticker: string): Candle[] {
  return candleState1h[ticker]?.history ?? [];
}

/**
 * Возвращает последний непрерывный блок 1h свечей (без больших разрывов из‑за выходных/ночи).
 * Нужно для стратегии на Мосбирже: не 24/7, разрывы не должны искажать Bollinger/RSI.
 */
export function getConsecutiveBlock1h(
  ticker: string,
  maxGapHours: number = MAX_CONSECUTIVE_GAP_HOURS
): Candle[] {
  const state = candleState1h[ticker];
  if (!state) return [];
  const all = state.current ? [...state.history, state.current] : [...state.history];
  if (all.length < 2) return all;
  const out: Candle[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const c = all[i]!;
    const prev = all[i + 1];
    if (!prev) {
      out.unshift(c);
      continue;
    }
    const gap = prev.minute - c.minute;
    if (gap > maxGapHours || gap < 0) break;
    out.unshift(c);
  }
  return out;
}

export function getATR1h(ticker: string): number {
  return candleState1h[ticker]?.atr ?? 0;
}
