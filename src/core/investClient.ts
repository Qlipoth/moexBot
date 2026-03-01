/**
 * Клиент Tinkoff Invest API: фьючерсы и последние цены.
 */

import {
  TTechApiClient,
  InstrumentIdType,
  LastPriceType,
  type Quotation,
} from '@tinkoff/invest-js';

const FUTURES_CLASS_CODE = 'SPBFUT';

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
  const client = new TTechApiClient({ token });
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
