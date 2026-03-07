/**
 * Расчёт размера позиции по риску на сделку (как в byBitBot).
 * Для фьючерсов Мосбиржи: баланс в рублях, цена и стоп в пунктах.
 */

const RISK_PER_TRADE = 0.005; // 0.5%
const RR_RATIO = 2; // 2:1 — тейк ближе, чаще срабатывает
const ENTRY_FEE_PCT = 0.0004;
const EXIT_FEE_PCT = 0.0004;
const TOTAL_FEE_PCT = ENTRY_FEE_PCT + EXIT_FEE_PCT;
const MAX_STOP_PCT = 0.07;
const MIN_LOTS = 1;

export interface PositionSizingResult {
  lots: number;
  stopPct: number;
  takePrice: number;
}

/**
 * Считает размер позиции в лотах и цену тейк-профита.
 * entryPrice, stopPrice — в пунктах (как в API фьючерсов).
 * minPriceIncrement — шаг цены, minPriceIncrementAmount — стоимость шага в рублях за 1 лот.
 */
export function calculatePositionSizing(
  balanceRub: number,
  entryPrice: number,
  stopPrice: number,
  side: 'LONG' | 'SHORT',
  minPriceIncrement: number,
  minPriceIncrementAmount: number,
  silent = false
): PositionSizingResult | null {
  if (balanceRub <= 0 || entryPrice <= 0 || minPriceIncrement <= 0 || minPriceIncrementAmount <= 0) {
    return null;
  }

  const stopDistance = Math.abs(entryPrice - stopPrice);
  const stopPct = stopDistance / entryPrice;

  if (stopPct <= 0 || stopPct > MAX_STOP_PCT) {
    return null;
  }

  const maxPriceRiskPct = RISK_PER_TRADE - TOTAL_FEE_PCT;
  if (maxPriceRiskPct <= 0) {
    return null;
  }

  // Риск в рублях на сделку
  const riskRub = balanceRub * maxPriceRiskPct;
  // Убыток в рублях на 1 лот при срабатывании стопа
  const lossPerLotRub = (stopDistance / minPriceIncrement) * minPriceIncrementAmount;
  if (lossPerLotRub <= 0) {
    return null;
  }

  const lots = Math.floor(riskRub / lossPerLotRub);
  if (lots < MIN_LOTS) {
    if (!silent) {
      console.warn(
        `[SIZING] Недостаточно для 1 лота: riskRub=${riskRub.toFixed(2)}, lossPerLot=${lossPerLotRub.toFixed(2)}, lots=${lots}`
      );
    }
    return null;
  }
  if (!silent) {
    console.log(
      `[SIZING] balance=${balanceRub.toFixed(0)} riskRub=${riskRub.toFixed(2)} lossPerLot=${lossPerLotRub.toFixed(2)} lots=${lots} stopPct=${(stopPct * 100).toFixed(2)}%`
    );
  }

  const takePct = stopPct * RR_RATIO + TOTAL_FEE_PCT;
  const takePrice =
    side === 'LONG'
      ? entryPrice * (1 + takePct)
      : entryPrice * (1 - takePct);

  return { lots, stopPct, takePrice };
}
