/**
 * Telegram-бот для moex-bot: start, stop, status, market.
 */

import 'dotenv/config';
import * as http from 'node:http';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import dayjs from 'dayjs';
import 'dayjs/locale/ru.js';
import {
  ensureSandboxAccount,
  getAccountBalance,
  getFuturesLastPrices,
  getFuturesPositions,
  getOrders,
  getFutureInstrument,
  postOrder,
  sandboxTopUp,
  computeSandboxTopUpAmount,
} from '../core/investClient.js';
import { tradingState } from '../core/tradingState.js';
import { getTradeStats, recordClosedTrade } from '../core/tradeStats.js';
import { startAllWatchers } from '../market/watcher.js';
import { TinkoffTradeManager } from '../market/tinkoffTradeManager.js';

dayjs.locale('ru');

/** Тикеры фьючерсов для команды /market и watcher (EURRUBF исключён) */
const MARKET_FUTURES_TICKERS = [
  'CNYRUBF',
  'USDRUBF',
  'RGBIF',
  'GLDRUBF',
  'IMOEXF',
  'SBERF',
  'GAZPF',
];

/** Иконки для тикеров */
const TICKER_ICONS: Record<string, string> = {
  CNYRUBF: '🇨🇳',
  USDRUBF: '💵',
  RGBIF: '📜',
  GLDRUBF: '🪙',
  IMOEXF: '📊',
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

const mainKeyboard = new Keyboard()
  .text('Старт')
  .text('Стоп')
  .row()
  .text('Статус')
  .text('Рынок')
  .row()
  .text('Баланс')
  .text('Мои заявки')
  .row()
  .text('Открытые позиции')
  .text('Закрыть позицию')
  .row()
  .text('Статистика')
  .resized();

const subscribers = new Set<number>();
let stopWatchers: (() => void) | null = null;
let tradeExecutor: TinkoffTradeManager | null = null;

async function startWatchersOnce(): Promise<void> {
  if (stopWatchers) {
    console.log('Watchers already running');
    return;
  }
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    console.warn('Watchers: TINKOFF_TOKEN не задан — мониторинг точек входа отключён');
    stopWatchers = () => {};
    return;
  }
  if (process.env.TINKOFF_PRODUCTION !== '1' && process.env.TINKOFF_PRODUCTION !== 'true') {
    const accountId = await ensureSandboxAccount(token);
    if (accountId) {
      console.log('Sandbox: счёт готов, accountId:', accountId);
    }
  }

  tradeExecutor = new TinkoffTradeManager();
  const balanceProvider = async (): Promise<number> => {
    const b = await getAccountBalance(token);
    return b?.rub ?? 0;
  };

  stopWatchers = startAllWatchers(MARKET_FUTURES_TICKERS, {
    token,
    onAlert: async (msg) => {
      for (const chatId of subscribers) {
        try {
          await bot.api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
        } catch (e) {
          console.error(`Watcher alert to ${chatId}:`, e);
        }
      }
    },
    tradeExecutor,
    balanceProvider,
  });
  console.log('Watchers started (Bollinger 1h,', MARKET_FUTURES_TICKERS.length, 'tickers)');
}

// ——— Команды ———

const welcomeMsg =
  'MOEX Bot\n\n' +
  'Кнопки: Старт, Стоп, Статус, Рынок, Баланс, Мои заявки, Открытые позиции, Закрыть позицию, Статистика.';

async function handleStart(ctx: any): Promise<void> {
  subscribers.add(ctx.chat.id);
  tradingState.enable();
  await startWatchersOnce();
  console.log(`Subscribed chat ${ctx.chat.id}`);
  await ctx.reply(welcomeMsg, { reply_markup: mainKeyboard });
}

async function handleStop(ctx: any): Promise<void> {
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
}

async function handleStatus(ctx: any): Promise<void> {
  const enabled = tradingState.isEnabled();
  const closeOnly = tradingState.isCloseOnlyMode();
  const status =
    `Подписчиков: ${subscribers.size}\n` +
    `Торговля: ${enabled ? 'вкл' : 'выкл'}\n` +
    (closeOnly ? 'Режим «только закрытие»: да\n' : '');
  await ctx.reply(status || 'Нет данных.', { reply_markup: mainKeyboard });
}

async function handleMarket(ctx: any): Promise<void> {
  const loadingMsg = await ctx.reply('Загрузка данных рынка...');
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    await bot.api.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      'Рынок: не задан TINKOFF_TOKEN.'
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
        const lastR = Math.round(p.lastPrice * 100) / 100;
        const prevR = Math.round(p.previousClose * 100) / 100;
        const change = lastR - prevR;
        const changePercent = (change / prevR) * 100;
        const emoji = change >= 0 ? '🟢' : '🔴';
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
}

async function handleStats(ctx: any): Promise<void> {
  const start = dayjs().subtract(30, 'day').startOf('day');
  const end = dayjs();
  const stats = getTradeStats(start.valueOf(), end.valueOf());

  const winrate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0;
  const pnlNet = stats.pnlTotalRub;
  const pnlNetSign = pnlNet > 0 ? '+' : '';
  const earned = stats.pnlWinRub;
  const lost = Math.abs(stats.pnlLossRub);

  const symbolsLines =
    stats.byTicker.length > 0
      ? stats.byTicker
          .map((s) => {
            const sign = s.pnlTotalRub > 0 ? '+' : '';
            return `• ${s.ticker}: ${s.trades} сд. | PnL ${sign}${s.pnlTotalRub.toFixed(2)} ₽`;
          })
          .join('\n')
      : '— (нет данных)';

  const hint =
    stats.trades === 0
      ? '\n\n_Сделки записываются при закрытии по SL/TP или вручную (если позиция в памяти бота). Файл: C:\\tmp\\moex-trades.jsonl_'
      : '';

  const msg =
    `📈 *Статистика сделок*\n` +
    `Период: *${start.format('DD.MM.YYYY')} → ${end.format('DD.MM.YYYY')}*\n\n` +
    `Сделок: *${stats.trades}*\n` +
    `Winrate: *${winrate.toFixed(2)}%* (W:${stats.wins} / L:${stats.losses})\n\n` +
    `Заработано: *+${earned.toFixed(2)} ₽*\n` +
    `Убыток: *-${lost.toFixed(2)} ₽*\n` +
    `Итого (Net): *${pnlNetSign}${pnlNet.toFixed(2)} ₽*\n\n` +
    `По тикерам:\n${symbolsLines}${hint}`;

  await ctx.reply(msg, { reply_markup: mainKeyboard, parse_mode: 'Markdown' });
}

bot.command('start', handleStart);
bot.command('stop', handleStop);
bot.command('status', handleStatus);
bot.command('market', handleMarket);
bot.command('stats', handleStats);

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text?.trim();

  if (text === 'Старт') return handleStart(ctx);
  if (text === 'Стоп') return handleStop(ctx);
  if (text === 'Статус') return handleStatus(ctx);
  if (text === 'Рынок') return handleMarket(ctx);
  if (text === 'Статистика') return handleStats(ctx);

  if (text === 'Баланс') {
    const token = process.env.TINKOFF_TOKEN;
    if (!token) {
      await ctx.reply('Остаток: не задан TINKOFF_TOKEN.', { reply_markup: mainKeyboard });
      return;
    }
    const balance = await getAccountBalance(token);
    if (!balance) {
      await ctx.reply('Не удалось получить остаток по счёту.', { reply_markup: mainKeyboard });
      return;
    }
    const label = balance.isSandbox ? ' (тестовый счёт)' : '';
    await ctx.reply(
      `Остаток на счёте${label}: ${balance.rub.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽`,
      { reply_markup: mainKeyboard }
    );
    return;
  }

  // Кнопка «Мои заявки» — активные заявки по счёту
  if (text === 'Мои заявки') {
    const token = process.env.TINKOFF_TOKEN;
    if (!token) {
      await ctx.reply('Заявки: не задан TINKOFF_TOKEN.', { reply_markup: mainKeyboard });
      return;
    }
    const balance = await getAccountBalance(token);
    if (!balance) {
      await ctx.reply('Не удалось получить счёт (нужен для списка заявок).', {
        reply_markup: mainKeyboard,
      });
      return;
    }
    const orders = await getOrders(token, balance.accountId);
    if (orders.length === 0) {
      const label = balance.isSandbox ? ' (тестовый счёт)' : '';
      await ctx.reply(`Активных заявок нет${label}.`, { reply_markup: mainKeyboard });
      return;
    }
    // Подставляем тикер по instrument_uid для известных фьючерсов
    const uidToTicker: Record<string, string> = {};
    for (const ticker of MARKET_FUTURES_TICKERS) {
      const info = await getFutureInstrument(token, ticker);
      if (info) uidToTicker[info.uid] = ticker;
    }
    const statusStr = (s: number) =>
      s === 1 ? 'Исполнена' : s === 4 ? 'Новая' : s === 5 ? 'Частично' : `Статус ${s}`;
    const lines = orders.map((o) => {
      const ticker = uidToTicker[o.instrumentUid] ?? o.instrumentUid.slice(0, 8) + '…';
      const price = o.initialSecurityPrice != null ? ` ${o.initialSecurityPrice.toFixed(2)} п.` : '';
      return `• ${o.direction} ${ticker} — ${o.lotsRequested} л.${price} (${statusStr(o.executionReportStatus)})`;
    });
    const label = balance.isSandbox ? ' (тестовый счёт)' : '';
    await ctx.reply(
      `Активные заявки${label}:\n\n${lines.join('\n')}`,
      { reply_markup: mainKeyboard }
    );
    return;
  }

  // Кнопка «Открытые позиции» — позиции бота + биржа
  if (text === 'Открытые позиции') {
    const token = process.env.TINKOFF_TOKEN;
    if (!token) {
      await ctx.reply('Позиции: не задан TINKOFF_TOKEN.', { reply_markup: mainKeyboard });
      return;
    }
    const balance = await getAccountBalance(token);
    if (!balance) {
      await ctx.reply('Не удалось получить счёт.', { reply_markup: mainKeyboard });
      return;
    }

    // Перезагружаем с диска (на случай закрытия через скрипт или другой процесс)
    tradeExecutor?.reloadFromDisk();
    const botPositions = tradeExecutor?.getAllPositions() ?? [];

    // Позиции с биржи (фьючерсы с ненулевым балансом)
    const exchangePositions = await getFuturesPositions(token, balance.accountId);

    // Маппинг uid → ticker + данные инструмента
    const uidToTicker: Record<string, string> = {};
    const uidToInstrument: Record<string, { minPriceIncrement: number; minPriceIncrementAmount: number }> = {};
    for (const ticker of MARKET_FUTURES_TICKERS) {
      const info = await getFutureInstrument(token, ticker);
      if (info) {
        uidToTicker[info.uid] = ticker;
        uidToInstrument[info.uid] = {
          minPriceIncrement: info.minPriceIncrement,
          minPriceIncrementAmount: info.minPriceIncrementAmount,
        };
      }
    }

    const fmtRub = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 0 });

    const lastPrices = await getFuturesLastPrices(token, MARKET_FUTURES_TICKERS);
    const priceByTicker = new Map(lastPrices.map((p) => [p.ticker, p]));

    const lines: string[] = [];

    // 1. Позиции бота (с диска) — SL/TP в памяти
    for (const pos of botPositions) {
      const sideIcon = pos.side === 'LONG' ? '🟢' : '🔴';
      const currentPrice = priceByTicker.get(pos.ticker)?.lastPrice ?? pos.entryPrice;
      const nominal = pos.minPriceIncrement > 0
        ? (currentPrice / pos.minPriceIncrement) * pos.minPriceIncrementAmount * pos.lots
        : 0;
      const nominalStr = nominal > 0 ? ` | Номинал: ${fmtRub(nominal)} ₽` : '';
      const pct =
        pos.entryPrice > 0
          ? (pos.side === 'LONG'
              ? (currentPrice - pos.entryPrice) / pos.entryPrice
              : (pos.entryPrice - currentPrice) / pos.entryPrice) * 100
          : 0;
      const pctStr = `${pct >= 0 ? '🟢' : '🔴'} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      lines.push(
        `${sideIcon} ${pos.ticker} ${pos.side} — ${pos.lots} лот.${nominalStr} ${pctStr} 📁\n` +
          `   Вход: ${pos.entryPrice.toFixed(2)} | SL: ${pos.stopPrice.toFixed(2)} | TP: ${pos.takePrice.toFixed(2)}`
      );
    }

    // 2. Позиции с биржи (API), которых нет в памяти бота — без % (нет цены входа)
    const botInstrumentIds = new Set(botPositions.map((p) => p.instrumentId));
    for (const ep of exchangePositions) {
      if (botInstrumentIds.has(ep.instrumentUid)) continue;
      const ticker = uidToTicker[ep.instrumentUid] ?? ep.instrumentUid.slice(0, 8) + '…';
      const side = ep.balance > 0 ? 'LONG 🟢' : 'SHORT 🔴';
      const lots = Math.abs(ep.balance);
      const instr = uidToInstrument[ep.instrumentUid];
      const priceInfo = priceByTicker.get(ticker);
      let nominalStr = '';
      if (instr && priceInfo && instr.minPriceIncrement > 0) {
        const nominal = (priceInfo.lastPrice / instr.minPriceIncrement) * instr.minPriceIncrementAmount * lots;
        nominalStr = ` | Номинал: ${fmtRub(nominal)} ₽`;
      }
      lines.push(`${side} ${ticker} — ${lots} лот.${nominalStr} 🌐\n   (биржа, без SL/TP в боте)`);
    }

    const label = balance.isSandbox ? ' (тестовый счёт)' : '';
    const legend = '\n\n📁 = с диска (SL/TP в боте)\n🌐 = с биржи (без SL/TP)';
    if (lines.length === 0) {
      await ctx.reply(`Открытых позиций нет${label}.`, { reply_markup: mainKeyboard });
    } else {
      await ctx.reply(
        `Открытые позиции${label}:${legend}\n\n${lines.join('\n\n')}`,
        { reply_markup: mainKeyboard }
      );
    }
    return;
  }

  // Кнопка «Закрыть позицию» — показать inline-кнопки с открытыми позициями
  if (text === 'Закрыть позицию') {
    const token = process.env.TINKOFF_TOKEN;
    if (!token) {
      await ctx.reply('Не задан TINKOFF_TOKEN.', { reply_markup: mainKeyboard });
      return;
    }
    const balance = await getAccountBalance(token);
    if (!balance) {
      await ctx.reply('Не удалось получить счёт.', { reply_markup: mainKeyboard });
      return;
    }
    const exchangePositions = await getFuturesPositions(token, balance.accountId);
    if (exchangePositions.length === 0) {
      await ctx.reply('Нет открытых позиций для закрытия.', { reply_markup: mainKeyboard });
      return;
    }
    const uidToTicker: Record<string, string> = {};
    for (const ticker of MARKET_FUTURES_TICKERS) {
      const info = await getFutureInstrument(token, ticker);
      if (info) uidToTicker[info.uid] = ticker;
    }
    const kb = new InlineKeyboard();
    for (const ep of exchangePositions) {
      const ticker = uidToTicker[ep.instrumentUid] ?? ep.instrumentUid.slice(0, 8);
      const side = ep.balance > 0 ? 'LONG' : 'SHORT';
      const lots = Math.abs(ep.balance);
      kb.text(
        `Закрыть ${ticker} ${side} (${lots} лот.)`,
        `close_pos:${ep.instrumentUid}:${ep.balance}`
      ).row();
    }
    await ctx.reply('Выберите позицию для закрытия:', { reply_markup: kb });
    return;
  }

  await ctx.reply('Используйте кнопки ниже.', { reply_markup: mainKeyboard });
});

// Callback: закрытие позиции по inline-кнопке
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('close_pos:')) {
    await ctx.answerCallbackQuery();
    return;
  }
  const parts = data.split(':');
  const instrumentUid = parts[1]!;
  const posBalance = Number(parts[2]);
  const lots = Math.abs(posBalance);
  const direction = posBalance > 0 ? 'SELL' : 'BUY'; // обратная заявка

  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    await ctx.answerCallbackQuery({ text: 'Нет TINKOFF_TOKEN' });
    return;
  }
  const balance = await getAccountBalance(token);
  if (!balance) {
    await ctx.answerCallbackQuery({ text: 'Не удалось получить счёт' });
    return;
  }

  const uidToTicker: Record<string, string> = {};
  for (const ticker of MARKET_FUTURES_TICKERS) {
    const info = await getFutureInstrument(token, ticker);
    if (info) uidToTicker[info.uid] = ticker;
  }
  const ticker = uidToTicker[instrumentUid];
  const pos = ticker && tradeExecutor?.hasPosition(ticker) ? tradeExecutor.getPosition(ticker) : undefined;

  const { randomUUID } = await import('node:crypto');
  let result = await postOrder({
    token,
    accountId: balance.accountId,
    instrumentId: instrumentUid,
    quantity: lots,
    direction,
    orderType: 'MARKET',
    orderId: randomUUID(),
  });

  // 30034 = not enough balance (песочница) — пополняем только нехватающую сумму
  if (!result.success && result.message?.includes('30034')) {
    const priceInfo = (await getFuturesLastPrices(token, MARKET_FUTURES_TICKERS)).find(
      (p) => uidToTicker[instrumentUid] === p.ticker
    );
    const instr = ticker ? await getFutureInstrument(token, ticker) : null;
    const price = priceInfo?.lastPrice ?? 0;
    const amount =
      instr && price > 0
        ? await computeSandboxTopUpAmount(
            token,
            balance.accountId,
            instrumentUid,
            lots,
            price,
            instr.minPriceIncrement,
            instr.minPriceIncrementAmount,
            direction
          )
        : 10_000; // fallback если нет данных
    const topped = await sandboxTopUp(token, balance.accountId, amount);
    if (topped) {
      result = await postOrder({
        token,
        accountId: balance.accountId,
        instrumentId: instrumentUid,
        quantity: lots,
        direction,
        orderType: 'MARKET',
        orderId: randomUUID(),
      });
    }
  }

  if (result.success && tradeExecutor && ticker && pos) {
    const lastPrices = await getFuturesLastPrices(token, MARKET_FUTURES_TICKERS);
    const priceInfo = lastPrices.find((p) => p.ticker === ticker);
    const exitPrice = priceInfo?.lastPrice ?? pos.entryPrice;
    const priceDiff = pos.side === 'LONG' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnlRub =
      pos.minPriceIncrement > 0
        ? (priceDiff / pos.minPriceIncrement) * pos.minPriceIncrementAmount * pos.lots
        : 0;
    recordClosedTrade({
      ticker,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      lots: pos.lots,
      pnlRub,
      reason: 'ручное закрытие',
      closedAt: Date.now(),
    });
    tradeExecutor.forceRemovePosition(ticker);
  }

  if (result.success) {
    await ctx.answerCallbackQuery({ text: 'Позиция закрыта' });
    await ctx.editMessageText(`✅ Позиция закрыта (${lots} лот., ${direction})`);
  } else {
    await ctx.answerCallbackQuery({ text: 'Ошибка закрытия' });
    await ctx.editMessageText(`❌ Ошибка: ${result.message ?? 'неизвестная ошибка'}`);
  }
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
