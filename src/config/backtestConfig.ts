/**
 * Конфигурация бэктеста (по образцу byBitBot adaptiveBacktest).
 * Параметры можно менять для экспериментов.
 * Для лайв-торговли: STOP_ATR_MULT в watcher.ts, RR_RATIO в positionSizing.ts.
 */

export const BACKTEST_CONFIG = {
  /** Стартовый баланс в рублях */
  startBalance: 500_000,
  /** Множитель ATR для стоп-лосса (2.5 = шире стоп, меньше ложных выходов) */
  stopAtrMult: 2.5,
  /** Risk/Reward: тейк = стоп × rrRatio (2.5 = больше прибыль при TAKE) */
  rrRatio: 2.5,
  /** Риск на сделку (0.005 = 0.5%, как в positionSizing) */
  riskPerTrade: 0.005,
  /** Допуск выхода к средней Bollinger (0.0025 = 0.25%) */
  meanExitTolerance: 0.0025,
  /** Отключить выход по MEAN — только STOP/TAKE (устраняет мелкие выигрыши) */
  disableMeanExit: false,
  /** MEAN только при прибыли >= stopDistance * ratio (0.5 = половина стопа). 0 = без ограничения */
  meanExitMinProfitRatio: 0,
  /** Трейлинг-тейк: стоп следует за ценой на ATR × mult. 0 = выключен. Активируется при прибыли > mult×ATR */
  trailingTakeAtrMult: 0,
  /** Катастрофический стоп при движении цены на 7% против позиции */
  catastrophicStopPct: 0.07,
  /** Комиссия входа + выхода (0.0004 + 0.0004, как в positionSizing) */
  feeRate: 0.0008,
  /** Только эти тикеры в backtest:all (пусто = все). Прибыльные за год: SBERF, GAZPF */
  tickersFilter: [] as readonly string[],
  /** Минимальная дата начала (ms) для инструментов. SBERF/GAZPF — вечные фьючерсы с 1 окт 2024 */
  tickerMinStartMs: {
    SBERF: Date.parse('2024-10-01T00:00:00Z'),
    GAZPF: Date.parse('2024-10-01T00:00:00Z'),
  } as Record<string, number>,
} as const;

/** Эффективная дата начала загрузки с учётом tickerMinStartMs */
export function getEffectiveStartMs(ticker: string, startMs: number): number {
  const min = BACKTEST_CONFIG.tickerMinStartMs[ticker];
  return min != null ? Math.max(startMs, min) : startMs;
}
