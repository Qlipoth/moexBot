/**
 * Бэктест стратегии Adaptive Bollinger для фьючерсов MOEX (по образцу byBitBot).
 * Использует 1h свечи, Tinkoff API, расчёт PnL в рублях.
 */

import { adaptiveBollingerStrategy } from '../market/adaptiveBollingerStrategy.js';
import {
  ingestHistoricalCandle,
  getATR1h,
} from '../market/candleBuilder.js';
import { calculatePositionSizing } from '../market/positionSizing.js';
import { BACKTEST_CONFIG } from '../config/backtestConfig.js';
import type { HistoricalCandleInput } from '../core/investClient.js';
import type { FutureInstrumentInfo } from '../core/investClient.js';

type TradeSide = 'LONG' | 'SHORT';

const CFG = BACKTEST_CONFIG;

interface OpenTrade {
  side: TradeSide;
  entryPrice: number;
  stopPrice: number;
  takePrice: number;
  lots: number;
  entryTime: number;
  statIndex: number;
  atr: number;
  bestPrice: number;
}

interface ClosedTrade extends OpenTrade {
  exitPrice: number;
  exitTime: number;
  pnl: number;
  reason: 'STOP' | 'TAKE' | 'TRAILING_TAKE' | 'FLIP' | 'MEAN';
}

interface TradeDiagnostic {
  side: TradeSide;
  entryTime: number;
  entryPrice: number;
  atr: number;
  rsi: number;
  distanceToMiddle: number;
  stopDistance: number;
  takeDistance: number;
  exitPrice?: number;
  exitTime?: number;
  pnl?: number;
  reason?: ClosedTrade['reason'];
}

function annotateExit(diagnostics: TradeDiagnostic[], trade: OpenTrade, closed: ClosedTrade): void {
  const diag = diagnostics[trade.statIndex];
  if (!diag) return;
  diag.exitPrice = closed.exitPrice;
  diag.exitTime = closed.exitTime;
  diag.pnl = closed.pnl;
  diag.reason = closed.reason;
}

function applyInBarExit(
  trade: OpenTrade,
  candle: HistoricalCandleInput
): { reason: 'STOP' | 'TAKE' | 'TRAILING_TAKE'; price: number } | null {
  const trailMult = CFG.trailingTakeAtrMult ?? 0;

  if (trade.side === 'LONG') {
    const newBest = Math.max(trade.bestPrice, candle.high);
    trade.bestPrice = newBest;
    if (trailMult > 0 && newBest > trade.entryPrice + trade.atr * trailMult) {
      const trailingStop = Math.max(trade.entryPrice, newBest - trade.atr * trailMult);
      if (candle.low <= trailingStop) return { reason: 'TRAILING_TAKE', price: trailingStop };
    }
    if (candle.low <= trade.stopPrice) return { reason: 'STOP', price: trade.stopPrice };
    if (candle.high >= trade.takePrice) return { reason: 'TAKE', price: trade.takePrice };
  } else {
    const newBest = Math.min(trade.bestPrice, candle.low);
    trade.bestPrice = newBest;
    if (trailMult > 0 && newBest < trade.entryPrice - trade.atr * trailMult) {
      const trailingStop = Math.min(trade.entryPrice, newBest + trade.atr * trailMult);
      if (candle.high >= trailingStop) return { reason: 'TRAILING_TAKE', price: trailingStop };
    }
    if (candle.high >= trade.stopPrice) return { reason: 'STOP', price: trade.stopPrice };
    if (candle.low <= trade.takePrice) return { reason: 'TAKE', price: trade.takePrice };
  }
  return null;
}

function checkMeanReversionExit(
  trade: OpenTrade,
  candle: HistoricalCandleInput,
  context: ReturnType<typeof adaptiveBollingerStrategy.getContext>
): { reason: 'MEAN'; price: number } | null {
  if (CFG.disableMeanExit) return null;
  if (!context) return null;
  const { middle } = context;
  const meanTol = CFG.meanExitTolerance;
  if (!Number.isFinite(middle)) return null;

  const stopDistance = Math.abs(trade.entryPrice - trade.stopPrice);
  const minProfitRatio = CFG.meanExitMinProfitRatio ?? 0;

  if (trade.side === 'LONG') {
    const triggerPrice = middle * (1 - meanTol);
    if (candle.high >= triggerPrice) {
      const profitAtMiddle = middle - trade.entryPrice;
      if (minProfitRatio > 0 && profitAtMiddle < stopDistance * minProfitRatio) return null;
      return { reason: 'MEAN', price: middle };
    }
  } else {
    const triggerPrice = middle * (1 + meanTol);
    if (candle.low <= triggerPrice) {
      const profitAtMiddle = trade.entryPrice - middle;
      if (minProfitRatio > 0 && profitAtMiddle < stopDistance * minProfitRatio) return null;
      return { reason: 'MEAN', price: middle };
    }
  }
  return null;
}

function closeTrade(
  trade: OpenTrade,
  exitPrice: number,
  exitTime: number,
  reason: ClosedTrade['reason'],
  instrument: FutureInstrumentInfo
): ClosedTrade {
  const direction = trade.side === 'LONG' ? 1 : -1;
  const { minPriceIncrement, minPriceIncrementAmount } = instrument;
  const mult = minPriceIncrementAmount / minPriceIncrement;
  const rawPnl = (exitPrice - trade.entryPrice) * direction * trade.lots * mult;

  const notionalEntry = trade.entryPrice * trade.lots * mult;
  const notionalExit = exitPrice * trade.lots * mult;
  const fee = (notionalEntry + notionalExit) * CFG.feeRate;

  const pnl = rawPnl - fee;
  return {
    ...trade,
    exitPrice,
    exitTime,
    pnl,
    reason,
  };
}

export interface BacktestResult {
  ticker: string;
  trades: number;
  wins: number;
  losses: number;
  winrate: number;
  pnl: number;
  maxDrawdown: number;
}

export async function runBacktest(
  candles: HistoricalCandleInput[],
  ticker: string,
  instrument: FutureInstrumentInfo,
  silent = false
): Promise<BacktestResult> {
  if (!candles.length) {
    throw new Error('❌ Нет исторических данных для бэктеста');
  }

  const { minPriceIncrement, minPriceIncrementAmount } = instrument;
  if (minPriceIncrement <= 0 || minPriceIncrementAmount <= 0) {
    throw new Error('❌ Некорректные параметры инструмента');
  }

  const INTERVAL_MS_1H = 3600_000;
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i]!.timestamp - candles[i - 1]!.timestamp;
    if (diff !== INTERVAL_MS_1H) gaps++;
  }
  if (!silent && gaps > 0) {
    console.log(`Обнаружено разрывов (1h): ${gaps}`);
  }

  let balance: number = CFG.startBalance;
  let maxEquity = balance;
  let maxDrawdown = 0;
  let openTrade: OpenTrade | null = null;
  const trades: ClosedTrade[] = [];
  const diagnostics: TradeDiagnostic[] = [];

  const commitClose = (trade: OpenTrade, closed: ClosedTrade) => {
    trades.push(closed);
    annotateExit(diagnostics, trade, closed);
    balance += closed.pnl;
    maxEquity = Math.max(maxEquity, balance);
    maxDrawdown = Math.max(maxDrawdown, maxEquity - balance);
  };

  for (const candle of candles) {
    ingestHistoricalCandle(ticker, candle);

    const signalResult = adaptiveBollingerStrategy.getSignal(ticker);
    const contextSnapshot = adaptiveBollingerStrategy.getContext(ticker);
    if (!signalResult.ready) continue;

    // 1️⃣ Проверка выхода из текущей позиции
    if (openTrade) {
      const inBarExit = applyInBarExit(openTrade, candle);
      if (inBarExit) {
        const closed = closeTrade(openTrade, inBarExit.price, candle.timestamp, inBarExit.reason, instrument);
        commitClose(openTrade, closed);
        openTrade = null;
        continue;
      }

      const meanExit = checkMeanReversionExit(openTrade, candle, contextSnapshot);
      if (meanExit) {
        const closed = closeTrade(openTrade, meanExit.price, candle.timestamp, meanExit.reason, instrument);
        commitClose(openTrade, closed);
        openTrade = null;
        continue;
      }

      const catastrophicStop = (t: OpenTrade) => {
        const pctMove = (candle.close - t.entryPrice) / t.entryPrice;
        if (t.side === 'LONG' && pctMove < -CFG.catastrophicStopPct) return true;
        if (t.side === 'SHORT' && pctMove > CFG.catastrophicStopPct) return true;
        return false;
      };
      if (catastrophicStop(openTrade)) {
        const closed = closeTrade(openTrade, candle.close, candle.timestamp, 'STOP', instrument);
        commitClose(openTrade, closed);
        openTrade = null;
        continue;
      }
    }

    // 2️⃣ Разворот по новому сигналу
    if (openTrade && signalResult.signal !== openTrade.side && signalResult.signal !== 'NONE') {
      const closed = closeTrade(openTrade, candle.close, candle.timestamp, 'FLIP', instrument);
      commitClose(openTrade, closed);
      openTrade = null;
    }

    // 3️⃣ Условия входа
    if (!openTrade && (signalResult.signal === 'LONG' || signalResult.signal === 'SHORT')) {
      const side: TradeSide = signalResult.signal;
      const confirmed = adaptiveBollingerStrategy.confirmEntry(ticker, signalResult.signal);
      if (!confirmed) continue;

      const atr = getATR1h(ticker);
      if (!Number.isFinite(atr) || atr <= 0) continue;

      const stopDistance = atr * CFG.stopAtrMult;
      const entryPrice = candle.close;
      const stopPrice: number = side === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;

      const sizing = calculatePositionSizing(
        balance,
        entryPrice,
        stopPrice,
        side,
        minPriceIncrement,
        minPriceIncrementAmount,
        silent
      );
      if (!sizing || sizing.lots < 1) continue;

      const rrRatio = CFG.rrRatio ?? 2;
      const takePrice: number =
        side === 'LONG'
          ? entryPrice + stopDistance * rrRatio
          : entryPrice - stopDistance * rrRatio;

      const distanceToMiddle =
        contextSnapshot?.middle
          ? Math.abs(contextSnapshot.close - contextSnapshot.middle) / contextSnapshot.middle
          : 0;

      const statIndex = diagnostics.length;
      diagnostics.push({
        side,
        entryTime: candle.timestamp,
        entryPrice,
        atr,
        rsi: contextSnapshot?.rsiLong ?? 0,
        distanceToMiddle,
        stopDistance,
        takeDistance: Math.abs(takePrice - entryPrice),
      });

      openTrade = {
        side,
        entryPrice,
        stopPrice,
        takePrice,
        lots: sizing.lots,
        entryTime: candle.timestamp,
        statIndex,
        atr,
        bestPrice: entryPrice,
      };
    }
  }

  // Закрываем оставшуюся позицию
  if (openTrade) {
    const lastCandle = candles[candles.length - 1]!;
    const closed = closeTrade(openTrade, lastCandle.close, lastCandle.timestamp, 'FLIP', instrument);
    commitClose(openTrade, closed);
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winrate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const pnlTotal = balance - CFG.startBalance;

  if (!silent) {
    console.log('================ ADAPTIVE BOLLINGER BACKTEST (MOEX) ================');
    console.log(`Тикер: ${ticker}`);
    console.log(`Сделок: ${trades.length}`);
    console.log(`Winrate: ${winrate.toFixed(2)}% (W:${wins.length} / L:${losses.length})`);
    console.log(`Чистый PnL: ${pnlTotal.toFixed(2)} ₽`);
    console.log(`Итоговый баланс: ${balance.toFixed(2)} ₽`);
    console.log(`Max Drawdown: ${maxDrawdown.toFixed(2)} ₽`);
    console.log('Топ-5 сделок по PnL:');
    trades
      .slice()
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 5)
      .forEach((t) => {
        console.log(
          `  ${new Date(t.entryTime).toISOString()} | ${t.side} | PnL: ${t.pnl.toFixed(2)} ₽ | ${t.reason}`
        );
      });

    const avg = (values: number[]) =>
      values.length ? values.reduce((sum, val) => sum + val, 0) / values.length : 0;
    const closedDiag = diagnostics.filter((d) => typeof d.pnl === 'number');
    const avgHoldHours = avg(closedDiag.map((d) => ((d.exitTime ?? d.entryTime) - d.entryTime) / 3600000));
    const exitStats = closedDiag.reduce<Record<string, number>>((acc, d) => {
      if (d.reason) acc[d.reason] = (acc[d.reason] ?? 0) + 1;
      return acc;
    }, {});

    const winPnls = wins.map((t) => t.pnl);
    const lossPnls = losses.map((t) => t.pnl);
    const avgWin = winPnls.length ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
    const avgLoss = lossPnls.length ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;

    console.log('--- PnL: средний выигрыш vs средний убыток ---');
    console.log(`Средний выигрыш: +${avgWin.toFixed(2)} ₽ (${wins.length} сделок)`);
    console.log(`Средний убыток: ${avgLoss.toFixed(2)} ₽ (${losses.length} сделок)`);
    console.log(
      `Причины выхода: ${Object.entries(exitStats).map(([r, c]) => `${r}=${c}`).join(', ') || 'нет'}`
    );
    console.log('--- Диагностика входа ---');
    console.log(`Средний ATR: ${avg(diagnostics.map((d) => d.atr)).toFixed(4)}`);
    console.log(`Средний RSI: ${avg(diagnostics.map((d) => d.rsi)).toFixed(2)}`);
    console.log(`Среднее время удержания: ${avgHoldHours.toFixed(2)} ч`);
  }

  const byMonth = new Map<
    string,
    { wins: number; losses: number; pnl: number; stopCount: number; meanCount: number; winSum: number; lossSum: number }
  >();
  for (const t of trades) {
    const date = new Date(t.entryTime);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = byMonth.get(key) ?? {
      wins: 0,
      losses: 0,
      pnl: 0,
      stopCount: 0,
      meanCount: 0,
      winSum: 0,
      lossSum: 0,
    };
    if (t.pnl > 0) {
      row.wins++;
      row.winSum += t.pnl;
    } else {
      row.losses++;
      row.lossSum += t.pnl;
    }
    row.pnl += t.pnl;
    if (t.reason === 'STOP') row.stopCount++;
    else if (t.reason === 'MEAN') row.meanCount++;
    byMonth.set(key, row);
  }
  if (!silent) {
    const sortedMonths = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sortedMonths.length) {
      console.log('--- По месяцам (Winrate % | PnL ₽ | STOP/MEAN | avg win/loss) ---');
      for (const [month, row] of sortedMonths) {
        const total = row.wins + row.losses;
        const wr = total ? ((row.wins / total) * 100).toFixed(1) : '0';
        const pnlStr = row.pnl >= 0 ? `+${row.pnl.toFixed(2)}` : row.pnl.toFixed(2);
        const avgWin = row.wins ? (row.winSum / row.wins).toFixed(2) : '-';
        const avgLoss = row.losses ? (row.lossSum / row.losses).toFixed(2) : '-';
        console.log(
          `  ${month}: ${wr}% (W:${row.wins} L:${row.losses}) | PnL: ${pnlStr} ₽ | STOP:${row.stopCount} MEAN:${row.meanCount} | avg win: ${avgWin} avg loss: ${avgLoss}`
        );
      }
    }
  }

  return {
    ticker,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winrate,
    pnl: pnlTotal,
    maxDrawdown,
  };
}
