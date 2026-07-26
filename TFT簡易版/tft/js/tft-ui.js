// ============================================================
// TFT の UI 層。ロビー → 盤面/パネル描画 → 入力 → 演出。
// エントリポイント（DOMContentLoaded で tftInit）。
//
// 操作の原則: 「まず盤面のセルを選択し、そのセルの情報と可能な行動が
// サイドパネル(#tft-panel-cell)に表示され、そこから行動する」という
// セル選択起点の単一フローに統一されている（タブは廃止）。
// 出陣（侵攻・移動）だけは、選択中セルの駐留ユニット一覧のチェックボックス
// をONにすると経路構築モードに入り、隣接セルを順にクリックして経路を
// 伸ばし、出陣ボタンで実行する（tftUi.routeInProgress → tftConfirmDeploy）。
// 経路上の自領セルのAPを消費する。
// ============================================================

// --- UI ローカル状態 ---
const tftUi = {
  // プレイヤー枠は human / off のみ（対人戦=ホットシートは未実装のため P1 以外は常に off）。
  // 枠自体は将来のオンライン対戦のために残してある。対戦相手は常設CPU7勢力（TFT_CPU_FACTIONS）。
  lobbySlots: ['human', 'off', 'off', 'off'],
  turnPresetId: '1m',

  selectedCell: null,       // 現在選択中のセルindex。null=未選択（サイドパネルの表示起点）
  selectedUnits: new Set(), // 出陣対象ユニットuid（全員が selectedCell 由来。経路構築中のみ意味を持つ）
  routeInProgress: null,    // 経路構築中のcellIndex配列。null=非構築中
  schemeInProgress: null,   // 計略の対象選択中 { schemeId, fromCell }。null=非選択中（routeInProgressと相互排他）
  openCategory: null,       // 自領セルパネルで開いているカテゴリ('build'|'hire'|'research'|'train'|'explore'|'trade'|'item'|'scheme'|'garrison')。null=すべて閉じている
  openHireLineage: null,    // 雇用パネルで展開中の系統id。null=雇用可能な最初の系統を既定で開く
  rulebookReturn: 'tft-screen-lobby', // ルールブックの「戻る」先画面id（ロビー/ゲーム中どちらから開いたか）

  // このブラウザで操作しているプレイヤーのid。stateはゲーム全体で共有される単一オブジェクトなので、
  // 「自分が誰か」はstateの一部ではなく各ブラウザ固有のクライアントローカル値として持つ
  // （オンライン対戦で複数人間が同時に同じstateを見る場合、元のプレイヤー枠idは単一値のままだが
  // 各ブラウザの「自分」は別々になるため）。ソロ/CPU戦は tftLobbyStart で元のhuman枠id(=0)に
  // 同期して従来の挙動を維持し、オンライン対戦はjoin/resume時にサーバーから受け取ったslotIndexを設定する。
  myPlayerId: 0,
};

// 経路(出陣)選択のみをクリアするヘルパ（駐留一覧のチェック解除・出陣確定/取消で使う）
function tftClearRouteSelection() {
  tftUi.selectedUnits.clear();
  tftUi.routeInProgress = null;
}

// 計略の対象選択モードをクリアするヘルパ（routeInProgressとの相互排他にも使う）
function tftClearSchemeSelection() {
  tftUi.schemeInProgress = null;
}

function tftShowScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

let tftToastTimer = null;
function tftToast(msg) {
  const el = document.getElementById('tft-toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(tftToastTimer);
  tftToastTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
}

// ============ ロビー ============

// 本拠地守備隊の編成を一言で説明する（盤面ツールチップ・セルパネルで共用）。
// 単一ランク指定は「そのランクの全5系統」が固定で湧く（tftSpawnHomeGuard 参照）。
function tftGuardDesc(guardRanks) {
  if (!guardRanks) return '';
  if (guardRanks.length === 1) {
    const rank = guardRanks[0];
    const names = UNITS_DATA.filter(u => !u.isMonster && u.rank === rank).map(u => u.name).join('・');
    return `守備隊${TFT_HOME_GUARD_SIZE}体（ランク${rank}の全系統: ${names}）`;
  }
  return `守備隊${TFT_HOME_GUARD_SIZE}体（ランク${guardRanks[0]}〜${guardRanks[guardRanks.length - 1]}のランダム構成）`;
}

// 勢力の種別バッジ（盤面・ロビー・セルパネルで共用）
function tftFactionBadge(kind) {
  if (kind === 'lastboss') return '☠️';
  if (kind === 'midboss') return '⭐';
  if (kind === 'normal') return '◆';
  return '';
}

function tftRenderLobby() {
  const slotsEl = document.getElementById('tft-lobby-slots');
  slotsEl.innerHTML = '';
  tftUi.lobbySlots.forEach((slot, i) => {
    const row = document.createElement('div');
    row.className = 'tft-lobby-slot';
    const typeLabel = slot === 'human' ? '👤 あなた' : '－ 対人戦は準備中';
    row.innerHTML = `
      <span class="tft-slot-color" style="background:${TFT_PLAYER_COLORS[i]}"></span>
      <span class="tft-slot-name">${TFT_PLAYER_NAMES[i]}</span>
      <button class="tft-slot-type ${slot}" ${i > 0 ? 'disabled' : ''}>${typeLabel}</button>
    `;
    slotsEl.appendChild(row);
  });

  // 常設CPU7勢力の紹介（人数に関係なく必ず盤面に居る対戦相手）
  const foes = document.createElement('div');
  foes.className = 'tft-lobby-foes';
  foes.innerHTML = `<div class="tft-lobby-foes-title">対戦相手（CPU7勢力・常設）</div>` +
    TFT_CPU_FACTIONS.map(f => {
      const kind = TFT_FACTION_KINDS[f.kind];
      const lockKey = kind.lockKeyId ? tftKeyItemById(kind.lockKeyId) : null;
      const note = f.kind === 'lastboss' ? '侵攻してこない。最強ヒーロー5体が守る'
        : f.kind === 'midboss' ? 'ランク7の5体が本拠地を守る'
        : '普通に攻めてくる';
      return `<div class="tft-lobby-foe">
        <span class="tft-slot-color" style="background:${f.color}"></span>
        <span class="tft-lobby-foe-name">${tftFactionBadge(f.kind)} ${f.name}</span>
        <span class="tft-lobby-foe-cell">${tftCellLabel(f.home)}</span>
        <span class="tft-lobby-foe-note">${lockKey ? `${lockKey.icon}${lockKey.name}が必要 / ` : ''}${note}</span>
      </div>`;
    }).join('');
  slotsEl.appendChild(foes);

  const lenEl = document.getElementById('tft-turn-length');
  lenEl.innerHTML = '';
  for (const preset of TFT_TURN_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'tft-turn-option' + (tftUi.turnPresetId === preset.id ? ' selected' : '');
    btn.textContent = preset.label;
    btn.addEventListener('click', () => { tftUi.turnPresetId = preset.id; tftRenderLobby(); });
    lenEl.appendChild(btn);
  }
}

function tftLobbyStart() {
  // 対戦相手の人数チェックは不要になった（常設CPU7勢力が必ず盤面に居るため）
  SoundFX.resume();
  const preset = TFT_TURN_PRESETS.find(p => p.id === tftUi.turnPresetId);
  const state = tftCreateState(tftUi.lobbySlots, preset.ms);
  tftUi.myPlayerId = state.humanPlayerId; // ソロ/CPU戦は常に自分=humanPlayerId（従来の挙動を維持）
  tftShowScreen('tft-screen-game');
  tftStartGame(state);
}

// ============ 盤面・HUD 描画 ============

function tftRenderAll(state) {
  // 防御的キャンセル: 経路の起点セルの所有権を喪失した等、致命的に破綻した場合のみ強制クリア
  if (tftUi.routeInProgress && tftUi.routeInProgress.length > 0 &&
      state.cells[tftUi.routeInProgress[0]].ownerId !== tftUi.myPlayerId) {
    tftClearRouteSelection();
  }
  // 計略の発動元セルの所有権を喪失した場合も同様に強制クリア
  if (tftUi.schemeInProgress &&
      state.cells[tftUi.schemeInProgress.fromCell].ownerId !== tftUi.myPlayerId) {
    tftClearSchemeSelection();
  }

  tftRenderHud(state);
  tftRenderBoard(state);
  tftRenderScoreboard(state);
  tftRenderCellPanel(state);
  tftRenderDeployBar(state);
  tftRenderAuctionPanel(state);
  tftRenderActionLog(state);
}

function tftRenderHud(state) {
  const p = state.players[tftUi.myPlayerId];
  // 1ターン=1ヶ月。収入は季節で集約されるため、暦を主表示にする。
  const month = tftMonthOf(state.turn);
  const turnEl = document.getElementById('tft-hud-turn');
  turnEl.textContent = `📅 ${tftYearOf(state.turn)}年${month}月`;
  turnEl.title = `ターン${state.turn}（1ターン=1ヶ月）／金の収入: ${TFT_GOLD_INCOME_MONTHS.join('/')}月・食料の収穫: ${TFT_FOOD_HARVEST_MONTHS.join('/')}月`;
  turnEl.classList.toggle('harvest-month', tftIsFoodHarvestTurn(state.turn));
  turnEl.classList.toggle('income-month', tftIsGoldIncomeTurn(state.turn));

  // 開幕保護のバッジ。保護が明けたら消す（期間中だけ出る一時的な表示）。
  const protectEl = document.getElementById('tft-hud-protect');
  const protecting = tftIsHomeProtectTurn(state.turn);
  protectEl.hidden = !protecting;
  if (protecting) {
    const left = tftHomeProtectMonthsLeft(state.turn);
    protectEl.textContent = `🛡️ 本拠地保護 あと${left}ヶ月`;
    protectEl.title = `開幕${TFT_HOME_PROTECT_YEARS}年のあいだ、全勢力の本拠地は侵攻も計略も通りません（CPU・人間とも同条件）。`
      + `${TFT_HOME_PROTECT_YEARS + 1}年1月＝ターン${TFT_HOME_PROTECT_LAST_TURN + 1}から解禁されます`;
  }

  // 金は収入月（1/4/7/10月）にまとめて入る。次の収入月と金額を併記。
  const goldIncome = tftCellCount(state, tftUi.myPlayerId) * TFT_INCOME_PER_CELL
    + tftBuildingIncomeSum(state, tftUi.myPlayerId, 'town');
  const goldIn = tftMonthsUntil(state.turn, TFT_GOLD_INCOME_MONTHS);
  const goldWhen = goldIn === 0 ? '今月' : `${tftNextMonthOf(state.turn, TFT_GOLD_INCOME_MONTHS)}月`;
  const goldEl = document.getElementById('tft-hud-gold');
  goldEl.textContent = `💰 ${p.gold}G ${goldWhen}+${goldIncome}`;
  goldEl.title = `所持${p.gold}G。${TFT_GOLD_INCOME_MONTHS.join('/')}月にまとめて収入（所有マス×${TFT_INCOME_PER_CELL}G＋町の効果）。次は${goldWhen}に+${goldIncome}G`;

  // 食料は収穫月（3/9月）にまとめて入り、維持費は毎月かかる。
  // 次の収穫までに枯渇する見込みなら警告色（備蓄不足の予告）。
  const foodHarvest = tftBuildingIncomeSum(state, tftUi.myPlayerId, 'farm');
  const foodUpkeep = tftFoodUpkeep(state, tftUi.myPlayerId);
  const foodIn = tftMonthsUntil(state.turn, TFT_FOOD_HARVEST_MONTHS);
  const foodWhen = foodIn === 0 ? '今月' : `${tftNextMonthOf(state.turn, TFT_FOOD_HARVEST_MONTHS)}月`;
  const foodEl = document.getElementById('tft-hud-food');
  foodEl.textContent = `🌾 ${p.food} -${foodUpkeep}/月 ${foodWhen}+${foodHarvest}`;
  foodEl.title = `備蓄${p.food}。毎月-${foodUpkeep}（ユニット維持費＋所有マス×${TFT_UPKEEP_PER_CELL}）。`
    + `${TFT_FOOD_HARVEST_MONTHS.join('/')}月に農場が収穫し、次は${foodWhen}に+${foodHarvest}。`
    + `次の収穫までに必要な備蓄は約${foodUpkeep * Math.max(1, foodIn)}`;
  // 次の収穫が来る前に備蓄が尽きるか（収穫月まで foodIn ヶ月ぶんの維持費を払えるか）
  foodEl.classList.toggle('food-danger', p.food < foodUpkeep * Math.max(1, foodIn));

  // 自分の色バッジ（常時表示）。「（あなた）」はここで付ける（p.nameはstate共有データのため無印）
  const meEl = document.getElementById('tft-hud-me');
  meEl.textContent = `● ${p.name}（あなた）`;
  meEl.style.background = p.color;

  const phaseEl = document.getElementById('tft-hud-phase');
  const phaseNames = { live: '🔥 進行中', over: '終了' };
  phaseEl.textContent = phaseNames[state.phase] || state.phase;
  phaseEl.className = 'tft-phase-badge phase-' + state.phase;

  const guideEl = document.getElementById('tft-phase-guide');
  guideEl.textContent = state.phase === TFT_PHASE.LIVE
    ? '⚔️ ユニットを選んで隣接マスを順にクリックして経路を伸ばし、出陣ボタンで実行。経路上の自領マスは行動力(AP)を1ずつ消費します（毎ターン+2回復、上限8）。'
    : '';
}

function tftRenderTimer(remainingMs, phase) {
  const el = document.getElementById('tft-hud-timer');
  const ms = Math.max(0, remainingMs);
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  el.textContent = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  el.classList.toggle('urgent', ms < 10000);
}

function tftRenderBoard(state) {
  const board = document.getElementById('tft-board');
  board.innerHTML = '';
  const humanId = tftUi.myPlayerId;
  const human = state.players[humanId];
  const canOrder = !human.eliminated && state.phase === TFT_PHASE.LIVE;

  // 経路構築中: tip（経路末尾）からの隣接候補のみをハイライト対象にする
  const route = tftUi.routeInProgress;
  const routeSet = new Set(route || []);
  const nextFriendly = new Set(), nextAttack = new Set();
  if (canOrder && route && route.length > 0) {
    const tip = route[route.length - 1];
    if (state.cells[tip].ownerId === humanId) {
      for (const nb of tftNeighbors(tip)) {
        if (routeSet.has(nb)) continue;
        if (state.cells[nb].ownerId === humanId) nextFriendly.add(nb);
        // 鍵で封じられたボス本拠地は「攻撃できる次のマス」に出さない（🔒表示に任せる）
        else if (!tftCellLockReason(state, humanId, nb)) nextAttack.add(nb);
      }
    }
  }
  // 計略の対象選択中: 盤面全域から有効な対象セルをハイライト（射程制限なし）
  const schemeTargets = new Set();
  if (canOrder && tftUi.schemeInProgress) {
    for (const c of state.cells) {
      if (tftSchemeTargetValid(state, humanId, tftUi.schemeInProgress.schemeId, c.index)) {
        schemeTargets.add(c.index);
      }
    }
  }
  // 盤面コンテナをヘックス盤面のピクセルサイズに固定
  const boardSize = tftHexBoardSize();
  board.style.width = boardSize.w + 'px';
  board.style.height = boardSize.h + 'px';

  for (const cell of state.cells) {
    const el = document.createElement('div');
    el.className = 'tft-cell';
    el.dataset.cell = cell.index;

    // ヘックスの絶対配置（中心から左上へ換算）
    const c = tftHexCenter(cell.index);
    el.style.left = (c.x - TFT_HEX_W / 2) + 'px';
    el.style.top = (c.y - TFT_HEX_H / 2) + 'px';
    el.style.width = TFT_HEX_W + 'px';
    el.style.height = TFT_HEX_H + 'px';

    // 塗り色（--fill）: 所有者の半透明色 or 中立
    el.style.setProperty('--fill',
      cell.ownerId !== null ? TFT_PLAYER_COLORS[cell.ownerId] + '55' : 'rgba(255,255,255,0.04)');

    // 自領土は自色の枠（--own-color）で「自分の領域」を明示
    if (cell.ownerId === humanId) {
      el.classList.add('own');
      el.style.setProperty('--own-color', human.color);
    }

    // 経路ハイライト: 経路上=金(route-step/tip) / 赤=侵攻できる次のマス / 青緑=経路を伸ばせる次のマス
    if (routeSet.has(cell.index)) {
      el.classList.add(route[route.length - 1] === cell.index ? 'route-tip' : 'route-step');
    } else if (nextAttack.has(cell.index)) {
      el.classList.add('attackable');
    } else if (nextFriendly.has(cell.index)) {
      el.classList.add('movable');
    }
    // 計略の対象候補（対象選択中のみ。既存のattackableと同じ赤系ハイライトを流用）
    if (schemeTargets.has(cell.index)) el.classList.add('scheme-target');
    // 現在選択中セルのハイライト（経路ハイライトより弱い優先度）
    if (cell.index === tftUi.selectedCell) el.classList.add('selected');
    // 占領直後（今ターン出撃不可）の表示
    if (cell.capturedThisTurn) el.classList.add('captured-fresh');
    // 鍵が無くて手出しできないボス本拠地
    const lockedReason = tftCellLockReason(state, humanId, cell.index);
    if (lockedReason) el.classList.add('locked');

    let html = '';

    // 座標ラベル（A1等）を常時表示
    html += `<span class="tft-cell-label">${tftCellLabel(cell.index)}</span>`;

    // 経路上のセルには順路番号バッジ
    if (routeSet.has(cell.index)) {
      html += `<span class="tft-cell-origin-badge">${route.indexOf(cell.index) + 1}</span>`;
    }

    // 本拠地マーク（開幕保護中は🛡️ ＞ 鍵ロック中は🔒 ＞ ボス種別バッジ ／ 通常は👑）。
    // 保護は自分の本拠地にも掛かるが lockedReason は自領には出ない（＝自分から見た可否）ため、
    // ここは state.turn だけを見て全勢力の本拠地に等しく🛡️を出す。
    const homePlayer = state.players.find(p => p.homeCell === cell.index && !p.eliminated);
    if (homePlayer && cell.ownerId === homePlayer.id) {
      const badge = tftFactionBadge(homePlayer.kind);
      const mark = tftIsHomeProtectTurn(state.turn) ? '🛡️' : (lockedReason ? '🔒' : badge || '👑');
      html += `<span class="tft-cell-home">${mark}</span>`;
    }
    // 町・農場レベル（本拠地に限らず、建てたセルすべてに表示。占領されると建物ごと奪われる）
    if (cell.townLevel > 0 || cell.farmLevel > 0) {
      const b = [];
      if (cell.townLevel > 0) b.push(`🏘️${cell.townLevel}`);
      if (cell.farmLevel > 0) b.push(`🌾${cell.farmLevel}`);
      html += `<span class="tft-cell-buildings">${b.join(' ')}</span>`;
    }
    // 進行中の建設（🚧＋残りターン数）
    if (cell.townBuild || cell.farmBuild) {
      const parts = [];
      if (cell.townBuild) parts.push(`🏘️🚧${cell.townBuild.turnsLeft}`);
      if (cell.farmBuild) parts.push(`🌾🚧${cell.farmBuild.turnsLeft}`);
      html += `<span class="tft-cell-construction">${parts.join(' ')}</span>`;
    }
    // 中立セル: モンスターの脅威ヒント（現在の出現段階を体数ぶんの👹で表示）
    if (cell.ownerId === null) {
      html += `<span class="tft-cell-monster-hint">${'👹'.repeat(tftMonsterCountForTurn(state.turn))}</span>`;
    }

    // 駐留ユニット数（CPU本拠地は実際の駐留に関わらず、常時スポーンする守備隊を表示）
    const garrison = cell.ownerId !== null ? tftGarrison(state, cell.index) : [];
    const guardRanks = homePlayer && cell.ownerId === homePlayer.id
      ? tftFactionKind(state, homePlayer.id).guardRanks : null;
    if (guardRanks) {
      html += `<span class="tft-cell-guard">🛡${TFT_HOME_GUARD_SIZE}</span>`;
    } else if (garrison.length > 0) {
      html += `<span class="tft-cell-units">🛡${garrison.length}</span>`;
    }
    // 行動力(AP)と支持率（所有者がいる全セル＝自領・敵領とも常時表示）。
    // ヘックスが縦に窮屈にならないよう1行にまとめる。支持率は計略の圏内かどうかで色分けする。
    if (cell.ownerId !== null) {
      const supLevel = cell.support <= TFT_SUPPORT_AGITATE_MAX ? ' danger'
        : cell.support <= TFT_SUPPORT_POACH_MAX ? ' warn' : '';
      const supIcon = supLevel ? '😠' : '📊';
      html += `<span class="tft-cell-meta">`
        + `<span class="tft-cell-ap">⚡${cell.ap}</span>`
        + `<span class="tft-cell-support${supLevel}">${supIcon}${cell.support}</span>`
        + `</span>`;
    }

    // 防衛設備アイコン（最大4つ表示）
    if (cell.facilities.length > 0) {
      const icons = cell.facilities.slice(0, 4)
        .map(id => (FACILITIES_LIST.find(f => f.id === id) || {}).icon || '')
        .join('');
      html += `<span class="tft-cell-facilities">${icons}</span>`;
    }

    let monsterHint = '';
    if (cell.ownerId === null) {
      const stage = TFT_MONSTER_STAGES.find(s => state.turn <= s.untilTurn) || TFT_MONSTER_STAGES[TFT_MONSTER_STAGES.length - 1];
      monsterHint = ` / モンスター出現（R${stage.ranks.join('-')}・${tftMonsterCountForTurn(state.turn)}体）`;
    }
    el.innerHTML = html;
    el.title = `${tftCellLabel(cell.index)}` +
      (cell.ownerId !== null ? ` — ${state.players[cell.ownerId].name}` : ' — 中立') +
      (cell.ownerId !== null ? ` / AP${cell.ap}/${TFT_CELL_AP_MAX}` : '') +
      (cell.ownerId !== null ? ` / 支持率${cell.support}` : '') +
      (guardRanks ? ` / ${tftGuardDesc(guardRanks)}が常時防衛`
        : garrison.length ? ` / 駐留${garrison.length}体` : '') +
      (cell.facilities.length ? ` / 設備${cell.facilities.length}` : '') +
      (cell.capturedThisTurn ? ' / 占領直後（今ターン出撃不可）' : '') +
      (lockedReason ? ` / 🔒 ${lockedReason}` : '') +
      monsterHint;
    el.addEventListener('click', () => tftOnCellClick(state, cell.index));
    board.appendChild(el);
  }
}

function tftRenderScoreboard(state) {
  const el = document.getElementById('tft-scoreboard');
  el.innerHTML = '';
  for (const p of state.players) {
    // 参加していないプレイヤー枠は表示しない（常設CPU勢力は id が枠の外なので常に表示される）
    if (!tftIsCpuFaction(p.id) && tftUi.lobbySlots[p.id] === 'off') continue;
    const item = document.createElement('div');
    item.className = 'tft-score-item' + (p.eliminated ? ' eliminated' : '');
    const badge = tftFactionBadge(p.kind);
    item.innerHTML = `
      <span class="tft-score-dot" style="background:${p.color}"></span>
      <span>${badge ? badge + ' ' : ''}${p.name}</span>
      <span>🗺${tftCellCount(state, p.id)}</span>
      <span>👥${p.roster.length}</span>
    `;
    el.appendChild(item);
  }
}

// ============ 統合セルパネル（セル選択が全操作の起点） ============

function tftRenderCellPanel(state) {
  const root = document.getElementById('tft-panel-cell');
  root.innerHTML = '';
  root.appendChild(tftCellPanelStatusButton(state));
  const humanId = tftUi.myPlayerId;
  const cellIndex = tftUi.selectedCell;

  if (cellIndex === null) {
    root.appendChild(tftBuildCellPanelEmpty(state));
    return;
  }
  const cell = state.cells[cellIndex];
  if (cell.ownerId === humanId) {
    root.appendChild(tftBuildCellPanelOwn(state, cell));
  } else {
    root.appendChild(tftBuildCellPanelForeign(state, cell));
  }
}

// パネル最上部に常時固定表示する「状況」ボタン。押すとセル選択そのものを解除し、
// 未選択時の帝国ダッシュボードに戻る（自領/他領/未選択、どの状態からでも同じ動作）。
function tftCellPanelStatusButton(state) {
  const row = document.createElement('div');
  row.className = 'tft-cellpanel-status-row';
  const btn = document.createElement('button');
  btn.className = 'tft-cellpanel-status-btn' + (tftUi.selectedCell === null ? ' active' : '');
  btn.textContent = '📊 状況';
  btn.addEventListener('click', () => {
    tftUi.selectedCell = null;
    tftUi.openCategory = null;
    tftRenderAll(state);
  });
  row.appendChild(btn);
  return row;
}

// 帝国全体のダッシュボード中身（ユニット配置・研究状況・進行中の着工のみ）。
// 未選択時＝「状況」画面で表示する。
function tftBuildEmpireStatusBox(state) {
  const humanId = tftUi.myPlayerId;
  const human = state.players[humanId];
  const frag = document.createDocumentFragment();

  // ユニットの配置（どの領土にユニットがいるか）
  const unitBox = document.createElement('div');
  unitBox.innerHTML = '<h3 class="section-title">🎽 ユニットの配置</h3>';
  const placed = tftOwnedCells(state, humanId)
    .map(c => ({ cell: c, units: tftGarrison(state, c.index) }))
    .filter(x => x.units.length > 0);
  if (placed.length === 0) {
    unitBox.innerHTML += '<div class="tft-panel-help">配置中のユニットはいません</div>';
  } else {
    for (const { cell, units } of placed) {
      const isHome = cell.index === human.homeCell;
      const row = document.createElement('div');
      row.className = 'tft-building-row';
      row.innerHTML = `
        <div class="tft-building-info">
          <b>${tftCellLabel(cell.index)}${isHome ? ' 👑' : ''} — ${units.length}体</b>
          <div class="tft-building-desc">${units.map(u => u.name).join('・')}</div>
        </div>`;
      unitBox.appendChild(row);
    }
  }
  frag.appendChild(unitBox);

  // 系統別研究状況（読み取り専用。AP消費元セル未確定のためここには着手ボタンを置かない）
  const researchBox = document.createElement('div');
  researchBox.innerHTML = '<h3 class="section-title">🔬 研究状況</h3>';
  const lineageObjs = Object.values(LINEAGES);
  for (const lid of TFT_LINEAGE_IDS) {
    const lineage = lineageObjs.find(l => l.id === lid);
    const cur = human.research[lid];
    const maxed = cur >= TFT_MAX_RESEARCHABLE_RANK;
    const inProgress = human.researchInProgress[lid];
    const row = document.createElement('div');
    row.className = 'tft-building-row';
    let descText;
    if (maxed) descText = '研究できるランクはすべて解禁済み（R4はヒーロー専用）';
    else if (inProgress) descText = `研究中… 完成まで残り${inProgress.turnsLeft}ターン`;
    else descText = `自領マスを選ぶと着手できます（次はR${cur + 1}）`;
    row.innerHTML = `
      <span style="color:${lineage.color}; font-weight:bold;">●</span>
      <div class="tft-building-info">
        <b>${lineage.label} R${cur}${maxed ? '（最大）' : ''}</b>
        <div class="tft-building-desc">${descText}</div>
      </div>
    `;
    researchBox.appendChild(row);
  }
  // 計略研究の進行状況（一本鎖）
  {
    const cur = human.schemeLevel;
    const maxed = cur >= TFT_SCHEME_MAX_LEVEL;
    const inProg = human.schemeInProgress;
    const row = document.createElement('div');
    row.className = 'tft-building-row';
    const unlockedText = cur > 0 ? `解禁済み: ${TFT_SCHEME_LEVEL_LABELS.slice(0, cur).join('・')}` : '未研究';
    const descText = maxed ? unlockedText
      : inProg ? `${unlockedText} ／ 「${TFT_SCHEME_LEVEL_LABELS[cur]}」研究中… 残り${inProg.turnsLeft}ターン`
      : `${unlockedText} ／ 次は「${TFT_SCHEME_LEVEL_LABELS[cur]}」（自領マスの計略メニューから着手）`;
    row.innerHTML = `
      <span style="font-weight:bold;">📜</span>
      <div class="tft-building-info">
        <b>計略 Lv${cur}${maxed ? '（最大）' : ''}</b>
        <div class="tft-building-desc">${descText}</div>
      </div>
    `;
    researchBox.appendChild(row);
  }
  frag.appendChild(researchBox);

  // 進行中の着工一覧（全セル横断）
  const inProgress = [];
  for (const c of tftOwnedCells(state, humanId)) {
    if (c.townBuild) inProgress.push({ cell: c, icon: '🏘️', name: '町', build: c.townBuild });
    if (c.farmBuild) inProgress.push({ cell: c, icon: '🌾', name: '農場', build: c.farmBuild });
  }
  if (inProgress.length > 0) {
    const box = document.createElement('div');
    box.className = 'tft-construction-progress';
    box.innerHTML = '<div class="tft-construction-progress-title">🚧 着工中</div>'
      + inProgress.map(item =>
        `<div class="tft-construction-progress-row">${item.icon} ${tftCellLabel(item.cell.index)} ${item.name}Lv${item.build.targetLevel} — 残り${item.build.turnsLeft}ターン</div>`
      ).join('');
    frag.appendChild(box);
  }

  return frag;
}

// 未選択時: 帝国全体のダッシュボード
function tftBuildCellPanelEmpty(state) {
  const wrap = document.createElement('div');
  wrap.className = 'tft-cellpanel-empty';

  const guide = document.createElement('div');
  guide.className = 'tft-panel-help';
  guide.textContent = '盤面のマスをクリックして選択してください。自分の領土なら建設・雇用・研究・出撃・解雇ができます。';
  wrap.appendChild(guide);
  wrap.appendChild(tftBuildEmpireStatusBox(state));

  return wrap;
}

// 領地情報ヘッダー（最小限: AP残量・駐留数・建物レベルのみ）
function tftCellPanelHeader(state, cell, kind) {
  const el = document.createElement('div');
  el.className = 'tft-cellpanel-header';
  const garrison = cell.ownerId !== null ? tftGarrison(state, cell.index) : [];
  const stats = cell.ownerId !== null
    ? `⚡AP ${cell.ap}/${TFT_CELL_AP_MAX} ・ 🛡駐留 ${garrison.length}/${TFT_GARRISON_MAX} ・ 🏘️Lv${cell.townLevel} 🌾Lv${cell.farmLevel} ・ 📊支持 ${cell.support}`
    : '中立地';
  el.innerHTML = `
    <div class="tft-cellpanel-title">${tftCellLabel(cell.index)}${kind === 'own' ? '（自領）' : ''}</div>
    <div class="tft-cellpanel-stats">${stats}</div>`;
  return el;
}

// 自領セルパネルのカテゴリ定義（ボタン1つ=メニュー1つ、同時に1つだけ開く）
const TFT_CELL_CATEGORIES = [
  { key: 'build',    icon: '🏘️', label: '建設',     build: tftCellPanelBuildSection },
  // 防衛設備はいったん廃止中（tftCellPanelFacilitySection ごとコメントアウト）
  // { key: 'facility', icon: '🏰', label: '防衛設備', build: tftCellPanelFacilitySection },
  { key: 'hire',     icon: '👥', label: '雇用',     build: tftCellPanelHireSection },
  { key: 'research', icon: '🔬', label: '研究',     build: tftCellPanelResearchSection },
  { key: 'train',    icon: '🏋️', label: '訓練',     build: tftCellPanelTrainSection },
  { key: 'explore',  icon: '🧭', label: '探索',     build: tftCellPanelExploreSection },
  { key: 'trade',    icon: '🏪', label: '市場',     build: tftCellPanelTradeSection },
  { key: 'item',     icon: '📦', label: 'アイテム', build: tftCellPanelItemSection },
  { key: 'scheme',   icon: '📜', label: '計略',     build: tftCellPanelSchemeSection },
  { key: 'garrison', icon: '⚔️', label: '出陣',     build: tftCellPanelGarrisonSection },
];

// 自領セル選択時: ヘッダー＋カテゴリボタン＋開いているカテゴリのメニューのみ表示
function tftBuildCellPanelOwn(state, cell) {
  const wrap = document.createElement('div');
  wrap.appendChild(tftCellPanelHeader(state, cell, 'own'));
  wrap.appendChild(tftCellPanelCategoryTabs(state, cell));
  const active = TFT_CELL_CATEGORIES.find(c => c.key === tftUi.openCategory);
  if (active) wrap.appendChild(active.build(state, cell));
  return wrap;
}

// 出陣選択の起動: このマスの全ユニットをデフォルト選択し、経路構築を開始する
// （出陣タブを開いたとき、および出陣を開いたまま別の自領セルへ切り替えたときに使う）
function tftActivateGarrisonSelection(state, cellIndex) {
  tftClearRouteSelection();
  tftClearSchemeSelection(); // 計略の対象選択と相互排他
  const garrison = tftGarrison(state, cellIndex);
  if (garrison.length > 0) {
    for (const u of garrison) tftUi.selectedUnits.add(u.uid);
    tftUi.routeInProgress = [cellIndex];
  }
}

// カテゴリボタン行（トグル式アコーディオン）
function tftCellPanelCategoryTabs(state, cell) {
  const row = document.createElement('div');
  row.className = 'tft-cellpanel-tabs';
  const garrisonCount = tftGarrison(state, cell.index).length;
  for (const c of TFT_CELL_CATEGORIES) {
    const btn = document.createElement('button');
    btn.className = 'tft-cellpanel-tab' + (tftUi.openCategory === c.key ? ' active' : '');
    btn.textContent = c.key === 'garrison' ? `${c.icon} ${c.label}(${garrisonCount})` : `${c.icon} ${c.label}`;
    btn.addEventListener('click', () => {
      const willOpen = tftUi.openCategory !== c.key;
      tftUi.openCategory = willOpen ? c.key : null;
      // 出陣メニューを開くたびに、必ずこのマスの全ユニットをデフォルト選択し直す
      if (willOpen && c.key === 'garrison') tftActivateGarrisonSelection(state, cell.index);
      tftRenderAll(state);
    });
    row.appendChild(btn);
  }
  return row;
}

// 建設セクション（町・農場、ボタン一発で着工）
function tftCellPanelBuildSection(state, cell) {
  const human = state.players[tftUi.myPlayerId];
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';
  const buildings = [
    { kind: 'town', icon: '🏘️', name: '町', costs: TFT_TOWN_COST, table: TFT_TOWN_INCOME_TABLE,
      level: cell.townLevel, build: cell.townBuild, unit: `G（${TFT_GOLD_INCOME_MONTHS.join('/')}月の収入ごと）` },
    { kind: 'farm', icon: '🌾', name: '農場', costs: TFT_FARM_COST, table: TFT_FARM_INCOME_TABLE,
      level: cell.farmLevel, build: cell.farmBuild, unit: `食料（${TFT_FOOD_HARVEST_MONTHS.join('/')}月の収穫ごと）` },
  ];
  for (const b of buildings) {
    const maxed = b.level >= TFT_BUILDING_MAX_LV;
    const cost = maxed ? null : b.costs[b.level];
    const row = document.createElement('div');
    row.className = 'tft-building-row';
    let descText;
    if (b.build) descText = `🚧 建設中・残り${b.build.turnsLeft}ターン`;
    else if (maxed) descText = '最大レベル';
    else descText = `次のレベル(Lv${b.level + 1})まで ${cost}G・${TFT_BUILD_DURATION[b.level]}ターン・効果+${b.table[b.level + 1]}${b.unit}`;
    row.innerHTML = `
      <div class="tft-building-info">
        <b>${b.icon} ${b.name} Lv${b.level}</b>
        <div class="tft-building-desc">${descText}</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn tft-btn-small';
    btn.textContent = maxed ? 'MAX' : b.build ? '着工中' : `${cost}G`;
    btn.disabled = maxed || !!b.build || human.gold < cost || cell.ap < TFT_AP_COST.build;
    btn.addEventListener('click', async () => {
      const r = await tftUpgradeBuilding(state, tftUi.myPlayerId, cell.index, b.kind);
      tftToast(r.ok ? `${b.icon} ${b.name} 着工（${r.turns}ターン後に完成）` : r.reason);
      tftRenderAll(state);
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  return box;
}

// 防衛設備セクション（ボタン一発で建設）
// 防衛設備はいったん廃止中のため丸ごとコメントアウト
// function tftCellPanelFacilitySection(state, cell) {
//   const human = state.players[tftUi.myPlayerId];
//   const box = document.createElement('div');
//   box.className = 'tft-cellpanel-section';
//   for (const f of FACILITIES_LIST) {
//     const built = cell.facilities.includes(f.id);
//     const affordable = human.gold >= f.cost && cell.ap >= TFT_AP_COST.facility;
//     const card = document.createElement('div');
//     card.className = 'tft-buy-card' + (affordable && !built ? '' : ' unaffordable');
//     card.innerHTML = `
//       <div class="tft-buy-name">${f.icon} ${f.name}${built ? '（建設済み）' : ''}</div>
//       <div class="tft-buy-desc">${f.desc}</div>
//       <div class="tft-buy-cost">${built ? '' : f.cost + 'G'}</div>
//     `;
//     card.addEventListener('click', () => {
//       if (built || !affordable) return;
//       const r = tftBuildFacility(state, tftUi.myPlayerId, cell.index, f.id);
//       tftToast(r.ok ? `${f.icon} ${f.name} を建設！` : r.reason);
//       tftRenderAll(state);
//     });
//     box.appendChild(card);
//   }
//   return box;
// }

// 系統アイコン（js/main.jsのgetLineageIconはTFTでは読み込まれないためTFT側に同等品を持つ）
function tftLineageIcon(id) {
  return { warrior: '⚔️', mage: '🔮', rogue: '🗡️', archer: '🏹', monk: '🙏', goblin: '👹' }[id] || '◆';
}

// 雇用パネル先頭の「この領土の駐留」サマリ（雇用済みユニットと発動中シナジーの文脈表示）
function tftHireGarrisonSummary(state, cell) {
  const garrison = tftGarrison(state, cell.index);
  const box = document.createElement('div');
  box.className = 'tft-hire-garrison';
  const names = garrison.length ? garrison.map(u => u.name).join('・') : '駐留なし';
  const active = getActiveSynergies(garrison).filter(s => s.triggered);
  const synText = active.length
    ? active.map(s => `${s.classId}${s.count} ${tftSynergyEffectText(s)}`).join(' / ')
    : 'シナジーなし';
  box.innerHTML = `
    <div class="tft-hire-garrison-title">🎽 この領土の駐留（${garrison.length}/${TFT_GARRISON_MAX}体）</div>
    <div class="tft-hire-garrison-names">${names}</div>
    <div class="tft-hire-garrison-syn">発動中: ${synText}</div>
  `;
  return box;
}

// このユニットをマスの駐留に加えると起きるシナジー変化を分類して返す。
// 戻り値: [{ kind:'new'|'up'|'progress', classId, text }]（beforeはループ外で1回計算して渡す）
function tftSynergyDeltaForUnit(before, garrison, u) {
  const beforeByClass = new Map(before.map(s => [s.classId, s]));
  const after = getActiveSynergies([...garrison, u]);
  const out = [];
  for (const a of after) {
    const b = beforeByClass.get(a.classId);
    if (!b || a.count <= b.count) continue; // このユニットは当該シナジーに寄与しない
    if (a.triggered && !b.triggered) {
      out.push({ kind: 'new', classId: a.classId, text: `✨ 新発動: ${a.classId} ${tftSynergyEffectText(a)}` });
    } else if (a.triggered && b.triggered && a.triggered.count > b.triggered.count) {
      out.push({ kind: 'up', classId: a.classId, text: `⬆️ 強化: ${a.classId} ${tftSynergyEffectText(a)}` });
    } else {
      const remain = a.nextThreshold != null ? a.nextThreshold - a.count : null;
      const tail = remain != null ? `（あと${remain}体で${a.triggered ? '強化' : '発動'}）` : '';
      out.push({ kind: 'progress', classId: a.classId, text: `↗ ${a.classId} ${a.count}体${tail}` });
    }
  }
  return out;
}

// 雇用可能な1ユニットのカードDOMを作る
function tftBuildHireCard(state, cell, u, before, garrison) {
  const human = state.players[tftUi.myPlayerId];
  const affordable = human.gold >= u.cost && human.roster.length < TFT_ROSTER_MAX
    && cell.ap >= TFT_AP_COST.hire;
  const deltas = tftSynergyDeltaForUnit(before, garrison, u);
  const gainHtml = deltas.filter(d => d.kind !== 'progress')
    .map(d => `<div class="tft-buy-synergy-gain">${d.text}</div>`).join('');
  const progressHtml = deltas.filter(d => d.kind === 'progress')
    .map(d => `<div class="tft-buy-synergy-progress">${d.text}</div>`).join('');
  const skillHtml = u.skill
    ? `<div class="unit-skill"><div class="unit-skill-head"><span class="unit-skill-name">${u.skill.name}</span><span class="skill-mp-badge">MP${unitMaxMp(u)}</span></div><span class="unit-skill-desc">${u.skill.desc}</span></div>`
    : '';
  const card = document.createElement('div');
  card.className = 'tft-buy-card' + (affordable ? '' : ' unaffordable');
  card.innerHTML = `
    <div class="tft-buy-head">
      <div class="tft-buy-portrait unit-sprite" style="${unitSpriteStyle(u)}"></div>
      <div class="tft-buy-head-text">
        <div class="tft-buy-name">${u.name}</div>
        <div class="tft-buy-desc">${u.lineage.label} R${u.rank} / HP${u.hp} ATK${u.atk}</div>
      </div>
    </div>
    <div class="unit-classes">${u.classes.length ? u.classes.join(' / ') : '<span class="no-synergy">シナジーなし</span>'}</div>
    ${skillHtml}
    ${gainHtml}
    ${progressHtml}
    <div class="tft-buy-cost">${u.cost}G</div>
  `;
  card.addEventListener('click', async () => {
    if (!affordable) return;
    const r = await tftHireUnit(state, tftUi.myPlayerId, u.id, cell.index);
    tftToast(r.ok ? `${u.name} を雇用！${tftCellLabel(cell.index)}に配置` : r.reason);
    tftRenderAll(state);
  });
  return card;
}

// 雇用セクション（系統アコーディオン。未解禁ユニットは一覧に出さない）
// 先頭に駐留サマリを置き、各系統見出しをクリックで開閉（同時に1系統だけ展開）。
// カードには「このマスの駐留に加えると起きるシナジー変化（新発動/強化/前進）」を表示する。
function tftCellPanelHireSection(state, cell) {
  const human = state.players[tftUi.myPlayerId];
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';

  // ①「この領土で雇用済み」駐留サマリ
  box.appendChild(tftHireGarrisonSummary(state, cell));

  // ② 雇用可能ユニットを系統ごとに分類
  const hireable = UNITS_DATA.filter(u => {
    if (u.isMonster) return false; // モンスターは中立地専用ユニットのため雇用対象外
    if (u.rank === 8) return human.heroUnlocked[u.lineage.id]; // ヒーローは条件を満たすまで非表示
    return u.rank <= human.research[u.lineage.id]; // 未解禁ランクは非表示
  });
  if (hireable.length === 0) {
    const help = document.createElement('div');
    help.className = 'tft-panel-help';
    help.textContent = '雇用できるユニットがありません（研究を進めてください）';
    box.appendChild(help);
    return box;
  }
  const byLineage = {};
  for (const lid of TFT_LINEAGE_IDS) byLineage[lid] = [];
  for (const u of hireable) byLineage[u.lineage.id].push(u);
  const availableLineages = TFT_LINEAGE_IDS.filter(lid => byLineage[lid].length > 0);

  // 展開する系統の解決。'__none__'=全閉、null(初期)=先頭の雇用可能系統を既定で開く。
  // 指定系統に雇用可能ユニットが無くなった場合も先頭にフォールバック。
  let openLid = tftUi.openHireLineage;
  if (openLid === '__none__') openLid = null;
  else if (!openLid || byLineage[openLid] === undefined || byLineage[openLid].length === 0) openLid = availableLineages[0];

  // ③ 駐留を基準にしたシナジー差分計算（before はループ外で1回だけ）
  const garrison = tftGarrison(state, cell.index);
  const before = getActiveSynergies(garrison);

  const lineageObjs = Object.values(LINEAGES);
  for (const lid of availableLineages) {
    const lineage = lineageObjs.find(l => l.id === lid);
    const isOpen = lid === openLid;
    const header = document.createElement('div');
    header.className = 'lineage-header tft-hire-lineage-header';
    header.dataset.lineage = lid;
    header.innerHTML = `
      <span class="tft-hire-accordion-mark">${isOpen ? '▾' : '▸'}</span>
      <span class="lineage-icon">${tftLineageIcon(lid)}</span>
      <span class="lineage-label">${lineage.label}</span>
      <span class="tft-hire-count">${byLineage[lid].length}</span>
    `;
    header.addEventListener('click', () => {
      tftUi.openHireLineage = isOpen ? '__none__' : lid; // 開いている系統の再クリックで全閉
      tftRenderAll(state);
    });
    box.appendChild(header);

    if (isOpen) {
      const list = document.createElement('div');
      list.className = 'tft-hire-list';
      for (const u of byLineage[lid]) list.appendChild(tftBuildHireCard(state, cell, u, before, garrison));
      box.appendChild(list);
    }
  }
  return box;
}

// 研究セクション（AP消費元はこのセル、ボタン一発で着手）
function tftCellPanelResearchSection(state, cell) {
  const human = state.players[tftUi.myPlayerId];
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';
  const lineageObjs = Object.values(LINEAGES);
  for (const lid of TFT_LINEAGE_IDS) {
    const lineage = lineageObjs.find(l => l.id === lid);
    const cur = human.research[lid];
    const maxed = cur >= TFT_MAX_RESEARCHABLE_RANK;
    const inProgress = human.researchInProgress[lid];
    const cost = maxed ? null : TFT_RESEARCH_COST[cur - 1];
    const row = document.createElement('div');
    row.className = 'tft-building-row';
    let descText;
    if (maxed) descText = '研究できるランクはすべて解禁済み（R4はヒーロー専用）';
    else if (inProgress) descText = `研究中… 完成まで残り${inProgress.turnsLeft}ターン`;
    else descText = `解禁すると R${cur + 1} まで雇用可能に`;
    row.innerHTML = `
      <span style="color:${lineage.color}; font-weight:bold;">●</span>
      <div class="tft-building-info">
        <b>${lineage.label} R${cur}${maxed ? '（最大）' : ''}</b>
        <div class="tft-building-desc">${descText}</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn tft-btn-small';
    if (maxed) btn.textContent = 'MAX';
    else if (inProgress) btn.textContent = `🔬 残り${inProgress.turnsLeft}T`;
    else btn.textContent = `${cost}G`;
    btn.disabled = maxed || !!inProgress || human.gold < cost || cell.ap < TFT_AP_COST.research;
    btn.addEventListener('click', async () => {
      const r = await tftResearchRank(state, tftUi.myPlayerId, lid, cell.index);
      tftToast(r.ok ? `${lineage.label} の研究に着手（${r.turns}ターン後にR${cur + 1}解禁）` : r.reason);
      tftRenderAll(state);
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  return box;
}

// ユニットのレベルバッジ（駐留一覧・アイテム欄・バトル演出で共用）。最大レベルは金色で強調。
function tftLevelBadge(unit) {
  const lv = unit.level || 1;
  const max = lv >= TFT_LEVEL_MAX ? ' max' : '';
  return `<span class="tft-unit-lv${max}" title="レベル${lv}／全ステータス+${Math.round(TFT_LEVEL_STAT_STEP * (lv - 1) * 100)}%">Lv${lv}</span>`;
}

// 訓練セクション（このマスのAPだけで駐留ユニットを即+1レベル。金は不要）
function tftCellPanelTrainSection(state, cell) {
  const humanId = tftUi.myPlayerId;
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';
  box.innerHTML = `<h3 class="section-title">🏋️ 訓練（AP${TFT_TRAIN_AP_COST}で+1レベル・金は不要）</h3>`;
  const garrison = tftGarrison(state, cell.index);
  if (garrison.length === 0) {
    box.innerHTML += '<div class="tft-panel-help">このマスに駐留ユニットはいません。訓練したいユニットをこのマスに集めてください。</div>';
    return box;
  }
  box.innerHTML += `<div class="tft-panel-help">レベルが上がると全ステータスが+${Math.round(TFT_LEVEL_STAT_STEP * 100)}%（最大Lv${TFT_LEVEL_MAX}＝+${Math.round(TFT_LEVEL_STAT_STEP * (TFT_LEVEL_MAX - 1) * 100)}%）。戦闘に勝って生き残っても経験値で育つ。</div>`;
  for (const u of garrison) {
    const lv = u.level || 1;
    const maxed = lv >= TFT_LEVEL_MAX;
    const need = tftLevelXpNeeded(lv);
    const xpText = maxed ? '最大レベル' : `次のLvまで ${u.xp || 0}/${need} XP`;
    const pct = maxed ? 100 : Math.min(100, Math.round((u.xp || 0) / need * 100));
    const row = document.createElement('div');
    row.className = 'tft-building-row';
    row.innerHTML = `
      <span class="tft-unit-face unit-sprite" style="${unitSpriteStyle(u)}; border-color:${u.lineage.color}"></span>
      <div class="tft-building-info">
        <b>${u.name} ${tftLevelBadge(u)}</b>
        <div class="tft-xp-bar"><span style="width:${pct}%"></span></div>
        <div class="tft-building-desc">${xpText}</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn tft-btn-small';
    btn.textContent = maxed ? '最大' : `🏋️ 訓練`;
    btn.disabled = maxed || cell.ap < TFT_TRAIN_AP_COST;
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const r = await tftTrainUnit(state, humanId, u.uid, cell.index);
      tftToast(r.ok ? `🏋️ ${r.name} をLv${r.level}に鍛えた！` : r.reason);
      tftRenderAll(state);
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  return box;
}

// 探索セクション（このマスのAPを消費し、金/食料をランダムに獲得。ボタン一発で実行）
function tftCellPanelExploreSection(state, cell) {
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';
  const options = [
    { kind: 'gold', icon: '💰', label: '金の探索', unit: 'G',
      desc: `${TFT_EXPLORE_GOLD_RANGE[0]}〜${TFT_EXPLORE_GOLD_RANGE[1]}G 獲得（AP${TFT_AP_COST.explore}消費）` },
    { kind: 'food', icon: '🌾', label: '食料の探索', unit: '食料',
      desc: `${TFT_EXPLORE_FOOD_RANGE[0]}〜${TFT_EXPLORE_FOOD_RANGE[1]}食料 獲得（AP${TFT_AP_COST.explore}消費）` },
    { kind: 'item', icon: '📦', label: 'アイテム探索',
      desc: `${Math.round(TFT_ITEM_DROP_EXPLORE * 100)}%でランダムアイテム入手（AP${TFT_AP_COST.explore}消費）` },
  ];
  for (const opt of options) {
    const row = document.createElement('div');
    row.className = 'tft-building-row';
    row.innerHTML = `
      <div class="tft-building-info">
        <b>${opt.icon} ${opt.label}</b>
        <div class="tft-building-desc">${opt.desc}</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn tft-btn-small';
    btn.textContent = '探索';
    btn.disabled = cell.ap < TFT_AP_COST.explore;
    btn.addEventListener('click', async () => {
      const r = await tftExplore(state, tftUi.myPlayerId, cell.index, opt.kind);
      if (!r.ok) tftToast(r.reason);
      else if (opt.kind === 'item') tftToast(r.item ? `📦 ${r.item.icon}${r.item.name} を発見！` : '🔍 何も見つからなかった…');
      else tftToast(`${opt.icon} 探索成功！ +${r.amount}${opt.unit}`);
      tftRenderAll(state);
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  return box;
}

// 市場セクション（NPC商人と食料10をAP1で売買。レートは商人在庫で変動する）
function tftCellPanelTradeSection(state, cell) {
  const human = state.players[tftUi.myPlayerId];
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';
  const unit = TFT_MERCHANT_TRADE_UNIT;
  const stock = state.merchant.food;
  const buyPrice = tftMerchantBuyPrice(stock);
  const sellPrice = tftMerchantSellPrice(stock);

  const head = document.createElement('div');
  head.className = 'tft-panel-help';
  head.innerHTML = `商人の在庫: 🌾${stock}<br>買値 ${buyPrice}G / 売値 ${sellPrice}G（食料${unit}あたり・在庫で変動）`;
  box.appendChild(head);

  const rows = [
    { action: 'buy', icon: '💰', label: `食料${unit}を買う`,
      desc: `${buyPrice}G 支払い → 🌾+${unit}（AP${TFT_AP_COST.trade}消費）`,
      disabled: stock < unit || human.gold < buyPrice || cell.ap < TFT_AP_COST.trade },
    { action: 'sell', icon: '🌾', label: `食料${unit}を売る`,
      desc: `🌾-${unit} → ${sellPrice}G 獲得（AP${TFT_AP_COST.trade}消費）`,
      disabled: human.food < unit || cell.ap < TFT_AP_COST.trade },
  ];
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tft-building-row';
    row.innerHTML = `
      <div class="tft-building-info">
        <b>${r.icon} ${r.label}</b>
        <div class="tft-building-desc">${r.desc}</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn tft-btn-small';
    btn.textContent = r.action === 'buy' ? '買う' : '売る';
    btn.disabled = r.disabled;
    btn.addEventListener('click', async () => {
      const res = await tftTradeFood(state, tftUi.myPlayerId, cell.index, r.action);
      tftToast(res.ok
        ? (r.action === 'buy' ? `🌾 食料${res.unit}を購入（-${res.price}G）` : `💰 食料${res.unit}を売却（+${res.price}G）`)
        : res.reason);
      tftRenderAll(state);
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  return box;
}

// アイテムセクション（所持アイテム一覧＋このマスのユニットへ装備/付け替え/取り外し）
function tftCellPanelItemSection(state, cell) {
  const humanId = tftUi.myPlayerId;
  const human = state.players[humanId];
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';

  // 鍵は装備も出品もできない特殊アイテムなので、通常アイテムとは別枠で見せる
  const keys = human.items.filter(tftIsKeyItem);
  const keyBox = document.createElement('div');
  keyBox.innerHTML = '<h3 class="section-title">🗝 所持している鍵</h3>';
  if (keys.length === 0) {
    keyBox.innerHTML += `<div class="tft-panel-help">まだ持っていません。${TFT_KEY_ITEMS_LIST.map(k => `${k.icon}${k.name}: ${k.desc}`).join(' / ')}</div>`;
  } else {
    const list = document.createElement('div');
    list.className = 'tft-item-inventory';
    for (const k of keys) {
      const chip = document.createElement('div');
      chip.className = 'tft-item-chip tft-key-chip';
      chip.title = k.desc;
      chip.innerHTML = `${k.icon} ${k.name}<span class="tft-item-desc">${k.desc}</span>`;
      list.appendChild(chip);
    }
    keyBox.appendChild(list);
  }
  box.appendChild(keyBox);

  // 所持アイテム（インベントリ）を id ごとに個数集計。鍵は上の専用枠で扱うので除外する
  const normalItems = human.items.filter(it => !tftIsKeyItem(it));
  const invCounts = {};
  for (const it of normalItems) invCounts[it.id] = (invCounts[it.id] || 0) + 1;
  const invEntries = Object.keys(invCounts).map(id => ({ item: normalItems.find(it => it.id === id), count: invCounts[id] }));

  const invBox = document.createElement('div');
  invBox.innerHTML = '<h3 class="section-title">📦 所持アイテム</h3>';
  if (invEntries.length === 0) {
    invBox.innerHTML += '<div class="tft-panel-help">所持アイテムはありません（中立地占領40%・アイテム探索20%で入手）</div>';
  } else {
    const list = document.createElement('div');
    list.className = 'tft-item-inventory';
    const auctionFull = state.auction.lots.length >= TFT_AUCTION_MAX_LOTS;
    for (const e of invEntries) {
      const chip = document.createElement('div');
      chip.className = 'tft-item-chip';
      chip.title = e.item.desc;
      chip.innerHTML = `${e.item.icon} ${e.item.name}<span class="tft-item-count">×${e.count}</span><span class="tft-item-desc">${e.item.desc}</span>`;
      const listBtn = document.createElement('button');
      listBtn.className = 'btn tft-btn-small tft-item-list-btn';
      listBtn.textContent = '🔨 出品';
      listBtn.disabled = auctionFull;
      listBtn.title = auctionFull ? 'オークションの出品枠が満員です' : `このアイテムをオークションに出品する`;
      listBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const idx = human.items.findIndex(it => it.id === e.item.id);
        const r = await tftListItemForAuction(state, humanId, idx);
        tftToast(r.ok ? `🔨 【${e.item.name}】を出品しました` : r.reason);
        tftRenderAll(state);
      });
      chip.appendChild(listBtn);
      list.appendChild(chip);
    }
    invBox.appendChild(list);
  }
  box.appendChild(invBox);

  // このマスのユニットごとに装備UI（<select>で装備/付け替え/取り外し・状態を持たない）
  const garrison = tftGarrison(state, cell.index);
  const unitsBox = document.createElement('div');
  unitsBox.innerHTML = '<h3 class="section-title">🎽 このマスのユニット</h3>';
  if (garrison.length === 0) {
    unitsBox.innerHTML += '<div class="tft-panel-help">このマスに駐留ユニットはいません</div>';
    box.appendChild(unitsBox);
    return box;
  }
  for (const u of garrison) {
    const row = document.createElement('div');
    row.className = 'tft-item-unit-row';
    const equipped = u.item ? `${u.item.icon}${u.item.name}` : '未装備';
    row.innerHTML = `
      <span class="tft-score-dot" style="background:${u.lineage.color}"></span>
      <span class="tft-item-unit-name">${u.name}<span class="tft-item-equipped">装備: ${equipped}</span></span>`;
    const sel = document.createElement('select');
    sel.className = 'tft-item-select';
    // 選択肢: なし / 現在装備 / 所持アイテム各種
    let opts = '<option value="__none__">なし（外す）</option>';
    if (u.item) opts += `<option value="__current__" selected>${u.item.icon} ${u.item.name}（装備中）</option>`;
    for (const e of invEntries) opts += `<option value="${e.item.id}">${e.item.icon} ${e.item.name}（所持×${e.count}）</option>`;
    sel.innerHTML = opts;
    if (!u.item) sel.value = '__none__';
    sel.addEventListener('change', async () => {
      const v = sel.value;
      if (v === '__none__') {
        if (u.item) { const r = await tftUnequipItem(state, humanId, u.uid); tftToast(r.ok ? `${r.name} の ${r.item.icon}${r.item.name} を外した` : r.reason); }
      } else if (v !== '__current__') {
        const r = await tftEquipItem(state, humanId, u.uid, v);
        tftToast(r.ok ? `${r.name} に ${r.item.icon}${r.item.name} を装備` : r.reason);
      }
      tftRenderAll(state);
    });
    row.appendChild(sel);
    unitsBox.appendChild(row);
  }
  box.appendChild(unitsBox);
  return box;
}

// 発動中シナジーの効果を短い文字列にする（バッジ・雇用プレビューで共用）
function tftSynergyEffectText(syn) {
  if (syn.rule.type === 'multiplier') return `${syn.triggered.stat.toUpperCase()}+${Math.round(syn.triggered.multiplier * 100)}%`;
  if (syn.rule.type === 'heal')       return `HP+${syn.triggered.healPerTurn}/T`;
  if (syn.rule.type === 'berserker')  return `低HP ATK+${Math.round(syn.triggered.bonus * 100)}%`;
  if (syn.rule.type === 'shield')     return `開幕シールド+${Math.round(syn.triggered.shieldPct * 100)}%HP`;
  return '';
}

// 発動中のシナジーバッジ一覧（tft-battle-view.js の tftBattleRenderSynergies と同じ表示ロジックだが、
// バトルモーダル用DOMに依存せずDOM要素を直接返す）
function tftBuildSynergyBadges(team) {
  const wrap = document.createElement('div');
  wrap.className = 'battle-synergy-bar';
  const triggered = getActiveSynergies(team).filter(s => s.triggered);
  if (triggered.length === 0) {
    wrap.innerHTML = '<div class="tft-panel-help">発動中のシナジーはありません</div>';
    return wrap;
  }
  for (const syn of triggered) {
    const badge = document.createElement('div');
    badge.className = 'battle-syn-badge';
    badge.innerHTML = `<span class="syn-name">${syn.classId}</span><span class="syn-count">${syn.count}体</span><span class="syn-effect">${tftSynergyEffectText(syn)}</span>`;
    wrap.appendChild(badge);
  }
  return wrap;
}

// 計略セクション: 解禁済み計略の発動（対象選択モードへ）と、次段階の研究着手
function tftCellPanelSchemeSection(state, cell) {
  const human = state.players[tftUi.myPlayerId];
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';

  // 対象選択中: 案内とキャンセルのみ表示
  if (tftUi.schemeInProgress) {
    const scheme = tftSchemeById(tftUi.schemeInProgress.schemeId);
    const info = document.createElement('div');
    info.className = 'tft-panel-help tft-scheme-targeting';
    info.textContent = `🎯 ${scheme.icon}【${scheme.name}】の対象を選択中… 盤面の光っているマスをクリックしてください`;
    box.appendChild(info);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn tft-btn-small';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', () => {
      tftClearSchemeSelection();
      tftRenderAll(state);
    });
    box.appendChild(cancelBtn);
    return box;
  }

  // 解禁済みの計略一覧
  const unlocked = TFT_SCHEMES.filter(s => human.schemeLevel >= s.level);
  if (unlocked.length === 0) {
    const help = document.createElement('div');
    help.className = 'tft-panel-help';
    help.textContent = '計略は未解禁です。下の研究から着手してください。';
    box.appendChild(help);
  }
  for (const scheme of unlocked) {
    const row = document.createElement('div');
    row.className = 'tft-building-row';
    const effectNote = scheme.id === 'rumor' ? `支持率-${tftRumorValue(human.schemeLevel)}・` :
      scheme.id === 'propaganda' ? `支持率+${TFT_PROPAGANDA_VALUE}・` :
      scheme.id === 'foodraid' ? `最大${TFT_FOODRAID_AMOUNT}奪取・` : '';
    row.innerHTML = `
      <div class="tft-building-info">
        <b>${scheme.icon} ${scheme.name}</b>
        <div class="tft-building-desc">${scheme.desc}（${effectNote}成功率${Math.round(scheme.chance * 100)}%・AP${scheme.ap}）</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn tft-btn-small';
    btn.textContent = '発動';
    btn.disabled = cell.ap < scheme.ap;
    btn.title = cell.ap < scheme.ap ? `このマスのAPが足りません（${cell.ap}/${scheme.ap}）` : '';
    btn.addEventListener('click', () => {
      tftClearRouteSelection(); // 出陣モードとは相互排他
      tftUi.schemeInProgress = { schemeId: scheme.id, fromCell: cell.index };
      tftRenderAll(state);
      tftToast(`${scheme.icon}【${scheme.name}】の対象マスをクリックしてください`);
    });
    row.appendChild(btn);
    box.appendChild(row);
  }

  // 次段階の研究（一本鎖）
  const cur = human.schemeLevel;
  const row = document.createElement('div');
  row.className = 'tft-building-row tft-scheme-research-row';
  if (cur >= TFT_SCHEME_MAX_LEVEL) {
    row.innerHTML = `<div class="tft-building-info"><b>🔬 計略研究</b><div class="tft-building-desc">すべての計略を研究済み</div></div>`;
  } else {
    const label = TFT_SCHEME_LEVEL_LABELS[cur];
    const cost = TFT_SCHEME_RESEARCH_COST[cur];
    const dur = TFT_SCHEME_RESEARCH_DURATION[cur];
    const inProgress = human.schemeInProgress;
    row.innerHTML = `
      <div class="tft-building-info">
        <b>🔬 計略研究: ${label}</b>
        <div class="tft-building-desc">${inProgress
          ? `研究中… 完成まで残り${inProgress.turnsLeft}ターン`
          : `${cost}G・${dur}ターンで「${label}」を解禁（AP${TFT_AP_COST.research}消費）`}</div>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn tft-btn-small';
    if (inProgress) btn.textContent = `🔬 残り${inProgress.turnsLeft}T`;
    else btn.textContent = `${cost}G`;
    btn.disabled = !!inProgress || human.gold < cost || cell.ap < TFT_AP_COST.research;
    btn.addEventListener('click', async () => {
      const r = await tftResearchScheme(state, tftUi.myPlayerId, cell.index);
      tftToast(r.ok ? `📜 計略「${r.label}」の研究に着手（${r.turns}ターン後に解禁）` : r.reason);
      tftRenderAll(state);
    });
    row.appendChild(btn);
  }
  box.appendChild(row);
  return box;
}

// 駐留ユニット一覧（チェックで出撃選択・解雇ボタン）。防衛時に発動するシナジー（駐留全員の構成）も表示する
function tftCellPanelGarrisonSection(state, cell) {
  const humanId = tftUi.myPlayerId;
  const box = document.createElement('div');
  box.className = 'tft-cellpanel-section';
  const garrison = tftGarrison(state, cell.index);
  if (garrison.length === 0) {
    box.innerHTML = '<div class="tft-panel-help">このマスに駐留ユニットはいません</div>';
    return box;
  }
  box.appendChild(tftBuildSynergyBadges(garrison));
  for (const u of garrison) {
    const row = document.createElement('div');
    const effHp = tftEffectiveHp(u);
    const tired = u.fatigue > 0;
    row.className = 'tft-unit-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tft-unit-checkbox';
    checkbox.checked = tftUi.selectedUnits.has(u.uid);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        tftUi.selectedUnits.add(u.uid);
        if (!tftUi.routeInProgress) tftUi.routeInProgress = [cell.index];
      } else {
        tftUi.selectedUnits.delete(u.uid);
        if (tftUi.selectedUnits.size === 0) tftClearRouteSelection();
      }
      tftRenderAll(state);
    });
    row.appendChild(checkbox);
    const itemBadge = u.item ? `<span class="tft-unit-item" title="${u.item.name}：${u.item.desc}">${u.item.icon}</span>` : '';
    const mpBadge = u.skill ? `<span class="skill-mp-badge" title="${u.skill.name}：${u.skill.desc}">MP${unitMaxMp(u)}</span>` : '';
    row.insertAdjacentHTML('beforeend', `
      <span class="tft-unit-face unit-sprite" style="${unitSpriteStyle(u)}; border-color:${u.lineage.color}"></span>
      <span class="tft-unit-info">
        <span class="tft-unit-name">${u.name}${tftLevelBadge(u)}${itemBadge}${mpBadge}</span>
        <span class="unit-classes">${u.classes.length ? u.classes.join(' / ') : '<span class="no-synergy">シナジーなし</span>'}</span>
      </span>
      <span class="tft-unit-hp${tired ? ' tired' : ''}">HP${effHp}/${u.hp}${tired ? `（疲労${u.fatigue}）` : ''}</span>
    `);
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn tft-btn-small tft-unit-dismiss';
    dismissBtn.textContent = `解雇（${u.cost}G返金・AP${TFT_AP_COST.dismiss}）`;
    dismissBtn.disabled = cell.ap < TFT_AP_COST.dismiss;
    dismissBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const r = await tftDismissUnit(state, humanId, u.uid, cell.index);
      tftToast(r.ok ? `${r.name} を解雇（${r.refund}G返金）` : r.reason);
      if (r.ok) {
        tftUi.selectedUnits.delete(u.uid);
        if (tftUi.selectedUnits.size === 0) tftClearRouteSelection();
      }
      tftRenderAll(state);
    });
    row.appendChild(dismissBtn);
    box.appendChild(row);
  }
  return box;
}

// 敵/中立セル選択時: 読み取り専用ビュー
function tftBuildCellPanelForeign(state, cell) {
  const wrap = document.createElement('div');
  wrap.appendChild(tftCellPanelHeader(state, cell, 'foreign'));
  const help = document.createElement('div');
  help.className = 'tft-panel-help';
  help.textContent = cell.ownerId === null
    ? '中立地です。隣接する自領マスの駐留ユニットにチェックを入れて経路を伸ばすと侵攻できます。'
    : `${state.players[cell.ownerId].name} の領土です。隣接する自領マスから侵攻できます。`;
  wrap.appendChild(help);

  // ボスの本拠地: 守備隊の中身と、必要な鍵・その入手条件を明示する
  const owner = cell.ownerId !== null ? state.players[cell.ownerId] : null;
  if (owner && cell.index === owner.homeCell && tftIsBossFaction(state, owner.id)) {
    const kind = tftFactionKind(state, owner.id);
    const key = tftKeyItemById(kind.lockKeyId);
    const has = tftHasKey(state, tftUi.myPlayerId, kind.lockKeyId);
    const box = document.createElement('div');
    box.className = 'tft-panel-help tft-boss-info' + (has ? ' unlocked' : '');
    box.innerHTML = `<div class="tft-boss-title">${tftFactionBadge(owner.kind)} ${owner.name}の本拠地</div>`
      + `<div>🛡 ${tftGuardDesc(kind.guardRanks)}</div>`
      + (kind.passive ? `<div>💤 侵攻してこない（内政も計略もしない）</div>` : '')
      + `<div>${has ? '🔓' : '🔒'} ${key.icon}${key.name}${has ? ' を所持 — 侵攻できます' : ' が必要'}</div>`
      + (has ? '' : `<div class="tft-boss-howto">${key.desc}</div>`);
    wrap.appendChild(box);
  }

  // 敵領土: 計略の観点からの支持率ヒント（研究済みの範囲で）。
  // 鍵で封じられたセルは計略も通らないので、対象になるかのようなヒントは出さない。
  const human = state.players[tftUi.myPlayerId];
  if (cell.ownerId !== null && human.schemeLevel >= 1
      && !tftCellLockReason(state, tftUi.myPlayerId, cell.index)) {
    const hints = [];
    if (human.schemeLevel >= tftSchemeById('poach').level) {
      hints.push(cell.support <= TFT_SUPPORT_POACH_MAX
        ? '🕵️ 引き抜きの対象です' : `🕵️ 引き抜きまで支持率あと${cell.support - TFT_SUPPORT_POACH_MAX}`);
    }
    if (human.schemeLevel >= tftSchemeById('agitate').level && cell.index !== state.players[cell.ownerId].homeCell) {
      hints.push(cell.support <= TFT_SUPPORT_AGITATE_MAX
        ? '🔥 扇動の対象です' : `🔥 扇動まで支持率あと${cell.support - TFT_SUPPORT_AGITATE_MAX}`);
    }
    if (hints.length > 0) {
      const hintEl = document.createElement('div');
      hintEl.className = 'tft-panel-help tft-scheme-hint';
      hintEl.textContent = hints.join('　');
      wrap.appendChild(hintEl);
    }
  }
  return wrap;
}

// 盤面上部の出陣バー（経路構築中のみ表示。tftValidateRouteは副作用なしなので毎回呼んで安全）
function tftRenderDeployBar(state) {
  const bar = document.getElementById('tft-deploy-bar');
  if (!bar) return;
  const route = tftUi.routeInProgress;
  if (!route || route.length === 0) { bar.style.display = 'none'; return; }

  const humanId = tftUi.myPlayerId;
  const check = tftValidateRoute(state, humanId, route, [...tftUi.selectedUnits]);
  const pathText = route.map(tftCellLabel).join(' → ');
  const confirmBtn = document.getElementById('tft-deploy-confirm');
  const textEl = document.getElementById('tft-deploy-text');
  if (check.ok) {
    const kind = check.isAttack ? '⚔️侵攻' : '🚶移動';
    textEl.textContent = `${pathText}　${kind}　消費AP: ${check.apCells.length}（${check.apCells.map(tftCellLabel).join('・')}）`;
    confirmBtn.disabled = false;
    confirmBtn.title = '';
  } else {
    textEl.textContent = `${pathText}　— ${check.reason}`;
    confirmBtn.disabled = true;
    confirmBtn.title = check.reason;
  }
  bar.style.display = '';
}

async function tftConfirmDeploy(state) {
  const humanId = tftUi.myPlayerId;
  const route = tftUi.routeInProgress;
  if (!route) return;
  // オンライン対戦では実行がサーバー往復（await）になるため、待っている間に「出陣」を
  // 連打されると同じ経路で二重に侵攻してしまう。送信前に選択状態を確定的にクリアして
  // 再入を塞ぐ（元々成否によらずクリアする挙動なので、ソロ時のUXは変わらない）。
  const uids = [...tftUi.selectedUnits];
  tftUi.selectedUnits.clear();
  tftUi.routeInProgress = null;
  tftRenderAll(state);

  const r = await tftExecuteRoute(state, humanId, route, uids);
  tftToast(r.ok ? (r.isAttack ? r.report.logText : `${route.length}マス移動しました`) : r.reason);
  tftRenderAll(state);
  tftHandleGameOverIfNeeded(state);
}

function tftCancelDeploy(state) {
  tftUi.selectedUnits.clear();
  tftUi.routeInProgress = null;
  tftRenderAll(state);
}

// ============ オークション（AP非依存の常設パネル。出陣・計略の対象選択とは無関係） ============

function tftRenderAuctionPanel(state) {
  const el = document.getElementById('tft-auction-panel');
  if (!el) return;
  el.innerHTML = '';
  const humanId = tftUi.myPlayerId;
  const human = state.players[humanId];

  const title = document.createElement('h3');
  title.className = 'section-title';
  title.textContent = '🔨 オークション';
  el.appendChild(title);

  if (state.auction.lots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tft-panel-help';
    empty.textContent = '現在出品はありません。';
    el.appendChild(empty);
    return;
  }

  const row = document.createElement('div');
  row.className = 'tft-auction-lots';
  for (const lot of state.auction.lots) {
    const card = document.createElement('div');
    card.className = 'tft-auction-card';
    const minBid = tftAuctionMinNextBid(lot);
    const turnsLeft = lot.closesTurn - state.turn;
    const bidderName = lot.highestBidderId !== null ? state.players[lot.highestBidderId].name : '入札なし';
    const sellerNote = lot.sellerId !== null
      ? `出品者: ${lot.sellerId === humanId ? 'あなた' : state.players[lot.sellerId].name}`
      : '出品者: 商人';
    const isHighest = lot.highestBidderId === humanId;
    card.innerHTML = `
      <div class="tft-auction-item">${lot.item.icon} ${lot.item.name}</div>
      <div class="tft-auction-desc">${lot.item.desc}</div>
      <div class="tft-auction-meta">${sellerNote} ・ 残り${turnsLeft}ターン</div>
      <div class="tft-auction-bid">現在: ${lot.highestBid > 0 ? `${lot.highestBid}G（${bidderName}）` : '入札なし'}</div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn tft-btn-small';
    btn.textContent = isHighest ? '最高額入札中' : `入札する（${minBid}G）`;
    btn.disabled = isHighest || human.gold < minBid;
    btn.addEventListener('click', async () => {
      const r = await tftPlaceBid(state, humanId, lot.id, minBid);
      tftToast(r.ok ? `🔨 【${lot.item.name}】に${minBid}Gで入札しました` : r.reason);
      tftRenderAll(state);
    });
    card.appendChild(btn);
    row.appendChild(card);
  }
  el.appendChild(row);
}

// ============ 行動履歴ログ ============

function tftRenderActionLog(state) {
  const el = document.getElementById('tft-action-log');
  if (!el) return;
  el.innerHTML = '';
  const entries = [...state.actionLog].reverse(); // 新しい順に表示
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'tft-log-row' + (entry.isHumanInvolved ? ' mine' : '');
    row.innerHTML = `<span class="tft-log-turn">T${entry.turn}</span><span class="tft-log-text">${entry.text}</span>`;
    if (entry.type === 'attack' && entry.battleRaw) {
      const btn = document.createElement('button');
      btn.className = 'btn tft-btn-small';
      btn.textContent = '🔁 リプレイ';
      btn.addEventListener('click', () => tftShowBattleModal(entry.battleRaw, entry.report));
      row.appendChild(btn);
    }
    el.appendChild(row);
  }
}

// ============ 盤面クリック（指示の即時実行） ============

async function tftOnCellClick(state, cellIndex) {
  const humanId = tftUi.myPlayerId;
  const human = state.players[humanId];
  if (human.eliminated || state.phase !== TFT_PHASE.LIVE) return;

  // 計略の対象選択中: 盤面クリックは対象決定として扱う（routeInProgressと相互排他・最優先）
  if (tftUi.schemeInProgress) {
    await tftHandleSchemeClick(state, cellIndex);
    return;
  }

  // 経路構築中: 盤面クリックは常に経路の延長/短縮/解除として扱う（最優先）
  if (tftUi.routeInProgress) {
    tftHandleRouteClick(state, cellIndex);
    return;
  }

  // 同じセルの再クリックは選択解除（カテゴリも閉じる）
  if (tftUi.selectedCell === cellIndex) {
    tftUi.selectedCell = null;
    tftUi.openCategory = null;
    tftRenderAll(state);
    return;
  }

  // 別セルへの切替: 開いているカテゴリ（建設・雇用・研究・市場・探索・出陣）は維持したまま移る。
  // 出陣を開いたまま自領セルへ移った場合は、新セルの全ユニットを再選択する。
  tftUi.selectedCell = cellIndex;
  if (tftUi.openCategory === 'garrison' && state.cells[cellIndex].ownerId === humanId) {
    tftActivateGarrisonSelection(state, cellIndex);
  }
  tftRenderAll(state);
}

// 計略の対象選択中のクリック処理: 有効な対象なら即発動、無効ならヒント、発動元セルの再クリックでキャンセル
async function tftHandleSchemeClick(state, cellIndex) {
  const humanId = tftUi.myPlayerId;
  const { schemeId, fromCell } = tftUi.schemeInProgress;
  const scheme = tftSchemeById(schemeId);

  if (cellIndex === fromCell && !tftSchemeTargetValid(state, humanId, schemeId, cellIndex)) {
    tftClearSchemeSelection();
    tftToast('計略をキャンセルしました');
    tftRenderAll(state);
    return;
  }
  if (!tftSchemeTargetValid(state, humanId, schemeId, cellIndex)) {
    tftToast(`${scheme.icon}【${scheme.name}】の対象にできないマスです（${scheme.desc}）`);
    return;
  }

  const r = await tftUseScheme(state, humanId, schemeId, fromCell, cellIndex);
  tftClearSchemeSelection();
  if (!r.ok) {
    tftToast(r.reason);
  } else {
    tftToast(r.success ? `✅ ${r.text}` : `❌ ${r.text}`);
  }
  tftRenderAll(state);
  tftHandleGameOverIfNeeded(state); // 懐柔・扇動で勝利セル数に到達した場合
}

// 経路構築中のクリック処理: tip（経路末尾）の再クリックで短縮/解除、それ以外は隣接マスへの延長のみ受け付ける
function tftHandleRouteClick(state, cellIndex) {
  const humanId = tftUi.myPlayerId;
  const route = tftUi.routeInProgress;
  const tip = route[route.length - 1];

  if (cellIndex === tip) {
    if (route.length === 1) {
      tftClearRouteSelection();
      tftToast('選択を解除しました');
    } else {
      route.pop();
      tftToast('経路を1マス短縮しました');
    }
    tftRenderAll(state);
    return;
  }

  if (state.cells[tip].ownerId !== humanId) {
    tftToast('侵攻対象を確定済みです。出陣するか、取消してください');
    return;
  }
  if (route.includes(cellIndex)) { tftToast('同じマスは経路に含められません'); return; }
  if (!tftIsAdjacent(tip, cellIndex)) { tftToast('経路の続きにできるのは隣接マスだけです'); return; }

  route.push(cellIndex);
  tftRenderAll(state);
}

// ============ 勝敗画面 ============

function tftShowGameOver(state) {
  // 進行中のバトルモーダル（本拠地喪失の瞬間などに開いたまま）を強制的に閉じる
  if (typeof tftBattleView !== 'undefined') {
    tftBattleView.queue = [];
    if (tftBattleView.timer) clearTimeout(tftBattleView.timer);
    tftBattleView.active = false;
  }
  const modal = document.getElementById('tft-battle-modal');
  if (modal) modal.style.display = 'none';

  const winEl = document.getElementById('tft-winner-text');
  const subEl = document.getElementById('tft-winner-sub');
  if (state.winner !== null) {
    const w = state.players[state.winner];
    winEl.textContent = `🏆 ${w.name} の勝利！`;
    winEl.style.color = w.color;
    const reasonTexts = {
      lastboss: 'TFT帝国を打ち倒した！ タイセリオンに平和が戻った',
      elimination: '他の全勢力を打ち破った！',
      cells: `${TFT_WIN_CELL_COUNT}マスを制圧した！`,
      turnlimit: `${state.turn}ターンの戦いが終わった…（最多マス数で勝利）`,
    };
    subEl.textContent = reasonTexts[state.winnerReason] || '';
    if (w.isHuman) SoundFX.fx.win(); else SoundFX.fx.lose();
  } else {
    winEl.textContent = '引き分け';
    subEl.textContent = '';
    SoundFX.fx.draw();
  }
  tftShowScreen('tft-screen-over');
}

// ============ ゲームガイド（行動ログの下の常設ヘルプ） ============
// 文言はバランス定数から生成し、調整しても表示が実装とズレないようにする。

// SYNERGY_RULES の閾値1段を「DEF+35%」等の効果文字列にする
function tftSynergyThresholdText(rule, t) {
  if (rule.type === 'multiplier') return `${t.stat.toUpperCase()}+${Math.round(t.multiplier * 100)}%`;
  if (rule.type === 'heal') return `毎ラウンド全員HP+${t.healPerTurn}`;
  if (rule.type === 'berserker') return `HP50%以下でATK+${Math.round(t.bonus * 100)}%`;
  if (rule.type === 'shield') return `開幕シールド${Math.round(t.shieldPct * 100)}%HP`;
  return '';
}

function tftRenderGameGuide() {
  const el = document.getElementById('tft-game-guide');
  if (!el) return;

  const rules = [
    ['🏆 勝利条件', `${TFT_CPU_FACTIONS.find(f => f.kind === 'lastboss').name}（${tftCellLabel(TFT_CPU_FACTIONS.find(f => f.kind === 'lastboss').home)}）の撃破で即勝利。${TFT_WIN_CELL_COUNT}マス占領、他勢力の全滅、または${TFT_MAX_TURNS}ターン終了時に最多マスでも勝利。本拠地を落とされると脱落`],
    ['🛡️ 開幕保護', `最初の${TFT_HOME_PROTECT_YEARS}年（${TFT_HOME_PROTECT_LAST_TURN}ターン目＝1年12月まで）は全勢力の本拠地が不可侵で、侵攻も計略も通らない。`
      + `CPUも同じ制限を受ける（あなたの本拠地も守られる）。${TFT_HOME_PROTECT_YEARS + 1}年1月＝${TFT_HOME_PROTECT_LAST_TURN + 1}ターン目から解禁。保護中の本拠地は盤面で🛡️`],
    ['🗝 ボスの階段', `盤面には常設のCPU7勢力が居る。`
      + `${TFT_CPU_FACTIONS.filter(f => f.kind === 'normal').map(f => tftCellLabel(f.home)).join('/')} の通常CPUをどれか1つ撃破 → ${TFT_KEY_ITEMS.GREEN.icon}${TFT_KEY_ITEMS.GREEN.name} で `
      + `${TFT_CPU_FACTIONS.filter(f => f.kind === 'midboss').map(f => `${f.name}(${tftCellLabel(f.home)})`).join('・')} に侵攻可能 → どちらか1つ撃破 → ${TFT_KEY_ITEMS.BLACK.icon}${TFT_KEY_ITEMS.BLACK.name} で TFT帝国 に侵攻可能。`
      + `鍵で封じられるのはボスの本拠地だけで、ボスが外へ広げた領土には鍵なしで攻め込める。鍵は装備も出品もできない`],
    ['🤝 CPU同士', `常設CPU7勢力は互いに侵攻しない（中立地への拡張とあなたへの侵攻はしてくる）。TFT帝国は侵攻も内政もせず本拠地に籠もる`],
    ['⚡ 行動力(AP)', `マスごとに上限${TFT_CELL_AP_MAX}・毎ターン+${TFT_CELL_AP_REGEN}回復。建設・雇用・研究・探索・出陣・計略はそのマスのAPを消費。上限で無駄になる回復分は自動探索（+${TFT_AP_OVERFLOW_GOLD_RANGE[0]}〜${TFT_AP_OVERFLOW_GOLD_RANGE[1]}G）に変わる`],
    ['📅 暦', `1ターン＝1ヶ月（T1が1年目1月）。収入は季節でまとまって入る: 金は${TFT_GOLD_INCOME_MONTHS.join('/')}月、食料の収穫は${TFT_FOOD_HARVEST_MONTHS.join('/')}月。維持費は毎月かかるので、収穫で備蓄して次の収穫まで凌ぐ`],
    ['💰 収入', `${TFT_GOLD_INCOME_MONTHS.join('/')}月に 所有マス×${TFT_INCOME_PER_CELL}G ＋ 町の効果（Lv1/2/3 = +${TFT_TOWN_INCOME_TABLE[1]}/+${TFT_TOWN_INCOME_TABLE[2]}/+${TFT_TOWN_INCOME_TABLE[3]}G）がまとめて入る`],
    ['🌾 食料', `${TFT_FOOD_HARVEST_MONTHS.join('/')}月に農場が収穫（Lv1/2/3 = +${TFT_FARM_INCOME_TABLE[1]}/+${TFT_FARM_INCOME_TABLE[2]}/+${TFT_FARM_INCOME_TABLE[3]}）。維持費は毎月（ユニットはランク比例${TFT_UPKEEP_BY_RANK[1]}〜${TFT_UPKEEP_BY_RANK[8]}＋所有マス×${TFT_UPKEEP_PER_CELL}）。商人・探索でも確保できる。不足するとユニットが疲労し全領土の支持率-${TFT_SUPPORT_SHORTAGE_PENALTY}`],
    ['💪 疲労', `戦闘に参加するたび最大HP-${Math.round(TFT_FATIGUE_STEP * 100)}%（下限${Math.round(TFT_FATIGUE_FLOOR * 100)}%）。本拠地へ戻すと即全回復`],
    ['🏋️ レベル', `ユニットは戦闘か訓練で成長。勝って生き残ると経験値（強敵ほど多い）、または自領マスのAP${TFT_TRAIN_AP_COST}だけで即+1レベル（金は不要）。1レベルごとに全ステータス+${Math.round(TFT_LEVEL_STAT_STEP * 100)}%（最大Lv${TFT_LEVEL_MAX}＝+${Math.round(TFT_LEVEL_STAT_STEP * (TFT_LEVEL_MAX - 1) * 100)}%）。シナジー・アイテムの上に乗算で乗る`],
    ['📊 支持率', `マスごと0〜100。平時は標準値${TFT_SUPPORT_BASELINE}へ収束する（下回ると毎ターン+${TFT_SUPPORT_REGEN}回復、宣撫工作等で上回った分は毎ターン-${TFT_SUPPORT_DECAY}減衰）。侵攻するたび全自領-${TFT_SUPPORT_INVADE_PENALTY}、食料不足で-${TFT_SUPPORT_SHORTAGE_PENALTY}（そのターンは回復もなし）。低いマスは計略（引き抜き≤${TFT_SUPPORT_POACH_MAX}・扇動≤${TFT_SUPPORT_AGITATE_MAX}）の標的になる`],
    ['📜 計略', `計略研究で順に解禁: ${TFT_SCHEME_LEVEL_LABELS.join(' → ')}。対象は盤面のどこでもよく、失敗してもAPは消費する`],
    ['🔨 オークション', `毎ターン1点出品・最大${TFT_AUCTION_MAX_LOTS}点が同時進行し${TFT_AUCTION_DURATION}ターンで締切。入札はAP不要・即時徴収（競り負けたら自動返金）。自分のアイテムも出品でき、落札されれば代金が入る（流札なら手元に戻る）`],
    ['🔬 研究', `系統ごとにR${TFT_MAX_RESEARCHABLE_RANK}まで段階解禁（R${MAX_RANK}はヒーロー専用枠）。建設と同じ着工制で、完成までターンがかかる`],
    ['👹 モンスター', `中立地に侵攻すると出現（ターン経過でランク・体数が増える）。討伐すると食料ボーナス、${Math.round(TFT_ITEM_DROP_CAPTURE * 100)}%でアイテム入手`],
    ['⚔️ バトル', `1マスの駐留は最大${TFT_GARRISON_MAX}体。防衛側は常にDEF+${Math.round(DEFENDER_DEF_BONUS * 100)}%。同じユニットを複数編成してもシナジーは1体分しか数えない`],
  ];
  const rulesHtml = rules.map(([title, desc]) =>
    `<div class="tft-guide-row"><b>${title}</b><span>${desc}</span></div>`).join('');

  const synHtml = SYNERGY_RULES.map(rule => {
    const steps = [...rule.thresholds].sort((a, b) => a.count - b.count)
      .map(t => `${t.count}体: ${tftSynergyThresholdText(rule, t)}`).join(' ／ ');
    return `<div class="tft-guide-row"><b>${rule.classId}</b><span>${steps}</span></div>`;
  }).join('');

  el.innerHTML = `
    <div class="tft-guide-col">
      <h3 class="section-title">📖 ゲームルール</h3>
      ${rulesHtml}
    </div>
    <div class="tft-guide-col">
      <h3 class="section-title">✨ シナジー一覧（同クラスのユニット数で発動）</h3>
      ${synHtml}
    </div>`;
}

// ============ ルールブック（読み物版。ゲーム中の常設早見ガイド tftRenderGameGuide とは別物で、
// ロビー/ゲーム中どちらからも開ける独立画面。内容はすべてバランス定数から生成し実装とのズレを防ぐ） ============

// ルールブックを開く。fromScreenId は「戻る」で復帰する元の画面id。
function tftOpenRulebook(fromScreenId) {
  tftUi.rulebookReturn = fromScreenId;
  tftRenderRulebook();
  tftShowScreen('tft-screen-rules');
}

function tftRenderRulebook() {
  const el = document.getElementById('tft-rulebook');
  if (!el) return;

  const lastBoss = TFT_CPU_FACTIONS.find(f => f.kind === 'lastboss');
  const sections = [
    ['🏆 ゲームの目的・勝利条件',
      `盤面の中心 ${tftCellLabel(lastBoss.home)} に座す「${lastBoss.name}」を撃破すれば即勝利。`
      + `それ以外にも ${TFT_WIN_CELL_COUNT}マスの占領、他の全勢力の脱落、${TFT_MAX_TURNS}ターン終了時点で最多マスのいずれかで勝利となる。`
      + `自分の本拠地を陥落させられると即座に脱落する（残りの領土は本拠地以外すべて中立化する）。`],
    ['🛡️ 開幕保護（最初の1年）',
      `ゲーム開始から${TFT_HOME_PROTECT_YEARS}年のあいだ（${TFT_HOME_PROTECT_LAST_TURN}ターン目＝1年12月まで）は、全勢力の本拠地が不可侵になる。`
      + `この期間は本拠地へ侵攻できず、計略（扇動・引き抜き等）も通らない。制限はCPUにも等しくかかるので、`
      + `あなたの本拠地が序盤に落とされて何もできないまま脱落する事故は起きない。`
      + `保護されている本拠地は盤面で🛡️と表示され、画面上部にも残り月数が出る。`
      + `${TFT_HOME_PROTECT_YEARS + 1}年1月（${TFT_HOME_PROTECT_LAST_TURN + 1}ターン目）から通常どおり侵攻・計略の対象になる。`
      + `保護されるのは本拠地セルそのものだけで、本拠地以外の領土は最初から奪い合いの対象。`],
    ['🗺️ 盤面と勢力',
      `盤面は${TFT_NUM_ROWS}行のハニカム（${TFT_CELLS}マス）。プレイヤーは開始候補${TFT_PLAYER_START_CELLS.map(tftCellLabel).join('/')}のいずれかからランダムに始まり、`
      + `常設のCPU7勢力（通常CPU4・中ボス2・ラスボス1）が最初から盤面に存在する。`
      + `通常CPU（${TFT_CPU_FACTIONS.filter(f => f.kind === 'normal').map(f => tftCellLabel(f.home)).join('/')}）をどれか1つ撃破すると${TFT_KEY_ITEMS.GREEN.icon}${TFT_KEY_ITEMS.GREEN.name}を入手し、`
      + `中ボス（${TFT_CPU_FACTIONS.filter(f => f.kind === 'midboss').map(f => `${f.name} ${tftCellLabel(f.home)}`).join('・')}）の本拠地に侵攻できるようになる。`
      + `中ボスのどちらかを撃破すると${TFT_KEY_ITEMS.BLACK.icon}${TFT_KEY_ITEMS.BLACK.name}を入手し、ラスボス「${lastBoss.name}」に侵攻できる。`
      + `鍵で封じられるのはボスの本拠地セルだけで、ボスが外へ広げた領土には鍵なしで攻め込める（鍵は装備も出品もできない特殊アイテム）。`
      + `常設CPU7勢力は互いに侵攻しない（中立地への拡張とプレイヤーへの侵攻はする）。ラスボスは侵攻も内政も計略も一切しない。`],
    ['📅 ターンと暦',
      `1ターン＝1ヶ月で、ターン1が1年目1月（${TFT_MAX_TURNS}ターン＝約${Math.ceil(TFT_MAX_TURNS / TFT_MONTHS_PER_YEAR)}年）。`
      + `収入は毎ターン平坦には入らず季節でまとまる: 金は${TFT_GOLD_INCOME_MONTHS.join('/')}月、食料の収穫は${TFT_FOOD_HARVEST_MONTHS.join('/')}月。`
      + `一方で維持費は毎月かかるため、収穫でしっかり備蓄して次の収穫まで凌ぐ計画性が問われる。`],
    ['⚡ 行動力(AP)と操作',
      `ユニット単位の「1ターン1行動」制限は無く、代わりにセル（領土）ごとにAPを持つ（上限${TFT_CELL_AP_MAX}・毎ターン+${TFT_CELL_AP_REGEN}回復）。`
      + `建設・雇用・研究・訓練・探索・市場取引・出陣・計略はすべてそのセルのAPを消費する（計略のみ種別ごとに個別コスト）。`
      + `AP上限に無駄なく達すると少額の金を自動探索する（+${TFT_AP_OVERFLOW_GOLD_RANGE[0]}〜${TFT_AP_OVERFLOW_GOLD_RANGE[1]}G）。`
      + `セルを占領すると新所有者のAPは0にリセットされる。`
      + `操作は「盤面のセルを選ぶ→サイドパネルにそのセルで可能な行動が並ぶ」の一本道。出陣だけは駐留一覧のチェックボックスで対象を選び、隣接する自領セルを辿って経路を伸ばし、出陣バーの「⚔️ 出陣」で実行する。`],
    ['💰 経済',
      `${TFT_GOLD_INCOME_MONTHS.join('/')}月に「所有マス数×${TFT_INCOME_PER_CELL}G」＋町の効果（Lv1/2/3＝+${TFT_TOWN_INCOME_TABLE[1]}/+${TFT_TOWN_INCOME_TABLE[2]}/+${TFT_TOWN_INCOME_TABLE[3]}G）がまとめて入る。`
      + `${TFT_FOOD_HARVEST_MONTHS.join('/')}月に農場が収穫（Lv1/2/3＝+${TFT_FARM_INCOME_TABLE[1]}/+${TFT_FARM_INCOME_TABLE[2]}/+${TFT_FARM_INCOME_TABLE[3]}）。維持費は毎月（ユニットはランク比例${TFT_UPKEEP_BY_RANK[1]}〜${TFT_UPKEEP_BY_RANK[8]}＋所有マス×${TFT_UPKEEP_PER_CELL}）。`
      + `建設・研究は着工制で、着手時に全額支払い、指定ターン数後に完成する。`
      + `NPC商人と食料10単位で売買もできる（在庫が少ないほど高騰・在庫連動レート）。探索でAPを消費して金や食料をランダムに得ることもできる。`],
    ['⚔️ 軍事',
      `雇用は自領セルでAP・金を払って即座に加入。1セルの駐留上限は${TFT_GARRISON_MAX}体。出陣・移動は経路を伸ばして実行し、経路上の自領セルすべてのAPを消費する。`
      + `戦闘に参加したユニットは疲労が溜まり最大HPが下がる（1回ごとに-${Math.round(TFT_FATIGUE_STEP * 100)}%、下限${Math.round(TFT_FATIGUE_FLOOR * 100)}%）。本拠地へ戻すと即全回復する。`
      + `防衛側には常にDEF+${Math.round(DEFENDER_DEF_BONUS * 100)}%のボーナスが付く。中立セルへの侵攻ではモンスターが出現し、ターン経過でランク・体数が増える（討伐で食料ボーナスと${Math.round(TFT_ITEM_DROP_CAPTURE * 100)}%のアイテムドロップ）。`
      + `CPU勢力の本拠地は攻撃されるたびに固定編成の守備隊が湧く（実際の駐留とは無関係。通常CPUはランク${TFT_HOME_GUARD_RANKS.join('-')}のランダム5体、中ボス・ラスボスはそれぞれ最上位ランクの全5系統）。`],
    ['🏋️ 成長',
      `ユニットは戦闘か訓練で成長する。戦闘に勝って生き残ると倒した相手のコスト合計に応じた経験値（強敵ほど多い）を得て、閾値に達すると自動でレベルアップする。`
      + `訓練は駐留セルのAP${TFT_TRAIN_AP_COST}だけで即+1レベル（金は不要）。レベルごとに全ステータス（HP/ATK/DEF/SPD）が+${Math.round(TFT_LEVEL_STAT_STEP * 100)}%（最大Lv${TFT_LEVEL_MAX}＝+${Math.round(TFT_LEVEL_STAT_STEP * (TFT_LEVEL_MAX - 1) * 100)}%）で、シナジー・アイテムの効果の上に乗算で乗る。`
      + `別軸として系統ごとの研究があり、R${TFT_MAX_RESEARCHABLE_RANK}まで段階的に解禁できる（R${MAX_RANK}のヒーローユニットのみ研究とは別の専用条件で解禁）。`],
    ['📊 支持率と計略',
      `セルごとに支持率(0〜100)を持ち、平時は基準値${TFT_SUPPORT_BASELINE}へ双方向に収束する（下回れば毎ターン+${TFT_SUPPORT_REGEN}回復、宣撫工作等で上回った分は毎ターン-${TFT_SUPPORT_DECAY}で減衰）。`
      + `100は計略でしか作れず一時的にしか維持できない。侵攻するたび攻撃側の全自領が-${TFT_SUPPORT_INVADE_PENALTY}、食料不足のセルは-${TFT_SUPPORT_SHORTAGE_PENALTY}（そのターンは回復もない）。`
      + `低い支持率のセルほど計略（引き抜き≤${TFT_SUPPORT_POACH_MAX}・扇動≤${TFT_SUPPORT_AGITATE_MAX}）の標的になりやすい。計略は専用の研究で段階的に解禁し、射程は盤面のどこでもよい（失敗してもAPは消費する）。`],
    ['🔨 オークション',
      `毎ターン1点ずつ新規出品され、最大${TFT_AUCTION_MAX_LOTS}点まで同時進行し、出品から${TFT_AUCTION_DURATION}ターンで締切。入札はAP不要・即時徴収で、競り負けると自動返金される。`
      + `自分のインベントリのアイテムも出品でき、落札されれば代金が入り、流札なら手元に戻る。`],
  ];
  const sectionsHtml = sections.map(([title, body]) =>
    `<section class="tft-rulebook-section"><h2 class="section-title">${title}</h2><p>${body}</p></section>`).join('');

  // 早見表①: シナジー段階（クラスごとに count 昇順で発動条件と効果を列挙）
  const synergyTableRows = SYNERGY_RULES.map(rule => {
    const steps = [...rule.thresholds].sort((a, b) => a.count - b.count)
      .map(t => `<div>${t.count}体: ${tftSynergyThresholdText(rule, t)}</div>`).join('');
    return `<tr><th>${rule.classId}</th><td>${steps}</td></tr>`;
  }).join('');

  // 早見表②: 計略の研究連鎖（段階と、その段階で解禁される効果の対応）
  const schemeTableRows = TFT_SCHEME_LEVEL_LABELS.map((label, i) => {
    const lv = i + 1;
    const scheme = TFT_SCHEMES.find(s => s.level === lv);
    const effect = scheme
      ? `${scheme.icon} ${scheme.name}（AP${scheme.ap}・成功率${Math.round(scheme.chance * 100)}%・対象:${scheme.target === 'own' ? '自領' : scheme.target === 'neutral' ? '中立地' : '敵領土'}）<br>${scheme.desc}`
      : '（支持率低下量が強化される段階。新規効果なし）';
    return `<tr><th>Lv${lv} ${label}</th><td>研究${TFT_SCHEME_RESEARCH_COST[i]}G・${TFT_SCHEME_RESEARCH_DURATION[i]}ターン</td><td>${effect}</td></tr>`;
  }).join('');

  // 早見表③: ステータスティア（STAT_TIERS）とランク別の維持費・MP
  const statRowsHtml = Object.entries(STAT_TIERS).map(([stat, tiers]) =>
    `<tr><th>${stat.toUpperCase()}</th>${tiers.map(v => `<td>${v}</td>`).join('')}</tr>`).join('');
  const rankHeaderHtml = Array.from({ length: MAX_RANK }, (_, i) => `<th>R${i + 1}</th>`).join('');
  const upkeepRowHtml = Array.from({ length: MAX_RANK }, (_, i) => `<td>${TFT_UPKEEP_BY_RANK[i + 1]}</td>`).join('');
  const mpRowHtml = Array.from({ length: MAX_RANK }, (_, i) => `<td>${TFT_MP_BY_RANK[i + 1]}</td>`).join('');

  el.innerHTML = `
    ${sectionsHtml}
    <section class="tft-rulebook-section">
      <h2 class="section-title">✨ 早見表: シナジー段階</h2>
      <div class="tft-rulebook-table-wrap"><table class="tft-rulebook-table">
        <tbody>${synergyTableRows}</tbody>
      </table></div>
    </section>
    <section class="tft-rulebook-section">
      <h2 class="section-title">📜 早見表: 計略の研究連鎖</h2>
      <div class="tft-rulebook-table-wrap"><table class="tft-rulebook-table">
        <thead><tr><th>段階</th><th>研究</th><th>効果</th></tr></thead>
        <tbody>${schemeTableRows}</tbody>
      </table></div>
    </section>
    <section class="tft-rulebook-section">
      <h2 class="section-title">📈 早見表: ステータスティアとランク</h2>
      <div class="tft-rulebook-table-wrap"><table class="tft-rulebook-table">
        <thead><tr><th></th>${rankHeaderHtml}</tr></thead>
        <tbody>
          ${statRowsHtml}
          <tr><th>維持費/月</th>${upkeepRowHtml}</tr>
          <tr><th>MP上限</th>${mpRowHtml}</tr>
        </tbody>
      </table></div>
      <div class="tft-panel-help">STAT_TIERSは各ステータスが取り得る値の並び。個々のユニットのHP/ATK/DEF/SPDは必ずこの並びのいずれかの値に揃えてある（アイテムの段階アップもこの並びに沿って1段ずつ上がる）</div>
    </section>
  `;
}

// ============ 初期化 ============

function tftInit() {
  tftRenderLobby();
  tftShowScreen('tft-screen-lobby');
  tftRenderGameGuide();

  document.getElementById('tft-btn-start').addEventListener('click', tftLobbyStart);
  document.getElementById('tft-btn-restart').addEventListener('click', () => location.reload());

  document.getElementById('tft-deploy-confirm').addEventListener('click', () => tftConfirmDeploy(tftGame));
  document.getElementById('tft-deploy-cancel').addEventListener('click', () => tftCancelDeploy(tftGame));

  document.getElementById('tft-btn-rules-lobby').addEventListener('click', () => tftOpenRulebook('tft-screen-lobby'));
  document.getElementById('tft-btn-rules-game').addEventListener('click', () => tftOpenRulebook('tft-screen-game'));
  document.getElementById('tft-btn-rules-back').addEventListener('click', () => tftShowScreen(tftUi.rulebookReturn || 'tft-screen-lobby'));

  document.getElementById('tft-btn-online').addEventListener('click', tftOnlineShow);

  const soundBtn = document.getElementById('tft-btn-sound');
  const syncSoundBtn = () => { soundBtn.textContent = SoundFX.isEnabled() ? '🔊' : '🔇'; };
  soundBtn.addEventListener('click', () => { SoundFX.toggle(); syncSoundBtn(); });
  syncSoundBtn();
}

document.addEventListener('DOMContentLoaded', tftInit);
