# Агент-исследователь торговых стратегий (MOEX фьючерсы)

Этот файл — шаблон промпта для запуска параллельных агентов через Task(best-of-n-runner).
Замени `[СТРАТЕГИЯ_НАЗВАНИЕ]` и `[ОПИСАНИЕ_СТРАТЕГИИ]` перед запуском.

---

## ПРОМПТ ДЛЯ АГЕНТА

```
Ты — агент разработки торговых стратегий для MOEX фьючерсов (TypeScript).
Работаешь в изолированной ветке git (best-of-n-runner worktree).

════════════════════════════════════════════
КОНТЕКСТ ПРОЕКТА
════════════════════════════════════════════

Язык: TypeScript ESM (расширения .ts, импорты .js)
Пакетный менеджер: pnpm
Биржа: MOEX фьючерсы, API Tinkoff Invest
Таймфрейм: 1h свечи
Тикеры: CNYRUBF, USDRUBF, GLDRUBF, IMOEXF, SBERF, GAZPF
(RGBIF пропускать — нет данных)

Параметры бэктеста:
  startBalance: 500_000 ₽
  riskPerTrade: 0.5% баланса
  feeRate: 0.0008 (вход + выход)
  stopAtrMult: 2.5 (стоп = ATR × 2.5)
  rrRatio: 2.5 (тейк = стоп × 2.5)

════════════════════════════════════════════
ДАННЫЕ (НЕ ТРОГАТЬ — только чтение)
════════════════════════════════════════════

Кэш свечей (уже скачан):
  C:\work\moexBot\data\candles\<TICKER>_1h.json

Кэш инструментов:
  C:\work\moexBot\data\instruments\<TICKER>.json

Установи переменные окружения для чтения кэша из главного репо:
  CANDLE_CACHE_DIR=C:\work\moexBot\data\candles
  INSTRUMENT_CACHE_DIR=C:\work\moexBot\data\instruments

════════════════════════════════════════════
ФАЙЛЫ ДЛЯ ИЗУЧЕНИЯ (прочитай ДО написания кода)
════════════════════════════════════════════

ОБЯЗАТЕЛЬНО прочитай эти файлы как образцы:

1. src/market/adaptiveBollingerStrategy.ts
   → структура стратегии: getSignal(), confirmEntry(), getContext()

2. src/backtest/adaptiveBollingerBacktest.ts
   → структура бэктеста: runBacktest(), BacktestResult

3. src/backtest/candleCache.ts
   → loadCachedCandles(), loadCachedInstrument()

4. scripts/runBacktestAllCached.ts
   → образец entry-point скрипта

5. src/market/candleBuilder.ts
   → ingestHistoricalCandle(), getATR1h() — ОБЯЗАТЕЛЬНО переиспользовать

6. src/market/analysis.ts
   → RSI и другие индикаторы

7. src/market/positionSizing.ts
   → calculatePositionSizing() — переиспользовать без изменений

8. src/config/backtestConfig.ts
   → BACKTEST_CONFIG — константы (stopAtrMult, rrRatio, feeRate и т.д.)

════════════════════════════════════════════
ТВОЯ ЗАДАЧА: [СТРАТЕГИЯ_НАЗВАНИЕ]
════════════════════════════════════════════

[ОПИСАНИЕ_СТРАТЕГИИ]

════════════════════════════════════════════
ТРЕБОВАНИЯ К РЕАЛИЗАЦИИ
════════════════════════════════════════════

ШАГ 1. Создай src/market/<strategyName>Strategy.ts

Обязательный интерфейс (как в adaptiveBollingerStrategy.ts):

  export const <strategyName>Strategy = {
    getSignal(ticker: string): { signal: 'LONG' | 'SHORT' | 'NONE'; ready: boolean; reason?: string },
    confirmEntry(ticker: string, side: 'LONG' | 'SHORT'): boolean,
    getContext(ticker: string): { middle?: number; close?: number; [key: string]: unknown } | null,
  }

Правила:
  - используй ingestHistoricalCandle() и getATR1h() из candleBuilder
  - не обращайся к Tinkoff API внутри стратегии
  - храни состояние в Map<string, ...> по тикеру (как в образце)

ШАГ 2. Создай scripts/run<StrategyName>BacktestCached.ts

Скопируй структуру из scripts/runBacktestAllCached.ts:
  - замени импорт стратегии
  - замени вызовы adaptiveBollingerStrategy → <strategyName>Strategy
  - параметры берутся из BACKTEST_CONFIG (не меняй константы)
  - в конце при --json выводи JSON в stdout

ШАГ 3. Добавь скрипт в package.json:
  "backtest:<strategyName>": "tsx scripts/run<StrategyName>BacktestCached.ts"

════════════════════════════════════════════
ПРОЦЕСС ВЫПОЛНЕНИЯ
════════════════════════════════════════════

1. Прочитай все 8 файлов из раздела "ФАЙЛЫ ДЛЯ ИЗУЧЕНИЯ"
2. Реализуй стратегию (ШАГ 1)
3. Реализуй скрипт бэктеста (ШАГ 2 + ШАГ 3)
4. Запусти: pnpm typecheck
   → если ошибки — исправь, повтори
5. Запусти бэктест:
   $env:CANDLE_CACHE_DIR="C:\work\moexBot\data\candles"
   $env:INSTRUMENT_CACHE_DIR="C:\work\moexBot\data\instruments"
   pnpm run backtest:<strategyName> -- --json
   → если ошибки рантайма — исправь, повтори
6. Собери результаты из вывода

════════════════════════════════════════════
ФОРМАТ ОТВЕТА (верни в конце)
════════════════════════════════════════════

{
  "strategy": "<название>",
  "description": "<2-3 предложения: логика входа/выхода, какие индикаторы>",
  "keyParameters": {
    "<paramName>": <value>
  },
  "results": [
    {
      "ticker": "CNYRUBF",
      "trades": 0,
      "wins": 0,
      "losses": 0,
      "winrate": 0.0,
      "pnl": 0.0,
      "maxDrawdown": 0.0
    }
  ],
  "summary": {
    "totalTrades": 0,
    "totalPnl": 0.0,
    "overallWinrate": 0.0,
    "avgMaxDrawdown": 0.0,
    "bestTicker": "<ticker>",
    "worstTicker": "<ticker>"
  },
  "conclusion": "<вывод: стоит ли применять, при каких рыночных условиях работает лучше/хуже>"
}
```

---

## КАК ЗАПУСКАТЬ АГЕНТОВ ПАРАЛЛЕЛЬНО

В Agent mode Cursor — одно сообщение с тремя Task вызовами:

```
Запусти параллельно три best-of-n-runner агента.
Используй промпт из agents/strategy-researcher-prompt.md,
подставив для каждого агента свою стратегию:

Агент 1 — EMA Crossover:
  СТРАТЕГИЯ_НАЗВАНИЕ: EmaCrossover
  ОПИСАНИЕ: Трендовая стратегия. Сигнал LONG — EMA(9) пересекает EMA(21) снизу вверх
  И ATR > минимального порога (0.0015 × цена) для отсева флета.
  Сигнал SHORT — EMA(9) пересекает EMA(21) сверху вниз.
  confirmEntry: цена закрытия выше/ниже EMA(21), RSI между 40–70 (не экстремальный).

Агент 2 — Donchian Breakout:
  СТРАТЕГИЯ_НАЗВАНИЕ: DonchianBreakout
  ОПИСАНИЕ: Пробойная стратегия. Сигнал LONG — закрытие выше максимума N=20 предыдущих свечей.
  Сигнал SHORT — закрытие ниже минимума N=20 предыдущих свечей.
  Фильтр: только если ATR > минимального порога (нет узкого флета).
  confirmEntry: цена закрытия подтверждает пробой (не возврат в канал).

Агент 3 — RSI Momentum:
  СТРАТЕГИЯ_НАЗВАНИЕ: RsiMomentum
  ОПИСАНИЕ: Моментум на RSI. Сигнал LONG — RSI(14) выходит из зоны перепроданности
  (пересекает 35 снизу вверх) при условии что EMA(20) направлена вверх (emaBias > 0).
  Сигнал SHORT — RSI(14) пересекает 65 сверху вниз при emaBias < 0.
  confirmEntry: RSI не ушёл обратно в зону за одну свечу.
```

---

## ОЖИДАЕМЫЕ ФАЙЛЫ ПОСЛЕ РАБОТЫ АГЕНТОВ

```
src/market/emaCrossoverStrategy.ts
src/market/donchianBreakoutStrategy.ts
src/market/rsiMomentumStrategy.ts

scripts/runEmaCrossoverBacktestCached.ts
scripts/runDonchianBreakoutBacktestCached.ts
scripts/runRsiMomentumBacktestCached.ts
```

После завершения агентов: сравни JSON результаты и выбери лучшую стратегию для мержа в master.
