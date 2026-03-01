/**
 * Точка входа: запуск Telegram-бота (см. src/bot/index.ts).
 * Загружаем .env из корня проекта, чтобы токены были доступны при любом cwd.
 */
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import './bot/index.js';
