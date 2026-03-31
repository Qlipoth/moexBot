/**
 * Grid search калибровка стратегии EmaCrossover для IMOEXF.
 * Параметры: fastPeriod, slowPeriod, atrMinRatio, rsiMin, rsiMax, rrRatio.
 */

import { loadCachedCandles, loadCachedInstrument } from '../src/backtest/candleCache.js';
import { calculatePositionSizing } from '../src/market/positionSizing.js';
import { calculateRSI } from '../src/market/analysis.js';
import { BACKTEST_CONFIG } from '../src/config/backtestConfig.js';
import type { HistoricalCandleInput, FutureInstrumentInfo } from '../src/core/investClient.js';

const CFG = BACKTEST_CONFIG;
const TICKER = 'IMOEXF';

// ────────────────────────────────────────────────────────────
// Параметры сетки
// ────────────────────────────────────────────────────────────

const EMA_PAIRS: [number, number][] = [
  [5, 20], [7, 21], [9, 21], [9, 26], [12, 26], [5, 15], [3, 14],
];
const ATR_MIN_RATIOS = [0.001, 0.0015, 0.002, 0.003];
const RSI_RANGES: [number, number][] = [[30, 75], [35, 70], [40, 65], [25, 80]];
const RR_RATIOS = [1.5, 2.0, 2.5, 3.0];

// ────────────────────────────────────────────────────────────
// Типы
// ────────────────────────────────────────────────────────────

interface EmaParams {
  fastPeriod: number;
  slowPeriod: number;
  atrMinRatio: number;
  rsiMin: number;
  rsiMax: number;
  rrRatio: number;
}

interface RunResult {
  params: EmaParams;
  trades: number;
  wins: number;
  winrate: number;
  pnl: number;
  maxDrawdown: number;
  pnlPerDrawdown: number;
}

interface CandleSlim {
  high: number;
  low: number;
  close: number;
}

// ────────────────────────────────────────────────────────────
// Inline ATR (14 периодов, true range)
// ────────────────────────────────────────────────────────────

function calcATR14(candles: CandleSlim[]): number {
  if (candles.length < 15) return 0;
  const last15 = candles.slice(-15);
  const tr: number[] = [];
  for (let i = 1; i < last15.length; i++) {
    const curr = last15[i]!;
    const prev = last15[i - 1]!;
    tr.push(Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    ));
  }
  return tr.reduce((s, v) => s + v, 0) / tr.length;
}

// ────────────────────────────────────────────────────────────
// Закрытие сделки (как в adaptiveBollingerBacktest.ts)
// ────────────────────────────────────────────────────────────

function computePnl(
  exitPrice: number,
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  lots: number,
  mult: number,
): number {
  const direction = side === 'LONG' ? 1 : -1;
  const rawPnl = (exitPrice - entryPrice) * direction * lots * mult;
  const notionalEntry = entryPrice * lots * mult;
  const notionalExit = exitPrice * lots * mult;
  const fee = (notionalEntry + notionalExit) * CFG.feeRate;
  return rawPnl - fee;
}

// ────────────────────────────────────────────────────────────
// Inline бэктест одной комбинации параметров
// ────────────────────────────────────────────────────────────

function runInlineBacktest(
  candles: HistoricalCandleInput[],
  instrument: FutureInstrumentInfo,
  params: EmaParams,
): { trades: number; wins: number; winrate: number; pnl: number; maxDrawdown: number } {
  const { fastPeriod, slowPeriod, atrMinRatio, rsiMin, rsiMax, rrRatio } = params;
  const { minPriceIncrement, minPriceIncrementAmount } = instrument;
  const mult = minPriceIncrementAmount / minPriceIncrement;

  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);
  const MIN_CANDLES = slowPeriod + 5;
  const MAX_HIST = Math.max(slowPeriod + 10, 60);

  // Скользящий буфер (ограниченный размер после инициализации)
  const hist: CandleSlim[] = [];
  let totalCandles = 0;

  let fastEma = 0;
  let slowEma = 0;
  let prevFastEma = 0;
  let prevSlowEma = 0;
  let fastReady = false;
  let slowReady = false;

  let balance = CFG.startBalance;
  let maxEquity = balance;
  let maxDrawdown = 0;

  interface OpenTrade {
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    stopPrice: number;
    takePrice: number;
    lots: number;
  }

  let openTrade: OpenTrade | null = null;
  const tradesPnl: number[] = [];

  const commitClose = (pnl: number) => {
    tradesPnl.push(pnl);
    balance += pnl;
    if (balance > maxEquity) maxEquity = balance;
    const dd = maxEquity - balance;
    if (dd > maxDrawdown) maxDrawdown = dd;
  };

  for (const candle of candles) {
    totalCandles++;
    hist.push({ high: candle.high, low: candle.low, close: candle.close });
    if (hist.length > MAX_HIST) hist.shift();

    // EMA инициализация / обновление
    if (totalCandles === fastPeriod) {
      fastEma = hist.reduce((s, c) => s + c.close, 0) / fastPeriod;
      prevFastEma = fastEma;
      fastReady = true;
    } else if (fastReady) {
      prevFastEma = fastEma;
      fastEma = fastEma * (1 - kFast) + candle.close * kFast;
    }

    if (totalCandles === slowPeriod) {
      slowEma = hist.reduce((s, c) => s + c.close, 0) / slowPeriod;
      prevSlowEma = slowEma;
      slowReady = true;
    } else if (slowReady) {
      prevSlowEma = slowEma;
      slowEma = slowEma * (1 - kSlow) + candle.close * kSlow;
    }

    if (!fastReady || !slowReady || totalCandles < MIN_CANDLES) continue;

    const close = candle.close;
    const atr = calcATR14(hist);
    if (atr <= 0) continue;

    // ── Проверка выхода из открытой позиции ──
    if (openTrade) {
      // Катастрофический стоп
      const pctMove = (close - openTrade.entryPrice) / openTrade.entryPrice;
      const cata = openTrade.side === 'LONG'
        ? pctMove < -CFG.catastrophicStopPct
        : pctMove > CFG.catastrophicStopPct;

      if (cata) {
        commitClose(computePnl(close, openTrade.entryPrice, openTrade.side, openTrade.lots, mult));
        openTrade = null;
        continue;
      }

      // STOP / TAKE по диапазону свечи
      let exitReason: 'STOP' | 'TAKE' | null = null;
      let exitPrice = 0;
      if (openTrade.side === 'LONG') {
        if (candle.low <= openTrade.stopPrice) { exitReason = 'STOP'; exitPrice = openTrade.stopPrice; }
        else if (candle.high >= openTrade.takePrice) { exitReason = 'TAKE'; exitPrice = openTrade.takePrice; }
      } else {
        if (candle.high >= openTrade.stopPrice) { exitReason = 'STOP'; exitPrice = openTrade.stopPrice; }
        else if (candle.low <= openTrade.takePrice) { exitReason = 'TAKE'; exitPrice = openTrade.takePrice; }
      }
      if (exitReason) {
        commitClose(computePnl(exitPrice, openTrade.entryPrice, openTrade.side, openTrade.lots, mult));
        openTrade = null;
        continue;
      }
    }

    // ── Сигнал EMA-пересечения ──
    let signal: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
    const atrOk = atr > atrMinRatio * close;
    if (atrOk) {
      if (prevFastEma < prevSlowEma && fastEma >= slowEma) signal = 'LONG';
      else if (prevFastEma > prevSlowEma && fastEma <= slowEma) signal = 'SHORT';
    }

    // ── FLIP по противоположному сигналу ──
    if (openTrade && signal !== 'NONE' && signal !== openTrade.side) {
      commitClose(computePnl(close, openTrade.entryPrice, openTrade.side, openTrade.lots, mult));
      openTrade = null;
    }

    // ── Вход в позицию ──
    if (!openTrade && (signal === 'LONG' || signal === 'SHORT')) {
      const rsiSlice = hist.slice(-15).map(c => c.close);
      const rsi = calculateRSI(rsiSlice, 14);

      // confirmEntry
      let confirmed = false;
      if (signal === 'LONG') {
        confirmed = close > slowEma && rsi >= rsiMin && rsi <= rsiMax;
      } else {
        confirmed = close < slowEma && rsi >= rsiMin && rsi <= rsiMax;
      }
      if (!confirmed) continue;

      const stopDistance = atr * CFG.stopAtrMult;
      const entryPrice = close;
      const stopPrice = signal === 'LONG'
        ? entryPrice - stopDistance
        : entryPrice + stopDistance;

      const sizing = calculatePositionSizing(
        balance,
        entryPrice,
        stopPrice,
        signal,
        minPriceIncrement,
        minPriceIncrementAmount,
        true,
      );
      if (!sizing || sizing.lots < 1) continue;

      const takePrice = signal === 'LONG'
        ? entryPrice + stopDistance * rrRatio
        : entryPrice - stopDistance * rrRatio;

      openTrade = {
        side: signal,
        entryPrice,
        stopPrice,
        takePrice,
        lots: sizing.lots,
      };
    }
  }

  // Закрываем оставшуюся позицию по последней свече
  if (openTrade && candles.length > 0) {
    const last = candles[candles.length - 1]!;
    commitClose(computePnl(last.close, openTrade.entryPrice, openTrade.side, openTrade.lots, mult));
  }

  const wins = tradesPnl.filter(p => p > 0).length;
  const tradesCount = tradesPnl.length;
  const winrate = tradesCount > 0 ? wins / tradesCount : 0;
  const pnl = balance - CFG.startBalance;

  return { trades: tradesCount, wins, winrate, pnl, maxDrawdown };
}

// ────────────────────────────────────────────────────────────
// Главная функция калибровки
// ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[Calibrate] Загрузка данных ${TICKER}...`);
  const candles = loadCachedCandles(TICKER);
  const instrument = loadCachedInstrument(TICKER);
  console.log(`[Calibrate] Свечей: ${candles.length}, инструмент: uid=${instrument.uid}`);

  // Генерируем все комбинации
  const combos: EmaParams[] = [];
  for (const [fastPeriod, slowPeriod] of EMA_PAIRS) {
    for (const atrMinRatio of ATR_MIN_RATIOS) {
      for (const [rsiMin, rsiMax] of RSI_RANGES) {
        for (const rrRatio of RR_RATIOS) {
          combos.push({ fastPeriod, slowPeriod, atrMinRatio, rsiMin, rsiMax, rrRatio });
        }
      }
    }
  }

  console.log(`[Calibrate] Всего комбинаций: ${combos.length}`);
  console.log('[Calibrate] Запуск grid search...');

  const results: RunResult[] = [];
  const t0 = Date.now();

  for (let i = 0; i < combos.length; i++) {
    const params = combos[i]!;
    const res = runInlineBacktest(candles, instrument, params);
    const pnlPerDrawdown = res.maxDrawdown > 0 ? res.pnl / res.maxDrawdown : (res.pnl > 0 ? Infinity : 0);
    results.push({ params, ...res, pnlPerDrawdown });

    if ((i + 1) % 50 === 0 || i === combos.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`\r[Calibrate] ${i + 1}/${combos.length} (${elapsed}s)  `);
    }
  }
  console.log('\n[Calibrate] Готово.');

  // Сортировка по PnL
  const byPnl = results.slice().sort((a, b) => b.pnl - a.pnl);
  // Топ-5 по Sharpe-подобной метрике (PnL/maxDrawdown), только trades >= 20
  const bySharpe = results
    .filter(r => r.trades >= 20 && Number.isFinite(r.pnlPerDrawdown))
    .sort((a, b) => b.pnlPerDrawdown - a.pnlPerDrawdown);

  const top20 = byPnl.slice(0, 20);
  const top5Sharpe = bySharpe.slice(0, 5);

  console.log('\n══════════════ ТОП-20 по PnL ══════════════');
  for (let i = 0; i < top20.length; i++) {
    const r = top20[i]!;
    const { fastPeriod, slowPeriod, atrMinRatio, rsiMin, rsiMax, rrRatio } = r.params;
    console.log(
      `#${i + 1} | EMA(${fastPeriod},${slowPeriod}) atr=${atrMinRatio} rsi=[${rsiMin},${rsiMax}] rr=${rrRatio}` +
      ` | trades=${r.trades} wr=${(r.winrate * 100).toFixed(1)}%` +
      ` pnl=${r.pnl.toFixed(0)}₽ dd=${r.maxDrawdown.toFixed(0)}₽ pnl/dd=${r.pnlPerDrawdown.toFixed(2)}`,
    );
  }

  console.log('\n══════════════ ТОП-5 по Sharpe (pnl/dd, trades≥20) ══════════════');
  for (let i = 0; i < top5Sharpe.length; i++) {
    const r = top5Sharpe[i]!;
    const { fastPeriod, slowPeriod, atrMinRatio, rsiMin, rsiMax, rrRatio } = r.params;
    console.log(
      `#${i + 1} | EMA(${fastPeriod},${slowPeriod}) atr=${atrMinRatio} rsi=[${rsiMin},${rsiMax}] rr=${rrRatio}` +
      ` | trades=${r.trades} wr=${(r.winrate * 100).toFixed(1)}%` +
      ` pnl=${r.pnl.toFixed(0)}₽ dd=${r.maxDrawdown.toFixed(0)}₽ pnl/dd=${r.pnlPerDrawdown.toFixed(2)}`,
    );
  }

  const best = byPnl[0]!;
  const bestSharpe = top5Sharpe[0] ?? byPnl[0]!;

  console.log('\n══════════════ ЛУЧШАЯ ПО PnL ══════════════');
  console.log(JSON.stringify(best, null, 2));

  console.log('\n══════════════ ЛУЧШАЯ ПО SHARPE ══════════════');
  console.log(JSON.stringify(bestSharpe, null, 2));

  // Формат ответа
  const output = {
    ticker: TICKER,
    strategy: 'EmaCrossover',
    totalCombinations: combos.length,
    top5: top20.slice(0, 5).map((r, i) => ({
      rank: i + 1,
      params: r.params,
      trades: r.trades,
      winrate: parseFloat((r.winrate * 100).toFixed(2)),
      pnl: parseFloat(r.pnl.toFixed(2)),
      maxDrawdown: parseFloat(r.maxDrawdown.toFixed(2)),
      pnlPerDrawdown: Number.isFinite(r.pnlPerDrawdown) ? parseFloat(r.pnlPerDrawdown.toFixed(3)) : 0,
    })),
    top5BySharpe: top5Sharpe.map((r, i) => ({
      rank: i + 1,
      params: r.params,
      trades: r.trades,
      winrate: parseFloat((r.winrate * 100).toFixed(2)),
      pnl: parseFloat(r.pnl.toFixed(2)),
      maxDrawdown: parseFloat(r.maxDrawdown.toFixed(2)),
      pnlPerDrawdown: Number.isFinite(r.pnlPerDrawdown) ? parseFloat(r.pnlPerDrawdown.toFixed(3)) : 0,
    })),
    bestByPnl: {
      params: best.params,
      trades: best.trades,
      winrate: parseFloat((best.winrate * 100).toFixed(2)),
      pnl: parseFloat(best.pnl.toFixed(2)),
      maxDrawdown: parseFloat(best.maxDrawdown.toFixed(2)),
      pnlPerDrawdown: Number.isFinite(best.pnlPerDrawdown) ? parseFloat(best.pnlPerDrawdown.toFixed(3)) : 0,
    },
    bestBySharpe: {
      params: bestSharpe.params,
      trades: bestSharpe.trades,
      winrate: parseFloat((bestSharpe.winrate * 100).toFixed(2)),
      pnl: parseFloat(bestSharpe.pnl.toFixed(2)),
      maxDrawdown: parseFloat(bestSharpe.maxDrawdown.toFixed(2)),
      pnlPerDrawdown: Number.isFinite(bestSharpe.pnlPerDrawdown) ? parseFloat(bestSharpe.pnlPerDrawdown.toFixed(3)) : 0,
    },
    conclusion: '',
  };

  // Вывод заключения
  const conclusion = [
    `Grid search завершён: ${combos.length} комбинаций, ${candles.length} свечей.`,
    `Лучшая по PnL: EMA(${best.params.fastPeriod},${best.params.slowPeriod})`,
    `atrMinRatio=${best.params.atrMinRatio}, rsi=[${best.params.rsiMin},${best.params.rsiMax}], rr=${best.params.rrRatio}`,
    `→ PnL=${best.pnl.toFixed(0)}₽, wr=${(best.winrate * 100).toFixed(1)}%, trades=${best.trades}, dd=${best.maxDrawdown.toFixed(0)}₽`,
  ].join(' ');
  output.conclusion = conclusion;

  console.log('\n══════════════ ИТОГОВЫЙ JSON ══════════════');
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err: unknown) => {
  console.error('[Calibrate] Ошибка:', err);
  process.exit(1);
});
