// Bundles the widget (with marked, DOMPurify, Chart.js and CSS) into one
// self-contained script served by agent-service at /embed.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build, context } from 'esbuild';

const outfile = '../agent-service/public/embed.js';

/** Writes a pre-compressed copy after every build, including watch-mode rebuilds. */
const gzipPlugin = {
  name: 'gzip',
  setup(b) {
    b.onEnd((result) => {
      if (result.errors.length === 0) writeFileSync(`${outfile}.gz`, gzipSync(readFileSync(outfile), { level: 9 }));
    });
  },
};

const options = {
  entryPoints: ['embed.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  loader: { '.css': 'text' },
  legalComments: 'none',
  banner: { js: '/* MF Chat widget | built ' + new Date().toISOString().slice(0, 10) + ' */' },
  outfile,
  logLevel: 'info',
  plugins: [gzipPlugin],
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
