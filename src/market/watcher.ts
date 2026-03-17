/**
 * Мониторинг фьючерсов: загрузка 1h свечей и проверка точек входа (Bollinger), по образцу byBitBot.
 * При наличии tradeExecutor — открытие позиции по сигналу и проверка стопа/тейка по последней цене.
 */

import { fetchTinkoffCandles } from './candleLoader.js';
import {
  getLastCandleTimestamp1h,
  getLastClose1h,
  ingest1hCandles,
  merge1hCandles,
} from './candleBuilder.js';
import { adaptiveBollingerStrategy } from './adaptiveBollingerStrategy.js';
import { tradingState } from '../core/tradingState.js';
import {
  isOverDailyLossLimit,
  wasLimitAlertTriggeredToday,
  markLimitAlertTriggered,
} from '../core/dailyLossLimit.js';
import type { TinkoffTradeManager } from './tinkoffTradeManager.js';

const WATCH_INTERVAL_MS = 60_000; // 1 минута
const CANDLES_REQUEST_DAYS = 30;
const FULL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // раз в 6 часов делаем полный ресинк
const INCREMENTAL_SYNC_LOOKBACK_MS = 3 * 60 * 60 * 1000; // хвост 3 часа на случай коррекции последних свечей
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 час
const STALE_CANDLE_MS = 4 * 60 * 60 * 1000; // 4 часа
const REENTRY_COOLDOWN_MS = 20 * 60 * 1000; // 20 минут после закрытия
const WATCHER_START_STAGGER_MS = 5_000; // размазываем стартовые загрузки по времени
/** Множитель ATR для расчёта стопа (2.0 — шире для MOEX, меньше ложных срабатываний). */
const STOP_ATR_MULT = 2.0;

const lastAlertByTicker = new Map<string, { side: 'LONG' | 'SHORT'; at: number }>();
const lastClosedCandleByTicker = new Map<string, number>();
const reentryCooldownUntilByTicker = new Map<string, number>();
const lastFullSyncByTicker = new Map<string, number>();

export interface WatcherOptions {
  token: string;
  onAlert: (message: string) => void | Promise<void>;
  intervalMs?: number;
  initialDelayMs?: number;
  /** Если задан — при подтверждённом сигнале выставляется заявка (и проверяется стоп/тейк). */
  tradeExecutor?: TinkoffTradeManager;
  /** Функция для получения баланса в рублях (для расчёта размера позиции). */
  balanceProvider?: () => Promise<number>;
}

/**
 * Запускает вотчер по одному тикеру: периодически подгружает 1h свечи, считает сигнал Bollinger, при входе шлёт алерт.
 * Возвращает функцию остановки.
 */
export function startMarketWatcher(
  ticker: string,
  options: WatcherOptions
): () => void {
  const {
    token,
    onAlert,
    intervalMs = WATCH_INTERVAL_MS,
    initialDelayMs = 0,
    tradeExecutor,
    balanceProvider,
  } = options;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<boolean> => {
    try {
      if (!tradingState.isEnabled()) return true;
      const now = Date.now();

      const end = Math.floor(Date.now() / 3600000) * 3600000;
      const lastKnownCandleTime = getLastCandleTimestamp1h(ticker);
      const lastFullSyncAt = lastFullSyncByTicker.get(ticker) ?? 0;
      const needsFullSync =
        lastKnownCandleTime == null ||
        lastFullSyncAt === 0 ||
        now - lastFullSyncAt >= FULL_SYNC_INTERVAL_MS;
      const start = needsFullSync
        ? end - CANDLES_REQUEST_DAYS * 24 * 3600 * 1000
        : Math.max(0, lastKnownCandleTime - INCREMENTAL_SYNC_LOOKBACK_MS);

      const candles1h = await fetchTinkoffCandles(
        token,
        ticker,
        start,
        end,
        '1h'
      );
      if (candles1h.length === 0) return true;

      if (needsFullSync) {
        ingest1hCandles(ticker, candles1h);
        lastFullSyncByTicker.set(ticker, now);
      } else {
        merge1hCandles(ticker, candles1h);
      }
      console.log(
        `[WATCHER] ${ticker}: обработано ${candles1h.length} свечей 1h (${needsFullSync ? 'full-sync' : 'incremental'})`
      );

      // Проверка стопа/тейка по открытой позиции (песочница — стоп/тейк в памяти)
      if (tradeExecutor?.hasPosition(ticker)) {
        const currentPrice = getLastClose1h(ticker);
        if (currentPrice != null) {
          const trigger = tradeExecutor.checkStopTake(ticker, currentPrice);
          if (trigger === 'STOP' || trigger === 'TAKE') {
            const reason = trigger === 'STOP' ? 'стоп-лосс' : 'тейк-профит';
            const { closed, pnlRub } = await tradeExecutor.closePosition(
              token,
              ticker,
              currentPrice,
              reason
            );
            if (closed) {
              const closedCandleTs =
                getLastCandleTimestamp1h(ticker) ?? Math.floor(now / 3600000) * 3600000;
              lastClosedCandleByTicker.set(ticker, closedCandleTs);
              reentryCooldownUntilByTicker.set(ticker, now + REENTRY_COOLDOWN_MS);
              await Promise.resolve(
                onAlert(
                  `📤 *${ticker}: ЗАКРЫТИЕ* (${reason})\nЦена: ${currentPrice}\nPnL ≈ ${pnlRub.toFixed(2)} ₽`
                )
              );
              if (isOverDailyLossLimit() && !wasLimitAlertTriggeredToday()) {
                markLimitAlertTriggered();
                await Promise.resolve(
                  onAlert(
                    `⚠️ Дневной лимит убытка достигнут. Новые сделки отключены до следующего дня (UTC) или до повторного /start.`
                  )
                );
              }
            }
            return true;
          }
        }
      }

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
      if (
        lastCandleTime === null ||
        now - lastCandleTime > STALE_CANDLE_MS
      ) {
        return true;
      }

      const lastClosedCandle = lastClosedCandleByTicker.get(ticker);
      if (lastClosedCandle != null && lastCandleTime <= lastClosedCandle) {
        console.log(`[WATCHER] ${ticker}: ждём новую 1h свечу после закрытия`);
        return true;
      }
      const cooldownUntil = reentryCooldownUntilByTicker.get(ticker) ?? 0;
      if (now < cooldownUntil) {
        const leftMin = Math.ceil((cooldownUntil - now) / 60000);
        console.log(`[WATCHER] ${ticker}: re-entry cooldown (${leftMin} мин.)`);
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

      const entryPrice = getLastClose1h(ticker) ?? 0;
      if (entryPrice <= 0) return true;

      // Выставление заявки при включённой торговле и наличии исполнителя
      if (!tradeExecutor || !balanceProvider) {
        console.log(`[WATCHER] ${ticker}: нет tradeExecutor/balanceProvider, только алерт`);
      } else if (!tradingState.allowNewEntries()) {
        console.log(`[WATCHER] ${ticker}: торговля выключена или close-only`);
      } else if (isOverDailyLossLimit()) {
        console.log(`[WATCHER] ${ticker}: дневной лимит убытка достигнут`);
      } else if (tradeExecutor.hasPosition(ticker)) {
        console.log(`[WATCHER] ${ticker}: уже есть позиция в памяти бота`);
      } else {
        const balanceRub = await balanceProvider();
        if (balanceRub <= 0) {
          console.log(`[WATCHER] ${ticker}: баланс ${balanceRub} ₽, нельзя открыть`);
        } else {
          const ctx = adaptiveBollingerStrategy.getContext(ticker);
          let stopPrice: number | null = null;
          if (ctx && Number.isFinite(ctx.atr) && ctx.atr > 0) {
            stopPrice =
              signalSide === 'LONG'
                ? entryPrice - ctx.atr * STOP_ATR_MULT
                : entryPrice + ctx.atr * STOP_ATR_MULT;
          }
          if (stopPrice == null || stopPrice <= 0) {
            console.log(`[WATCHER] ${ticker}: не удалось рассчитать стоп (ATR=${ctx?.atr})`);
          } else {
            const opened = await tradeExecutor.openPosition({
              token,
              ticker,
              side: signalSide,
              price: entryPrice,
              stopPrice,
              balanceRub,
            });
            if (opened) {
              lastAlertByTicker.set(ticker, { side: signalSide, at: now });
              const sideStr = signalSide === 'LONG' ? 'LONG 🟢' : 'SHORT 🔴';
              await Promise.resolve(
                onAlert(
                  `✅ *${ticker}: ВХОД В СДЕЛКУ*\n` +
                    `Сигнал: ${sideStr}\n` +
                    `Цена: ${entryPrice}\n` +
                    `Score: L:${adaptive.longScore} S:${adaptive.shortScore}\n` +
                    `(Bollinger 1h)`
                )
              );
              return true;
            }
            console.log(`[WATCHER] ${ticker}: openPosition вернул false (см. [TRADE] логи выше)`);
          }
        }
      }

      lastAlertByTicker.set(ticker, { side: signalSide, at: now });
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

  if (initialDelayMs > 0) {
    timeoutId = setTimeout(run, initialDelayMs);
  } else {
    run();
  }

  return () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

/**
 * Удалить из Maps состояние по тикерам, которых нет в списке (как в byBitBot — не забивать память).
 */
function clearStaleTickerState(activeTickers: Set<string>): void {
  for (const key of lastAlertByTicker.keys()) {
    if (!activeTickers.has(key)) lastAlertByTicker.delete(key);
  }
  for (const key of lastClosedCandleByTicker.keys()) {
    if (!activeTickers.has(key)) lastClosedCandleByTicker.delete(key);
  }
  for (const key of reentryCooldownUntilByTicker.keys()) {
    if (!activeTickers.has(key)) reentryCooldownUntilByTicker.delete(key);
  }
  for (const key of lastFullSyncByTicker.keys()) {
    if (!activeTickers.has(key)) lastFullSyncByTicker.delete(key);
  }
}

/**
 * Запускает вотчеры по всем тикерам, возвращает функцию остановки.
 */
export function startAllWatchers(
  tickers: string[],
  options: WatcherOptions
): () => void {
  clearStaleTickerState(new Set(tickers));
  const stopFns: Array<() => void> = [];
  for (const [index, ticker] of tickers.entries()) {
    stopFns.push(
      startMarketWatcher(ticker, {
        ...options,
        initialDelayMs: index * WATCHER_START_STAGGER_MS,
      })
    );
  }
  return () => {
    for (const stop of stopFns) stop();
  };
}
