/**
 * Запрос к бирже: какие позиции открыты.
 * Запуск: pnpm run list-positions
 */
import 'dotenv/config';
import { getAccountBalance, getFuturesPositions, getFutureInstrument } from '../src/core/investClient.js';

const MARKET_FUTURES_TICKERS = [
  'CNYRUBF', 'USDRUBF', 'RGBIF', 'GLDRUBF', 'IMOEXF', 'SBERF', 'GAZPF',
];

async function main(): Promise<void> {
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    console.error('TINKOFF_TOKEN не задан');
    process.exit(1);
  }

  const balance = await getAccountBalance(token);
  if (!balance) {
    console.error('Не удалось получить счёт');
    process.exit(1);
  }

  const positions = await getFuturesPositions(token, balance.accountId);
  const uidToTicker: Record<string, string> = {};
  for (const ticker of MARKET_FUTURES_TICKERS) {
    const info = await getFutureInstrument(token, ticker);
    if (info) uidToTicker[info.uid] = ticker;
  }

  console.log('=== Позиции на бирже (API) ===');
  console.log(`Счёт: ${balance.accountId} | Песочница: ${balance.isSandbox}`);
  console.log('');

  if (positions.length === 0) {
    console.log('Открытых позиций нет.');
    return;
  }

  for (const p of positions) {
    const ticker = uidToTicker[p.instrumentUid] ?? p.instrumentUid;
    const side = p.balance > 0 ? 'LONG' : 'SHORT';
    const lots = Math.abs(p.balance);
    console.log(`${ticker} ${side} ${lots} лот. (balance=${p.balance})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
