/**
 * Общий интерфейс торговой стратегии для watcher.
 * Позволяет использовать разные стратегии на разных тикерах без изменения логики watcher.
 */

export interface StrategySignalResult {
  signal: 'LONG' | 'SHORT' | 'NONE';
  ready: boolean;
  /** Опциональные поля для логирования (только у AdaptiveBollinger) */
  longScore?: number;
  shortScore?: number;
  entrySignal?: string;
}

export interface TradingStrategy {
  getSignal(ticker: string): StrategySignalResult;
  confirmEntry(ticker: string, side: 'LONG' | 'SHORT'): boolean;
  /**
   * Контекст стратегии для расчёта стопа и mean-exit.
   * `atr` — обязательно (нужен для стопа).
   * `middle` — опционально (только для mean-reversion стратегий: используется для MEAN exit).
   */
  getContext(ticker: string): {
    atr: number;
    close?: number;
    middle?: number;
    [key: string]: unknown;
  } | null;
  /** Если не задан — считается что тикер поддерживается */
  isSupported?(ticker: string): boolean;
  /** Человекочитаемое имя стратегии для логов */
  name?: string;
}
