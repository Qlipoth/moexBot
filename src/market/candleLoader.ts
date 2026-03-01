/**
 * Загрузка свечей Tinkoff Invest API для фьючерсов (по образцу byBitBot candleLoader).
 */

import {
  getFutureUid,
  getCandles,
  type HistoricalCandleInput,
} from '../core/investClient.js';

export type { HistoricalCandleInput };

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
  const candles = await getCandles(token, uid, start, end, interval);
  if (candles.length === 0) {
    console.log(`[LOADER] ${ticker}: получено 0 свечей`);
    return [];
  }
  const lastTs = candles[candles.length - 1]!.timestamp;
  console.log(
    `[LOADER] ${ticker}: получено ${candles.length} свечей, последняя дата: ${new Date(lastTs).toISOString()}`
  );
  return candles;
}
