/**
 * Мониторинг фьючерсов: загрузка 1h свечей и проверка точек входа (Bollinger), по образцу byBitBot.
 */

import { fetchTinkoffCandles } from './candleLoader.js';
import {
  getLastCandleTimestamp1h,
  ingest1hCandles,
} from './candleBuilder.js';
import { adaptiveBollingerStrategy } from './adaptiveBollingerStrategy.js';
import { tradingState } from '../core/tradingState.js';

const WATCH_INTERVAL_MS = 60_000; // 1 минута
/** Календарных дней для запроса 1h свечей (торговля не 24/7 — за 30 дней набираем достаточно торговых часов). */
const CANDLES_REQUEST_DAYS = 30;
/** Не слать повторный алерт по одному тикеру и той же стороне (LONG/SHORT) в течение этого времени (мс). */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 час
/** Если последняя свеча старше этого порога — не слать алерт (устаревшие данные, выходные/перерыв торгов). */
const STALE_CANDLE_MS = 4 * 60 * 60 * 1000; // 4 часа

const lastAlertByTicker = new Map<string, { side: 'LONG' | 'SHORT'; at: number }>();

export interface WatcherOptions {
  token: string;
  onAlert: (message: string) => void | Promise<void>;
  intervalMs?: number;
}

/**
 * Запускает вотчер по одному тикеру: периодически подгружает 1h свечи, считает сигнал Bollinger, при входе шлёт алерт.
 * Возвращает функцию остановки.
 */
export function startMarketWatcher(
  ticker: string,
  options: WatcherOptions
): () => void {
  const { token, onAlert, intervalMs = WATCH_INTERVAL_MS } = options;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<boolean> => {
    try {
      if (!tradingState.isEnabled()) return true;

      const end = Math.floor(Date.now() / 3600000) * 3600000;
      const start = end - CANDLES_REQUEST_DAYS * 24 * 3600 * 1000;

      const candles1h = await fetchTinkoffCandles(
        token,
        ticker,
        start,
        end,
        '1h'
      );
      if (candles1h.length === 0) return true;

      ingest1hCandles(ticker, candles1h);
      console.log(`[WATCHER] ${ticker}: обработано ${candles1h.length} свечей 1h`);

      if (!adaptiveBollingerStrategy.isSupported(ticker)) return true;

      const adaptive = adaptiveBollingerStrategy.getSignal(ticker);
      const scoreLog =
        adaptive.signal === 'NONE'
          ? `[Bollinger NO_SETUP] ${ticker} L=${adaptive.longScore} S=${adaptive.shortScore} (${adaptive.entrySignal})`
          : `[Bollinger] ${ticker} 🟢L=${adaptive.longScore} 🔴S=${adaptive.shortScore} signal=${adaptive.signal}`;
      console.log(scoreLog);

      if (!adaptive.ready || adaptive.signal === 'NONE') return true;

      const confirmed = adaptiveBollingerStrategy.confirmEntry(
        ticker,
        adaptive.signal as 'LONG' | 'SHORT'
      );
      if (!confirmed) return true;

      const lastCandleTime = getLastCandleTimestamp1h(ticker);
      const now = Date.now();
      if (
        lastCandleTime === null ||
        now - lastCandleTime > STALE_CANDLE_MS
      ) {
        return true;
      }

      const signalSide = adaptive.signal as 'LONG' | 'SHORT';
      const last = lastAlertByTicker.get(ticker);
      if (
        last &&
        last.side === signalSide &&
        now - last.at < ALERT_COOLDOWN_MS
      ) {
        return true;
      }
      lastAlertByTicker.set(ticker, { side: signalSide, at: now });

      const side =
        adaptive.signal === 'LONG'
          ? 'LONG 🟢'
          : adaptive.signal === 'SHORT'
            ? 'SHORT 🔴'
            : '—';
      const msg =
        `✅ *${ticker}: ТОЧКА ВХОДА*\n` +
        `Сигнал: ${side}\n` +
        `Score: L:${adaptive.longScore} S:${adaptive.shortScore}\n` +
        `(Bollinger 1h)`;

      await Promise.resolve(onAlert(msg));
      return true;
    } catch (err) {
      console.error(`[WATCHER] ${ticker} error:`, err);
      return true;
    }
  };

  const run = () => {
    tick().then((ok) => {
      if (ok) {
        timeoutId = setTimeout(run, intervalMs);
      }
    });
  };

  run();

  return () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

/**
 * Запускает вотчеры по всем тикерам, возвращает функцию остановки.
 */
export function startAllWatchers(
  tickers: string[],
  options: WatcherOptions
): () => void {
  const stopFns: Array<() => void> = [];
  for (const ticker of tickers) {
    stopFns.push(startMarketWatcher(ticker, options));
  }
  return () => {
    for (const stop of stopFns) stop();
  };
}
