import { build } from 'esbuild';

build({
  entryPoints: ['src/bot/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/bot.js',
  format: 'esm',
  external: ['grammy', 'dotenv'],
  minify: true,
  sourcemap: true,
  tsconfig: './tsconfig.json',
}).catch(() => process.exit(1));
