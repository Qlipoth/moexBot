/**
 * Клиент Tinkoff Invest API: фьючерсы и последние цены.
 * По умолчанию используется песочница (тестовый счёт). Боевой контур — только при TINKOFF_PRODUCTION=1.
 */

import {
  TTechApiClient,
  InstrumentIdType,
  LastPriceType,
  CandleInterval,
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
  return q.units + q.nano / 1e9;
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
 * Возвращает доступный остаток по счёту (рубли).
 * В песочнице использует счёт, созданный ensureSandboxAccount; в боевом — первый счёт пользователя.
 */
export async function getAccountBalance(token: string): Promise<AccountBalanceResult | null> {
  const client = getInvestClient(token);
  try {
    if (isSandbox()) {
      const accountId = await ensureSandboxAccount(token);
      if (!accountId) return null;
      let rub = 0;
      const limits = await client.sandbox.getSandboxWithdrawLimits({ accountId });
      for (const m of limits.money ?? []) {
        if (m.currency === 'RUB') rub += moneyValueToNumber(m);
      }
      if (rub === 0) {
        const portfolio = await client.sandbox.getSandboxPortfolio({ accountId });
        if (portfolio.totalAmountCurrencies && portfolio.totalAmountCurrencies.currency === 'RUB') {
          rub = moneyValueToNumber(portfolio.totalAmountCurrencies);
        }
        if (rub === 0 && portfolio.totalAmountPortfolio) {
          rub = moneyValueToNumber(portfolio.totalAmountPortfolio);
        }
      }
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
