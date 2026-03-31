/**
 * Бэктест стратегии EMA Crossover по всем тикерам (кэшированные свечи).
 * Требует: pnpm run download (или наличия кэша в CANDLE_CACHE_DIR).
 *
 * Использование: pnpm run backtest:ema [--json]
 *   --json   дополнительно вывести JSON с результатами в конце
 *
 * Переменные окружения:
 *   CANDLE_CACHE_DIR      путь к папке со свечами (по умолчанию: <cwd>/data/candles)
 *   INSTRUMENT_CACHE_DIR  путь к папке с инструментами (по умолчанию: <cwd>/data/instruments)
 */

import { loadCachedCandles, loadCachedInstrument } from '../src/backtest/candleCache.js';
import {
  runBacktest,
  type BacktestResult,
} from '../src/backtest/emaCrossoverBacktest.js';
import { BACKTEST_CONFIG } from '../src/config/backtestConfig.js';

// RGBIF пропускается — нет данных
const ALL_TICKERS = [
  'CNYRUBF',
  'USDRUBF',
  'GLDRUBF',
  'IMOEXF',
  'SBERF',
  'GAZPF',
];

const outputJson = process.argv.includes('--json');

async function main(): Promise<void> {
  const tickers =
    BACKTEST_CONFIG.tickersFilter.length > 0
      ? [...BACKTEST_CONFIG.tickersFilter]
      : ALL_TICKERS;

  console.log(`\n📊 EMA Crossover Backtest (кэш) | Тикеры: ${tickers.join(', ')}\n`);
  console.log(
    `Параметры: EMA(9/21), ATR×${BACKTEST_CONFIG.stopAtrMult} стоп, RR ${BACKTEST_CONFIG.rrRatio}, баланс ${BACKTEST_CONFIG.startBalance.toLocaleString('ru')} ₽\n`
  );

  const results: BacktestResult[] = [];

  for (const ticker of tickers) {
    let candles: ReturnType<typeof loadCachedCandles>;
    let instrument: ReturnType<typeof loadCachedInstrument>;

    try {
      candles = loadCachedCandles(ticker);
      instrument = loadCachedInstrument(ticker);
    } catch (e) {
      console.warn(`⚠️  ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (candles.length === 0) {
      console.warn(`⚠️  ${ticker}: кэш пустой`);
      continue;
    }

    const result = await runBacktest(candles, ticker, instrument, outputJson);
    results.push(result);
  }

  const totalTrades = results.reduce((s, r) => s + r.trades, 0);
  const totalWins = results.reduce((s, r) => s + r.wins, 0);
  const totalLosses = results.reduce((s, r) => s + r.losses, 0);
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const overallWinrate = totalTrades ? (totalWins / totalTrades) * 100 : 0;
  const avgMaxDrawdown =
    results.length > 0
      ? results.reduce((s, r) => s + r.maxDrawdown, 0) / results.length
      : 0;

  const bestTicker = results.reduce(
    (best, r) => (r.pnl > best.pnl ? r : best),
    results[0] ?? { ticker: '', pnl: -Infinity, trades: 0, wins: 0, losses: 0, winrate: 0, maxDrawdown: 0 }
  ).ticker;
  const worstTicker = results.reduce(
    (worst, r) => (r.pnl < worst.pnl ? r : worst),
    results[0] ?? { ticker: '', pnl: Infinity, trades: 0, wins: 0, losses: 0, winrate: 0, maxDrawdown: 0 }
  ).ticker;

  console.log('\n================ СВОДКА: EMA CROSSOVER ================');
  console.log(
    '| Тикер    | Сделок | W/L   | Winrate | PnL ₽      | MaxDD ₽    |'
  );
  console.log(
    '|----------|--------|-------|---------|------------|------------|'
  );

  for (const r of results) {
    const pnlStr = r.pnl >= 0 ? `+${r.pnl.toFixed(2)}` : r.pnl.toFixed(2);
    const ddStr = r.maxDrawdown.toFixed(2);
    const wr = r.trades ? r.winrate.toFixed(1) : '0';
    console.log(
      `| ${r.ticker.padEnd(8)} | ${String(r.trades).padStart(6)} | ${String(r.wins).padStart(2)}/${String(r.losses).padStart(2)} | ${wr.padStart(6)}% | ${pnlStr.padStart(10)} | ${ddStr.padStart(10)} |`
    );
  }

  console.log(
    '|----------|--------|-------|---------|------------|------------|'
  );
  const totalPnlStr =
    totalPnl >= 0 ? `+${totalPnl.toFixed(2)}` : totalPnl.toFixed(2);
  console.log(
    `| ИТОГО    | ${String(totalTrades).padStart(6)} | ${String(totalWins).padStart(2)}/${String(totalLosses).padStart(2)} | ${overallWinrate.toFixed(1).padStart(6)}% | ${totalPnlStr.padStart(10)} | ~${avgMaxDrawdown.toFixed(0).padStart(9)} |`
  );
  console.log('');

  if (outputJson) {
    const summary = {
      strategy: 'EmaCrossover',
      description:
        'Трендовая стратегия на пересечении EMA(9) и EMA(21) с фильтрами по ATR и RSI',
      keyParameters: {
        fastPeriod: 9,
        slowPeriod: 21,
        atrMinRatio: 0.002,
        stopAtrMult: BACKTEST_CONFIG.stopAtrMult,
        rrRatio: BACKTEST_CONFIG.rrRatio,
      },
      results,
      summary: {
        totalTrades,
        totalPnl,
        overallWinrate,
        avgMaxDrawdown,
        bestTicker,
        worstTicker,
      },
    };
    console.log('--- JSON ---');
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch((err) => {
  console.error('❌ Ошибка:', err);
  process.exit(1);
});
