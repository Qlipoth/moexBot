/**
 * Telegram-бот для moex-bot: start, stop, status, market.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile, Keyboard } from 'grammy';
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
import {
  TinkoffTradeManager,
  getMoexPositionsFilePath,
  parseTradePositionsJsonl,
} from '../market/tinkoffTradeManager.js';

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
] as const;

/**
 * Тикеры только для UI: маппинг instrument_uid → тикер и цены (список позиций, закрытие).
 * Не участвуют в watcher — чтобы можно было закрыть позицию с биржи по тикеру, даже если бот её не торгует.
 */
const POSITION_UI_EXTRA_TICKERS = ['EURRUBF'] as const;

function tickersForPositionUi(): readonly string[] {
  return [...MARKET_FUTURES_TICKERS, ...POSITION_UI_EXTRA_TICKERS];
}

/** Иконки для тикеров */
const TICKER_ICONS: Record<string, string> = {
  CNYRUBF: '🇨🇳',
  USDRUBF: '💵',
  RGBIF: '📜',
  GLDRUBF: '🪙',
  IMOEXF: '📊',
  SBERF: '🏦',
  GAZPF: '⛽',
  EURRUBF: '🇪🇺',
};

const requiredEnvVars = ['BOT_TOKEN'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length) {
  console.error('Missing env vars:', missingVars.join(', '));
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN!);
const tempDir = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
const BOT_RUNTIME_FILE =
  process.env.MOEX_RUNTIME_FILE ?? path.join(tempDir, 'moex-bot-runtime.json');
const BOT_DISABLE_LOG_FILE =
  process.env.MOEX_DISABLE_LOG_FILE ?? path.join(tempDir, 'moex-bot-disable-events.jsonl');
const sessionId = randomUUID();

type BotDisableReason =
  | 'manual_stop'
  | 'signal'
  | 'uncaught_exception'
  | 'unhandled_rejection'
  | 'unexpected_restart_detected';

interface DisableEvent {
  at: number;
  reason: BotDisableReason;
  graceful: boolean;
  details?: string;
  sessionId: string;
}

interface RuntimeState {
  subscribers: number[];
  sessionActive: boolean;
  tradingEnabled: boolean;
  closeOnlyMode: boolean;
  lastSessionId?: string;
  lastStartedAt?: number;
  lastDisableEvent?: DisableEvent;
}

function getDefaultRuntimeState(): RuntimeState {
  return {
    subscribers: [],
    sessionActive: false,
    tradingEnabled: false,
    closeOnlyMode: false,
  };
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function readRuntimeState(): RuntimeState {
  try {
    const raw = readFileSync(BOT_RUNTIME_FILE, 'utf-8').trim();
    if (!raw) return getDefaultRuntimeState();
    const parsed = JSON.parse(raw) as Partial<RuntimeState>;
    return {
      ...getDefaultRuntimeState(),
      ...parsed,
      subscribers: Array.isArray(parsed.subscribers)
        ? parsed.subscribers.filter((value): value is number => Number.isInteger(value))
        : [],
    };
  } catch {
    return getDefaultRuntimeState();
  }
}

function writeRuntimeState(state: RuntimeState): void {
  try {
    ensureParentDir(BOT_RUNTIME_FILE);
    writeFileSync(BOT_RUNTIME_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('[BOT] Ошибка сохранения runtime-state:', error);
  }
}

function parseChatIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[,\s;]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

function buildDisableMessage(event: DisableEvent): string {
  const lines = [
    '⚠️ <b>Бот выключился</b>',
    `Время: ${dayjs(event.at).format('DD.MM.YYYY HH:mm:ss')}`,
    `Причина: <code>${escapeHtml(event.reason)}</code>`,
  ];
  if (event.details) {
    lines.push(`Детали:\n<pre>${escapeHtml(truncateText(event.details, 1500))}</pre>`);
  }
  return lines.join('\n');
}

function appendDisableEvent(event: DisableEvent): void {
  try {
    ensureParentDir(BOT_DISABLE_LOG_FILE);
    appendFileSync(BOT_DISABLE_LOG_FILE, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch (error) {
    console.error('[BOT] Ошибка записи disable-лога:', error);
  }
  console.error('[BOT DISABLE EVENT]', event);
}

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
  .text('Принуд. синхронизация')
  .row()
  .text('Экспорт файла позиций')
  .text('Импорт файла позиций')
  .row()
  .text('Статистика')
  .resized();

let runtimeState = readRuntimeState();
const previousSessionWasActive = runtimeState.sessionActive;
const previousSessionId = runtimeState.lastSessionId;
const previousSessionStartedAt = runtimeState.lastStartedAt;
const alertChatIdsFromEnv = parseChatIds(process.env.BOT_ALERT_CHAT_IDS);
const subscribers = new Set<number>(runtimeState.subscribers);
let stopWatchers: (() => void) | null = null;
let tradeExecutor: TinkoffTradeManager | null = null;
let shutdownInProgress = false;

const POSITIONS_FILE_IMPORT_WAIT_MS = 5 * 60_000;
/** chatId → срок ожидания документа для импорта файла позиций */
const pendingPositionsFileImportUntil = new Map<number, number>();

function clearStalePendingPositionImports(): void {
  const now = Date.now();
  for (const [id, until] of pendingPositionsFileImportUntil) {
    if (until < now) pendingPositionsFileImportUntil.delete(id);
  }
}

function persistRuntimeState(overrides: Partial<RuntimeState> = {}): void {
  runtimeState = {
    ...runtimeState,
    ...overrides,
    subscribers: overrides.subscribers ?? Array.from(subscribers),
    tradingEnabled: overrides.tradingEnabled ?? tradingState.isEnabled(),
    closeOnlyMode: overrides.closeOnlyMode ?? tradingState.isCloseOnlyMode(),
  };
  writeRuntimeState(runtimeState);
}

function getNotificationChatIds(): number[] {
  return Array.from(
    new Set<number>([
      ...runtimeState.subscribers,
      ...Array.from(subscribers),
      ...alertChatIdsFromEnv,
    ])
  );
}

async function notifyDisableEvent(event: DisableEvent, extraChatIds: number[] = []): Promise<void> {
  const chatIds = Array.from(new Set<number>([...getNotificationChatIds(), ...extraChatIds]));
  if (chatIds.length === 0) {
    console.warn('[BOT] Нет chatId для уведомления об отключении');
    return;
  }
  const message = buildDisableMessage(event);
  for (const chatId of chatIds) {
    try {
      await bot.api.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
      console.error(`[BOT] Не удалось отправить disable-уведомление в ${chatId}:`, error);
    }
  }
}

function stopWatchersIfRunning(): void {
  if (stopWatchers) {
    stopWatchers();
    stopWatchers = null;
  }
}

async function recordDisableEvent(
  reason: BotDisableReason,
  details: string,
  graceful: boolean,
  extraChatIds: number[] = []
): Promise<DisableEvent> {
  tradingState.disable();
  const event: DisableEvent = {
    at: Date.now(),
    reason,
    graceful,
    details,
    sessionId,
  };
  appendDisableEvent(event);
  persistRuntimeState({
    sessionActive: false,
    tradingEnabled: false,
    closeOnlyMode: false,
    lastDisableEvent: event,
  });
  await notifyDisableEvent(event, extraChatIds);
  return event;
}

/** Сверка файла позиций с биржей: убирает записи без открытого контракта. */
async function runPositionsFileSyncWithExchange(): Promise<string[]> {
  const token = process.env.TINKOFF_TOKEN;
  if (!token) return [];
  const balance = await getAccountBalance(token);
  if (!balance) return [];
  if (!tradeExecutor) {
    tradeExecutor = new TinkoffTradeManager();
  } else {
    tradeExecutor.reloadFromDisk();
  }
  return tradeExecutor.syncPositionsFileWithExchange(token, balance.accountId);
}

async function notifyUnexpectedPreviousShutdown(): Promise<void> {
  if (!previousSessionWasActive) return;
  const previousStart =
    previousSessionStartedAt != null
      ? dayjs(previousSessionStartedAt).format('DD.MM.YYYY HH:mm:ss')
      : 'неизвестно';
  const event: DisableEvent = {
    at: Date.now(),
    reason: 'unexpected_restart_detected',
    graceful: false,
    details:
      `Предыдущая сессия завершилась без штатного shutdown.` +
      ` Последний старт: ${previousStart}.` +
      (previousSessionId ? ` sessionId=${previousSessionId}` : ''),
    sessionId: previousSessionId ?? 'unknown',
  };
  appendDisableEvent(event);
  persistRuntimeState({ lastDisableEvent: event });
  await notifyDisableEvent(event);
}

persistRuntimeState({
  sessionActive: true,
  tradingEnabled: false,
  closeOnlyMode: false,
  lastSessionId: sessionId,
  lastStartedAt: Date.now(),
});

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

  // Переиспользуем менеджер, если он уже создан (например, по запросу «Открытые позиции» до нажатия «Старт»)
  if (!tradeExecutor) {
    tradeExecutor = new TinkoffTradeManager();
  }
  const balanceProvider = async (): Promise<number> => {
    const b = await getAccountBalance(token);
    return b?.rub ?? 0;
  };

  stopWatchers = startAllWatchers([...MARKET_FUTURES_TICKERS], {
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
  'Кнопки: Старт, Стоп, Статус, Рынок, Баланс, Мои заявки, Открытые позиции, Закрыть позицию, Принуд. синхронизация, экспорт/импорт файла позиций (JSONL), Статистика.';

async function handleStart(ctx: any): Promise<void> {
  subscribers.add(ctx.chat.id);
  tradingState.enable();
  persistRuntimeState({
    sessionActive: true,
    tradingEnabled: true,
    closeOnlyMode: false,
  });
  await startWatchersOnce();
  console.log(`Subscribed chat ${ctx.chat.id}`);
  await ctx.reply(welcomeMsg, { reply_markup: mainKeyboard });
}

async function handleStop(ctx: any): Promise<void> {
  subscribers.delete(ctx.chat.id);
  persistRuntimeState();
  stopWatchersIfRunning();
  await recordDisableEvent('manual_stop', `Команда Стоп от chat ${ctx.chat.id}`, true, [ctx.chat.id]);
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
    const prices = await getFuturesLastPrices(token, [...MARKET_FUTURES_TICKERS]);
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
    for (const ticker of tickersForPositionUi()) {
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

    // Менеджер создаётся при «Старт» или по первому запросу позиций — иначе данные из файла не подтягиваются
    if (!tradeExecutor) {
      tradeExecutor = new TinkoffTradeManager();
    }
    tradeExecutor.reloadFromDisk();
    const botPositions = tradeExecutor.getAllPositions();

    // Позиции с биржи (фьючерсы с ненулевым балансом)
    const exchangePositions = await getFuturesPositions(token, balance.accountId);

    // Маппинг uid → ticker + данные инструмента
    const uidToTicker: Record<string, string> = {};
    const uidToInstrument: Record<string, { minPriceIncrement: number; minPriceIncrementAmount: number }> = {};
    for (const ticker of tickersForPositionUi()) {
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

    const lastPrices = await getFuturesLastPrices(token, [...tickersForPositionUi()]);
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
    for (const ticker of tickersForPositionUi()) {
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

  // Файл позиций ↔ биржа: убрать «призраки» (запись в файле без открытого контракта)
  if (text === 'Принуд. синхронизация') {
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
    const removed = await runPositionsFileSyncWithExchange();
    if (removed.length === 0) {
      await ctx.reply(
        'Синхронизация: все записи в файле позиций соответствуют открытым контрактам на бирже (лишних нет).',
        { reply_markup: mainKeyboard }
      );
    } else {
      await ctx.reply(
        `Синхронизация: из файла удалены тикеры без открытой позиции на бирже:\n${removed.map((t) => `• ${t}`).join('\n')}`,
        { reply_markup: mainKeyboard }
      );
    }
    return;
  }

  if (text === 'Экспорт файла позиций') {
    if (!subscribers.has(ctx.chat.id)) {
      await ctx.reply('Сначала нажмите «Старт».', { reply_markup: mainKeyboard });
      return;
    }
    const filePath = getMoexPositionsFilePath();
    let buf: Buffer;
    try {
      buf = readFileSync(filePath);
    } catch (e) {
      const code =
        e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : '';
      if (code === 'ENOENT') {
        await ctx.reply(
          `Файл позиций на сервере ещё не создан:\n\`${filePath}\``,
          { reply_markup: mainKeyboard, parse_mode: 'Markdown' }
        );
        return;
      }
      await ctx.reply(
        `Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`,
        { reply_markup: mainKeyboard }
      );
      return;
    }
    await ctx.replyWithDocument(new InputFile(buf, 'moex-positions.jsonl'), {
      caption: `moex-positions.jsonl\n${filePath}`,
      reply_markup: mainKeyboard,
    });
    return;
  }

  if (text === 'Импорт файла позиций') {
    if (!subscribers.has(ctx.chat.id)) {
      await ctx.reply('Сначала нажмите «Старт».', { reply_markup: mainKeyboard });
      return;
    }
    clearStalePendingPositionImports();
    pendingPositionsFileImportUntil.set(ctx.chat.id, Date.now() + POSITIONS_FILE_IMPORT_WAIT_MS);
    await ctx.reply(
      'Пришлите **документ** с файлом в формате JSONL (как при экспорте): одна строка — один JSON позиции.\n\n' +
        'Текущий файл позиций на сервере будет **полностью заменён** содержимым файла.\n\n' +
        'Ожидание файла: 5 минут.',
      { reply_markup: mainKeyboard, parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.reply('Используйте кнопки ниже.', { reply_markup: mainKeyboard });
});

bot.on('message:document', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  if (!subscribers.has(chatId)) return;

  clearStalePendingPositionImports();
  const until = pendingPositionsFileImportUntil.get(chatId);
  if (until == null || Date.now() > until) return;

  const doc = ctx.message.document;
  if (!doc) return;

  pendingPositionsFileImportUntil.delete(chatId);

  if (doc.file_size != null && doc.file_size > 1_048_576) {
    await ctx.reply('Файл слишком большой (максимум 1 МБ).', { reply_markup: mainKeyboard });
    return;
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    await ctx.reply('BOT_TOKEN не задан.', { reply_markup: mainKeyboard });
    return;
  }

  try {
    const file = await ctx.getFile();
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply('Не удалось получить путь к файлу в Telegram.', { reply_markup: mainKeyboard });
      return;
    }
    const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      await ctx.reply(`Не удалось скачать файл: HTTP ${res.status}`, { reply_markup: mainKeyboard });
      return;
    }
    const bodyText = await res.text();
    const parsed = parseTradePositionsJsonl(bodyText);
    if (!parsed.ok) {
      await ctx.reply(`Импорт отклонён: ${parsed.error}`, { reply_markup: mainKeyboard });
      return;
    }
    if (!tradeExecutor) tradeExecutor = new TinkoffTradeManager();
    tradeExecutor.replaceAllPositionsFromImport(parsed.positions);
    await ctx.reply(
      `Импорт выполнен. Записей в файле позиций: ${parsed.positions.length}.`,
      { reply_markup: mainKeyboard }
    );
  } catch (e) {
    console.error('[BOT] Импорт файла позиций:', e);
    await ctx.reply(
      `Ошибка импорта: ${e instanceof Error ? e.message : String(e)}`,
      { reply_markup: mainKeyboard }
    );
  }
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
  for (const ticker of tickersForPositionUi()) {
    const info = await getFutureInstrument(token, ticker);
    if (info) uidToTicker[info.uid] = ticker;
  }
  const ticker = uidToTicker[instrumentUid];
  if (!tradeExecutor) tradeExecutor = new TinkoffTradeManager();
  const pos = ticker && tradeExecutor.hasPosition(ticker) ? tradeExecutor.getPosition(ticker) : undefined;

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
    const priceInfo = (await getFuturesLastPrices(token, [...tickersForPositionUi()])).find(
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
    const lastPrices = await getFuturesLastPrices(token, [...tickersForPositionUi()]);
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

async function stopInfrastructure(): Promise<void> {
  stopWatchersIfRunning();
  healthServer.close();
  try {
    await bot.stop();
  } catch (error) {
    console.error('[BOT] Ошибка при остановке bot.stop():', error);
  }
}

async function shutdownWithEvent(
  exitCode: number,
  reason: BotDisableReason,
  details: string,
  graceful: boolean
): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  try {
    await recordDisableEvent(reason, details, graceful);
  } catch (error) {
    console.error('[BOT] Не удалось зафиксировать disable-событие:', error);
  }
  await stopInfrastructure();
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void shutdownWithEvent(0, 'signal', 'Получен сигнал SIGINT', true);
});
process.on('SIGTERM', () => {
  void shutdownWithEvent(0, 'signal', 'Получен сигнал SIGTERM', true);
});
process.on('uncaughtException', (error) => {
  void shutdownWithEvent(1, 'uncaught_exception', formatUnknownError(error), false);
});
process.on('unhandledRejection', (reason) => {
  void shutdownWithEvent(1, 'unhandled_rejection', formatUnknownError(reason), false);
});

console.log('Starting bot...');
bot.start({
  onStart: async (info) => {
    console.log(`Bot @${info.username} is running`);
    await notifyUnexpectedPreviousShutdown();
    try {
      const removed = await runPositionsFileSyncWithExchange();
      if (removed.length > 0) {
        console.log('[BOT] Старт: синхронизация файла позиций с биржей, удалено:', removed.join(', '));
      }
    } catch (e) {
      console.error('[BOT] Старт: не удалось синхронизировать файл позиций с биржей:', e);
    }
  },
});
