/**
 * Бэктест по всем тикерам за один период.
 * Использование: pnpm run backtest:all [START_ISO] [END_ISO]
 * Пример: pnpm run backtest:all 2025-11-07T00:00:00Z 2026-03-07T00:00:00Z
 */

import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTinkoffCandles } from '../src/market/candleLoader.js';
import { getFutureInstrument } from '../src/core/investClient.js';
import {
  runBacktest,
  type BacktestResult,
} from '../src/backtest/adaptiveBollingerBacktest.js';
import { BACKTEST_CONFIG, getEffectiveStartMs } from '../src/config/backtestConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const ALL_TICKERS = [
  'CNYRUBF',
  'USDRUBF',
  'RGBIF',
  'GLDRUBF',
  'IMOEXF',
  'SBERF',
  'GAZPF',
];

const DEFAULT_DAYS = 120;

async function main(): Promise<void> {
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    console.error('TINKOFF_TOKEN не задан в .env');
    process.exit(1);
  }

  const [startArg, endArg] = process.argv.slice(2);
  const endTime = endArg ? Date.parse(endArg) : Date.now();
  const startTime = startArg ? Date.parse(startArg) : endTime - DEFAULT_DAYS * 24 * 3600 * 1000;

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    console.error('Использование: pnpm run backtest:all [START_ISO] [END_ISO]');
    console.error('Пример: pnpm run backtest:all 2025-11-07T00:00:00Z 2026-03-07T00:00:00Z');
    process.exit(1);
  }

  const tickers =
    BACKTEST_CONFIG.tickersFilter.length > 0
      ? BACKTEST_CONFIG.tickersFilter
      : ALL_TICKERS;

  console.log(
    `\n📊 Бэктест | Тикеры: ${tickers.join(', ')} | Период: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}\n`
  );

  const results: BacktestResult[] = [];

  for (const ticker of tickers) {
    const instrument = await getFutureInstrument(token, ticker);
    if (!instrument) {
      console.warn(`⚠️ ${ticker}: инструмент не найден, пропуск`);
      continue;
    }

    const effectiveStart = getEffectiveStartMs(ticker, startTime);
    if (effectiveStart >= endTime) {
      console.warn(`⚠️ ${ticker}: период полностью до даты листинга, пропуск`);
      continue;
    }
    const candles = await fetchTinkoffCandles(token, ticker, effectiveStart, endTime, '1h');
    if (candles.length === 0) {
      console.warn(`⚠️ ${ticker}: нет свечей, пропуск`);
      continue;
    }

    const result = await runBacktest(candles, ticker, instrument, true);
    results.push(result);
  }

  // Сводка
  const totalTrades = results.reduce((s, r) => s + r.trades, 0);
  const totalWins = results.reduce((s, r) => s + r.wins, 0);
  const totalLosses = results.reduce((s, r) => s + r.losses, 0);
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const overallWinrate = totalTrades ? (totalWins / totalTrades) * 100 : 0;

  console.log('================ СВОДКА ПО ТИКЕРАМ ================');
  console.log(`Период: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}`);
  console.log('');
  console.log('| Тикер    | Сделок | W/L   | Winrate | PnL ₽      |');
  console.log('|----------|--------|-------|---------|------------|');

  for (const r of results) {
    const pnlStr = r.pnl >= 0 ? `+${r.pnl.toFixed(2)}` : r.pnl.toFixed(2);
    const wr = r.trades ? r.winrate.toFixed(1) : '0';
    console.log(`| ${r.ticker.padEnd(8)} | ${String(r.trades).padStart(6)} | ${String(r.wins).padStart(2)}/${String(r.losses).padStart(2)} | ${wr.padStart(6)}% | ${pnlStr.padStart(10)} |`);
  }

  console.log('|----------|--------|-------|---------|------------|');
  const totalPnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(2)}` : totalPnl.toFixed(2);
  console.log(`| ИТОГО    | ${String(totalTrades).padStart(6)} | ${String(totalWins).padStart(2)}/${String(totalLosses).padStart(2)} | ${overallWinrate.toFixed(1).padStart(6)}% | ${totalPnlStr.padStart(10)} |`);
  console.log('');
}

main().catch((err) => {
  console.error('❌ Ошибка:', err);
  process.exit(1);
});
