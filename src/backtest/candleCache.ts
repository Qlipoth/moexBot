/**
 * Чтение кэшированных свечей и данных инструментов из файлов (data/).
 * Используется в скриптах бэктеста для работы без обращений к API Tinkoff.
 *
 * Пути к кэшу:
 *   CANDLE_CACHE_DIR     (env) или <cwd>/data/candles
 *   INSTRUMENT_CACHE_DIR (env) или <cwd>/data/instruments
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoricalCandleInput, FutureInstrumentInfo } from '../core/investClient.js';

function getCandleDir(): string {
  return process.env['CANDLE_CACHE_DIR'] ?? join(process.cwd(), 'data', 'candles');
}

function getInstrumentDir(): string {
  return process.env['INSTRUMENT_CACHE_DIR'] ?? join(process.cwd(), 'data', 'instruments');
}

export function loadCachedCandles(ticker: string): HistoricalCandleInput[] {
  const filePath = join(getCandleDir(), `${ticker}_1h.json`);
  if (!existsSync(filePath)) {
    throw new Error(
      `Кэш свечей не найден: ${filePath}\n` +
        `Сначала запустите: pnpm run download`
    );
  }
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as HistoricalCandleInput[];
}

export function loadCachedInstrument(ticker: string): FutureInstrumentInfo {
  const filePath = join(getInstrumentDir(), `${ticker}.json`);
  if (!existsSync(filePath)) {
    throw new Error(
      `Кэш инструмента не найден: ${filePath}\n` +
        `Сначала запустите: pnpm run download`
    );
  }
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as FutureInstrumentInfo;
}
