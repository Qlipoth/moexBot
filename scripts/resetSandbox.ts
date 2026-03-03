/**
 * Сброс песочницы: закрыть все счета (и позиции), создать новый с депозитом 100 000 ₽.
 * Запуск: pnpm run sandbox:reset
 */

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { resetSandboxAccount, getAccountBalance } from '../src/core/investClient.js';

const token = process.env.TINKOFF_TOKEN;
if (!token) {
  console.error('TINKOFF_TOKEN не задан в .env');
  process.exit(1);
}

console.log('Сброс песочницы...');
const accountId = await resetSandboxAccount(token);
if (!accountId) {
  console.error('Не удалось сбросить песочницу');
  process.exit(1);
}

const balance = await getAccountBalance(token);
console.log(`Новый счёт: ${accountId}`);
console.log(`Баланс: ${balance?.rub.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽`);
process.exit(0);
