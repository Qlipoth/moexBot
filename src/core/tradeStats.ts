/**
 * Статистика закрытых сделок. Запись в JSONL (C:\tmp\moex-trades.jsonl).
 */

import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const tempDir = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
const TRADES_FILE = path.join(tempDir, 'moex-trades.jsonl');

export interface ClosedTradeRecord {
  ticker: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  lots: number;
  pnlRub: number;
  reason: string;
  closedAt: number;
}

export interface TradeStatsResult {
  trades: number;
  wins: number;
  losses: number;
  pnlTotalRub: number;
  pnlWinRub: number;
  pnlLossRub: number;
  byTicker: Array<{ ticker: string; trades: number; pnlTotalRub: number }>;
}

/**
 * Записать закрытую сделку в файл.
 */
export function recordClosedTrade(record: ClosedTradeRecord): void {
  try {
    mkdirSync(path.dirname(TRADES_FILE), { recursive: true });
    const line = JSON.stringify(record) + '\n';
    appendFileSync(TRADES_FILE, line, 'utf-8');
  } catch (e) {
    console.error('[TRADE_STATS] Ошибка записи:', e);
  }
}

/**
 * Получить агрегированную статистику за период.
 */
export function getTradeStats(startTime: number, endTime: number): TradeStatsResult {
  const result: TradeStatsResult = {
    trades: 0,
    wins: 0,
    losses: 0,
    pnlTotalRub: 0,
    pnlWinRub: 0,
    pnlLossRub: 0,
    byTicker: [],
  };

  for (const [ticker, stats] of getByTicker(startTime, endTime)) {
    result.trades += stats.trades;
    result.wins += stats.wins;
    result.losses += stats.losses;
    result.pnlTotalRub += stats.pnlTotalRub;
    result.pnlWinRub += stats.pnlWinRub;
    result.pnlLossRub += stats.pnlLossRub;
    result.byTicker.push({ ticker, trades: stats.trades, pnlTotalRub: stats.pnlTotalRub });
  }

  result.byTicker.sort((a, b) => Math.abs(b.pnlTotalRub) - Math.abs(a.pnlTotalRub));
  return result;
}

function getByTicker(
  startTime: number,
  endTime: number
): Map<string, { trades: number; wins: number; losses: number; pnlTotalRub: number; pnlWinRub: number; pnlLossRub: number }> {
  const byTicker = new Map<
    string,
    { trades: number; wins: number; losses: number; pnlTotalRub: number; pnlWinRub: number; pnlLossRub: number }
  >();

  try {
    const raw = readFileSync(TRADES_FILE, 'utf-8').trim();
    if (!raw) return byTicker;

    for (const line of raw.split('\n')) {
      const r: ClosedTradeRecord = JSON.parse(line);
      if (r.closedAt < startTime || r.closedAt > endTime) continue;

      const t = byTicker.get(r.ticker) ?? {
        trades: 0,
        wins: 0,
        losses: 0,
        pnlTotalRub: 0,
        pnlWinRub: 0,
        pnlLossRub: 0,
      };
      t.trades += 1;
      t.pnlTotalRub += r.pnlRub;
      if (r.pnlRub > 0) {
        t.wins += 1;
        t.pnlWinRub += r.pnlRub;
      } else if (r.pnlRub < 0) {
        t.losses += 1;
        t.pnlLossRub += r.pnlRub;
      }
      byTicker.set(r.ticker, t);
    }
  } catch {
    // Файл не существует или повреждён
  }

  return byTicker;
}
