/**
 * Grid search калибровка стратегии RSI Momentum для USDRUBF (MOEX).
 * Перебирает 400 комбинаций параметров, сортирует по PnL.
 *
 * Запуск:
 *   $env:CANDLE_CACHE_DIR="C:\work\moexBot\data\candles"
 *   $env:INSTRUMENT_CACHE_DIR="C:\work\moexBot\data\instruments"
 *   pnpm run calibrate:rsi
 */

import { loadCachedCandles, loadCachedInstrument } from '../src/backtest/candleCache.js';
import { calculatePositionSizing } from '../src/market/positionSizing.js';
import { calculateRSI } from '../src/market/analysis.js';
import { BACKTEST_CONFIG } from '../src/config/backtestConfig.js';
import type { HistoricalCandleInput } from '../src/core/investClient.js';
import type { FutureInstrumentInfo } from '../src/core/investClient.js';

const TICKER = 'USDRUBF';
const RSI_PERIOD = 14;
const EMA_PERIOD = 20;
const ATR_PERIOD = 14;
const MIN_CANDLES = 25;
const CFG = BACKTEST_CONFIG;

// ─── Сетка параметров ────────────────────────────────────────────────────────

const RSI_LEVEL_PAIRS: [number, number][] = [
  [28, 72],
  [30, 70],
  [32, 68],
  [35, 65],
  [38, 62],
];
const EMA_BIAS_MIN_VALS = [0, 0.001, 0.002, 0.003, 0.005];
const ATR_MIN_RATIO_VALS = [0.001, 0.0015, 0.002, 0.003];
const RR_RATIO_VALS = [1.5, 2.0, 2.5, 3.0];

// ─── Типы ────────────────────────────────────────────────────────────────────

interface GridParams {
  rsiLongLevel: number;
  rsiShortLevel: number;
  emaBiasMin: number;
  atrMinRatio: number;
  rrRatio: number;
}

interface GridResult extends GridParams {
  trades: number;
  wins: number;
  winrate: number;
  pnl: number;
  maxDrawdown: number;
}

interface PrecomputedCandle {
  timestamp: number;
  high: number;
  low: number;
  close: number;
  rsi: number;
  prevRsi: number | null;
  ema20: number;
  emaBias: number;
  atr: number;
  ready: boolean;
}

interface OpenTrade {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  takePrice: number;
  lots: number;
  entryTime: number;
  atr: number;
  bestPrice: number;
}

// ─── Предварительный расчёт индикаторов (однократно для всех комбо) ──────────

function precomputeCandles(candles: HistoricalCandleInput[]): PrecomputedCandle[] {
  const EMA_K = 2 / (EMA_PERIOD + 1);
  const result: PrecomputedCandle[] = [];

  let ema: number | null = null;
  let prevRsiValue: number | null = null;
  let atr: number | null = null;
  const trBuffer: number[] = [];
  const closesWindow: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const prevCandle = i > 0 ? candles[i - 1] : undefined;

    // ── Скользящее окно цен закрытия ──
    closesWindow.push(candle.close);
    if (closesWindow.length > 250) closesWindow.shift();

    // ── True Range → ATR (сглаживание Уайлдера) ──
    let tr = candle.high - candle.low;
    if (prevCandle) {
      tr = Math.max(
        tr,
        Math.abs(candle.high - prevCandle.close),
        Math.abs(candle.low - prevCandle.close)
      );
    }
    if (atr === null) {
      trBuffer.push(tr);
      if (trBuffer.length === ATR_PERIOD) {
        atr = trBuffer.reduce((s, v) => s + v, 0) / ATR_PERIOD;
        trBuffer.length = 0;
      }
    } else {
      atr = (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
    }

    // ── EMA(20) инкрементально ──
    if (ema === null && closesWindow.length >= EMA_PERIOD) {
      // Инициализация: среднее первых EMA_PERIOD значений
      ema = closesWindow.slice(0, EMA_PERIOD).reduce((a, b) => a + b, 0) / EMA_PERIOD;
      for (let j = EMA_PERIOD; j < closesWindow.length; j++) {
        ema = closesWindow[j]! * EMA_K + ema * (1 - EMA_K);
      }
    } else if (ema !== null) {
      ema = candle.close * EMA_K + ema * (1 - EMA_K);
    }

    // ── RSI(14) текущий ──
    let currentRsi = 50;
    if (closesWindow.length >= RSI_PERIOD + 1) {
      currentRsi = calculateRSI(closesWindow.slice(-(RSI_PERIOD + 2)), RSI_PERIOD);
    }

    const emaBias = ema !== null && ema > 0 ? (candle.close - ema) / ema : 0;
    const ready = closesWindow.length >= MIN_CANDLES;

    result.push({
      timestamp: candle.timestamp,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      rsi: currentRsi,
      // prevRsi — значение RSI, рассчитанное на предыдущей свече
      prevRsi: closesWindow.length >= RSI_PERIOD + 2 ? prevRsiValue : null,
      ema20: ema ?? candle.close,
      emaBias,
      atr: atr ?? 0,
      ready,
    });

    // Сохраняем текущий RSI для следующей итерации
    if (closesWindow.length >= RSI_PERIOD + 1) {
      prevRsiValue = currentRsi;
    }
  }

  return result;
}

// ─── Вспомогательные функции бэктеста ────────────────────────────────────────

function closeTrade(
  trade: OpenTrade,
  exitPrice: number,
  mult: number
): number {
  const direction = trade.side === 'LONG' ? 1 : -1;
  const rawPnl = (exitPrice - trade.entryPrice) * direction * trade.lots * mult;
  const notionalEntry = trade.entryPrice * trade.lots * mult;
  const notionalExit = exitPrice * trade.lots * mult;
  const fee = (notionalEntry + notionalExit) * CFG.feeRate;
  return rawPnl - fee;
}

function applyInBarExit(
  trade: OpenTrade,
  high: number,
  low: number
): { price: number } | null {
  if (trade.side === 'LONG') {
    trade.bestPrice = Math.max(trade.bestPrice, high);
    if (low <= trade.stopPrice) return { price: trade.stopPrice };
    if (high >= trade.takePrice) return { price: trade.takePrice };
  } else {
    trade.bestPrice = Math.min(trade.bestPrice, low);
    if (high >= trade.stopPrice) return { price: trade.stopPrice };
    if (low <= trade.takePrice) return { price: trade.takePrice };
  }
  return null;
}

// ─── Inline-бэктест (чистая функция, без глобального состояния) ──────────────

function runInlineBacktest(
  precomputed: PrecomputedCandle[],
  candles: HistoricalCandleInput[],
  instrument: FutureInstrumentInfo,
  params: GridParams
): { trades: number; wins: number; pnl: number; maxDrawdown: number } {
  const { rsiLongLevel, rsiShortLevel, emaBiasMin, atrMinRatio, rrRatio } = params;
  const { minPriceIncrement, minPriceIncrementAmount } = instrument;
  const mult = minPriceIncrementAmount / minPriceIncrement;

  let balance = CFG.startBalance;
  let maxEquity = balance;
  let maxDrawdown = 0;
  let openTrade: OpenTrade | null = null;
  let totalTrades = 0;
  let totalWins = 0;

  const commitPnl = (pnl: number, isWin: boolean): void => {
    totalTrades++;
    if (isWin) totalWins++;
    balance += pnl;
    if (balance > maxEquity) maxEquity = balance;
    const dd = maxEquity - balance;
    if (dd > maxDrawdown) maxDrawdown = dd;
  };

  const getSignal = (pc: PrecomputedCandle): 'LONG' | 'SHORT' | 'NONE' => {
    if (!pc.ready || pc.prevRsi === null) return 'NONE';
    if (!Number.isFinite(pc.atr) || pc.atr < atrMinRatio * pc.close) return 'NONE';
    if (pc.prevRsi < rsiLongLevel && pc.rsi >= rsiLongLevel && pc.emaBias > 0) return 'LONG';
    if (pc.prevRsi > rsiShortLevel && pc.rsi <= rsiShortLevel && pc.emaBias < 0) return 'SHORT';
    return 'NONE';
  };

  const confirmEntry = (pc: PrecomputedCandle, side: 'LONG' | 'SHORT'): boolean => {
    if (side === 'LONG') return pc.rsi >= rsiLongLevel - 3 && pc.emaBias > -emaBiasMin;
    return pc.rsi <= rsiShortLevel + 3 && pc.emaBias < emaBiasMin;
  };

  for (let i = 0; i < precomputed.length; i++) {
    const pc = precomputed[i]!;
    const candle = candles[i]!;

    if (!pc.ready) continue;

    const signal = getSignal(pc);

    // 1. Проверка выхода из открытой позиции
    if (openTrade) {
      const inBarExit = applyInBarExit(openTrade, candle.high, candle.low);
      if (inBarExit) {
        const pnl = closeTrade(openTrade, inBarExit.price, mult);
        commitPnl(pnl, pnl > 0);
        openTrade = null;
        continue;
      }

      // Катастрофический стоп
      const pctMove = (candle.close - openTrade.entryPrice) / openTrade.entryPrice;
      const isCatastrophic =
        (openTrade.side === 'LONG' && pctMove < -CFG.catastrophicStopPct) ||
        (openTrade.side === 'SHORT' && pctMove > CFG.catastrophicStopPct);
      if (isCatastrophic) {
        const pnl = closeTrade(openTrade, candle.close, mult);
        commitPnl(pnl, pnl > 0);
        openTrade = null;
        continue;
      }
    }

    // 2. Разворот по противоположному сигналу (FLIP)
    if (openTrade && signal !== 'NONE' && signal !== openTrade.side) {
      const pnl = closeTrade(openTrade, candle.close, mult);
      commitPnl(pnl, pnl > 0);
      openTrade = null;
    }

    // 3. Вход в новую позицию
    if (!openTrade && (signal === 'LONG' || signal === 'SHORT')) {
      if (!confirmEntry(pc, signal)) continue;

      const atr = pc.atr;
      if (!Number.isFinite(atr) || atr <= 0) continue;

      const stopDistance = atr * CFG.stopAtrMult;
      const entryPrice = candle.close;
      const stopPrice =
        signal === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;

      const sizing = calculatePositionSizing(
        balance,
        entryPrice,
        stopPrice,
        signal,
        minPriceIncrement,
        minPriceIncrementAmount,
        true // silent
      );
      if (!sizing || sizing.lots < 1) continue;

      const takePrice =
        signal === 'LONG'
          ? entryPrice + stopDistance * rrRatio
          : entryPrice - stopDistance * rrRatio;

      openTrade = {
        side: signal,
        entryPrice,
        stopPrice,
        takePrice,
        lots: sizing.lots,
        entryTime: candle.timestamp,
        atr,
        bestPrice: entryPrice,
      };
    }
  }

  // Закрываем оставшуюся позицию по последней свече
  if (openTrade && candles.length > 0) {
    const lastCandle = candles[candles.length - 1]!;
    const pnl = closeTrade(openTrade, lastCandle.close, mult);
    commitPnl(pnl, pnl > 0);
  }

  return {
    trades: totalTrades,
    wins: totalWins,
    pnl: balance - CFG.startBalance,
    maxDrawdown,
  };
}

// ─── Основной скрипт ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🔍 Калибровка RSI Momentum | Тикер: ${TICKER}`);
  console.log('Загрузка данных...');

  const candles = loadCachedCandles(TICKER);
  const instrument = loadCachedInstrument(TICKER);

  console.log(`Свечей: ${candles.length}`);
  console.log(`Инструмент: minPriceIncrement=${instrument.minPriceIncrement}, minPriceIncrementAmount=${instrument.minPriceIncrementAmount}`);

  console.log('Предвычисление индикаторов...');
  const precomputed = precomputeCandles(candles);
  const readyCount = precomputed.filter((p) => p.ready).length;
  console.log(`Готово к торговле (ready): ${readyCount} свечей из ${precomputed.length}\n`);

  // Генерация всех комбинаций параметров
  const allParams: GridParams[] = [];
  for (const [long, short] of RSI_LEVEL_PAIRS) {
    for (const emaBiasMin of EMA_BIAS_MIN_VALS) {
      for (const atrMinRatio of ATR_MIN_RATIO_VALS) {
        for (const rrRatio of RR_RATIO_VALS) {
          allParams.push({
            rsiLongLevel: long,
            rsiShortLevel: short,
            emaBiasMin,
            atrMinRatio,
            rrRatio,
          });
        }
      }
    }
  }

  console.log(`Запуск grid search: ${allParams.length} комбинаций...`);
  const startTime = Date.now();

  const results: GridResult[] = [];

  for (let idx = 0; idx < allParams.length; idx++) {
    const params = allParams[idx]!;
    const res = runInlineBacktest(precomputed, candles, instrument, params);
    results.push({
      ...params,
      trades: res.trades,
      wins: res.wins,
      winrate: res.trades > 0 ? (res.wins / res.trades) * 100 : 0,
      pnl: res.pnl,
      maxDrawdown: res.maxDrawdown,
    });

    if ((idx + 1) % 100 === 0) {
      process.stdout.write(`  Прогресс: ${idx + 1}/${allParams.length}\r`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nГотово за ${elapsed}с`);

  // Сортировка по PnL (убыванию)
  results.sort((a, b) => b.pnl - a.pnl);

  const top20 = results.slice(0, 20);
  const best = top20[0]!;

  // ── Вывод топ-20 ──
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('ТОП-20 комбинаций (по PnL)');
  console.log('─────────────────────────────────────────────────────────────────────');
  console.log(
    'Rank | rsiL/rsiS | emaBias | atrRatio | rrRatio | Trades | Winrate | PnL ₽      | MaxDD ₽'
  );
  console.log(
    '─────────────────────────────────────────────────────────────────────'
  );

  top20.forEach((r, rank) => {
    const pnlStr = r.pnl >= 0 ? `+${r.pnl.toFixed(0)}` : r.pnl.toFixed(0);
    const ddStr = r.maxDrawdown.toFixed(0);
    const wr = r.winrate.toFixed(1);
    console.log(
      `${String(rank + 1).padStart(4)} | ${String(r.rsiLongLevel).padStart(4)}/${String(r.rsiShortLevel).padEnd(4)} | ${r.emaBiasMin.toFixed(3).padStart(7)} | ${r.atrMinRatio.toFixed(4).padStart(8)} | ${r.rrRatio.toFixed(1).padStart(7)} | ${String(r.trades).padStart(6)} | ${wr.padStart(6)}%  | ${pnlStr.padStart(10)} | ${ddStr.padStart(8)}`
    );
  });

  console.log('─────────────────────────────────────────────────────────────────────');
  console.log('\n🏆 Лучшая комбинация:');
  console.log(`  rsiLongLevel  = ${best.rsiLongLevel}`);
  console.log(`  rsiShortLevel = ${best.rsiShortLevel}`);
  console.log(`  emaBiasMin    = ${best.emaBiasMin}`);
  console.log(`  atrMinRatio   = ${best.atrMinRatio}`);
  console.log(`  rrRatio       = ${best.rrRatio}`);
  console.log(`  Сделок        = ${best.trades}`);
  console.log(`  Winrate       = ${best.winrate.toFixed(2)}%`);
  console.log(`  PnL           = ${best.pnl >= 0 ? '+' : ''}${best.pnl.toFixed(2)} ₽`);
  console.log(`  MaxDrawdown   = ${best.maxDrawdown.toFixed(2)} ₽`);

  // ── JSON-результат ──
  const jsonOutput = {
    ticker: TICKER,
    strategy: 'RsiMomentum',
    totalCombinations: allParams.length,
    top5: top20.slice(0, 5).map((r, i) => ({
      rank: i + 1,
      params: {
        rsiLongLevel: r.rsiLongLevel,
        rsiShortLevel: r.rsiShortLevel,
        emaBiasMin: r.emaBiasMin,
        atrMinRatio: r.atrMinRatio,
        rrRatio: r.rrRatio,
      },
      trades: r.trades,
      winrate: parseFloat(r.winrate.toFixed(2)),
      pnl: parseFloat(r.pnl.toFixed(2)),
      maxDrawdown: parseFloat(r.maxDrawdown.toFixed(2)),
    })),
    bestParams: {
      rsiLongLevel: best.rsiLongLevel,
      rsiShortLevel: best.rsiShortLevel,
      emaBiasMin: best.emaBiasMin,
      atrMinRatio: best.atrMinRatio,
      rrRatio: best.rrRatio,
    },
    bestPnl: parseFloat(best.pnl.toFixed(2)),
    conclusion: `Лучший результат: PnL=${best.pnl >= 0 ? '+' : ''}${best.pnl.toFixed(0)}₽, winrate=${best.winrate.toFixed(1)}%, сделок=${best.trades}. ` +
      `Параметры: RSI ${best.rsiLongLevel}/${best.rsiShortLevel}, emaBiasMin=${best.emaBiasMin}, atrMinRatio=${best.atrMinRatio}, rrRatio=${best.rrRatio}.`,
  };

  console.log('\n--- JSON ---');
  console.log(JSON.stringify(jsonOutput, null, 2));
}

main().catch((err) => {
  console.error('❌ Ошибка:', err);
  process.exit(1);
});
