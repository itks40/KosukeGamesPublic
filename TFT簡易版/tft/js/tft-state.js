// ============================================================
// TFT のゲーム状態（GameState）生成・クエリ・経済処理。
// バトル解決そのものは tft-battle.js に委ねる（ここは純粋な状態層）。
// ============================================================

let tftUidCounter = 0;
function tftNewUid(playerId) { return `u_p${playerId}_${tftUidCounter++}`; }

// UNITS_DATA のベースユニットから TFT 管理ユニットを作る
function tftMakeUnit(baseUnit, playerId, pos) {
  return { ...baseUnit, uid: tftNewUid(playerId), pos, fatigue: 0, level: 1, xp: 0 };
}

// ユニットにXPを加算し、閾値を超えたぶんレベルを上げる。上がったレベル数を返す（ログ・演出用）。
// level/xp は個体に永続する動的フィールド（疲労と同じ系列）。
function tftGainXp(unit, amount) {
  if ((unit.level || 1) >= TFT_LEVEL_MAX) return 0;
  unit.xp = (unit.xp || 0) + amount;
  let ups = 0;
  while (unit.level < TFT_LEVEL_MAX && unit.xp >= tftLevelXpNeeded(unit.level)) {
    unit.xp -= tftLevelXpNeeded(unit.level);
    unit.level++;
    ups++;
  }
  if (unit.level >= TFT_LEVEL_MAX) unit.xp = 0; // 最大レベルでXPを溜め続けない
  return ups;
}

// 初期ロスター: 研究前提のためランク1のみで25G分を編成（本拠地の駐留上限5体まで）。
// モンスター(isMonster)は中立地に湧く専用ユニットのためプレイヤーの編成対象から除外する。
function tftInitialRoster(playerId, homeCell) {
  const pool = UNITS_DATA.filter(u => u.rank === 1 && !u.isMonster);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  let budget = TFT_START_GOLD;
  const roster = [];
  for (const base of shuffled) {
    if (roster.length >= TFT_GARRISON_MAX) break;
    if (base.cost <= budget) {
      roster.push(tftMakeUnit(base, playerId, homeCell));
      budget -= base.cost;
    }
  }
  return { roster, goldLeft: budget };
}

// 初期状態を生成。slots は ['human'|'off'] × TFT_NUM_PLAYER_SLOTS（P1=human固定）。
// プレイヤー枠(id 0..3)には TFT_PLAYER_START_CELLS からランダムに本拠地を割り当て、
// 続けて常設CPU勢力(id 4..10)を TFT_CPU_FACTIONS の定義通りに配置する（人数に関係なく常に居る）。
function tftCreateState(slots, turnMs) {
  const cells = [];
  for (let i = 0; i < TFT_CELLS; i++) {
    cells.push({
      index: i,
      row: tftRowOf(i),
      seat: tftSeatOf(i),
      ownerId: TFT_INITIAL_OWNER[i],
      facilities: [],
      townLevel: 0,
      farmLevel: 0,
      townBuild: null,
      farmBuild: null,
      capturedThisTurn: false,
      ap: TFT_CELL_AP_START,
      support: TFT_SUPPORT_START, // 支持率(0-100)。所有セルのみ意味を持つ
    });
  }

  // 勢力ごとの席（本拠地・種別・参加有無）を先に確定させる
  const startCells = [...TFT_PLAYER_START_CELLS].sort(() => Math.random() - 0.5);
  const seats = [];
  for (let i = 0; i < TFT_NUM_PLAYER_SLOTS; i++) {
    seats.push({ kind: 'player', homeCell: startCells[i], isHuman: slots[i] === 'human', absent: slots[i] === 'off' });
  }
  for (const f of TFT_CPU_FACTIONS) {
    seats.push({ kind: f.kind, homeCell: f.home, isHuman: false, absent: false });
  }

  const players = seats.map((seat, id) => {
    const research = {};
    for (const lid of TFT_LINEAGE_IDS) research[lid] = 1;
    const heroUnlocked = {};
    for (const lid of TFT_LINEAGE_IDS) heroUnlocked[lid] = false;
    return {
      id,
      kind: seat.kind,        // TFT_FACTION_KINDS のキー（player/normal/midboss/lastboss）
      // 「（あなた）」はここでは付けない。stateは複数人間で共有される単一オブジェクトなので、
      // 生成時に付与すると「自分」の意味を持てない（オンライン対戦で全人間プレイヤーに付いてしまう）。
      // 「自分は誰か」はクライアントローカルな tftUi.myPlayerId で判定し、表示側（HUD等）で付与する。
      name: TFT_PLAYER_NAMES[id],
      isHuman: seat.isHuman,
      color: TFT_PLAYER_COLORS[id],
      gold: TFT_START_GOLD,
      food: TFT_START_FOOD,
      homeCell: seat.homeCell,
      research,
      researchInProgress: {},
      heroUnlocked,
      schemeLevel: 0,         // 計略研究の到達段階（0=未研究、1..TFT_SCHEME_MAX_LEVEL）
      schemeInProgress: null, // { targetLevel, turnsLeft } | null
      roster: [],
      items: [], // 未装備アイテムのインベントリ（装備すると unit.item へ移る）
      eliminated: seat.absent,
    };
  });

  // 初期領土は本拠地1マスのみ。'off' のプレイヤー枠は本拠地も中立のまま
  // （＝使われなかった開始候補マスは、ただの中立地として盤面に残る）
  for (const p of players) {
    if (!p.eliminated) cells[p.homeCell].ownerId = p.id;
  }

  for (const p of players) {
    if (p.eliminated) continue;
    // ラスボスは動かないので遠征ロスターを持たない（本拠地は tftSpawnHomeGuard の固定編成が守る）。
    // ロスターが空なら食料維持費も発生しないが、そもそも経済ティック自体の対象外にしてある。
    if (TFT_FACTION_KINDS[p.kind].passive) continue;
    const { roster, goldLeft } = tftInitialRoster(p.id, p.homeCell);
    p.roster = roster;
    p.gold = goldLeft;
  }

  return {
    turn: 1,
    phase: TFT_PHASE.LOBBY,
    turnBoundaryAt: 0,
    turnMs,
    cells,
    players,
    merchant: { food: TFT_MERCHANT_FOOD_BASELINE }, // NPC商人（全プレイヤー共有の食料市場）
    auction: { lots: [] }, // オークション（毎ターン+1点・最大TFT_AUCTION_MAX_LOTS点・4ターンで締切）
    actionLog: [],
    winner: null,
    humanPlayerId: 0,
  };
}

// --- クエリ ---

function tftOwnedCells(state, playerId) {
  return state.cells.filter(c => c.ownerId === playerId);
}

function tftCellCount(state, playerId) {
  return tftOwnedCells(state, playerId).length;
}

// セルに駐留しているユニット（全プレイヤー横断ではなく所有者のロスターから）
function tftGarrison(state, cellIndex) {
  const owner = state.cells[cellIndex].ownerId;
  if (owner === null) return [];
  return state.players[owner].roster.filter(u => u.pos === cellIndex);
}

// 自領土に隣接する敵/中立セル一覧（人間UI・AI共用）。
// このターン占領したばかりのセル(capturedThisTurn)は出撃元から除外する（連鎖突破の防止）。
function tftBorderTargets(state, playerId) {
  const targets = [];
  const seen = new Set();
  for (const cell of tftOwnedCells(state, playerId)) {
    if (cell.capturedThisTurn) continue;
    for (const nb of tftNeighbors(cell.index)) {
      const owner = state.cells[nb].ownerId;
      const key = cell.index + '->' + nb;
      if (owner !== playerId && !seen.has(key)) {
        seen.add(key);
        targets.push({ from: cell.index, to: nb });
      }
    }
  }
  return targets;
}

function tftActivePlayers(state) {
  return state.players.filter(p => !p.eliminated);
}

// 経済ティック（収入・食料・維持費）の対象。ラスボスは1マスに座り続けるだけなので除外する
// ―― 通常通り徴収すると農場を持たない帝国が毎月飢えて支持率が0まで落ち、計略で丸裸になってしまう。
function tftEconomyPlayers(state) {
  return tftActivePlayers(state).filter(p => !tftIsPassiveFaction(state, p.id));
}

function tftHasKey(state, playerId, keyId) {
  return state.players[playerId].items.some(i => i.id === keyId);
}

// ボス本拠地の鍵ロック。侵攻・計略できるなら null、できないなら理由の文字列を返す。
// ロックの対象はボスの「本拠地セルそのもの」だけで、中ボスが外へ広げた領土は鍵なしで攻められる。
// ボスが本拠地を失った後（＝別勢力の領土になった後）もロックしない。
function tftCellLockReason(state, playerId, cellIndex) {
  const owner = state.cells[cellIndex].ownerId;
  if (owner === null || owner === playerId || !tftIsCpuFaction(owner)) return null;
  const boss = state.players[owner];
  if (cellIndex !== boss.homeCell) return null;
  const lockKeyId = tftFactionKind(state, owner).lockKeyId;
  if (!lockKeyId || tftHasKey(state, playerId, lockKeyId)) return null;
  const key = tftKeyItemById(lockKeyId);
  return `${key.icon}${key.name}がないと ${tftCellLabel(cellIndex)}（${boss.name}）には手を出せません`;
}

function tftFindUnit(state, playerId, uid) {
  return state.players[playerId].roster.find(u => u.uid === uid) || null;
}

// --- 経路（出陣）のバリデーション（実行は tft-battle.js の tftExecuteRoute） ---

// 選択ユニットが単一セルに揃っているかを判定し、その起点セルを返す（揃っていなければ null）。
// 経路は単一の出発地からしか構築できない（複数セルに散らばった選択は不可）。
function tftSelectionOriginCell(state, playerId, unitUids) {
  const units = unitUids.map(uid => tftFindUnit(state, playerId, uid)).filter(Boolean);
  if (units.length === 0) return null;
  const pos = units[0].pos;
  return units.every(u => u.pos === pos) ? pos : null;
}

// 経路(path=セルindexの配列)の妥当性を検証する副作用なしの純粋関数。
// path[0] は選択ユニット全員の現在地と一致必須。最終セル以外はすべて自領セルである必要があり、
// 最終セルが非自領なら侵攻、自領なら移動として扱う。経路上の自領セル全て（出発地含む）の
// AP残量をチェックする（最終セルが非自領＝侵攻対象の場合はそのセル自体は課金対象にならない）。
function tftValidateRoute(state, playerId, path, unitUids) {
  const p = state.players[playerId];
  if (p.eliminated) return { ok: false, reason: '脱落しています' };
  if (!unitUids || unitUids.length === 0) return { ok: false, reason: 'ユニットを選んでください' };
  if (unitUids.length > MAX_TEAM_SIZE) return { ok: false, reason: `一度に動かせるのは最大${MAX_TEAM_SIZE}体までです` };
  if (!path || path.length < 2) return { ok: false, reason: '経路が短すぎます（隣接マスをクリックして伸ばしてください）' };

  const origin = tftSelectionOriginCell(state, playerId, unitUids);
  if (origin === null) return { ok: false, reason: '選択ユニットは同じマスにいる必要があります' };
  if (path[0] !== origin) return { ok: false, reason: '経路の起点が選択ユニットの現在地と一致しません' };

  const seen = new Set();
  for (let i = 0; i < path.length; i++) {
    if (seen.has(path[i])) return { ok: false, reason: '同じマスを2回通る経路は指定できません' };
    seen.add(path[i]);
    if (i > 0 && !tftIsAdjacent(path[i - 1], path[i])) {
      return { ok: false, reason: '隣接していないマスは経路に含められません' };
    }
  }

  for (let i = 0; i < path.length - 1; i++) {
    if (state.cells[path[i]].ownerId !== playerId) {
      return { ok: false, reason: '経路の途中は自分の領土である必要があります' };
    }
  }

  const finalCell = path[path.length - 1];
  const isAttack = state.cells[finalCell].ownerId !== playerId;
  const fromCell = path[path.length - 2];

  if (isAttack) {
    const validEdge = tftBorderTargets(state, playerId).some(t => t.from === fromCell && t.to === finalCell);
    if (!validEdge) {
      return { ok: false, reason: `${tftCellLabel(fromCell)} からは侵攻できません（占領直後、または隣接していません）` };
    }
    const lock = tftCellLockReason(state, playerId, finalCell);
    if (lock) return { ok: false, reason: lock };
  } else {
    const current = tftGarrison(state, finalCell).length;
    if (current + unitUids.length > TFT_GARRISON_MAX) {
      return { ok: false, reason: `1マスに駐留できるのは${TFT_GARRISON_MAX}体までです（${tftCellLabel(finalCell)}は残り${TFT_GARRISON_MAX - current}体分）` };
    }
  }

  const apCells = path.filter(idx => state.cells[idx].ownerId === playerId);
  const apCost = isAttack ? TFT_AP_COST.attack : TFT_AP_COST.move;
  for (const idx of apCells) {
    if (state.cells[idx].ap < apCost) {
      return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(idx)}: ${state.cells[idx].ap}/${TFT_CELL_AP_MAX}）` };
    }
  }

  return { ok: true, isAttack, finalCell, fromCell, apCells, apCost, path };
}

// 侵攻宣言のバリデーション（単一隣接ホップの薄いラッパー、AI・既存呼び出し向けに存続）。
function tftIsValidDeclaration(state, playerId, toCell, unitUids) {
  const origin = tftSelectionOriginCell(state, playerId, unitUids);
  if (origin === null) return { ok: false, reason: 'ユニットが同じマスにいません' };
  return tftValidateRoute(state, playerId, [origin, toCell], unitUids);
}

// --- 移動（単一隣接ホップの薄いラッパー。複数マスの経路は tftExecuteRoute を使う） ---

// 自領隣接セルへ移動する。本拠地へ移動した場合は疲労が即全回復する。
// 経路長2の tftValidateRoute で検証し、AP消費・位置更新はここで直接行う。
function tftMoveUnit(state, playerId, uid, toCell) {
  const unit = tftFindUnit(state, playerId, uid);
  if (!unit) return { ok: false, reason: 'ユニットが見つかりません' };
  const check = tftValidateRoute(state, playerId, [unit.pos, toCell], [uid]);
  if (!check.ok) return check;
  if (check.isAttack) return { ok: false, reason: '移動先が自領土ではありません' };
  for (const idx of check.apCells) state.cells[idx].ap -= check.apCost;
  unit.pos = toCell;
  const p = state.players[playerId];
  if (toCell === p.homeCell) unit.fatigue = 0; // 本拠地帰還は即休養
  return { ok: true };
}

// --- 経済 ---

// 所有セルの町/農場レベル合計（領土のどのセルに建てても集計される・UI表示用）
function tftBuildingLevelSum(state, playerId, kind) {
  return tftOwnedCells(state, playerId).reduce((s, c) => s + (kind === 'town' ? c.townLevel : c.farmLevel), 0);
}

// 所有セルの町/農場の効果合計（加速テーブル参照。収入・食料計算はこちらを使う）
function tftBuildingIncomeSum(state, playerId, kind) {
  const table = kind === 'town' ? TFT_TOWN_INCOME_TABLE : TFT_FARM_INCOME_TABLE;
  return tftOwnedCells(state, playerId).reduce((s, c) => s + table[kind === 'town' ? c.townLevel : c.farmLevel], 0);
}

// プレイヤーの毎ターン食料消費（ランク別ユニット消費の合計 + 所有セル数×TFT_UPKEEP_PER_CELL）。
// 状態層・HUD・AIで式がずれないよう単一の純粋関数に集約する。
// CPU本拠地の守備隊はスポーン方式でロスター非所属のため、消費に加算されない（意図通り）。
function tftFoodUpkeep(state, playerId) {
  const p = state.players[playerId];
  const unitUpkeep = p.roster.reduce((s, u) => s + (TFT_UPKEEP_BY_RANK[u.rank] || 1), 0);
  return unitUpkeep + tftCellCount(state, playerId) * TFT_UPKEEP_PER_CELL;
}

// ターン境界で呼ぶ収入処理: 所有セル数×TFT_INCOME_PER_CELL + 全セルの町の効果合計（収入月のみ）
function tftApplyIncome(state) {
  // 金は収入月（TFT_GOLD_INCOME_MONTHS = 1/4/7/10月）にだけ入る。
  // テーブルは1回あたり3ヶ月分に換算済みなので、年間総量は毎月配っていた頃と同じ。
  if (!tftIsGoldIncomeTurn(state.turn)) return;
  for (const p of tftEconomyPlayers(state)) {
    const townIncome = tftBuildingIncomeSum(state, p.id, 'town');
    p.gold += tftCellCount(state, p.id) * TFT_INCOME_PER_CELL + townIncome;
  }
}

// 食料の収穫（収穫月のみ）と維持費（毎月。不足分は未給養ユニットの疲労+1）。
// 収穫は年2回・維持費は毎月のため、収穫で備蓄して次の収穫まで凌ぐ必要がある。
function tftApplyFoodAndUpkeep(state) {
  const events = [];
  const isHarvest = tftIsFoodHarvestTurn(state.turn);
  for (const p of tftEconomyPlayers(state)) {
    if (isHarvest) p.food += tftBuildingIncomeSum(state, p.id, 'farm');
    const upkeep = tftFoodUpkeep(state, p.id);
    const paid = Math.min(p.food, upkeep);
    p.food -= paid;
    const shortage = upkeep - paid;
    if (shortage > 0) {
      // 未給養: ランダムに shortage 体の疲労+1
      const shuffled = [...p.roster].sort(() => Math.random() - 0.5);
      for (const u of shuffled.slice(0, shortage)) u.fatigue++;
      // 飢餓は民心を直撃: 全所有セルの支持率が下がる（そのターンの自然回復もターン境界側でスキップされる）
      for (const c of tftOwnedCells(state, p.id)) {
        c.support = Math.max(0, c.support - TFT_SUPPORT_SHORTAGE_PENALTY);
      }
      events.push({ playerId: p.id, shortage });
    }
  }
  return events;
}

// ユニット雇用（プレイヤーが選んだ自領セルに配置。系統の研究ランクを超えるユニットは雇用不可）。
// 配置先セル＝AP消費元セル（本拠地固定配置は廃止）。
function tftHireUnit(state, playerId, unitDataId, targetCellIndex) {
  const p = state.players[playerId];
  const base = UNITS_DATA.find(u => u.id === unitDataId);
  if (!base) return { ok: false, reason: 'ユニットが見つかりません' };
  if (base.isMonster) return { ok: false, reason: 'モンスターは雇用できません' };
  if (base.rank === 8) {
    if (!p.heroUnlocked[base.lineage.id]) return { ok: false, reason: 'ヒーローは条件を満たすまで雇用できません' };
  } else if (base.rank > p.research[base.lineage.id]) {
    return { ok: false, reason: 'そのランクは未解禁です（開発タブの研究で解禁）' };
  }
  if (p.roster.length >= TFT_ROSTER_MAX) return { ok: false, reason: `ユニットは最大${TFT_ROSTER_MAX}体までです` };
  if (p.gold < base.cost) return { ok: false, reason: 'ゴールドが足りません' };
  const cell = state.cells[targetCellIndex];
  if (!cell || cell.ownerId !== playerId) return { ok: false, reason: '自分の領土のマスにのみ配置できます' };
  if (tftGarrison(state, targetCellIndex).length >= TFT_GARRISON_MAX) {
    return { ok: false, reason: `このマスの駐留は${TFT_GARRISON_MAX}体が上限です` };
  }
  if (cell.ap < TFT_AP_COST.hire) {
    return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(targetCellIndex)}: ${cell.ap}/${TFT_CELL_AP_MAX}）` };
  }
  p.gold -= base.cost;
  cell.ap -= TFT_AP_COST.hire;
  p.roster.push(tftMakeUnit(base, playerId, targetCellIndex));
  return { ok: true, cellIndex: targetCellIndex };
}

// ユニットの解雇（購入コスト全額を返金してロスターから除外）。
// cellIndex は対象ユニットの現在地と一致必須（盤面でセルを選び、その駐留一覧から選ぶUXのため）。
// そのセルのAPを消費する。
function tftDismissUnit(state, playerId, uid, cellIndex) {
  const p = state.players[playerId];
  const idx = p.roster.findIndex(u => u.uid === uid);
  if (idx === -1) return { ok: false, reason: 'ユニットが見つかりません' };
  const unit = p.roster[idx];
  if (unit.pos !== cellIndex) return { ok: false, reason: '指定したマスにいないユニットです' };
  const cell = state.cells[cellIndex];
  if (!cell || cell.ownerId !== playerId) return { ok: false, reason: '自分の領土のマスではありません' };
  if (cell.ap < TFT_AP_COST.dismiss) {
    return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(cellIndex)}: ${cell.ap}/${TFT_CELL_AP_MAX}）` };
  }
  cell.ap -= TFT_AP_COST.dismiss;
  p.gold += unit.cost;
  p.roster.splice(idx, 1);
  return { ok: true, name: unit.name, refund: unit.cost };
}

// ユニットの訓練（そのマスのAPだけで即+1レベル。金は不要）。
// cellIndex は対象ユニットの現在地と一致必須（駐留一覧から選ぶUXのため）。xpは据え置き（次レベルへの進捗を保持）。
function tftTrainUnit(state, playerId, uid, cellIndex) {
  const p = state.players[playerId];
  const unit = p.roster.find(u => u.uid === uid);
  if (!unit) return { ok: false, reason: 'ユニットが見つかりません' };
  if (unit.pos !== cellIndex) return { ok: false, reason: '指定したマスにいないユニットです' };
  const cell = state.cells[cellIndex];
  if (!cell || cell.ownerId !== playerId) return { ok: false, reason: '自分の領土のマスではありません' };
  if ((unit.level || 1) >= TFT_LEVEL_MAX) return { ok: false, reason: `${unit.name}は既に最大レベル(Lv${TFT_LEVEL_MAX})です` };
  if (cell.ap < TFT_TRAIN_AP_COST) {
    return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(cellIndex)}: ${cell.ap}/${TFT_CELL_AP_MAX}、必要${TFT_TRAIN_AP_COST}）` };
  }
  cell.ap -= TFT_TRAIN_AP_COST;
  unit.level = (unit.level || 1) + 1;
  return { ok: true, name: unit.name, level: unit.level };
}

// 防衛設備の建設（自領土の任意セル・同一セル内で同種は1つ）
function tftBuildFacility(state, playerId, cellIndex, facilityId) {
  const p = state.players[playerId];
  const cell = state.cells[cellIndex];
  if (cell.ownerId !== playerId) return { ok: false, reason: '自領土にのみ建設できます' };
  if (cell.facilities.includes(facilityId)) return { ok: false, reason: 'このマスには建設済みです' };
  const facility = FACILITIES_LIST.find(f => f.id === facilityId);
  if (!facility) return { ok: false, reason: '設備が見つかりません' };
  if (p.gold < facility.cost) return { ok: false, reason: 'ゴールドが足りません' };
  if (cell.ap < TFT_AP_COST.facility) {
    return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(cellIndex)}: ${cell.ap}/${TFT_CELL_AP_MAX}）` };
  }
  p.gold -= facility.cost;
  cell.ap -= TFT_AP_COST.facility;
  cell.facilities.push(facilityId);
  return { ok: true };
}

// --- アイテム ---

// 指定したアイテムを1個付与する。人間はインベントリへ、CPUは未装備の自軍ユニット
// （コスト降順の先頭）へ即装備。装備先が無ければインベントリ保持。生成インスタンスを返す。
// 鍵だけは例外で、人間/CPUを問わず必ずインベントリへ入れる（CPUの自動装備に流れると
// tftHasKey の p.items 判定に引っかからなくなる）。同じ鍵は2本持たない。
function tftGrantSpecificItem(state, playerId, baseItem) {
  const p = state.players[playerId];
  const item = { ...baseItem };
  if (tftIsKeyItem(baseItem)) {
    if (tftHasKey(state, playerId, baseItem.id)) return null;
    p.items.push(item);
    return item;
  }
  if (p.isHuman) {
    p.items.push(item);
  } else {
    const target = p.roster.filter(u => !u.item).sort((a, b) => b.cost - a.cost)[0];
    if (target) target.item = item; else p.items.push(item);
  }
  return item;
}

// ランダムなアイテムを1個生成して付与する（プールから抽選するだけの薄いラッパー）
function tftGrantRandomItem(state, playerId) {
  const base = TFT_ITEM_POOL[Math.floor(Math.random() * TFT_ITEM_POOL.length)];
  return tftGrantSpecificItem(state, playerId, base);
}

// インベントリのアイテム（itemId で最初の1個）をユニットへ装備する。既存装備はインベントリへ戻す（付け替え）。
function tftEquipItem(state, playerId, uid, itemId) {
  const p = state.players[playerId];
  const unit = p.roster.find(u => u.uid === uid);
  if (!unit) return { ok: false, reason: 'ユニットが見つかりません' };
  const invIdx = p.items.findIndex(it => it.id === itemId);
  if (invIdx === -1) return { ok: false, reason: 'そのアイテムを所持していません' };
  const candidate = p.items[invIdx];
  if (tftIsKeyItem(candidate)) {
    return { ok: false, reason: `${candidate.name}は装備できません（持っているだけで効果があります）` };
  }
  if (candidate.lineage && unit.lineage.id !== candidate.lineage) {
    const label = Object.values(LINEAGES).find(l => l.id === candidate.lineage)?.label || candidate.lineage;
    return { ok: false, reason: `${candidate.name}は${label}専用の装備です` };
  }
  const item = p.items.splice(invIdx, 1)[0];
  if (unit.item) p.items.push(unit.item); // 付け替え: 元アイテムをインベントリへ戻す
  unit.item = item;
  return { ok: true, item, name: unit.name };
}

// ユニットの装備アイテムを外してインベントリへ戻す
function tftUnequipItem(state, playerId, uid) {
  const p = state.players[playerId];
  const unit = p.roster.find(u => u.uid === uid);
  if (!unit || !unit.item) return { ok: false, reason: '装備アイテムがありません' };
  const removed = unit.item;
  p.items.push(removed);
  unit.item = null;
  return { ok: true, item: removed, name: unit.name };
}

// ============================================================
// オークション（毎ターン+1点・最大TFT_AUCTION_MAX_LOTS点・4ターンで締切）
// ロットは system 出品（sellerId:null、TFT_ITEM_POOLから抽選）とプレイヤー出品
// （sellerId:playerId、インベントリのアイテムを出品）の2種類を同じ配列・同じ枠で扱う。
// ============================================================

let tftAuctionLotCounter = 0;
function tftNewAuctionLotId() { return tftAuctionLotCounter++; }

// 現在のロットに対する最低入札額（入札が無ければ基準額、あれば最高額+刻み幅）
function tftAuctionMinNextBid(lot) {
  return lot.highestBid > 0 ? lot.highestBid + TFT_AUCTION_BID_STEP : TFT_AUCTION_MIN_BID;
}

// system出品を1点追加（TFT_ITEM_POOLからランダム抽選）
function tftSpawnAuctionLot(state) {
  const base = TFT_ITEM_POOL[Math.floor(Math.random() * TFT_ITEM_POOL.length)];
  state.auction.lots.push({
    id: tftNewAuctionLotId(),
    item: { ...base },
    sellerId: null,
    startedTurn: state.turn,
    closesTurn: state.turn + TFT_AUCTION_DURATION,
    highestBid: 0,
    highestBidderId: null,
  });
}

// プレイヤーが自分のインベントリのアイテム（itemIndex）をオークションに出品する
function tftListItemForAuction(state, playerId, itemIndex) {
  const p = state.players[playerId];
  if (state.auction.lots.length >= TFT_AUCTION_MAX_LOTS) {
    return { ok: false, reason: 'オークションの出品枠が満員です' };
  }
  const item = p.items[itemIndex];
  if (!item) return { ok: false, reason: 'そのアイテムを所持していません' };
  if (tftIsKeyItem(item)) return { ok: false, reason: `${item.name}は出品できません` };
  p.items.splice(itemIndex, 1);
  state.auction.lots.push({
    id: tftNewAuctionLotId(),
    item,
    sellerId: playerId,
    startedTurn: state.turn,
    closesTurn: state.turn + TFT_AUCTION_DURATION,
    highestBid: 0,
    highestBidderId: null,
  });
  tftLogAction(state, {
    playerId, type: 'auction',
    text: `${p.name} が【${item.name}】をオークションに出品`,
    isHumanInvolved: playerId === state.humanPlayerId,
  });
  return { ok: true };
}

// 入札する。前の最高額入札者がいれば即時返金し、新しい入札者から即時徴収する。
function tftPlaceBid(state, playerId, lotId, amount) {
  const p = state.players[playerId];
  const lot = state.auction.lots.find(l => l.id === lotId);
  if (!lot) return { ok: false, reason: 'その出品は終了しています' };
  const minBid = tftAuctionMinNextBid(lot);
  if (amount < minBid) return { ok: false, reason: `最低入札額は${minBid}Gです` };
  if (p.gold < amount) return { ok: false, reason: 'ゴールドが足りません' };
  if (lot.highestBidderId === playerId) return { ok: false, reason: 'すでに最高額入札者です' };

  if (lot.highestBidderId !== null) {
    const prev = state.players[lot.highestBidderId];
    prev.gold += lot.highestBid; // 競り負けた入札金は即時返金
    if (lot.highestBidderId === state.humanPlayerId) {
      tftToast(`💸 【${lot.item.name}】で他プレイヤーに競り負けました（返金+${lot.highestBid}G）`);
    }
  }
  p.gold -= amount;
  lot.highestBid = amount;
  lot.highestBidderId = playerId;
  tftLogAction(state, {
    playerId, type: 'auction',
    text: `${p.name} が【${lot.item.name}】に${amount}Gで入札`,
    isHumanInvolved: playerId === state.humanPlayerId,
  });
  return { ok: true };
}

// ターン境界で呼ぶ: 締切到達ロットの解決（落札 or 流札）→ system出品の補充（毎ターン最大+1点）
function tftTickAuction(state) {
  const remaining = [];
  for (const lot of state.auction.lots) {
    if (state.turn < lot.closesTurn) { remaining.push(lot); continue; }
    if (lot.highestBidderId !== null) {
      const winner = state.players[lot.highestBidderId];
      tftGrantSpecificItem(state, lot.highestBidderId, lot.item);
      if (lot.sellerId !== null) state.players[lot.sellerId].gold += lot.highestBid; // 出品者へ代金
      tftLogAction(state, {
        playerId: lot.highestBidderId, type: 'auction',
        text: `${winner.name} が【${lot.item.name}】を${lot.highestBid}Gで落札`,
        isHumanInvolved: lot.highestBidderId === state.humanPlayerId || lot.sellerId === state.humanPlayerId,
      });
      if (lot.highestBidderId === state.humanPlayerId) {
        tftToast(`🔨 【${lot.item.name}】を${lot.highestBid}Gで落札！`);
      } else if (lot.sellerId === state.humanPlayerId) {
        tftToast(`🔨 出品した【${lot.item.name}】が${lot.highestBid}Gで売れました！`);
      }
    } else {
      if (lot.sellerId !== null) state.players[lot.sellerId].items.push(lot.item); // 流札: 出品者へ返却
      tftLogAction(state, {
        playerId: lot.sellerId, type: 'auction',
        text: `【${lot.item.name}】は入札者なく流札`,
        isHumanInvolved: lot.sellerId === state.humanPlayerId,
      });
    }
  }
  state.auction.lots = remaining;
  if (state.auction.lots.length < TFT_AUCTION_MAX_LOTS) tftSpawnAuctionLot(state);
}

// 探索: 指定セルのAPを消費し、金/食料/アイテムをランダムに獲得する（kind: 'gold'|'food'|'item'）
function tftExplore(state, playerId, cellIndex, kind) {
  const p = state.players[playerId];
  const cell = state.cells[cellIndex];
  if (cell.ownerId !== playerId) return { ok: false, reason: 'このマスはあなたの領土ではありません' };
  if (cell.ap < TFT_AP_COST.explore) return { ok: false, reason: '行動力(AP)が足りません' };
  cell.ap -= TFT_AP_COST.explore;

  // アイテム探索: 一定確率でランダムアイテムを入手（外れは何もなし）
  if (kind === 'item') {
    const item = Math.random() < TFT_ITEM_DROP_EXPLORE ? tftGrantRandomItem(state, playerId) : null;
    tftLogAction(state, {
      playerId,
      type: 'explore',
      text: `${p.name} が ${tftCellLabel(cellIndex)} でアイテム探索 → ${item ? `📦 ${item.icon}${item.name} を発見！` : '何も見つからなかった'}`,
      isHumanInvolved: playerId === state.humanPlayerId,
    });
    return { ok: true, kind, item };
  }

  const amount = tftRollExploreAmount(kind === 'gold' ? TFT_EXPLORE_GOLD_RANGE : TFT_EXPLORE_FOOD_RANGE);
  if (kind === 'gold') p.gold += amount; else p.food += amount;
  tftLogAction(state, {
    playerId,
    type: 'explore',
    text: `${p.name} が ${tftCellLabel(cellIndex)} で探索 → ${kind === 'gold' ? `💰+${amount}G` : `🌾+${amount}`}`,
    isHumanInvolved: playerId === state.humanPlayerId,
  });
  return { ok: true, kind, amount };
}

// 食料の売買: 指定セルのAPを消費し、NPC商人と食料10を金で売買する（action: 'buy'|'sell'）
function tftTradeFood(state, playerId, cellIndex, action) {
  const p = state.players[playerId];
  const cell = state.cells[cellIndex];
  const unit = TFT_MERCHANT_TRADE_UNIT;
  if (cell.ownerId !== playerId) return { ok: false, reason: 'このマスはあなたの領土ではありません' };
  if (cell.ap < TFT_AP_COST.trade) return { ok: false, reason: '行動力(AP)が足りません' };

  if (action === 'buy') {
    if (state.merchant.food < unit) return { ok: false, reason: '商人の在庫が不足しています' };
    const price = tftMerchantBuyPrice(state.merchant.food);
    if (p.gold < price) return { ok: false, reason: 'ゴールドが足りません' };
    cell.ap -= TFT_AP_COST.trade;
    p.gold -= price; p.food += unit; state.merchant.food -= unit;
    tftLogAction(state, {
      playerId, type: 'trade', isHumanInvolved: playerId === state.humanPlayerId,
      text: `${p.name} が ${tftCellLabel(cellIndex)} で食料${unit}を購入 → 💰-${price}G / 🌾+${unit}`,
    });
    return { ok: true, action, price, unit };
  } else {
    if (p.food < unit) return { ok: false, reason: '売る食料が足りません' };
    const price = tftMerchantSellPrice(state.merchant.food);
    cell.ap -= TFT_AP_COST.trade;
    p.food -= unit; p.gold += price; state.merchant.food += unit;
    tftLogAction(state, {
      playerId, type: 'trade', isHumanInvolved: playerId === state.humanPlayerId,
      text: `${p.name} が ${tftCellLabel(cellIndex)} で食料${unit}を売却 → 🌾-${unit} / 💰+${price}G`,
    });
    return { ok: true, action, price, unit };
  }
}

// 町・農場の建設/増築に着工する（任意の自領土セル・セルごとにレベル式）。
// 着工時に全額支払い、完成はターン境界処理(tftTickConstructions)で反映される。
function tftUpgradeBuilding(state, playerId, cellIndex, kind /* 'town'|'farm' */) {
  const p = state.players[playerId];
  const cell = state.cells[cellIndex];
  if (cell.ownerId !== playerId) return { ok: false, reason: '自領土にのみ建設できます' };
  const buildKey = kind === 'town' ? 'townBuild' : 'farmBuild';
  if (cell[buildKey]) return { ok: false, reason: 'すでに着工中です' };
  const level = kind === 'town' ? cell.townLevel : cell.farmLevel;
  if (level >= TFT_BUILDING_MAX_LV) return { ok: false, reason: 'すでに最大レベルです' };
  const costs = kind === 'town' ? TFT_TOWN_COST : TFT_FARM_COST;
  const cost = costs[level];
  if (p.gold < cost) return { ok: false, reason: 'ゴールドが足りません' };
  if (cell.ap < TFT_AP_COST.build) {
    return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(cellIndex)}: ${cell.ap}/${TFT_CELL_AP_MAX}）` };
  }
  p.gold -= cost;
  cell.ap -= TFT_AP_COST.build;
  cell[buildKey] = { targetLevel: level + 1, turnsLeft: TFT_BUILD_DURATION[level] };
  return { ok: true, turns: TFT_BUILD_DURATION[level] };
}

// 系統研究（ランク解禁）に着工する。R2/R3の2段階のみ（R4=ヒーローは研究対象外）。
// 着工時に全額支払い、完成はターン境界処理(tftTickConstructions)で反映される。
// apCellIndex はプレイヤーが選んだAP消費元セル（研究自体はセル非依存の操作だがAPだけセルから払う）。
function tftResearchRank(state, playerId, lineageId, apCellIndex) {
  const p = state.players[playerId];
  if (p.researchInProgress[lineageId]) return { ok: false, reason: 'すでに研究中です' };
  const cur = p.research[lineageId];
  if (cur >= TFT_MAX_RESEARCHABLE_RANK) return { ok: false, reason: '研究できるのはR7までです（R8はヒーロー専用）' };
  const cost = TFT_RESEARCH_COST[cur - 1];
  if (p.gold < cost) return { ok: false, reason: 'ゴールドが足りません' };
  const apCell = state.cells[apCellIndex];
  if (!apCell || apCell.ownerId !== playerId) return { ok: false, reason: 'AP消費元は自領土のマスを選んでください' };
  if (apCell.ap < TFT_AP_COST.research) {
    return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(apCellIndex)}: ${apCell.ap}/${TFT_CELL_AP_MAX}）` };
  }
  p.gold -= cost;
  apCell.ap -= TFT_AP_COST.research;
  p.researchInProgress[lineageId] = { targetRank: cur + 1, turnsLeft: TFT_RESEARCH_DURATION[cur - 1] };
  return { ok: true, turns: TFT_RESEARCH_DURATION[cur - 1] };
}

// ヒーロー（ランク8）解禁条件の判定。条件は今後追加する（現状は常に未解禁）。
function tftCheckHeroConditions(state, playerId, lineageId) {
  return false;
}

// ============================================================
// 計略（支持率を使った特殊行動）
// ============================================================

// 計略研究（一本鎖 schemeLevel 0→TFT_SCHEME_MAX_LEVEL）に着工する。tftResearchRank と同じ着工制。
function tftResearchScheme(state, playerId, apCellIndex) {
  const p = state.players[playerId];
  if (p.schemeInProgress) return { ok: false, reason: 'すでに計略を研究中です' };
  const cur = p.schemeLevel;
  if (cur >= TFT_SCHEME_MAX_LEVEL) return { ok: false, reason: '計略はすべて研究済みです' };
  const cost = TFT_SCHEME_RESEARCH_COST[cur];
  if (p.gold < cost) return { ok: false, reason: 'ゴールドが足りません' };
  const apCell = state.cells[apCellIndex];
  if (!apCell || apCell.ownerId !== playerId) return { ok: false, reason: 'AP消費元は自領土のマスを選んでください' };
  if (apCell.ap < TFT_AP_COST.research) {
    return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(apCellIndex)}: ${apCell.ap}/${TFT_CELL_AP_MAX}）` };
  }
  p.gold -= cost;
  apCell.ap -= TFT_AP_COST.research;
  p.schemeInProgress = { targetLevel: cur + 1, turnsLeft: TFT_SCHEME_RESEARCH_DURATION[cur] };
  return { ok: true, turns: TFT_SCHEME_RESEARCH_DURATION[cur], label: TFT_SCHEME_LEVEL_LABELS[cur] };
}

// 指定計略が対象セルに使えるかの検証（UIの対象ハイライトと発動時の二重チェックで共用）。
// AP・研究レベルはここでは見ない（発動元セル依存のため tftUseScheme 側で検証する）。
function tftSchemeTargetValid(state, playerId, schemeId, targetCellIndex) {
  const cell = state.cells[targetCellIndex];
  if (!cell) return false;
  // 鍵で封じられたボスの本拠地には侵攻だけでなく計略も通さない。
  // （pacify/agitate は tftValidateRoute を経由せずにセルの所有権を奪えるため、ここを塞がないと抜け道になる）
  if (tftCellLockReason(state, playerId, targetCellIndex)) return false;
  switch (schemeId) {
    case 'rumor':
    case 'foodraid':
      return cell.ownerId !== null && cell.ownerId !== playerId;
    case 'propaganda':
      return cell.ownerId === playerId;
    case 'poach':
      return cell.ownerId !== null && cell.ownerId !== playerId
        && cell.support <= TFT_SUPPORT_POACH_MAX
        && tftGarrison(state, targetCellIndex).length > 0;
    case 'pacify':
      return cell.ownerId === null;
    case 'agitate':
      return cell.ownerId !== null && cell.ownerId !== playerId
        && cell.support <= TFT_SUPPORT_AGITATE_MAX
        && targetCellIndex !== state.players[cell.ownerId].homeCell; // 本拠地は扇動不可（計略での脱落を防ぐ）
  }
  return false;
}

// 計略の発動: 検証 → AP消費 → 成功判定 → 効果適用 → ログ。
// 射程制限なし（盤面のどこでも対象にできる）。失敗してもAPは消費される。
function tftUseScheme(state, playerId, schemeId, apCellIndex, targetCellIndex) {
  const p = state.players[playerId];
  const scheme = tftSchemeById(schemeId);
  if (!scheme) return { ok: false, reason: '計略が見つかりません' };
  if (p.schemeLevel < scheme.level) return { ok: false, reason: `「${scheme.name}」は未研究です` };
  const apCell = state.cells[apCellIndex];
  if (!apCell || apCell.ownerId !== playerId) return { ok: false, reason: 'AP消費元は自領土のマスを選んでください' };
  if (apCell.ap < scheme.ap) {
    return { ok: false, reason: `行動力(AP)が足りません（${tftCellLabel(apCellIndex)}: ${apCell.ap}/${TFT_CELL_AP_MAX}、必要${scheme.ap}）` };
  }
  if (!tftSchemeTargetValid(state, playerId, schemeId, targetCellIndex)) {
    return { ok: false, reason: 'その計略の対象にできないマスです' };
  }
  if (schemeId === 'poach') {
    // 引き抜いたユニットは発動元セルに配置されるため、受け入れ枠を先に検証する
    if (p.roster.length >= TFT_ROSTER_MAX) return { ok: false, reason: `ユニットは最大${TFT_ROSTER_MAX}体までです` };
    if (tftGarrison(state, apCellIndex).length >= TFT_GARRISON_MAX) {
      return { ok: false, reason: `発動元マスの駐留が${TFT_GARRISON_MAX}体で満員です（引き抜き先）` };
    }
  }

  apCell.ap -= scheme.ap;
  const target = state.cells[targetCellIndex];
  const targetOwner = target.ownerId !== null ? state.players[target.ownerId] : null;
  const success = Math.random() < scheme.chance;
  const label = tftCellLabel(targetCellIndex);
  let text = '';
  let detail = null;

  if (!success) {
    // 失敗: 敵領土への計略は陰謀の露見で支持率が上がる
    if (scheme.target === 'enemy') {
      target.support = Math.min(TFT_SUPPORT_MAX, target.support + TFT_SUPPORT_FAIL_BACKLASH);
    }
    text = `${p.name} の【${scheme.name}】が ${label} で失敗`;
  } else {
    switch (schemeId) {
      case 'rumor': {
        const value = tftRumorValue(p.schemeLevel);
        target.support = Math.max(0, target.support - value);
        text = `${p.name} の【流言】が ${label} に広まり支持率-${value}（→${target.support}）`;
        detail = { value };
        break;
      }
      case 'propaganda': {
        target.support = Math.min(TFT_SUPPORT_MAX, target.support + TFT_PROPAGANDA_VALUE);
        text = `${p.name} が ${label} で【宣撫工作】、支持率+${TFT_PROPAGANDA_VALUE}（→${target.support}）`;
        break;
      }
      case 'foodraid': {
        const steal = Math.min(TFT_FOODRAID_AMOUNT, targetOwner.food);
        targetOwner.food -= steal;
        p.food += steal;
        text = `${p.name} の【兵糧強奪】が ${label} で成功、${targetOwner.name} から食料${steal}を奪取`;
        detail = { steal };
        break;
      }
      case 'poach': {
        const garrison = tftGarrison(state, targetCellIndex);
        const victim = garrison[Math.floor(Math.random() * garrison.length)];
        targetOwner.roster = targetOwner.roster.filter(u => u.uid !== victim.uid);
        const recruit = { ...victim, uid: tftNewUid(playerId), pos: apCellIndex, fatigue: 0 };
        p.roster.push(recruit);
        text = `${p.name} の【戦士の引き抜き】が成功、${label} の ${victim.name} が寝返った`;
        detail = { unitName: victim.name };
        break;
      }
      case 'pacify': {
        target.ownerId = playerId;
        target.ap = 0;
        target.capturedThisTurn = true;
        target.support = TFT_SUPPORT_ON_PACIFY;
        text = `${p.name} の【懐柔】が成功、中立地 ${label} が自国領土になった`;
        break;
      }
      case 'agitate': {
        const defenders = tftGarrison(state, targetCellIndex);
        if (defenders.length > 0) tftRelocateUnits(state, target.ownerId, defenders);
        target.ownerId = playerId;
        target.ap = 0;
        target.capturedThisTurn = true;
        target.support = TFT_SUPPORT_ON_AGITATE;
        text = `${p.name} の【扇動】が成功、${targetOwner.name} の ${label} が寝返った！`;
        break;
      }
    }
  }

  tftLogAction(state, {
    playerId,
    type: 'scheme',
    schemeId,
    success,
    targetCell: targetCellIndex,
    text,
    isHumanInvolved: playerId === state.humanPlayerId
      || (targetOwner !== null && targetOwner.id === state.humanPlayerId),
  });

  // 懐柔・扇動による領土獲得で勝利セル数に到達しうる（tft-battle.jsの占領時と同じ判定）
  if (success && (schemeId === 'pacify' || schemeId === 'agitate')) {
    const gameOver = tftCheckGameOver(state);
    if (gameOver.over) { state.phase = TFT_PHASE.OVER; state.winner = gameOver.winner; state.winnerReason = gameOver.reason; }
  }
  return { ok: true, success, scheme, targetCell: targetCellIndex, text, detail };
}

// ターン境界で呼ぶ: 進行中の建設・研究のカウントダウンと完成処理
function tftTickConstructions(state) {
  const completed = [];
  for (const c of state.cells) {
    for (const key of ['townBuild', 'farmBuild']) {
      if (!c[key]) continue;
      if (--c[key].turnsLeft <= 0) {
        if (key === 'townBuild') c.townLevel = c[key].targetLevel; else c.farmLevel = c[key].targetLevel;
        completed.push({ type: key, cellIndex: c.index, ownerId: c.ownerId, level: c[key].targetLevel });
        c[key] = null;
      }
    }
  }
  for (const p of tftActivePlayers(state)) {
    for (const lid of Object.keys(p.researchInProgress)) {
      const prog = p.researchInProgress[lid];
      if (--prog.turnsLeft <= 0) {
        p.research[lid] = prog.targetRank;
        completed.push({ type: 'research', playerId: p.id, lineageId: lid, rank: prog.targetRank });
        delete p.researchInProgress[lid];
      }
    }
    if (p.schemeInProgress && --p.schemeInProgress.turnsLeft <= 0) {
      p.schemeLevel = p.schemeInProgress.targetLevel;
      completed.push({ type: 'schemeResearch', playerId: p.id, level: p.schemeLevel });
      p.schemeInProgress = null;
    }
  }
  return completed;
}

// --- 勝利判定（本拠地喪失による脱落は tft-battle.js 側で即時処理する） ---

function tftCheckGameOver(state) {
  // ラスボス（TFT帝国）の撃破が最優先の勝利条件。本拠地を陥落させた者が勝つ。
  const lastBoss = state.players.find(p => p.kind === 'lastboss');
  if (lastBoss && lastBoss.eliminated) {
    return { over: true, winner: state.cells[lastBoss.homeCell].ownerId, reason: 'lastboss' };
  }
  // 「最後の1勢力」判定からは passive を除外する。ラスボスは討伐されるまで永久に居座るため、
  // 含めてしまうと他を全て倒しても決着がつかなくなる。
  const alive = tftActivePlayers(state).filter(p => !tftIsPassiveFaction(state, p.id));
  if (alive.length === 1) return { over: true, winner: alive[0].id, reason: 'elimination' };
  if (alive.length === 0) return { over: true, winner: null, reason: 'elimination' };
  for (const p of alive) {
    if (tftCellCount(state, p.id) >= TFT_WIN_CELL_COUNT) return { over: true, winner: p.id, reason: 'cells' };
  }
  if (state.turn >= TFT_MAX_TURNS) {
    // ターン上限: 最大セル数のプレイヤー（同数なら若いID）
    let best = alive[0];
    for (const p of alive) if (tftCellCount(state, p.id) > tftCellCount(state, best.id)) best = p;
    return { over: true, winner: best.id, reason: 'turnlimit' };
  }
  return { over: false, winner: null, reason: null };
}

// --- 行動履歴ログ ---

const TFT_LOG_MAX = 200;

function tftLogAction(state, entry) {
  state.actionLog.push({ turn: state.turn, time: Date.now(), ...entry });
  if (state.actionLog.length > TFT_LOG_MAX) state.actionLog.shift();
}
