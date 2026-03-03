/**
 * Отслеживание дневного убытка (UTC).
 * При достижении лимита бот отключает новые сделки до ручного /start.
 * Открытые позиции не закрываются — управляются стопом/тейком.
 */

const DAILY_LOSS_LIMIT_RUB = 1000;

let dailyPnlRub = 0;
let dayKey = getDayKey(Date.now());
let limitReachedTriggeredToday = false;

function getDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function maybeResetDay(now: number): void {
  const currentKey = getDayKey(now);
  if (currentKey !== dayKey) {
    dayKey = currentKey;
    dailyPnlRub = 0;
    limitReachedTriggeredToday = false;
  }
}

/**
 * Добавить PnL закрытой сделки в дневной учёт (рубли).
 */
export function addDailyPnlRub(pnlRub: number, now: number = Date.now()): void {
  maybeResetDay(now);
  if (!Number.isFinite(pnlRub)) return;
  dailyPnlRub += pnlRub;
}

/**
 * Проверка: достигнут ли лимит дневного убытка.
 */
export function isOverDailyLossLimit(): boolean {
  return dailyPnlRub <= -DAILY_LOSS_LIMIT_RUB;
}

/**
 * Была ли уже отправлена сигнальная отключка за сегодня.
 */
export function wasLimitAlertTriggeredToday(): boolean {
  return limitReachedTriggeredToday;
}

/**
 * Отметить, что алерт о лимите за сегодня уже отправлен.
 */
export function markLimitAlertTriggered(): void {
  limitReachedTriggeredToday = true;
}

/**
 * Текущий дневной PnL в рублях.
 */
export function getDailyPnlRub(): number {
  return dailyPnlRub;
}

export function getDailyLossLimitRub(): number {
  return DAILY_LOSS_LIMIT_RUB;
}
