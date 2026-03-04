/**
 * Скрипт для ручного закрытия позиции (для отладки).
 * Использование: pnpm tsx scripts/closePosition.ts IMOEXF
 */
import 'dotenv/config';
import { TinkoffTradeManager } from '../src/market/tinkoffTradeManager.js';
import { getFuturesLastPrices } from '../src/core/investClient.js';

const TICKER = process.argv[2] ?? 'IMOEXF';
const TICKERS = [TICKER];

async function main(): Promise<void> {
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    console.error('Нет TINKOFF_TOKEN в .env');
    process.exit(1);
  }

  const tradeExecutor = new TinkoffTradeManager();
  if (!tradeExecutor.hasPosition(TICKER)) {
    console.log(`Позиция ${TICKER} не найдена в памяти.`);
    process.exit(0);
  }

  const prices = await getFuturesLastPrices(token, TICKERS);
  const priceInfo = prices.find((p) => p.ticker === TICKER);
  const exitPrice = priceInfo?.lastPrice ?? tradeExecutor.getPosition(TICKER)!.entryPrice;

  console.log(`Закрываем ${TICKER} по цене ${exitPrice}...`);
  const { closed, pnlRub } = await tradeExecutor.closePosition(
    token,
    TICKER,
    exitPrice,
    'скрипт closePosition'
  );
  if (closed) {
    console.log(`✅ Закрыто. PnL ≈ ${pnlRub.toFixed(2)} ₽`);
  } else {
    console.error('❌ Не удалось закрыть');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
