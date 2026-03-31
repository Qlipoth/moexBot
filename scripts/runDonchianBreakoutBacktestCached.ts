/**
 * Бэктест стратегии DonchianBreakout по всем тикерам используя кэшированные свечи (без API Tinkoff).
 * Требует предварительного запуска: pnpm run download
 *
 * Использование: pnpm run backtest:donchian [--json]
 *   --json   дополнительно вывести JSON с результатами в конце
 *
 * Переменные окружения:
 *   CANDLE_CACHE_DIR      путь к папке со свечами (по умолчанию: <cwd>/data/candles)
 *   INSTRUMENT_CACHE_DIR  путь к папке с инструментами (по умолчанию: <cwd>/data/instruments)
 */

import { loadCachedCandles, loadCachedInstrument } from '../src/backtest/candleCache.js';
import { runBacktest, type BacktestResult } from '../src/backtest/donchianBreakoutBacktest.js';
import { BACKTEST_CONFIG } from '../src/config/backtestConfig.js';

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

  console.log(`\n📊 DonchianBreakout бэктест (кэш) | Тикеры: ${tickers.join(', ')}\n`);

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

  console.log('\n================ СВОДКА ПО ТИКЕРАМ (DonchianBreakout) ================');
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
  const totalPnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(2)}` : totalPnl.toFixed(2);
  console.log(
    `| ИТОГО    | ${String(totalTrades).padStart(6)} | ${String(totalWins).padStart(2)}/${String(totalLosses).padStart(2)} | ${overallWinrate.toFixed(1).padStart(6)}% | ${totalPnlStr.padStart(10)} | ~${avgMaxDrawdown.toFixed(0).padStart(9)} |`
  );
  console.log('');

  if (outputJson) {
    const bestTicker = results.reduce(
      (best, r) => (r.pnl > best.pnl ? r : best),
      results[0] ?? { ticker: '', pnl: -Infinity, trades: 0, wins: 0, losses: 0, winrate: 0, maxDrawdown: 0 }
    );
    const worstTicker = results.reduce(
      (worst, r) => (r.pnl < worst.pnl ? r : worst),
      results[0] ?? { ticker: '', pnl: Infinity, trades: 0, wins: 0, losses: 0, winrate: 0, maxDrawdown: 0 }
    );

    const summary = {
      strategy: 'DonchianBreakout',
      results,
      summary: {
        totalTrades,
        totalPnl,
        overallWinrate,
        avgMaxDrawdown,
        bestTicker: bestTicker.ticker,
        worstTicker: worstTicker.ticker,
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
