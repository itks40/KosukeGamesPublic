// TFTのゲームロジック（js/data.js, js/synergy.js, js/battle.js, tft/js/tft-*.js）を
// Cloudflare Worker から import できる形に束ねるビルドスクリプト。
//
// 元ファイルは <script src> のグローバルスクリプト（export無し）のままブラウザ側で使い続ける。
// このスクリプトはそれらを「コピー」せず毎回「元ファイルをそのまま連結して export を自動付与」
// するだけなので、ブラウザ側のロジックとWorker側のロジックが将来乖離することは構造的に無い。
//
// 実行: `npm run build:logic`（worker/ ディレクトリで）。生成物は src/generated/game-logic.js
// （.gitignore対象）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(workerRoot, 'logic-manifest.json'), 'utf8'));

// 1. 元ファイルをそのまま連結する（コピーではなく毎回読み直す）
const chunks = manifest.files.map((relPath) => {
  const abs = path.resolve(workerRoot, relPath);
  const src = readFileSync(abs, 'utf8');
  return `// ---- from ${relPath} ----\n${src}`;
});

// 2. トップレベルの `function tftXxx` / `const TFT_XXX` / `let tftXxx` を自動検出する。
//    tft/TFT_ 接頭辞のグローバルのみを対象にする（プロジェクト規約: TFT側の新規グローバルは
//    TFT_/tft 接頭辞必須。それ以外のTFTBSコア由来のグローバルは manifest の extraExports で明示指定する）。
const declRe = /^(?:function|const|let)\s+(tft[A-Za-z0-9_]*|TFT_[A-Za-z0-9_]*)\b/gm;
const autoDetected = new Set();
for (const chunk of chunks) {
  let m;
  while ((m = declRe.exec(chunk))) autoDetected.add(m[1]);
}

const exportNames = new Set([...autoDetected, ...manifest.extraExports]);

// 3. モジュールレベルの可変カウンタ（tftUidCounter/tftAuctionLotCounter, tft-state.js）は
//    非同期PBEMの性質上ほぼ確実にDurable Objectのコールドスタートでリセットされる。
//    永続化済みstateから最大値を復元するヘルパを、カウンタと同じスコープ（＝この連結ファイル内）に
//    直接追記する。ESモジュールのimportは読み取り専用バインディングのため、DO側から
//    `GameLogic.tftUidCounter = N` のように外部代入することはできない――
//    このスコープ内の関数経由でしか書き換えられない、という理由でここに置く。
const rehydrateHelper = `
// ---- (build-game-logic.mjs が追記: DOコールドスタート後のカウンタ復元ヘルパ) ----
function tftRehydrateCounters(game) {
  let maxUid = -1;
  for (const p of game.players) {
    for (const u of p.roster) {
      const m = /^u_p\\d+_(\\d+)$/.exec(u.uid);
      if (m) maxUid = Math.max(maxUid, Number(m[1]));
    }
  }
  tftUidCounter = maxUid + 1;
  const lots = (game.auction && game.auction.lots) || [];
  const maxLot = lots.reduce((m, l) => Math.max(m, l.id), -1);
  tftAuctionLotCounter = maxLot + 1;
}
`;
exportNames.add('tftRehydrateCounters');

const exportBlock = `\nexport { ${[...exportNames].sort().join(', ')} };\n`;

const header = `// ============================================================\n` +
  `// 自動生成ファイル。手で編集しないこと。\n` +
  `// \`npm run build:logic\`（worker/scripts/build-game-logic.mjs）で再生成される。\n` +
  `// 元ファイル: ${manifest.files.join(', ')}\n` +
  `// ============================================================\n`;

const out = header + chunks.join('\n\n') + '\n' + rehydrateHelper + exportBlock;

const outDir = path.join(workerRoot, 'src', 'generated');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'game-logic.js'), out, 'utf8');

console.log(`✓ generated src/generated/game-logic.js (${out.length} bytes, ${exportNames.size} exports)`);
