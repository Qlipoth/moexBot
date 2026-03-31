/**
 * Сравнение AdaptiveBollinger vs новых стратегий для USDRUBF и IMOEXF.
 * Использует кэшированные свечи (pnpm run download уже выполнен).
 *
 * Запуск:
 *   $env:CANDLE_CACHE_DIR="C:\work\moexBot\data\candles"
 *   $env:INSTRUMENT_CACHE_DIR="C:\work\moexBot\data\instruments"
 *   pnpm tsx scripts/compareStrategies.ts
 */

import { loadCachedCandles, loadCachedInstrument } from '../src/backtest/candleCache.js';
import { runBacktest } from '../src/backtest/adaptiveBollingerBacktest.js';
import { BACKTEST_CONFIG } from '../src/config/backtestConfig.js';
import type { HistoricalCandleInput, FutureInstrumentInfo } from '../src/core/investClient.js';

// ─── Вспомогательные функции ─────────────────────────────────────────────────

function calcEma(prices: number[], period: number): number {
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i]! * k + ema * (1 - k);
  }
  return ema;
}

function calcRsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcAtr(candles: HistoricalCandleInput[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const slice = candles.slice(-period);
  const trs = slice.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[candles.length - period + i - 1]!;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return trs.reduce((a, b) => a + b, 0) / period;
}

// ─── Общий движок бэктеста (без mean-exit для трендовых стратегий) ───────────

type TradeSide = 'LONG' | 'SHORT';

interface TradeResult {
  pnl: number;
  entryTime: number;
  side: TradeSide;
  reason: string;
}

function runInlineBacktest(
  candles: HistoricalCandleInput[],
  instrument: FutureInstrumentInfo,
  getSignal: (idx: number) => { signal: 'LONG' | 'SHORT' | 'NONE'; ready: boolean },
  useMeanExit: boolean,
  getMidForMeanExit?: (idx: number) => number | null,
  rrRatio = BACKTEST_CONFIG.rrRatio
): { trades: TradeResult[]; finalBalance: number; maxDrawdown: number } {
  const { minPriceIncrement, minPriceIncrementAmount } = instrument;
  const mult = minPriceIncrementAmount / minPriceIncrement;
  const { startBalance, feeRate, riskPerTrade, stopAtrMult, catastrophicStopPct } = BACKTEST_CONFIG;

  let balance = startBalance;
  let maxEquity = balance;
  let maxDrawdown = 0;
  const trades: TradeResult[] = [];

  type OpenTrade = {
    side: TradeSide; entry: number; stop: number; take: number;
    lots: number; entryTime: number; atr: number;
  };
  let open: OpenTrade | null = null;

  const close = (trade: OpenTrade, exitPrice: number, exitTime: number, reason: string) => {
    const dir = trade.side === 'LONG' ? 1 : -1;
    const rawPnl = (exitPrice - trade.entry) * dir * trade.lots * mult;
    const fee = (trade.entry + exitPrice) * trade.lots * mult * feeRate;
    const pnl = rawPnl - fee;
    balance += pnl;
    maxEquity = Math.max(maxEquity, balance);
    maxDrawdown = Math.max(maxDrawdown, maxEquity - balance);
    trades.push({ pnl, entryTime: trade.entryTime, side: trade.side, reason });
    return pnl;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const sig = getSignal(i);
    if (!sig.ready) continue;

    if (open) {
      // Внутрибарный выход: стоп / тейк
      let exited = false;
      if (open.side === 'LONG') {
        if (c.low <= open.stop) { close(open, open.stop, c.timestamp, 'STOP'); open = null; exited = true; }
        else if (c.high >= open.take) { close(open, open.take, c.timestamp, 'TAKE'); open = null; exited = true; }
      } else {
        if (c.high >= open.stop) { close(open, open.stop, c.timestamp, 'STOP'); open = null; exited = true; }
        else if (c.low <= open.take) { close(open, open.take, c.timestamp, 'TAKE'); open = null; exited = true; }
      }

      if (!exited) {
        // Катастрофический стоп
        const pctMove = (c.close - open.entry) / open.entry;
        const catastrophic =
          (open.side === 'LONG' && pctMove < -catastrophicStopPct) ||
          (open.side === 'SHORT' && pctMove > catastrophicStopPct);
        if (catastrophic) {
          close(open, c.close, c.timestamp, 'CATASTROP');
          open = null;
          exited = true;
        }
      }

      if (!exited && useMeanExit && getMidForMeanExit) {
        const mid = getMidForMeanExit(i);
        if (mid != null && mid > 0) {
          const tol = 0.0025;
          const reachedMid =
            open.side === 'LONG' ? c.high >= mid * (1 - tol) : c.low <= mid * (1 + tol);
          const inProfit = open.side === 'LONG' ? c.close > open.entry : c.close < open.entry;
          if (reachedMid && inProfit) {
            close(open, mid, c.timestamp, 'MEAN');
            open = null;
            exited = true;
          }
        }
      }

      if (!exited && open && sig.signal !== 'NONE' && sig.signal !== open.side) {
        close(open, c.close, c.timestamp, 'FLIP');
        open = null;
      }
    }

    if (!open && (sig.signal === 'LONG' || sig.signal === 'SHORT')) {
      const atr = calcAtr(candles.slice(0, i + 1), 14);
      if (!Number.isFinite(atr) || atr <= 0) continue;
      const entry = c.close;
      const stopDist = atr * stopAtrMult;
      const stop = sig.signal === 'LONG' ? entry - stopDist : entry + stopDist;
      const take = sig.signal === 'LONG' ? entry + stopDist * rrRatio : entry - stopDist * rrRatio;

      // Размер позиции: риск = riskPerTrade * balance
      const riskRub = balance * riskPerTrade;
      const rubPerPt = mult;
      const riskPerLot = stopDist * rubPerPt;
      if (riskPerLot <= 0) continue;
      const lots = Math.max(1, Math.floor(riskRub / riskPerLot));

      open = { side: sig.signal, entry, stop, take, lots, entryTime: c.timestamp, atr };
    }
  }

  if (open) {
    const last = candles[candles.length - 1]!;
    close(open, last.close, last.timestamp, 'END');
  }

  return { trades, finalBalance: balance, maxDrawdown };
}

// ─── RSI Momentum (USDRUBF, откалиброванные параметры) ───────────────────────

function buildRsiMomentumSignals(
  candles: HistoricalCandleInput[],
  rsiLong = 38, rsiShort = 62, emaPeriod = 20, atrMinRatio = 0.002
): Array<{ signal: 'LONG' | 'SHORT' | 'NONE'; ready: boolean }> {
  const signals: Array<{ signal: 'LONG' | 'SHORT' | 'NONE'; ready: boolean }> = [];
  const closes = candles.map(c => c.close);
  let prevRsi: number | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i < emaPeriod + 1) {
      prevRsi = null;
      signals.push({ signal: 'NONE', ready: false });
      continue;
    }
    const slice = closes.slice(0, i + 1);
    const rsi = calcRsi(slice.slice(-15), 14);
    const ema20 = calcEma(slice, emaPeriod);
    const emaBias = (c.close - ema20) / ema20;
    const atr = calcAtr(candles.slice(0, i + 1), 14);
    const atrOk = atr > atrMinRatio * c.close;

    let signal: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
    if (prevRsi !== null && atrOk) {
      if (prevRsi < rsiLong && rsi >= rsiLong && emaBias > 0) signal = 'LONG';
      else if (prevRsi > rsiShort && rsi <= rsiShort && emaBias < 0) signal = 'SHORT';
    }
    prevRsi = rsi;
    signals.push({ signal, ready: true });
  }
  return signals;
}

// ─── EMA Crossover (IMOEXF, откалиброванные параметры) ───────────────────────

function buildEmaCrossoverSignals(
  candles: HistoricalCandleInput[],
  fast = 12, slow = 26, atrMinRatio = 0.002, rsiMin = 35, rsiMax = 70
): Array<{ signal: 'LONG' | 'SHORT' | 'NONE'; ready: boolean }> {
  const signals: Array<{ signal: 'LONG' | 'SHORT' | 'NONE'; ready: boolean }> = [];
  const closes = candles.map(c => c.close);
  let prevFast: number | null = null;
  let prevSlow: number | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i < slow + 5) {
      prevFast = null;
      prevSlow = null;
      signals.push({ signal: 'NONE', ready: false });
      continue;
    }
    const slice = closes.slice(0, i + 1);
    const fastEma = calcEma(slice, fast);
    const slowEma = calcEma(slice, slow);
    const rsi = calcRsi(slice.slice(-15), 14);
    const atr = calcAtr(candles.slice(0, i + 1), 14);
    const atrOk = atr > atrMinRatio * c.close;
    const rsiOk = rsi >= rsiMin && rsi <= rsiMax;

    let signal: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
    if (prevFast !== null && prevSlow !== null && atrOk && rsiOk) {
      if (prevFast < prevSlow && fastEma >= slowEma && c.close > slowEma) signal = 'LONG';
      else if (prevFast > prevSlow && fastEma <= slowEma && c.close < slowEma) signal = 'SHORT';
    }
    prevFast = fastEma;
    prevSlow = slowEma;
    signals.push({ signal, ready: true });
  }
  return signals;
}

// ─── Месячный разбивка ────────────────────────────────────────────────────────

function byMonth(trades: TradeResult[]): Map<string, { wins: number; losses: number; pnl: number }> {
  const m = new Map<string, { wins: number; losses: number; pnl: number }>();
  for (const t of trades) {
    const d = new Date(t.entryTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = m.get(key) ?? { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) row.wins++; else row.losses++;
    row.pnl += t.pnl;
    m.set(key, row);
  }
  return m;
}

function printComparison(
  label: string,
  trades: TradeResult[],
  maxDrawdown: number,
  finalBalance: number
) {
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.length - wins;
  const winrate = trades.length ? (wins / trades.length * 100).toFixed(1) : '0';
  const pnl = finalBalance - BACKTEST_CONFIG.startBalance;
  const pnlStr = pnl >= 0 ? `+${pnl.toFixed(0)}` : pnl.toFixed(0);

  console.log(`\n  Сделок: ${trades.length} | W:${wins} L:${losses} | Winrate: ${winrate}%`);
  console.log(`  PnL: ${pnlStr} ₽ | MaxDD: ${maxDrawdown.toFixed(0)} ₽`);

  const months = byMonth(trades);
  const sortedMonths = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (sortedMonths.length) {
    console.log(`  --- По месяцам ---`);
    for (const [month, row] of sortedMonths) {
      const total = row.wins + row.losses;
      const wr = total ? (row.wins / total * 100).toFixed(0) : '0';
      const p = row.pnl >= 0 ? `+${row.pnl.toFixed(0)}` : row.pnl.toFixed(0);
      console.log(`  ${month}: ${wr}% (W:${row.wins} L:${row.losses}) | ${p} ₽`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  СРАВНЕНИЕ СТРАТЕГИЙ: AdaptiveBollinger vs Новые');
  console.log('════════════════════════════════════════════════════════');

  // ── USDRUBF ──────────────────────────────────────────────────────────────

  const usdrubfCandles = loadCachedCandles('USDRUBF');
  const usdrubfInstrument = loadCachedInstrument('USDRUBF');

  console.log(`\n┌─────────────────────────────────────────────────────┐`);
  console.log(`│  USDRUBF  (${usdrubfCandles.length} свечей)                          │`);
  console.log(`└─────────────────────────────────────────────────────┘`);

  // Bollinger
  console.log('\n[1] AdaptiveBollinger (текущая стратегия):');
  const bollingerResultUsdrubf = await runBacktest(usdrubfCandles, 'USDRUBF', usdrubfInstrument, true);
  {
    const wins = bollingerResultUsdrubf.wins;
    const losses = bollingerResultUsdrubf.losses;
    const wr = bollingerResultUsdrubf.winrate.toFixed(1);
    const pnlStr = bollingerResultUsdrubf.pnl >= 0 ? `+${bollingerResultUsdrubf.pnl.toFixed(0)}` : bollingerResultUsdrubf.pnl.toFixed(0);
    console.log(`  Сделок: ${bollingerResultUsdrubf.trades} | W:${wins} L:${losses} | Winrate: ${wr}%`);
    console.log(`  PnL: ${pnlStr} ₽ | MaxDD: ${bollingerResultUsdrubf.maxDrawdown.toFixed(0)} ₽`);
  }

  // RSI Momentum
  console.log('\n[2] RSI Momentum (откалибровано: RSI 38/62, EMA20, ATR>0.2%):');
  const rsiSignals = buildRsiMomentumSignals(usdrubfCandles);
  const rsiResult = runInlineBacktest(
    usdrubfCandles, usdrubfInstrument,
    (i) => rsiSignals[i] ?? { signal: 'NONE', ready: false },
    false, undefined, 2.5
  );
  printComparison('[2] RSI Momentum', rsiResult.trades, rsiResult.maxDrawdown, rsiResult.finalBalance);

  // ── IMOEXF ───────────────────────────────────────────────────────────────

  const imoexfCandles = loadCachedCandles('IMOEXF');
  const imoexfInstrument = loadCachedInstrument('IMOEXF');

  console.log(`\n┌─────────────────────────────────────────────────────┐`);
  console.log(`│  IMOEXF  (${imoexfCandles.length} свечей)                            │`);
  console.log(`└─────────────────────────────────────────────────────┘`);

  // Bollinger
  console.log('\n[1] AdaptiveBollinger (текущая стратегия):');
  const bollingerResultImoexf = await runBacktest(imoexfCandles, 'IMOEXF', imoexfInstrument, true);
  {
    const wins = bollingerResultImoexf.wins;
    const losses = bollingerResultImoexf.losses;
    const wr = bollingerResultImoexf.winrate.toFixed(1);
    const pnlStr = bollingerResultImoexf.pnl >= 0 ? `+${bollingerResultImoexf.pnl.toFixed(0)}` : bollingerResultImoexf.pnl.toFixed(0);
    console.log(`  Сделок: ${bollingerResultImoexf.trades} | W:${wins} L:${losses} | Winrate: ${wr}%`);
    console.log(`  PnL: ${pnlStr} ₽ | MaxDD: ${bollingerResultImoexf.maxDrawdown.toFixed(0)} ₽`);
  }

  // EMA Crossover
  console.log('\n[2] EMA Crossover (откалибровано: EMA 12/26, RSI 35-70, ATR>0.2%, RR=3):');
  const emaSignals = buildEmaCrossoverSignals(imoexfCandles);
  const emaResult = runInlineBacktest(
    imoexfCandles, imoexfInstrument,
    (i) => emaSignals[i] ?? { signal: 'NONE', ready: false },
    false, undefined, 3.0
  );
  printComparison('[2] EMA Crossover', emaResult.trades, emaResult.maxDrawdown, emaResult.finalBalance);

  // ── Итоговое резюме ────────────────────────────────────────────────────────

  const bollingerTotal = bollingerResultUsdrubf.pnl + bollingerResultImoexf.pnl;
  const newStratTotal = (rsiResult.finalBalance - BACKTEST_CONFIG.startBalance) +
                        (emaResult.finalBalance - BACKTEST_CONFIG.startBalance);

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  ИТОГОВОЕ РЕЗЮМЕ (USDRUBF + IMOEXF combined)');
  console.log('════════════════════════════════════════════════════════');

  const bollingerTrades = bollingerResultUsdrubf.trades + bollingerResultImoexf.trades;
  const rsiEmaTrades = rsiResult.trades.length + emaResult.trades.length;

  console.log(`\n  AdaptiveBollinger:`);
  console.log(`    Сделок: ${bollingerTrades} | PnL: ${bollingerTotal >= 0 ? '+' : ''}${bollingerTotal.toFixed(0)} ₽`);
  console.log(`    MaxDD USDRUBF: ${bollingerResultUsdrubf.maxDrawdown.toFixed(0)} ₽ | IMOEXF: ${bollingerResultImoexf.maxDrawdown.toFixed(0)} ₽`);

  const rsiPnl = rsiResult.finalBalance - BACKTEST_CONFIG.startBalance;
  const emaPnl = emaResult.finalBalance - BACKTEST_CONFIG.startBalance;
  console.log(`\n  RSI Momentum (USDRUBF) + EMA Crossover (IMOEXF):`);
  console.log(`    Сделок: ${rsiEmaTrades} | PnL: ${newStratTotal >= 0 ? '+' : ''}${newStratTotal.toFixed(0)} ₽`);
  console.log(`    MaxDD USDRUBF: ${rsiResult.maxDrawdown.toFixed(0)} ₽ | IMOEXF: ${emaResult.maxDrawdown.toFixed(0)} ₽`);

  const improvement = newStratTotal - bollingerTotal;
  console.log(`\n  Разница PnL: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)} ₽ (${((improvement / Math.abs(bollingerTotal)) * 100).toFixed(0)}%)`);
  console.log('');
}

main().catch(err => {
  console.error('Ошибка:', err);
  process.exit(1);
});
