/**
 * Запуск бэктеста Adaptive Bollinger для фьючерсов MOEX.
 * Использование: pnpm run backtest [TICKER] [START_ISO] [END_ISO]
 * Пример: pnpm run backtest RGBIF 2024-01-01T00:00:00Z 2024-06-01T00:00:00Z
 */

import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTinkoffCandles } from '../src/market/candleLoader.js';
import { getFutureInstrument } from '../src/core/investClient.js';
import { runBacktest } from '../src/backtest/adaptiveBollingerBacktest.js';
import { getEffectiveStartMs } from '../src/config/backtestConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const DEFAULT_TICKER = 'RGBIF';
const DEFAULT_DAYS = 120;

async function main(): Promise<void> {
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    console.error('TINKOFF_TOKEN не задан в .env');
    process.exit(1);
  }

  const [tickerArg, startArg, endArg] = process.argv.slice(2);
  const ticker = tickerArg ?? DEFAULT_TICKER;
  const endTime = endArg ? Date.parse(endArg) : Date.now();
  const requestedStart = startArg ? Date.parse(startArg) : endTime - DEFAULT_DAYS * 24 * 3600 * 1000;
  const startTime = getEffectiveStartMs(ticker, requestedStart);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    console.error('Использование: pnpm run backtest [TICKER] [START_ISO] [END_ISO]');
    console.error('Пример: pnpm run backtest RGBIF 2024-01-01T00:00:00Z 2024-06-01T00:00:00Z');
    process.exit(1);
  }

  if (startTime >= endTime) {
    console.error(`${ticker}: запрошенный период полностью до даты листинга инструмента`);
    process.exit(1);
  }

  const instrument = await getFutureInstrument(token, ticker);
  if (!instrument) {
    console.error(`Инструмент ${ticker} не найден`);
    process.exit(1);
  }

  console.log(
    `⬇️  Загрузка свечей ${ticker} 1h с ${new Date(startTime).toISOString()} по ${new Date(endTime).toISOString()}`
  );
  const candles = await fetchTinkoffCandles(token, ticker, startTime, endTime, '1h');
  if (candles.length === 0) {
    console.error('Не получено ни одной свечи');
    process.exit(1);
  }

  console.log(`📈 Получено ${candles.length} свечей. Запуск бэктеста...`);
  await runBacktest(candles, ticker, instrument);
}

main().catch((err) => {
  console.error('❌ Ошибка бэктеста:', err);
  process.exit(1);
});
