/**
 * Загрузка свечей Tinkoff Invest API для фьючерсов (по образцу byBitBot candleLoader).
 * API возвращает макс. 2400 свечей за запрос — для периодов >100 дней (1h) загружаем чанками.
 */

import {
  getFutureUid,
  getCandles,
  type HistoricalCandleInput,
} from '../core/investClient.js';

export type { HistoricalCandleInput };

const CANDLES_PER_REQUEST = 2400;
const MS_PER_1H = 3600_000;

export async function fetchTinkoffCandles(
  token: string,
  ticker: string,
  start: number,
  end: number,
  interval: '1m' | '1h' = '1h'
): Promise<HistoricalCandleInput[]> {
  console.log(
    `[LOADER] Загрузка свечей ${ticker} ${interval}: с ${new Date(start).toISOString()} по ${new Date(end).toISOString()}`
  );
  const uid = await getFutureUid(token, ticker);
  if (!uid) {
    console.log(`[LOADER] ${ticker}: инструмент не найден (uid пустой)`);
    return [];
  }

  const stepMs = interval === '1h' ? MS_PER_1H * CANDLES_PER_REQUEST : 60_000 * CANDLES_PER_REQUEST;
  const allCandles: HistoricalCandleInput[] = [];
  let currentStart = start;

  while (currentStart < end) {
    const chunkEnd = Math.min(currentStart + stepMs, end);
    const chunk = await getCandles(token, uid, currentStart, chunkEnd, interval);
    if (chunk.length > 0) {
      for (const c of chunk) {
        if (c.timestamp >= start && c.timestamp <= end) {
          allCandles.push(c);
        }
      }
      const lastTs = chunk[chunk.length - 1]!.timestamp;
      currentStart = lastTs + (interval === '1h' ? MS_PER_1H : 60_000);
      if (currentStart >= end) break;
    } else {
      break;
    }
  }

  const unique = Array.from(
    new Map(allCandles.map((c) => [c.timestamp, c])).values()
  ).sort((a, b) => a.timestamp - b.timestamp);

  if (unique.length === 0) {
    console.log(`[LOADER] ${ticker}: получено 0 свечей`);
    return [];
  }
  console.log(
    `[LOADER] ${ticker}: получено ${unique.length} свечей, последняя дата: ${new Date(unique[unique.length - 1]!.timestamp).toISOString()}`
  );
  return unique;
}
