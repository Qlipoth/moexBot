/**
 * Скачивает 1h-свечи и данные инструментов для всех тикеров,
 * сохраняет в data/candles/<TICKER>_1h.json и data/instruments/<TICKER>.json.
 *
 * Использование: pnpm run download [START_ISO] [END_ISO]
 * Пример: pnpm run download 2025-01-01T00:00:00Z 2026-03-31T00:00:00Z
 *
 * Без аргументов — последние 365 дней.
 */

import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchTinkoffCandles } from '../src/market/candleLoader.js';
import { getFutureInstrument } from '../src/core/investClient.js';
import { getEffectiveStartMs } from '../src/config/backtestConfig.js';

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

const DEFAULT_DAYS = 365;

async function main(): Promise<void> {
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    console.error('❌ TINKOFF_TOKEN не задан в .env');
    process.exit(1);
  }

  const [startArg, endArg] = process.argv.slice(2);
  const endTime = endArg ? Date.parse(endArg) : Date.now();
  const startTime = startArg
    ? Date.parse(startArg)
    : endTime - DEFAULT_DAYS * 24 * 3600 * 1000;

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    console.error('Использование: pnpm run download [START_ISO] [END_ISO]');
    console.error('Пример: pnpm run download 2025-01-01T00:00:00Z 2026-03-31T00:00:00Z');
    process.exit(1);
  }

  const candleDir = join(__dirname, '..', 'data', 'candles');
  const instrumentDir = join(__dirname, '..', 'data', 'instruments');
  mkdirSync(candleDir, { recursive: true });
  mkdirSync(instrumentDir, { recursive: true });

  const periodStr = `${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}`;
  console.log(`\n📥 Загрузка данных MOEX | период: ${periodStr}\n`);

  let downloaded = 0;
  let skipped = 0;

  for (const ticker of ALL_TICKERS) {
    const instrument = await getFutureInstrument(token, ticker);
    if (!instrument) {
      console.warn(`⚠️  ${ticker}: инструмент не найден, пропуск`);
      skipped++;
      continue;
    }

    const instrumentFile = join(instrumentDir, `${ticker}.json`);
    writeFileSync(instrumentFile, JSON.stringify(instrument, null, 2), 'utf-8');

    const effectiveStart = getEffectiveStartMs(ticker, startTime);
    if (effectiveStart >= endTime) {
      console.warn(`⚠️  ${ticker}: период полностью до даты листинга инструмента, пропуск`);
      skipped++;
      continue;
    }

    const candles = await fetchTinkoffCandles(token, ticker, effectiveStart, endTime, '1h');
    if (candles.length === 0) {
      console.warn(`⚠️  ${ticker}: получено 0 свечей`);
      skipped++;
      continue;
    }

    const first = new Date(candles[0]!.timestamp).toISOString().slice(0, 10);
    const last = new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10);

    const candleFile = join(candleDir, `${ticker}_1h.json`);
    writeFileSync(candleFile, JSON.stringify(candles), 'utf-8');
    console.log(`✅ ${ticker}: ${candles.length} свечей (${first} → ${last}) → ${candleFile}`);
    downloaded++;
  }

  console.log(`\n📊 Готово: ${downloaded} тикеров скачано, ${skipped} пропущено`);
  console.log(`   Свечи:      data/candles/`);
  console.log(`   Инструменты: data/instruments/`);
  console.log(`\nТеперь можно запустить бэктест без API:`);
  console.log(`   pnpm run backtest:cached`);
}

main().catch((err) => {
  console.error('❌ Ошибка при загрузке:', err);
  process.exit(1);
});
