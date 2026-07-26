// ============================================================
// TFTオンライン対戦のAPIクライアント。
//
// 方針: レンダリング・演出コード（tft-ui.js / tft-battle-view.js）は1行も変えない。
// 既存の14個のアクション関数（tftHireUnit等）を、このファイルが後勝ちでモンキーパッチし、
// 「ローカルstateを直接書き換える同期関数」から「サーバーへAPIを叩いて結果を反映する非同期関数」に
// 差し替える。呼び出し元（tft-ui.js）は async/await を追加するだけで動く
// （非モジュールのグローバルスクリプトなので window.tftHireUnit = ... で上書きできる）。
//
// オンラインモードでは tft-turn.js のローカルタイマー（setInterval + tftRunTurnBoundary）は
// 一切使わない。ターン進行はサーバー側のDurable Object Alarmが行い、クライアントは
// ポーリングで最新stateを取得するだけ（tftOnlinePoll）。CPU AI（tft-ai.js）もサーバー側でのみ
// 実行されるため、この差し替えとCPUの内政/軍事ロジックが衝突することはない。
// ============================================================

const TFT_ONLINE_STORAGE_PREFIX = 'tft_online_session_';

// APIの向き先。window.TFT_ONLINE_API_BASE で明示指定できる（テスト用）。
// 未指定時は localhost/127.0.0.1 から開いていればローカルWorker、それ以外（本番Pages配信時）は
// デプロイ済みのWorker本番URLを既定にする（開発⇔本番でファイルを手で書き換える必要をなくすため）。
const TFT_ONLINE_API_BASE_PROD = 'https://tft-online-api.tftactics.workers.dev';
const TFT_ONLINE_API_BASE_LOCAL = 'http://127.0.0.1:8788';

const tftOnline = {
  apiBase: (typeof window !== 'undefined' && window.TFT_ONLINE_API_BASE) ||
    (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? TFT_ONLINE_API_BASE_LOCAL
      : TFT_ONLINE_API_BASE_PROD),
  gameId: null,
  playerId: null,   // D1上のplayers.id（表示用。認証には使わない）
  token: null,
  slotIndex: null,  // = state.players[slotIndex] の自分のid
  roomCode: null,
  pollTimer: null,
  active: false,    // オンラインモードで対戦中かどうか
};

// --- セッションの永続化（ブラウザを閉じても再接続できるように） ---
function tftOnlineSaveSession() {
  if (!tftOnline.gameId) return;
  localStorage.setItem(TFT_ONLINE_STORAGE_PREFIX + tftOnline.gameId, JSON.stringify({
    gameId: tftOnline.gameId, playerId: tftOnline.playerId, token: tftOnline.token,
    slotIndex: tftOnline.slotIndex, roomCode: tftOnline.roomCode,
  }));
}

function tftOnlineLoadSession(gameId) {
  const raw = localStorage.getItem(TFT_ONLINE_STORAGE_PREFIX + gameId);
  return raw ? JSON.parse(raw) : null;
}

// --- 低水準API呼び出し ---
async function tftOnlineFetch(path, options = {}) {
  const res = await fetch(tftOnline.apiBase + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(tftOnline.token ? { Authorization: `Bearer ${tftOnline.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({ ok: false, reason: 'サーバーの応答を解釈できませんでした' }));
  return { httpOk: res.ok, ...data };
}

async function tftOnlineCallApi(type, args) {
  const res = await tftOnlineFetch(`/api/games/${tftOnline.gameId}/actions/${type}`, {
    method: 'POST',
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) return { result: { ok: false, reason: res.reason || '通信に失敗しました' }, state: null };
  return { result: res.result, state: res.state };
}

// state全体を新オブジェクトで置き換えるのではなく in-place で更新する。
// tft-ui.js 側は既存のstate参照を保持し続けるので、参照を差し替えず中身だけ入れ替える必要がある。
function tftReplaceStateInPlace(target, src) {
  if (!src) return;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, src);
}

// --- ルーム作成・参加・開始 ---

async function tftOnlineCreateRoom(hostDisplayName, turnPresetId) {
  const res = await tftOnlineFetch('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ hostDisplayName, turnPresetId }),
  });
  if (!res.ok) return { ok: false, reason: res.reason || 'ルーム作成に失敗しました' };
  tftOnline.gameId = res.gameId; tftOnline.playerId = res.playerId; tftOnline.token = res.token;
  tftOnline.slotIndex = res.slotIndex; tftOnline.roomCode = res.roomCode;
  tftOnlineSaveSession();
  return { ok: true, roomCode: res.roomCode };
}

async function tftOnlineJoinRoom(roomCode, displayName) {
  const res = await tftOnlineFetch(`/api/rooms/${roomCode}/join`, {
    method: 'POST',
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) return { ok: false, reason: res.reason || '参加に失敗しました' };
  tftOnline.gameId = res.gameId; tftOnline.playerId = res.playerId; tftOnline.token = res.token;
  tftOnline.slotIndex = res.slotIndex; tftOnline.roomCode = res.roomCode;
  tftOnlineSaveSession();
  return { ok: true };
}

async function tftOnlineGetRoomInfo(roomCode) {
  const res = await tftOnlineFetch(`/api/rooms/${roomCode}`);
  if (!res.ok) return { ok: false, reason: res.reason || 'ルームが見つかりません' };
  return { ok: true, ...res };
}

async function tftOnlineStartGame() {
  const res = await tftOnlineFetch(`/api/games/${tftOnline.gameId}/start`, { method: 'POST' });
  if (!res.ok) return { ok: false, reason: res.reason || '開始に失敗しました' };
  return { ok: true, state: res.state };
}

// 既存セッション（localStorage）から再接続する。ブラウザリロード・再訪問向け。
async function tftOnlineResumeSession(gameId) {
  const saved = tftOnlineLoadSession(gameId);
  if (!saved) return { ok: false, reason: 'セッション情報が見つかりません' };
  tftOnline.gameId = saved.gameId; tftOnline.playerId = saved.playerId; tftOnline.token = saved.token;
  tftOnline.slotIndex = saved.slotIndex; tftOnline.roomCode = saved.roomCode;
  const res = await tftOnlineFetch(`/api/games/${tftOnline.gameId}/state`);
  if (!res.ok) return { ok: false, reason: res.reason || '再接続に失敗しました' };
  return { ok: true, state: res.state };
}

// --- ゲーム画面への突入・ポーリング ---

// state（ゲーム開始直後のstate、または再接続時に取得したstate）を受け取り、ゲーム画面に入る。
// tftStartGame（tft-turn.js、ローカルタイマー版）は使わない――サーバー側のAlarmがターンを進める。
function tftOnlineEnterGame(state) {
  tftOnline.active = true;
  tftUi.myPlayerId = tftOnline.slotIndex;
  tftGame = state;
  tftShowScreen('tft-screen-game');
  tftRenderAll(state);
  tftOnlineStartPolling();
}

function tftOnlineStartPolling() {
  tftOnlineStopPolling();
  const POLL_MS = 30000; // 30秒間隔。タブが非表示の間は間引かれるが、復帰時にvisibilitychangeで即時取得する
  tftOnline.pollTimer = setInterval(tftOnlinePoll, POLL_MS);
  document.addEventListener('visibilitychange', tftOnlineOnVisibilityChange);
}

// タイマーの停止のみを行う（tftOnline.activeには触れない）。
// tftOnlineStartPolling が既存タイマーのクリアのために毎回これを呼ぶため、ここで active を
// falseにしてしまうと「ゲーム開始直後に自分でactiveを取り消す」事故になる。
// activeを本当にfalseへ戻すのは、ゲーム終了・離脱などの明示的な状態遷移の側の責務にする。
function tftOnlineStopPolling() {
  if (tftOnline.pollTimer) { clearInterval(tftOnline.pollTimer); tftOnline.pollTimer = null; }
  document.removeEventListener('visibilitychange', tftOnlineOnVisibilityChange);
}

function tftOnlineOnVisibilityChange() {
  if (document.visibilityState === 'visible') tftOnlinePoll();
}

async function tftOnlinePoll() {
  if (!tftOnline.active || !tftOnline.gameId) return;
  const res = await tftOnlineFetch(`/api/games/${tftOnline.gameId}/state`);
  if (!res.ok || !tftGame) return; // 通信失敗時は次回ポーリングに委ねる（トーストで毎回騒がしくしない）
  const prevTurn = tftGame.turn;
  tftReplaceStateInPlace(tftGame, res.state);
  if (tftGame.turn !== prevTurn) tftToast(`📅 ターン${tftGame.turn}になりました`);
  if (tftGame.phase === 'over') { tftOnlineStopPolling(); tftOnline.active = false; tftShowGameOver(tftGame); return; }
  tftRenderAll(tftGame);
}

// --- 既存14関数のオンライン版への差し替え（モンキーパッチ） ---
// 引数の並び・返り値の形はすべて元関数（tft/js/tft-state.js, tft-battle.js）と同一。
// playerId 引数は無視して常に自分のslotIndexがサーバー側で使われる
// ――なりすまし防止はサーバー側（トークン→slotIndex逆引き）が担うので、ここで送るplayerIdは
//   「どのAPIパスを叩くか」を左右しない飾りに過ぎないが、シグネチャ互換のため受け取っておく。
//
// パッチはこのファイルの読み込み時に**無条件で**当てる。オンラインかどうかは呼ばれた瞬間に
// tftOnline.active で判定し、オフライン（ソロ/CPU戦）なら保存しておいた元関数へそのまま委譲する。
// 「オンライン突入時にだけパッチを当てる」方式にすると当て忘れ・二重当てのリスクが残るため、
// 常に同じ関数を通し、分岐は関数の内側1箇所だけにする。
// この結果すべての呼び出しが Promise を返すので、呼び出し元（tft-ui.js）は
// ソロ/オンラインの区別なく常に await する（await は非Promiseにも安全に使える）。

function tftOnlineWrapAction(fnName, type, argsBuilder) {
  const original = window[fnName];
  if (typeof original !== 'function') {
    console.error(`[tft-online] 差し替え対象 ${fnName} が見つかりません（読み込み順を確認）`);
    return;
  }
  window[fnName] = async function (...callArgs) {
    if (!tftOnline.active) return original.apply(this, callArgs); // ソロ/CPU戦: 従来どおり同期実行
    const state = callArgs[0];
    const { result, state: newState } = await tftOnlineCallApi(type, argsBuilder(...callArgs));
    if (newState) tftReplaceStateInPlace(state, newState);
    return result;
  };
}

function tftOnlineInstallActionPatches() {
  tftOnlineWrapAction('tftHireUnit', 'hireUnit',
    (state, playerId, unitDataId, targetCellIndex) => ({ unitDataId, targetCellIndex }));
  tftOnlineWrapAction('tftDismissUnit', 'dismissUnit',
    (state, playerId, uid, cellIndex) => ({ uid, cellIndex }));
  tftOnlineWrapAction('tftTrainUnit', 'trainUnit',
    (state, playerId, uid, cellIndex) => ({ uid, cellIndex }));
  tftOnlineWrapAction('tftEquipItem', 'equipItem',
    (state, playerId, uid, itemId) => ({ uid, itemId }));
  tftOnlineWrapAction('tftUnequipItem', 'unequipItem',
    (state, playerId, uid) => ({ uid }));
  tftOnlineWrapAction('tftListItemForAuction', 'listItemForAuction',
    (state, playerId, itemIndex) => ({ itemIndex }));
  tftOnlineWrapAction('tftPlaceBid', 'placeBid',
    (state, playerId, lotId, amount) => ({ lotId, amount }));
  tftOnlineWrapAction('tftExplore', 'explore',
    (state, playerId, cellIndex, kind) => ({ cellIndex, kind }));
  tftOnlineWrapAction('tftTradeFood', 'tradeFood',
    (state, playerId, cellIndex, action) => ({ cellIndex, action }));
  tftOnlineWrapAction('tftUpgradeBuilding', 'upgradeBuilding',
    (state, playerId, cellIndex, kind) => ({ cellIndex, kind }));
  tftOnlineWrapAction('tftResearchRank', 'researchRank',
    (state, playerId, lineageId, apCellIndex) => ({ lineageId, apCellIndex }));
  tftOnlineWrapAction('tftResearchScheme', 'researchScheme',
    (state, playerId, apCellIndex) => ({ apCellIndex }));
  tftOnlineWrapAction('tftUseScheme', 'useScheme',
    (state, playerId, schemeId, apCellIndex, targetCellIndex) => ({ schemeId, apCellIndex, targetCellIndex }));

  // tftExecuteRoute だけは特例: 元の関数は内部で tftOnBattleResolved(state, report) を呼び
  // 人間関与時の戦闘モーダルを自動表示するが、サーバー実行ではその副作用が起きないため
  // ここで明示的に呼ぶ（report は action結果の result そのもの＝ tftExecuteRoute の戻り値と同じ形）。
  const originalExecuteRoute = window.tftExecuteRoute;
  window.tftExecuteRoute = async function (state, playerId, path, unitUids) {
    if (!tftOnline.active) return originalExecuteRoute(state, playerId, path, unitUids);
    const { result, state: newState } = await tftOnlineCallApi('executeRoute', { path, unitUids });
    if (newState) tftReplaceStateInPlace(state, newState);
    if (result && result.ok && result.isAttack && result.report) {
      tftOnBattleResolved(state, result.report);
    }
    return result;
  };
}

tftOnlineInstallActionPatches();
