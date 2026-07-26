// ============================================================
// リアルタイムターン制の状態機械（簡素版）。
// 侵攻は即時解決されるため、進軍(march)・解決(resolve)フェーズは存在しない。
// フェーズは lobby → live → over の3つだけ。
// 真実の時刻源は state.turnBoundaryAt（絶対時刻）。tick は毎回
// 「残り = turnBoundaryAt - Date.now()」を差分計算する（累積しない）。
// バックグラウンドタブで setInterval が間引かれても、復帰時に
// visibilitychange で取りこぼしたターン境界を一括消化する。
//
// tftRunTurnBoundary 本体は tft-turn-boundary.js に分離してある（document/window に
// 依存しないため）。このファイルは document 依存のブラウザ専用タイマーループのみを持つ。
// ============================================================

let tftGame = null;    // 現在の GameState
let tftLoopId = null;  // setInterval ハンドル

function tftStartGame(state) {
  tftGame = state;
  if (tftLoopId) clearInterval(tftLoopId);
  tftLoopId = setInterval(tftTick, 250);
  state.phase = TFT_PHASE.LIVE;
  tftRunTurnBoundary(state); // ターン1の経済処理・CPU行動
  tftHandleGameOverIfNeeded(state);
  tftRenderAll(state);
}

function tftStopGame() {
  if (tftLoopId) { clearInterval(tftLoopId); tftLoopId = null; }
}

function tftAdvanceTurn() {
  const state = tftGame;
  if (!state || state.phase !== TFT_PHASE.LIVE) return;
  state.turn++;
  tftRunTurnBoundary(state);
  tftRenderAll(state);
}

// 侵攻・移動等でゲームが決着した場合の後処理（人間の操作直後にも呼ばれる）
function tftHandleGameOverIfNeeded(state) {
  if (state.phase === TFT_PHASE.OVER) {
    tftStopGame();
    tftShowGameOver(state);
    return true;
  }
  return false;
}

function tftTick() {
  const state = tftGame;
  if (!state || state.phase === TFT_PHASE.OVER || state.phase === TFT_PHASE.LOBBY) return;

  const remaining = state.turnBoundaryAt - Date.now();
  tftRenderTimer(remaining, state.phase);

  if (remaining <= 0) {
    tftAdvanceTurn();
    tftHandleGameOverIfNeeded(state);
  }
}

// タブ復帰時: 取りこぼしたターン境界を一括消化（長時間ターン運用の要）
document.addEventListener('visibilitychange', () => {
  const state = tftGame;
  if (document.visibilityState !== 'visible' || !state) return;
  // オンライン対戦ではターン進行はサーバー（Durable Object Alarm）だけの責務。
  // ここでローカルに進めると、CPU行動・収入・オークションを二重に走らせた
  // 「サーバーには存在しない盤面」を表示してしまう（次のポーリングで上書きされるまで嘘を見せる）。
  if (typeof tftOnline !== 'undefined' && tftOnline.active) return;
  let guard = 0;
  while (state.phase === TFT_PHASE.LIVE && Date.now() >= state.turnBoundaryAt && guard++ < 1000) {
    tftAdvanceTurn();
  }
  tftHandleGameOverIfNeeded(state);
});
