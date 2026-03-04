/**
 * Клиент Tinkoff Invest API: фьючерсы и последние цены.
 * По умолчанию используется песочница (тестовый счёт). Боевой контур — только при TINKOFF_PRODUCTION=1.
 */

import {
  TTechApiClient,
  InstrumentIdType,
  LastPriceType,
  CandleInterval,
  OrderDirection,
  OrderType,
  TimeInForceType,
  PriceType,
  type Quotation,
} from '@tinkoff/invest-js';

const FUTURES_CLASS_CODE = 'SPBFUT';

const PRODUCTION_URL = 'https://invest-public-api.tinkoff.ru';
const SANDBOX_URL = 'https://sandbox-invest-public-api.tinkoff.ru';

/** Стартовый депозит в песочнице (руб.). */
export const SANDBOX_INITIAL_DEPOSIT_RUB = 100_000;

/** Сейчас предполагается использование только песочницы. Боевой режим — при TINKOFF_PRODUCTION=1. */
function isSandbox(): boolean {
  const v = process.env.TINKOFF_PRODUCTION;
  return v !== '1' && v !== 'true' && v !== 'yes';
}

export function getInvestClient(token: string): TTechApiClient {
  const url = isSandbox() ? SANDBOX_URL : PRODUCTION_URL;
  return new TTechApiClient({ token, url });
}

/** Свеча для стратегий (timestamp в ms, OHLCV в пунктах/единицах). */
export interface HistoricalCandleInput {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function quotationToNumber(q: Quotation | undefined): number {
  if (!q) return 0;
  const u = typeof q.units === 'bigint' ? Number(q.units) : q.units;
  const n = typeof q.nano === 'bigint' ? Number(q.nano) : q.nano;
  return u + n / 1e9;
}

/** Цена в пунктах (фьючерсы) → Quotation для API. */
export function numberToQuotation(price: number): Quotation {
  const units = Math.floor(price);
  const nano = Math.round((price - units) * 1e9);
  return { units, nano };
}

export interface FuturePrice {
  ticker: string;
  name: string;
  /** Цена в пунктах (как в API). */
  lastPrice: number;
  /** Стоимость в рублях (price / minPriceIncrement * minPriceIncrementAmount), если известны шаг и стоимость шага. */
  priceRubles: number | undefined;
  /** Цена закрытия предыдущей торговой сессии (для изменения за день). */
  previousClose: number | undefined;
  time: Date | undefined;
}

/**
 * Возвращает последние цены по списку тикеров фьючерсов (Мосбиржа, SPBFUT).
 * Требуется TINKOFF_TOKEN в окружении.
 */
export async function getFuturesLastPrices(
  token: string,
  tickers: string[]
): Promise<FuturePrice[]> {
  const client = getInvestClient(token);
  const uids: string[] = [];
  const tickerByUid = new Map<
    string,
    { ticker: string; name: string; minPriceIncrement: number; minPriceIncrementAmount: number }
  >();

  for (const ticker of tickers) {
    try {
      const { instrument } = await client.instruments.futureBy({
        idType: InstrumentIdType.INSTRUMENT_ID_TYPE_TICKER,
        id: ticker,
        classCode: FUTURES_CLASS_CODE,
      });
      if (instrument?.uid) {
        uids.push(instrument.uid);
        const step = quotationToNumber(instrument.minPriceIncrement);
        const stepAmount = quotationToNumber(instrument.minPriceIncrementAmount);
        tickerByUid.set(instrument.uid, {
          ticker: instrument.ticker ?? ticker,
          name: instrument.name ?? ticker,
          minPriceIncrement: step,
          minPriceIncrementAmount: stepAmount,
        });
      }
    } catch (e) {
      console.error(`FutureBy ${ticker}:`, e);
      // продолжаем с остальными
    }
  }

  if (uids.length === 0) {
    return [];
  }

  const { lastPrices } = await client.marketdata.getLastPrices({
    instrumentId: uids,
    lastPriceType: LastPriceType.LAST_PRICE_EXCHANGE,
  });

  // Цена закрытия торговой сессии (price). eveningSessionPrice — вечерняя; для «за день» используем price
  const closePricesRes = await client.marketdata.getClosePrices({
    instruments: uids.map((uid) => ({ instrumentId: uid })),
  });
  const previousCloseByUid = new Map<string, number>();
  for (const cp of closePricesRes.closePrices) {
    const price = quotationToNumber(cp.price);
    if (price > 0) {
      previousCloseByUid.set(cp.instrumentUid, price);
    }
  }

  return lastPrices.map((lp) => {
    const info = tickerByUid.get(lp.instrumentUid);
    const ticker = info?.ticker ?? lp.figi;
    const name = info?.name ?? lp.figi;
    const lastPrice = quotationToNumber(lp.price);
    let priceRubles: number | undefined;
    if (info && info.minPriceIncrement > 0 && info.minPriceIncrementAmount !== undefined) {
      priceRubles = (lastPrice / info.minPriceIncrement) * info.minPriceIncrementAmount;
    }
    const previousClose = previousCloseByUid.get(lp.instrumentUid);

    return {
      ticker,
      name,
      lastPrice,
      priceRubles,
      previousClose,
      time: lp.time,
    };
  });
}

/**
 * Возвращает instrument_uid фьючерса по тикеру (SPBFUT).
 */
export async function getFutureUid(
  token: string,
  ticker: string
): Promise<string | null> {
  const client = getInvestClient(token);
  try {
    const { instrument } = await client.instruments.futureBy({
      idType: InstrumentIdType.INSTRUMENT_ID_TYPE_TICKER,
      id: ticker,
      classCode: FUTURES_CLASS_CODE,
    });
    return instrument?.uid ?? null;
  } catch (e) {
    console.error(`getFutureUid ${ticker}:`, e);
    return null;
  }
}

export interface FutureInstrumentInfo {
  uid: string;
  lot: number;
  minPriceIncrement: number;
  minPriceIncrementAmount: number;
}

/** Данные фьючерса для расчёта размера позиции и заявок. */
export async function getFutureInstrument(
  token: string,
  ticker: string
): Promise<FutureInstrumentInfo | null> {
  const client = getInvestClient(token);
  try {
    const { instrument } = await client.instruments.futureBy({
      idType: InstrumentIdType.INSTRUMENT_ID_TYPE_TICKER,
      id: ticker,
      classCode: FUTURES_CLASS_CODE,
    });
    if (!instrument?.uid) return null;
    const minPriceIncrement = quotationToNumber(instrument.minPriceIncrement);
    const minPriceIncrementAmount = quotationToNumber(instrument.minPriceIncrementAmount);
    return {
      uid: instrument.uid,
      lot: instrument.lot ?? 1,
      minPriceIncrement,
      minPriceIncrementAmount,
    };
  } catch (e) {
    console.error(`getFutureInstrument ${ticker}:`, e);
    return null;
  }
}

const CANDLE_LIMIT = 2400;

/**
 * Загружает исторические свечи по инструменту (instrument_uid).
 * from/to — время в миллисекундах; interval — '1m' или '1h'.
 */
export async function getCandles(
  token: string,
  instrumentId: string,
  from: number,
  to: number,
  interval: '1m' | '1h'
): Promise<HistoricalCandleInput[]> {
  const client = getInvestClient(token);
  const intervalEnum =
    interval === '1h' ? CandleInterval.CANDLE_INTERVAL_HOUR : CandleInterval.CANDLE_INTERVAL_1_MIN;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const { candles } = await client.marketdata.getCandles({
    instrumentId,
    from: fromDate,
    to: toDate,
    interval: intervalEnum,
    limit: CANDLE_LIMIT,
  });
  return candles.map((c) => ({
    timestamp: c.time ? c.time.getTime() : 0,
    open: quotationToNumber(c.open),
    high: quotationToNumber(c.high),
    low: quotationToNumber(c.low),
    close: quotationToNumber(c.close),
    volume: c.volume ?? 0,
  }));
}

/** Результат запроса остатка по счёту. */
export interface AccountBalanceResult {
  accountId: string;
  rub: number;
  isSandbox: boolean;
}

function moneyValueToNumber(m: { units?: number | string | bigint; nano?: number | string | bigint } | undefined): number {
  if (!m) return 0;
  const u = Number(typeof m.units === 'bigint' ? m.units.toString() : m.units ?? 0);
  const n = Number(typeof m.nano === 'bigint' ? m.nano.toString() : m.nano ?? 0) / 1e9;
  return u + n;
}

/**
 * Обеспечивает наличие счёта в песочнице и пополняет его на SANDBOX_INITIAL_DEPOSIT_RUB при нулевом балансе.
 * Баланс в песочнице задаётся только через API (SandboxPayIn). Возвращает accountId или null.
 */
export async function ensureSandboxAccount(token: string): Promise<string | null> {
  if (!isSandbox()) return null;
  const client = getInvestClient(token);
  try {
    const { accounts } = await client.sandbox.getSandboxAccounts({});
    if (accounts && accounts.length > 0) {
      const accountId = accounts[0]!.id ?? null;
      if (!accountId) return null;
      return accountId;
    }
    const { accountId } = await client.sandbox.openSandboxAccount({});
    if (!accountId) return null;
    await client.sandbox.sandboxPayIn({
      accountId,
      amount: {
        currency: 'RUB',
        units: SANDBOX_INITIAL_DEPOSIT_RUB,
        nano: 0,
      },
    });
    console.log(`[SANDBOX] Счёт ${accountId} создан, зачислено ${SANDBOX_INITIAL_DEPOSIT_RUB} ₽`);
    return accountId;
  } catch (e) {
    console.error('[SANDBOX] ensureSandboxAccount:', e);
    return null;
  }
}

/**
 * Сброс песочницы: закрыть все существующие счета, создать новый с начальным депозитом.
 * Возвращает новый accountId или null.
 */
export async function resetSandboxAccount(token: string): Promise<string | null> {
  if (!isSandbox()) return null;
  const client = getInvestClient(token);
  try {
    const { accounts } = await client.sandbox.getSandboxAccounts({});
    for (const acc of accounts ?? []) {
      if (acc.id) {
        await client.sandbox.closeSandboxAccount({ accountId: acc.id });
        console.log(`[SANDBOX] Закрыт счёт ${acc.id}`);
      }
    }
    const { accountId } = await client.sandbox.openSandboxAccount({});
    if (!accountId) return null;
    await client.sandbox.sandboxPayIn({
      accountId,
      amount: { currency: 'RUB', units: SANDBOX_INITIAL_DEPOSIT_RUB, nano: 0 },
    });
    console.log(`[SANDBOX] Новый счёт ${accountId}, зачислено ${SANDBOX_INITIAL_DEPOSIT_RUB} ₽`);
    return accountId;
  } catch (e) {
    console.error('[SANDBOX] resetSandboxAccount:', e);
    return null;
  }
}

/**
 * Возвращает доступный остаток по счёту (рубли).
 * В песочнице использует счёт, созданный ensureSandboxAccount; в боевом — первый счёт пользователя.
 */
export async function getAccountBalance(token: string): Promise<AccountBalanceResult | null> {
  const client = getInvestClient(token);
  try {
    if (isSandbox()) {
      const accountId = await ensureSandboxAccount(token);
      if (!accountId) return null;
      const portfolio = await client.sandbox.getSandboxPortfolio({ accountId });

      const totalPortfolio = portfolio.totalAmountPortfolio
        ? moneyValueToNumber(portfolio.totalAmountPortfolio)
        : 0;
      const totalCurrencies = portfolio.totalAmountCurrencies
        ? moneyValueToNumber(portfolio.totalAmountCurrencies)
        : 0;
      const totalFutures = portfolio.totalAmountFutures
        ? moneyValueToNumber(portfolio.totalAmountFutures)
        : 0;

      // Песочница: totalAmountPortfolio не учитывает фьючерсы, поэтому считаем вручную.
      // currencies завышен на номинал SHORT, futures < 0 → сумма = реальное эквити.
      const rub = totalCurrencies + totalFutures;
      console.log(
        `[BALANCE] equity=${rub.toFixed(2)} (currencies=${totalCurrencies.toFixed(2)} + futures=${totalFutures.toFixed(2)})`
      );

      return { accountId, rub, isSandbox: true };
    }
    const { accounts } = await client.users.getAccounts({});
    const accountId = accounts?.[0]?.id;
    if (!accountId) return null;
    const { money } = await client.operations.getWithdrawLimits({ accountId });
    let rub = 0;
    for (const m of money ?? []) {
      if (m.currency === 'RUB') rub += moneyValueToNumber(m);
    }
    return { accountId, rub, isSandbox: false };
  } catch (e) {
    console.error('getAccountBalance:', e);
    return null;
  }
}

/** Минимальная сумма пополнения при 30034 (руб.). */
const SANDBOX_TOPUP_MIN_RUB = 5_000;

/** Буфер поверх нехватающей суммы (руб.). */
const SANDBOX_TOPUP_BUFFER_RUB = 5_000;

/**
 * Вычислить сумму пополнения для закрытия позиции при 30034.
 * Нужно: номинал позиции − доступная маржа + буфер.
 */
export async function computeSandboxTopUpAmount(
  token: string,
  accountId: string,
  instrumentId: string,
  quantity: number,
  price: number,
  minPriceIncrement: number,
  minPriceIncrementAmount: number,
  direction: 'BUY' | 'SELL'
): Promise<number> {
  if (!isSandbox()) return 0;
  const { availableMoneyRub } = await getMaxLots(token, accountId, instrumentId, direction);
  const nominalPerLot =
    minPriceIncrement > 0 ? (price / minPriceIncrement) * minPriceIncrementAmount : 0;
  const neededRub = nominalPerLot * quantity;
  const shortage = Math.max(0, neededRub - availableMoneyRub);
  const amount = Math.ceil((shortage + SANDBOX_TOPUP_BUFFER_RUB) / 1000) * 1000;
  return Math.max(SANDBOX_TOPUP_MIN_RUB, amount);
}

/**
 * Пополнить счёт в песочнице на указанную сумму (рублей). В боевом режиме — no-op.
 */
export async function sandboxTopUp(
  token: string,
  accountId: string,
  amountRub: number
): Promise<boolean> {
  if (!isSandbox()) return false;
  const client = getInvestClient(token);
  try {
    await client.sandbox.sandboxPayIn({
      accountId,
      amount: { currency: 'RUB', units: amountRub, nano: 0 },
    });
    console.log(`[SANDBOX] Пополнено на ${amountRub} ₽ (accountId=${accountId})`);
    return true;
  } catch (e) {
    console.error('[SANDBOX] sandboxTopUp:', e);
    return false;
  }
}

export interface MaxLotsResult {
  maxLots: number;
  /** Доступная сумма для покупки (рублей). Нужна для расчёта ГО на 1 лот. */
  availableMoneyRub: number;
}

/**
 * Максимальное количество лотов, которое можно купить/продать по инструменту (с учётом ГО и баланса).
 * Песочница — getSandboxMaxLots, боевой — orders.getMaxLots.
 */
export async function getMaxLots(
  token: string,
  accountId: string,
  instrumentId: string,
  direction: 'BUY' | 'SELL'
): Promise<MaxLotsResult> {
  const client = getInvestClient(token);
  try {
    const result = isSandbox()
      ? await client.sandbox.getSandboxMaxLots({ accountId, instrumentId })
      : await client.orders.getMaxLots({ accountId, instrumentId });
    if (direction === 'BUY') {
      // LONG: buyMarginLimits (с учётом маржи) → buyLimits (на свои)
      const limits = result.buyMarginLimits ?? result.buyLimits;
      const maxLots = limits?.buyMaxMarketLots ?? limits?.buyMaxLots ?? 0;
      const availableMoneyRub = limits?.buyMoneyAmount
        ? quotationToNumber(limits.buyMoneyAmount)
        : 0;
      console.log(`[MAX_LOTS] BUY ${instrumentId}: maxLots=${maxLots}, money=${availableMoneyRub.toFixed(0)}`);
      return { maxLots, availableMoneyRub };
    }
    // SHORT: sellMarginLimits (открытие шорта на маржу) → sellLimits (продажа имеющегося)
    const marginLots = result.sellMarginLimits?.sellMaxLots ?? 0;
    const ownLots = result.sellLimits?.sellMaxLots ?? 0;
    const maxLots = Math.max(marginLots, ownLots);
    console.log(`[MAX_LOTS] SELL ${instrumentId}: marginLots=${marginLots}, ownLots=${ownLots}, maxLots=${maxLots}`);
    return { maxLots, availableMoneyRub: 0 };
  } catch (e) {
    console.error('getMaxLots:', e);
    return { maxLots: 0, availableMoneyRub: 0 };
  }
}

export interface PostOrderResult {
  orderId: string;
  success: boolean;
  filled: boolean;
  message?: string;
}

/**
 * Выставить заявку (в песочнице — postSandboxOrder, в боевом — postOrder).
 * instrumentId — uid фьючерса, quantity — лоты, price — в пунктах (для лимита).
 */
export async function postOrder(params: {
  token: string;
  accountId: string;
  instrumentId: string;
  quantity: number;
  direction: 'BUY' | 'SELL';
  orderType?: 'MARKET' | 'LIMIT';
  orderId: string;
  price?: number;
}): Promise<PostOrderResult> {
  const client = getInvestClient(params.token);
  const direction =
    params.direction === 'BUY'
      ? OrderDirection.ORDER_DIRECTION_BUY
      : OrderDirection.ORDER_DIRECTION_SELL;
  const orderType =
    params.orderType === 'LIMIT'
      ? OrderType.ORDER_TYPE_LIMIT
      : OrderType.ORDER_TYPE_MARKET;
  const request: Parameters<typeof client.sandbox.postSandboxOrder>[0] = {
    accountId: params.accountId,
    instrumentId: params.instrumentId,
    quantity: params.quantity,
    direction,
    orderType,
    orderId: params.orderId,
    timeInForce: TimeInForceType.TIME_IN_FORCE_DAY,
    priceType: PriceType.PRICE_TYPE_POINT,
  };
  if (params.price != null && orderType === OrderType.ORDER_TYPE_LIMIT) {
    request.price = numberToQuotation(params.price);
  }
  try {
    const result = isSandbox()
      ? await client.sandbox.postSandboxOrder(request)
      : await client.orders.postOrder(request);
    const status = result.executionReportStatus;
    const filled = status === 1; // EXECUTION_REPORT_STATUS_FILL
    const success = filled || status === 4; // NEW
    return {
      orderId: result.orderId ?? params.orderId,
      success,
      filled,
      message: result.message,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('postOrder:', e);
    return { orderId: params.orderId, success: false, filled: false, message };
  }
}

/** Тип заявки из API (список активных). */
export interface OrderInfo {
  orderId: string;
  instrumentUid: string;
  direction: 'BUY' | 'SELL';
  lotsRequested: number;
  lotsExecuted: number;
  initialSecurityPrice: number | null;
  executionReportStatus: number;
  orderType: string;
  orderDate: Date | undefined;
}

/**
 * Список активных заявок по счёту (песочница — getSandboxOrders, боевой — getOrders).
 */
export async function getOrders(
  token: string,
  accountId: string
): Promise<OrderInfo[]> {
  const client = getInvestClient(token);
  try {
    const response = isSandbox()
      ? await client.sandbox.getSandboxOrders({ accountId })
      : await client.orders.getOrders({ accountId });
    const orders = response.orders ?? [];
    return orders.map((o) => ({
      orderId: o.orderId ?? '',
      instrumentUid: o.instrumentUid ?? '',
      direction:
        o.direction === 2 ? 'SELL' : 'BUY', // 1=BUY, 2=SELL
      lotsRequested: o.lotsRequested ?? 0,
      lotsExecuted: o.lotsExecuted ?? 0,
      initialSecurityPrice: o.initialSecurityPrice
        ? quotationToNumber(o.initialSecurityPrice)
        : null,
      executionReportStatus: o.executionReportStatus ?? 0,
      orderType:
        o.orderType === 1 ? 'LIMIT' : o.orderType === 2 ? 'MARKET' : 'OTHER',
      orderDate: o.orderDate,
    }));
  } catch (e) {
    console.error('getOrders:', e);
    return [];
  }
}

/**
 * Список открытых позиций по фьючерсам (instrument_uid с ненулевым балансом).
 * Песочница — getSandboxPositions, боевой — operations.getPositions.
 */
export async function getFuturesPositions(
  token: string,
  accountId: string
): Promise<{ instrumentUid: string; balance: number }[]> {
  const client = getInvestClient(token);
  try {
    const response = isSandbox()
      ? await client.sandbox.getSandboxPositions({ accountId })
      : await client.operations.getPositions({ accountId });
    const futures = response.futures ?? [];
    return futures
      .filter((f) => (f.balance ?? 0) !== 0)
      .map((f) => ({
        instrumentUid: f.instrumentUid ?? '',
        balance: f.balance ?? 0,
      }));
  } catch (e) {
    console.error('getFuturesPositions:', e);
    return [];
  }
}
