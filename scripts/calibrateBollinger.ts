/**
 * Калибровка порога NARROW CHANNEL по истории 1h за месяц.
 * Запуск: pnpm exec tsx scripts/calibrateBollinger.ts
 * Нужен TINKOFF_TOKEN в .env.
 */

import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTinkoffCandles } from '../src/market/candleLoader.js';
import type { HistoricalCandleInput } from '../src/core/investClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const TICKERS = ['GLDRUBF', 'IMOEXF', 'USDRUBF', 'SBERF', 'GAZPF'];
const BB_PERIOD = 20;
const BB_STD = 2;
const DAYS_BACK = 30;

function sma(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function std(v: number[], m: number): number {
  return Math.sqrt(
    v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(v.length, 1)
  );
}

function bollingerWidthPct(closes: number[]): number {
  if (closes.length < BB_PERIOD) return NaN;
  const sample = closes.slice(-BB_PERIOD);
  const mid = sma(sample);
  const sdVal = std(sample, mid);
  if (mid <= 0) return NaN;
  const upper = mid + sdVal * BB_STD;
  const lower = mid - sdVal * BB_STD;
  return (upper - lower) / mid;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? NaN;
}

async function main(): Promise<void> {
  const token = process.env.TINKOFF_TOKEN;
  if (!token) {
    console.error('TINKOFF_TOKEN не задан в .env');
    process.exit(1);
  }

  const end = Math.floor(Date.now() / 3600000) * 3600000;
  const start = end - DAYS_BACK * 24 * 3600 * 1000;

  console.log('Калибровка Bollinger: ширина канала (upper-lower)/middle, 1h, период', BB_PERIOD);
  console.log('Период данных:', new Date(start).toISOString().slice(0, 10), '—', new Date(end).toISOString().slice(0, 10));
  console.log('');

  const allWidths: number[] = [];
  const byTicker: Record<string, number[]> = {};

  for (const ticker of TICKERS) {
    const candles: HistoricalCandleInput[] = await fetchTinkoffCandles(
      token,
      ticker,
      start,
      end,
      '1h'
    );
    if (candles.length < BB_PERIOD) {
      console.log(`${ticker}: недостаточно свечей (${candles.length}), пропуск`);
      continue;
    }
    const closes = candles.map((c) => c.close);
    const widths: number[] = [];
    for (let i = BB_PERIOD; i <= closes.length; i++) {
      const w = bollingerWidthPct(closes.slice(0, i));
      if (Number.isFinite(w)) {
        widths.push(w);
        allWidths.push(w);
      }
    }
    byTicker[ticker] = widths;
  }

  const fmt = (x: number) => (x * 100).toFixed(3) + '%';
  const fmtPct = (p: number, arr: number[]) => fmt(percentile(arr, p));

  /** Порог NARROW CHANNEL по тикеру: p10 (нижние 10% ширины канала по истории). */
  const p10ByTicker: Record<string, number> = {};

  console.log('--- По тикерам ---');
  for (const ticker of TICKERS) {
    const w = byTicker[ticker];
    if (!w || w.length === 0) continue;
    const sorted = [...w].sort((a, b) => a - b);
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const p10Val = percentile(w, 10);
    p10ByTicker[ticker] = p10Val;
    console.log(
      `${ticker}: n=${w.length} min=${fmt(min)} max=${fmt(max)} avg=${fmt(mean)} p10=${fmtPct(10, w)} p25=${fmtPct(25, w)} p50=${fmtPct(50, w)}`
    );
  }

  console.log('');
  console.log('--- Порог по тикеру (p10) для MIN_BOLLINGER_WIDTH_BY_TICKER ---');
  console.log(JSON.stringify(p10ByTicker, null, 2));

  if (allWidths.length > 0) {
    const sorted = [...allWidths].sort((a, b) => a - b);
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;
    const mean = allWidths.reduce((a, b) => a + b, 0) / allWidths.length;
    console.log('');
    console.log('--- Сводка по всем тикерам ---');
    console.log(`min=${fmt(min)} max=${fmt(max)} avg=${fmt(mean)}`);
    console.log(`p5=${fmtPct(5, allWidths)} p10=${fmtPct(10, allWidths)} p25=${fmtPct(25, allWidths)} p50=${fmtPct(50, allWidths)}`);
    console.log('');
    const p10 = percentile(sorted, 10);
    const p25 = percentile(sorted, 25);
    console.log('Рекомендация: в стратегии используется MIN_BOLLINGER_WIDTH_BY_TICKER (p10 по каждому тикеру).');
    console.log('Перезапустите pnpm run calibrate и обновите константу в adaptiveBollingerStrategy.ts при смене режима рынка.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
