// ============================================================
// TFTオンライン対戦のUI（ルーム作成・参加・待機ロビー）。
// #tft-screen-online の中身を丸ごと再構築する方式（tftUi/tftRenderCellPanel と同じパターン）。
// ゲーム開始後は tftOnlineEnterGame（tft-online-client.js）が通常の#tft-screen-gameに合流する。
// ============================================================

const tftOnlineUi = {
  view: 'menu',       // 'menu' | 'create' | 'join' | 'waiting'
  displayName: '',
  roomCodeInput: '',
  busy: false,
  errorText: '',
  waitingInfo: null,  // tftOnlineGetRoomInfo の結果
  waitingTimer: null,
};

function tftOnlineShow() {
  // 同一タブで別セッション（前回作成/参加したルーム）が残っていれば、その待機/ゲーム中ポーリングを
  // 止めてから新しいフローに入る（テスト等で繰り返しcreate/joinする場合の多重ポーリング防止）。
  tftOnlineStopWaitingPoll();
  tftOnlineStopPolling();
  tftOnlineUi.view = 'menu';
  tftOnlineUi.errorText = '';
  tftShowScreen('tft-screen-online');
  tftRenderOnlineScreen();
}

function tftOnlineBackToLobby() {
  tftOnlineStopWaitingPoll();
  tftShowScreen('tft-screen-lobby');
}

function tftOnlineStopWaitingPoll() {
  if (tftOnlineUi.waitingTimer) { clearInterval(tftOnlineUi.waitingTimer); tftOnlineUi.waitingTimer = null; }
}

function tftRenderOnlineScreen() {
  const root = document.getElementById('tft-online-inner');
  if (!root) return;
  root.innerHTML = '';

  const back = document.createElement('button');
  back.className = 'btn';
  back.textContent = '← ロビーへ戻る';
  back.addEventListener('click', tftOnlineBackToLobby);
  root.appendChild(back);

  const title = document.createElement('h1');
  title.className = 'title-logo';
  title.textContent = '🌐 オンライン対戦';
  root.appendChild(title);

  if (tftOnlineUi.errorText) {
    const err = document.createElement('div');
    err.className = 'tft-online-error';
    err.textContent = tftOnlineUi.errorText;
    root.appendChild(err);
  }

  if (tftOnlineUi.view === 'menu') root.appendChild(tftBuildOnlineMenu());
  else if (tftOnlineUi.view === 'create') root.appendChild(tftBuildOnlineCreateForm());
  else if (tftOnlineUi.view === 'join') root.appendChild(tftBuildOnlineJoinForm());
  else if (tftOnlineUi.view === 'waiting') root.appendChild(tftBuildOnlineWaitingRoom());
}

function tftBuildOnlineMenu() {
  const wrap = document.createElement('div');
  wrap.className = 'tft-online-panel';

  const createBtn = document.createElement('button');
  createBtn.className = 'btn btn-primary btn-large';
  createBtn.textContent = '🆕 ルームを作る';
  createBtn.addEventListener('click', () => { tftOnlineUi.view = 'create'; tftOnlineUi.errorText = ''; tftRenderOnlineScreen(); });
  wrap.appendChild(createBtn);

  const joinBtn = document.createElement('button');
  joinBtn.className = 'btn btn-large';
  joinBtn.textContent = '🔑 ルームコードで参加';
  joinBtn.addEventListener('click', () => { tftOnlineUi.view = 'join'; tftOnlineUi.errorText = ''; tftRenderOnlineScreen(); });
  wrap.appendChild(joinBtn);

  const help = document.createElement('p');
  help.className = 'tft-panel-help';
  help.textContent = '友人とプレイバイメール形式で対戦します（1ターン=数時間〜半日。好きなタイミングで開いて手を打ってください）。';
  wrap.appendChild(help);

  return wrap;
}

function tftBuildOnlineCreateForm() {
  const wrap = document.createElement('div');
  wrap.className = 'tft-online-panel';
  wrap.innerHTML = `
    <h2 class="section-title">ルームを作る</h2>
    <label class="tft-online-label">あなたの名前
      <input id="tft-online-name" type="text" maxlength="24" value="${tftOnlineUi.displayName}" placeholder="ホストくん">
    </label>
    <h3 class="section-title">1ターンの長さ</h3>
    <div id="tft-online-turn-length" class="tft-turn-length"></div>
  `;
  const lenEl = wrap.querySelector('#tft-online-turn-length');
  for (const preset of TFT_TURN_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'tft-turn-option' + (tftUi.turnPresetId === preset.id ? ' selected' : '');
    btn.textContent = preset.label;
    btn.addEventListener('click', () => { tftUi.turnPresetId = preset.id; tftRenderOnlineScreen(); });
    lenEl.appendChild(btn);
  }
  const submit = document.createElement('button');
  submit.className = 'btn btn-primary btn-large';
  submit.textContent = tftOnlineUi.busy ? '作成中…' : '作成する';
  submit.disabled = tftOnlineUi.busy;
  submit.addEventListener('click', async () => {
    const nameInput = document.getElementById('tft-online-name');
    tftOnlineUi.displayName = nameInput.value.trim();
    tftOnlineUi.busy = true; tftRenderOnlineScreen();
    const res = await tftOnlineCreateRoom(tftOnlineUi.displayName, tftUi.turnPresetId);
    tftOnlineUi.busy = false;
    if (!res.ok) { tftOnlineUi.errorText = res.reason; tftRenderOnlineScreen(); return; }
    tftOnlineUi.view = 'waiting';
    tftOnlineEnterWaitingRoom();
  });
  wrap.appendChild(submit);
  return wrap;
}

function tftBuildOnlineJoinForm() {
  const wrap = document.createElement('div');
  wrap.className = 'tft-online-panel';
  wrap.innerHTML = `
    <h2 class="section-title">ルームコードで参加</h2>
    <label class="tft-online-label">ルームコード
      <input id="tft-online-code" type="text" maxlength="6" style="text-transform:uppercase" value="${tftOnlineUi.roomCodeInput}" placeholder="例: C6K5QY">
    </label>
    <label class="tft-online-label">あなたの名前
      <input id="tft-online-name" type="text" maxlength="24" value="${tftOnlineUi.displayName}" placeholder="友人A">
    </label>
  `;
  const submit = document.createElement('button');
  submit.className = 'btn btn-primary btn-large';
  submit.textContent = tftOnlineUi.busy ? '参加中…' : '参加する';
  submit.disabled = tftOnlineUi.busy;
  submit.addEventListener('click', async () => {
    const code = document.getElementById('tft-online-code').value.trim().toUpperCase();
    const name = document.getElementById('tft-online-name').value.trim();
    tftOnlineUi.roomCodeInput = code; tftOnlineUi.displayName = name;
    tftOnlineUi.busy = true; tftRenderOnlineScreen();
    const res = await tftOnlineJoinRoom(code, name);
    tftOnlineUi.busy = false;
    if (!res.ok) { tftOnlineUi.errorText = res.reason; tftRenderOnlineScreen(); return; }
    tftOnlineUi.view = 'waiting';
    tftOnlineEnterWaitingRoom();
  });
  wrap.appendChild(submit);
  return wrap;
}

// 参加直後・待機ロビー突入時に呼ぶ。ロビー情報を取得して描画し、数秒おきに更新する
// （他プレイヤーの参加状況をリアルタイムに近い形で見せる。ゲーム開始前だけの短時間ポーリングなので
//  ゲーム中の30秒間隔ポーリングとは別枠で構わない）。
function tftOnlineEnterWaitingRoom() {
  tftOnlineRefreshWaitingRoom();
  tftOnlineStopWaitingPoll();
  tftOnlineUi.waitingTimer = setInterval(tftOnlineRefreshWaitingRoom, 4000);
}

async function tftOnlineRefreshWaitingRoom() {
  const res = await tftOnlineGetRoomInfo(tftOnline.roomCode);
  if (!res.ok) { tftOnlineUi.errorText = res.reason; tftRenderOnlineScreen(); return; }
  tftOnlineUi.waitingInfo = res;
  if (res.status === 'live') {
    // 他プレイヤー（ホスト）が既に開始していた場合、自分も合流する
    tftOnlineStopWaitingPoll();
    const state = await tftOnlineFetch(`/api/games/${tftOnline.gameId}/state`);
    if (state.ok) tftOnlineEnterGame(state.state);
    return;
  }
  tftRenderOnlineScreen();
}

function tftBuildOnlineWaitingRoom() {
  const info = tftOnlineUi.waitingInfo;
  const wrap = document.createElement('div');
  wrap.className = 'tft-online-panel';
  if (!info) { wrap.textContent = '読み込み中…'; return wrap; }

  const isHost = tftOnline.slotIndex === 0;
  wrap.innerHTML = `
    <h2 class="section-title">ルームコード</h2>
    <div class="tft-online-room-code">${info.roomCode}</div>
    <p class="tft-panel-help">このコードを友人に共有してください（最大${info.maxSlots}人まで参加できます）。</p>
    <h3 class="section-title">参加者（${info.players.length}/${info.maxSlots}）</h3>
    <div class="tft-online-player-list">
      ${info.players.map(p => `<div class="tft-online-player-row">👤 ${p.displayName}${p.slotIndex === 0 ? '（ホスト）' : ''}</div>`).join('')}
    </div>
  `;

  if (isHost) {
    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn-primary btn-large';
    startBtn.textContent = '⚔️ ゲーム開始（以降は参加者を追加できません）';
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      const res = await tftOnlineStartGame();
      if (!res.ok) { tftOnlineUi.errorText = res.reason; startBtn.disabled = false; tftRenderOnlineScreen(); return; }
      tftOnlineStopWaitingPoll();
      tftOnlineEnterGame(res.state);
    });
    wrap.appendChild(startBtn);
  } else {
    const waiting = document.createElement('p');
    waiting.className = 'tft-panel-help';
    waiting.textContent = 'ホストが開始するのを待っています…';
    wrap.appendChild(waiting);
  }
  return wrap;
}
