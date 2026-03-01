/**
 * Telegram-бот для moex-bot: start, stop, status, market.
 */

import 'dotenv/config';
import * as http from 'node:http';
import { Bot, Keyboard } from 'grammy';
import dayjs from 'dayjs';
import 'dayjs/locale/ru.js';
import { getFuturesLastPrices } from '../core/investClient.js';
import { tradingState } from '../core/tradingState.js';

dayjs.locale('ru');

/** Тикеры фьючерсов для команды /market */
const MARKET_FUTURES_TICKERS = ['GLDRUBF', 'IMOEXF', 'USDRUBF', 'SBERF', 'GAZPF'];

/** Иконки для тикеров (по смыслу: золото, индекс, валюта, банк, газ) */
const TICKER_ICONS: Record<string, string> = {
  GLDRUBF: '🪙',
  IMOEXF: '📊',
  USDRUBF: '💵',
  SBERF: '🏦',
  GAZPF: '⛽',
};

const requiredEnvVars = ['BOT_TOKEN'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length) {
  console.error('Missing env vars:', missingVars.join(', '));
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN!);

// Health server (опционально для деплоя)
const PORT = Number(process.env.PORT) || 8000;
const healthServer = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/health' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(PORT, () => {
  console.log(`Health check on :${PORT} (GET / or /health)`);
});

// Клавиатура: start, stop, status, market
const mainKeyboard = new Keyboard()
  .text('/start')
  .text('/stop')
  .row()
  .text('/status')
  .text('/market')
  .resized();

const subscribers = new Set<number>();
let stopWatchers: (() => void) | null = null;

async function startWatchersOnce(): Promise<void> {
  if (stopWatchers) {
    console.log('Watchers already running');
    return;
  }
  // TODO: инициализация вотчеров по Tinkoff (свечи, сигналы)
  stopWatchers = () => {
    console.log('Watchers stopped (stub)');
  };
  console.log('Watchers started (stub)');
}

// ——— Команды ———

const welcomeMsg =
  'MOEX Bot\n\n' +
  'Кнопки: Start — подписка и запуск вотчеров, Stop — остановка, Status — состояние, Market — сводка по рынку.';

bot.command('start', async (ctx) => {
  subscribers.add(ctx.chat.id);
  tradingState.enable();
  await startWatchersOnce();
  console.log(`Subscribed chat ${ctx.chat.id}`);
  await ctx.reply(welcomeMsg, {
    reply_markup: mainKeyboard,
  });
});

bot.command('stop', async (ctx) => {
  subscribers.delete(ctx.chat.id);
  tradingState.disable();
  if (stopWatchers) {
    stopWatchers();
    stopWatchers = null;
  }
  console.log(`Stopped by chat ${ctx.chat.id}`);
  await ctx.reply('Бот остановлен.\n• Торговля выключена\n• Вотчеры остановлены', {
    reply_markup: mainKeyboard,
  });
});

bot.command('status', async (ctx) => {
  const enabled = tradingState.isEnabled();
  const closeOnly = tradingState.isCloseOnlyMode();
  const status =
    `Подписчиков: ${subscribers.size}\n` +
    `Торговля: ${enabled ? 'вкл' : 'выкл'}\n` +
    (closeOnly ? 'Режим «только закрытие»: да\n' : '');
  await ctx.reply(status || 'Нет данных.', { reply_markup: mainKeyboard });
});

bot.command('market', async (ctx) => {
  const loadingMsg = await ctx.reply('Загрузка данных рынка...');
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    await bot.api.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      'Рынок: не задан TINKOFF_TOKEN. Проверьте, что в .env в корне проекта есть строка: TINKOFF_TOKEN=ваш_токен'
    );
    return;
  }
  try {
    const prices = await getFuturesLastPrices(token, MARKET_FUTURES_TICKERS);
    if (prices.length === 0) {
      await bot.api.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        'Рынок: не удалось получить данные по фьючерсам.'
      );
      return;
    }
    const lines = prices.map((p) => {
      const icon = TICKER_ICONS[p.ticker] ?? '📈';
      const timeStr = p.time ? dayjs(p.time).format('DD.MM.YYYY') : '';
      const rublesStr = p.priceRubles != null ? ` | ${p.priceRubles.toFixed(2)} ₽` : '';
      let changeStr = '';
      if (p.previousClose != null && p.previousClose > 0) {
        // Считаем от округлённых до 2 знаков цен (как на экране), чтобы совпадать с брокерскими приложениями
        const lastR = Math.round(p.lastPrice * 100) / 100;
        const prevR = Math.round(p.previousClose * 100) / 100;
        const change = lastR - prevR;
        const changePercent = (change / prevR) * 100;
        const emoji = change >= 0 ? '📈' : '📉';
        const sign = change >= 0 ? '+' : '−';
        const absChange = Math.abs(change);
        const absPercent = Math.abs(changePercent);
        changeStr = ` <b>${emoji} ${sign}${absChange.toFixed(2)} (${sign}${absPercent.toFixed(2)}%)</b>`;
      }
      return `${icon} ${p.ticker}: ${p.lastPrice.toFixed(2)} п.${rublesStr}${changeStr}${timeStr ? ` (${timeStr})` : ''}`;
    });
    const text = 'Фьючерсы (последняя цена, изменение за день)\n\n' + lines.join('\n\n');
    await bot.api.editMessageText(ctx.chat.id, loadingMsg.message_id, text, {
      parse_mode: 'HTML',
    });
  } catch (err) {
    console.error('Market error:', err);
    await bot.api.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      `Рынок: ошибка запроса — ${err instanceof Error ? err.message : String(err)}`
    );
  }
});

// Любое сообщение — подсказка по кнопкам
bot.on('message:text', async (ctx) => {
  await ctx.reply('Используйте кнопки ниже.', { reply_markup: mainKeyboard });
});

bot.catch((err) => console.error('Bot error:', err));

// Shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`Shutdown (${signal})`);
  if (stopWatchers) {
    stopWatchers();
    stopWatchers = null;
  }
  healthServer.close();
  await bot.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT').catch(console.error));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(console.error));

console.log('Starting bot...');
bot.start({
  onStart: (info) => {
    console.log(`Bot @${info.username} is running`);
  },
});
