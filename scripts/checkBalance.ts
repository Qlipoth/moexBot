/**
 * Проверка баланса через API (песочница по умолчанию).
 * Запуск: pnpm exec tsx scripts/checkBalance.ts
 */
import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccountBalance } from '../src/core/investClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

async function main(): Promise<void> {
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    console.error('TINKOFF_TOKEN не задан в .env');
    process.exit(1);
  }
  const balance = await getAccountBalance(token);
  if (!balance) {
    console.error('Не удалось получить баланс');
    process.exit(1);
  }
  console.log('accountId:', balance.accountId);
  console.log('rub:', balance.rub);
  console.log('isSandbox:', balance.isSandbox);
  console.log('Остаток:', balance.rub.toLocaleString('ru-RU', { minimumFractionDigits: 2 }), '₽');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
