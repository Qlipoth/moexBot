/**
 * Менеджер сделок через Tinkoff Invest API (песочница/боевой).
 * Открытие рыночной заявки, хранение стопа/тейка в памяти + JSON-файл на диске.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  getAccountBalance,
  getFutureInstrument,
  getFuturesPositions,
  getMaxLots,
  postOrder,
  sandboxTopUp,
  computeSandboxTopUpAmount,
  SANDBOX_INITIAL_DEPOSIT_RUB,
} from '../core/investClient.js';
import { calculatePositionSizing } from './positionSizing.js';
import { addDailyPnlRub } from '../core/dailyLossLimit.js';
import { recordClosedTrade } from '../core/tradeStats.js';
const tempDir = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
/** Путь к файлу позиций. При нескольких репликах укажите общий том (volume), иначе каждый инстанс видит только свой /tmp. */
const POSITIONS_FILE =
  process.env.MOEX_POSITIONS_FILE ?? path.join(tempDir, 'moex-positions.jsonl');

/** Абсолютный путь к файлу позиций (для экспорта/бэкапа). */
export function getMoexPositionsFilePath(): string {
  return POSITIONS_FILE;
}

export type Side = 'LONG' | 'SHORT';

export interface TradePosition {
  ticker: string;
  side: Side;
  entryPrice: number;
  stopPrice: number;
  takePrice: number;
  lots: number;
  accountId: string;
  instrumentId: string;
  minPriceIncrement: number;
  minPriceIncrementAmount: number;
  openedAt: number;
}

export interface OpenPositionParams {
  token: string;
  ticker: string;
  side: Side;
  price: number;
  stopPrice: number;
  balanceRub: number;
}

/** Номинал одной позиции не должен превышать этот % от депозита. */
const MAX_POSITION_SIZE_PCT = 0.05; // 5%
const OPENING_LOCK_MS = 15_000;
const openingLocks = new Map<string, number>();

/** Ключ идемпотентности: API требует формат UUID, макс. 36 символов (ошибка 30028). */
function generateOrderId(): string {
  return randomUUID();
}

function validateTradePositionRow(row: unknown): { ok: true; pos: TradePosition } | { ok: false; error: string } {
  if (row == null || typeof row !== 'object') {
    return { ok: false, error: 'запись не является объектом' };
  }
  const o = row as Record<string, unknown>;
  const ticker = o.ticker;
  if (typeof ticker !== 'string' || !ticker.trim()) {
    return { ok: false, error: 'некорректный ticker' };
  }
  const side = o.side;
  if (side !== 'LONG' && side !== 'SHORT') {
    return { ok: false, error: 'side должен быть LONG или SHORT' };
  }
  const num = (k: string): number | null => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const str = (k: string): string | null => {
    const v = o[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const entryPrice = num('entryPrice');
  const stopPrice = num('stopPrice');
  const takePrice = num('takePrice');
  const lots = num('lots');
  const minPriceIncrement = num('minPriceIncrement');
  const minPriceIncrementAmount = num('minPriceIncrementAmount');
  const openedAt = num('openedAt');
  if (entryPrice == null || entryPrice <= 0) return { ok: false, error: 'entryPrice' };
  if (stopPrice == null || stopPrice <= 0) return { ok: false, error: 'stopPrice' };
  if (takePrice == null || takePrice <= 0) return { ok: false, error: 'takePrice' };
  if (lots == null || !Number.isInteger(lots) || lots < 1) return { ok: false, error: 'lots' };
  if (minPriceIncrement == null || minPriceIncrement <= 0) return { ok: false, error: 'minPriceIncrement' };
  if (minPriceIncrementAmount == null || minPriceIncrementAmount <= 0) {
    return { ok: false, error: 'minPriceIncrementAmount' };
  }
  if (openedAt == null || openedAt <= 0) return { ok: false, error: 'openedAt' };
  const accountId = str('accountId');
  const instrumentId = str('instrumentId');
  if (!accountId) return { ok: false, error: 'accountId' };
  if (!instrumentId) return { ok: false, error: 'instrumentId' };
  return {
    ok: true,
    pos: {
      ticker: ticker.trim(),
      side,
      entryPrice,
      stopPrice,
      takePrice,
      lots,
      accountId,
      instrumentId,
      minPriceIncrement,
      minPriceIncrementAmount,
      openedAt,
    },
  };
}

/**
 * Разбор JSONL для импорта (Telegram и т.п.). Дубликаты тикера в файле — ошибка.
 */
export function parseTradePositionsJsonl(
  content: string
): { ok: true; positions: TradePosition[] } | { ok: false; error: string } {
  const trimmed = content.trim();
  if (trimmed === '') {
    return { ok: true, positions: [] };
  }
  const lines = trimmed.split(/\r?\n/);
  const positions: TradePosition[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return { ok: false, error: `строка ${i + 1}: невалидный JSON` };
    }
    const v = validateTradePositionRow(row);
    if (!v.ok) {
      return { ok: false, error: `строка ${i + 1}: ${v.error}` };
    }
    if (seen.has(v.pos.ticker)) {
      return { ok: false, error: `дубликат тикера в файле: ${v.pos.ticker}` };
    }
    seen.add(v.pos.ticker);
    positions.push(v.pos);
  }
  return { ok: true, positions };
}

function positionMatchesExchange(
  pos: TradePosition,
  exchange: { instrumentUid: string; balance: number }[]
): boolean {
  const ep = exchange.find((e) => e.instrumentUid === pos.instrumentId);
  if (!ep) return false;
  const bal = ep.balance ?? 0;
  if (bal === 0) return false;
  const exchangeLong = bal > 0;
  return pos.side === 'LONG' ? exchangeLong : !exchangeLong;
}

export class TinkoffTradeManager {
  private readonly positions = new Map<string, TradePosition>();

  constructor() {
    this.loadFromDisk();
  }

  hasPosition(ticker: string): boolean {
    return this.positions.has(ticker);
  }

  getPosition(ticker: string): TradePosition | undefined {
    return this.positions.get(ticker);
  }

  getAllPositions(): TradePosition[] {
    return Array.from(this.positions.values());
  }

  /** Удалить позицию из памяти и с диска (при ручном закрытии через бота). */
  forceRemovePosition(ticker: string): void {
    this.positions.delete(ticker);
    this.saveToDisk();
  }

  /**
   * Полная замена позиций из импорта (после parseTradePositionsJsonl).
   * Пустой массив — очищает файл.
   */
  replaceAllPositionsFromImport(positions: TradePosition[]): void {
    this.positions.clear();
    for (const p of positions) {
      this.positions.set(p.ticker, p);
    }
    this.saveToDisk();
    console.log(
      `[TRADE] Импорт позиций: ${positions.length} шт. записано в ${POSITIONS_FILE}`
    );
  }

  private saveToDisk(): void {
    try {
      mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
      const lines = Array.from(this.positions.values())
        .map((p) => JSON.stringify(p))
        .join('\n');
      writeFileSync(POSITIONS_FILE, lines ? lines + '\n' : '', 'utf-8');
      if (this.positions.size > 0) {
        console.log(`[TRADE] Позиции сохранены: ${POSITIONS_FILE}`);
      }
    } catch (e) {
      console.error('[TRADE] Ошибка записи позиций на диск:', e);
    }
  }

  private loadFromDisk(silent = false): void {
    this.positions.clear();
    let raw: string;
    try {
      raw = readFileSync(POSITIONS_FILE, 'utf-8').trim();
    } catch {
      return;
    }
    if (!raw) return;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const pos: TradePosition = JSON.parse(t);
        if (pos?.ticker) this.positions.set(pos.ticker, pos);
      } catch {
        // Пропускаем повреждённую строку, остальные загружаем
      }
    }
    if (!silent && this.positions.size > 0) {
      console.log(`[TRADE] Загружено ${this.positions.size} позиций с диска: ${POSITIONS_FILE}`);
    }
  }

  /** Перезагрузить позиции с диска (после закрытия через скрипт или другой процесс). */
  reloadFromDisk(): void {
    this.loadFromDisk(true);
  }

  /**
   * Удаляет из памяти и файла записи, для которых на бирже нет соответствующей открытой позиции
   * (тот же instrument_uid и сторона LONG/SHORT по знаку balance).
   */
  async syncPositionsFileWithExchange(token: string, accountId: string): Promise<string[]> {
    const exchange = await getFuturesPositions(token, accountId);
    const removed: string[] = [];
    for (const pos of [...this.getAllPositions()]) {
      if (!positionMatchesExchange(pos, exchange)) {
        this.positions.delete(pos.ticker);
        removed.push(pos.ticker);
      }
    }
    if (removed.length > 0) {
      this.saveToDisk();
      console.log(
        `[TRADE] Синхронизация с биржей: удалены из файла «призраки» (${removed.length}): ${removed.join(', ')}`
      );
    }
    return removed;
  }

  /**
   * Открыть позицию: расчёт лотов по риску, рыночная заявка, сохранение стопа/тейка.
   */
  async openPosition(params: OpenPositionParams): Promise<boolean> {
    const { token, ticker, side, price, stopPrice, balanceRub } = params;

    if (this.positions.has(ticker)) {
      console.warn(`[TRADE] ${ticker} уже есть открытая позиция`);
      return false;
    }

    const lockKey = ticker;
    if ((openingLocks.get(lockKey) ?? 0) > Date.now()) {
      console.warn(`[TRADE] ${ticker} открытие уже выполняется`);
      return false;
    }
    openingLocks.set(lockKey, Date.now() + OPENING_LOCK_MS);

    try {
      const accountId = await this.resolveAccountId(token);
      if (!accountId) {
        console.error('[TRADE] Не удалось получить accountId');
        return false;
      }

      const instrument = await getFutureInstrument(token, ticker);
      if (!instrument) {
        console.error(`[TRADE] Не получен инструмент ${ticker}`);
        return false;
      }

      // Не открывать вторую позицию по тому же фьючерсу (в т.ч. после рестарта бота)
      const positions = await getFuturesPositions(token, accountId);
      const hasPositionOnExchange = positions.some(
        (p) => p.instrumentUid === instrument.uid && p.balance !== 0
      );
      if (hasPositionOnExchange) {
        console.warn(`[TRADE] ${ticker} на бирже уже есть позиция, дубль не открываем`);
        return false;
      }

      const sizing = calculatePositionSizing(
        balanceRub,
        price,
        stopPrice,
        side,
        instrument.minPriceIncrement,
        instrument.minPriceIncrementAmount
      );
      if (!sizing || sizing.lots < 1) {
        console.warn(`[TRADE] ${ticker} не рассчитан размер позиции`);
        return false;
      }

      // Ограничение: номинал позиции ≤ MAX_POSITION_SIZE_PCT от депозита
      const nominalPerLot =
        (price / instrument.minPriceIncrement) * instrument.minPriceIncrementAmount;
      const maxPositionRub = balanceRub * MAX_POSITION_SIZE_PCT;
      const capByBalance = nominalPerLot > 0
        ? Math.max(1, Math.floor(maxPositionRub / nominalPerLot))
        : sizing.lots;

      // Также проверяем лимит биржи (ГО, свободная маржа)
      const direction = side === 'LONG' ? 'BUY' : 'SELL';
      const apiDirection = side === 'LONG' ? 'BUY' as const : 'SELL' as const;
      const { maxLots } = await getMaxLots(
        token, accountId, instrument.uid, apiDirection
      );
      if (maxLots < 1) {
        console.warn(`[TRADE] ${ticker} биржа: maxLots=0, недостаточно средств/маржи`);
        return false;
      }

      const finalLots = Math.min(sizing.lots, capByBalance, maxLots);

      console.log(
        `[TRADE] ${ticker} ${side} lots=${finalLots} (risk=${sizing.lots}, cap5%=${capByBalance}, apiMax=${maxLots}, номинал/лот=${nominalPerLot.toFixed(0)} ₽) balance=${balanceRub.toFixed(0)} ₽ entry=${price} SL=${stopPrice} TP=${sizing.takePrice.toFixed(2)}`
      );
      let result = await postOrder({
        token,
        accountId,
        instrumentId: instrument.uid,
        quantity: finalLots,
        direction,
        orderType: 'MARKET',
        orderId: generateOrderId(),
      });

      // 30034 = not enough balance (песочница); пополняем и повторяем 1 раз
      if (!result.success && result.message?.includes('30034')) {
        console.warn(`[TRADE] ${ticker} нехватка средств в песочнице, пополняем...`);
        const topped = await sandboxTopUp(token, accountId, SANDBOX_INITIAL_DEPOSIT_RUB);
        if (topped) {
          result = await postOrder({
            token,
            accountId,
            instrumentId: instrument.uid,
            quantity: finalLots,
            direction,
            orderType: 'MARKET',
            orderId: generateOrderId(),
          });
        }
      }

      if (!result.success) {
        console.error(`[TRADE] ${ticker} заявка не принята:`, result.message);
        return false;
      }

      this.positions.set(ticker, {
        ticker,
        side,
        entryPrice: price,
        stopPrice,
        takePrice: sizing.takePrice,
        lots: finalLots,
        accountId,
        instrumentId: instrument.uid,
        minPriceIncrement: instrument.minPriceIncrement,
        minPriceIncrementAmount: instrument.minPriceIncrementAmount,
        openedAt: Date.now(),
      });
      this.saveToDisk();

      console.log(
        `[TRADE] ${ticker} OPEN ${side} lots=${sizing.lots} entry=${price} SL=${stopPrice} TP=${sizing.takePrice}`
      );
      return true;
    } finally {
      openingLocks.delete(lockKey);
    }
  }

  /**
   * Закрыть позицию рыночной заявкой в противоположную сторону.
   * Возвращает PnL в рублях (приблизительно по разнице цен).
   */
  async closePosition(
    token: string,
    ticker: string,
    exitPrice: number,
    reason: string
  ): Promise<{ closed: boolean; pnlRub: number }> {
    const pos = this.positions.get(ticker);
    if (!pos) {
      return { closed: false, pnlRub: 0 };
    }

    const direction = pos.side === 'LONG' ? 'SELL' : 'BUY';
    const orderId = generateOrderId();
    let result = await postOrder({
      token,
      accountId: pos.accountId,
      instrumentId: pos.instrumentId,
      quantity: pos.lots,
      direction,
      orderType: 'MARKET',
      orderId,
    });

    // 30034 = not enough balance (песочница); пополняем только нехватающую сумму
    if (!result.success && result.message?.includes('30034')) {
      const amount = await computeSandboxTopUpAmount(
        token,
        pos.accountId,
        pos.instrumentId,
        pos.lots,
        exitPrice,
        pos.minPriceIncrement,
        pos.minPriceIncrementAmount,
        direction
      );
      console.warn(`[TRADE] ${ticker} 30034 при закрытии, пополняем на ${amount} ₽...`);
      const topped = await sandboxTopUp(token, pos.accountId, amount);
      if (topped) {
        result = await postOrder({
          token,
          accountId: pos.accountId,
          instrumentId: pos.instrumentId,
          quantity: pos.lots,
          direction,
          orderType: 'MARKET',
          orderId: generateOrderId(),
        });
      }
    }

    if (!result.success) {
      console.error(`[TRADE] ${ticker} не удалось закрыть:`, result.message);
      return { closed: false, pnlRub: 0 };
    }

    const pnlRub = this.estimatePnlRub(pos, exitPrice);
    this.positions.delete(ticker);
    this.saveToDisk();
    addDailyPnlRub(pnlRub);
    recordClosedTrade({
      ticker,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      lots: pos.lots,
      pnlRub,
      reason,
      closedAt: Date.now(),
    });

    console.log(
      `[TRADE] ${ticker} CLOSE ${reason} exit=${exitPrice} PnL≈${pnlRub.toFixed(2)} ₽`
    );
    return { closed: true, pnlRub };
  }

  /**
   * Проверка: сработал ли стоп или тейк по текущей цене.
   * Возвращает 'STOP' | 'TAKE' | null.
   */
  checkStopTake(ticker: string, currentPrice: number): 'STOP' | 'TAKE' | null {
    const pos = this.positions.get(ticker);
    if (!pos) return null;
    if (pos.side === 'LONG') {
      if (currentPrice <= pos.stopPrice) return 'STOP';
      if (currentPrice >= pos.takePrice) return 'TAKE';
    } else {
      if (currentPrice >= pos.stopPrice) return 'STOP';
      if (currentPrice <= pos.takePrice) return 'TAKE';
    }
    return null;
  }

  private estimatePnlRub(pos: TradePosition, exitPrice: number): number {
    const priceDiff =
      pos.side === 'LONG'
        ? exitPrice - pos.entryPrice
        : pos.entryPrice - exitPrice;
    if (pos.minPriceIncrement <= 0) return 0;
    const steps = priceDiff / pos.minPriceIncrement;
    return steps * pos.minPriceIncrementAmount * pos.lots;
  }

  private async resolveAccountId(token: string): Promise<string | null> {
    const balance = await getAccountBalance(token);
    return balance?.accountId ?? null;
  }
}
