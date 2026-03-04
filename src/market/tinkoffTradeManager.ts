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
const POSITIONS_FILE =
  process.env.MOEX_POSITIONS_FILE ?? path.join(tempDir, 'moex-positions.jsonl');

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
    try {
      let raw: string;
      try {
        raw = readFileSync(POSITIONS_FILE, 'utf-8').trim();
      } catch {
        return;
      }
      if (!raw) return;
      for (const line of raw.split('\n')) {
        const pos: TradePosition = JSON.parse(line);
        this.positions.set(pos.ticker, pos);
      }
      if (!silent) console.log(`[TRADE] Загружено ${this.positions.size} позиций с диска`);
    } catch {
      // Файл не существует или повреждён — начинаем с пустого состояния
    }
  }

  /** Перезагрузить позиции с диска (после закрытия через скрипт или другой процесс). */
  reloadFromDisk(): void {
    this.loadFromDisk(true);
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
