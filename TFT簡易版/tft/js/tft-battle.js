// ============================================================
// バトル解決層。既存 runBattle を再利用する。
// 【最重要規約】runBattle は内部で applyStatSynergies を呼ぶため、
// 渡すチームは必ず「ベース形」({...unit}) にする。疲労は hp を
// 書き換えたコピーで表現し、シナジー二重適用を絶対に避ける。
//
// リアルタイム化: 侵攻宣言＝即時解決（バッチ処理・競合トーナメントは廃止）。
// 1回の宣言につき1回だけ tftResolveOneAttack が呼ばれる。
// ============================================================

// 疲労を反映したベースチームを作る（原本は変更しない）。
// maxMp をここで毎回付与することで、MPは「バトル終了で全回復」する
// （ロスター本体には mp/maxMp を書き戻さないため、次の呼び出しで常に満タンから始まる）。
// id は uid で上書きする: runBattle/バトル演出は unit.id を個体識別キーとして使うが、
// 元の UNITS_DATA id は同一ユニット種別で共通のため、TFT のように同種を複数保有・
// 複数体スポーンできる場合（モンスター等）は id が重複し、演出のHPバーが別個体と
// 混線してしまう（TFTBS本体は同一ユニットの重複編成を禁止しているため問題化しない）。
// ただし countClasses（js/synergy.js）は id を重複排除キーに使うため、
// id を uid に上書きすると「同一ユニットはシナジー1体分」の仕様が効かなくなってしまう
// （同一種別を複数体保有できるTFTでは、これが無いと同じユニットだけでシナジーを稼げる）。
// そこで元の種別id（uid上書き前のid）が2体目以降のユニットは classes を空にし、
// シナジー加算の対象から外す（駐留パネルの表示計算と結果を一致させるため）。
function tftPrepTeam(units) {
  const seenBaseIds = new Set();
  return units.map(u => {
    const isDuplicate = seenBaseIds.has(u.id);
    seenBaseIds.add(u.id);
    // 疲労はベースhpの書き換えで、レベルは全ステータス倍率 statMul で反映する。
    // atk/def/spd はベース(ティア整合)のまま渡し、applyStatSynergies が最後に statMul を一律で掛ける
    // （こうするとアイテムのティア段上げとレベル倍率が共存する）。モンスター・守備隊は level 未設定→×1。
    return { ...u, id: u.uid, hp: tftEffectiveHp(u), maxMp: tftMaxMp(u),
      statMul: tftLevelStatMultiplier(u.level || 1), classes: isDuplicate ? [] : u.classes };
  });
}

// 防衛側が敗れて生存したユニットを安全な自領土へ退避させる（本拠地優先）
function tftRelocateUnits(state, playerId, units) {
  const p = state.players[playerId];
  const owned = tftOwnedCells(state, playerId);
  if (owned.length === 0) return;
  const dest = owned.some(c => c.index === p.homeCell) ? p.homeCell : owned[0].index;
  for (const u of units) u.pos = dest;
}

// 中立地侵攻の脅威見積もり（AI用）: 現在ターンのモンスター段階の平均cost×体数
function tftMonsterThreatEstimate(turn) {
  const stage = TFT_MONSTER_STAGES.find(s => turn <= s.untilTurn) || TFT_MONSTER_STAGES[TFT_MONSTER_STAGES.length - 1];
  const pool = UNITS_DATA.filter(u => u.isMonster && stage.ranks.includes(u.rank));
  const avgCost = pool.reduce((s, u) => s + u.cost, 0) / pool.length;
  return avgCost * tftMonsterCountForTurn(turn);
}

// 空白地（中立セル）侵攻時のモンスターを生成する。ランクはゲーム経過ターンに応じて強くなり、
// 体数は序盤（1〜3ターン目）だけ少なく、4ターン目以降は駐留上限と同じ5体になる。
function tftSpawnMonsters(turn) {
  const stage = TFT_MONSTER_STAGES.find(s => turn <= s.untilTurn) || TFT_MONSTER_STAGES[TFT_MONSTER_STAGES.length - 1];
  const pool = UNITS_DATA.filter(u => u.isMonster && stage.ranks.includes(u.rank));
  const monsters = [];
  const count = tftMonsterCountForTurn(turn);
  for (let i = 0; i < count; i++) {
    const base = pool[Math.floor(Math.random() * pool.length)];
    monsters.push({ ...base, uid: `monster_${i}`, pos: -1, fatigue: 0 });
  }
  return monsters;
}

// CPU本拠地の守備隊を生成する。攻撃されるたびにその場で作られる（中立地モンスターと同じく、
// プレイヤーのロスターには属さない防衛専用部隊）。これによりCPU本拠地は常に一定水準の戦力で
// 守られ、AIは全ユニットを攻めに回せる。食料維持費もかからない。
// 編成は勢力の種別ごと（TFT_FACTION_KINDS.guardRanks）:
//   通常CPU   ランク4-6の15体プールからランダム5体
//   中ボス    ランク7の全5系統
//   ラスボス  ランク8ヒーローの全5系統
function tftSpawnHomeGuard(state, defenderId) {
  const ranks = tftFactionKind(state, defenderId).guardRanks;
  const pool = UNITS_DATA.filter(u => !u.isMonster && ranks.includes(u.rank));
  const make = (base, i) => ({ ...base, uid: `guard_${i}`, pos: -1, fatigue: 0 });
  // 単一ランクのプールは5系統×1体でちょうど守備隊の体数に一致する。その場合は抽選せず全系統を
  // 1体ずつ使う（ランダムに引くと系統が重複し、countClasses が重複を1体分としか数えないため
  // ボスのシナジーが立たなくなる）。
  if (pool.length === TFT_HOME_GUARD_SIZE) return pool.map(make);
  const guard = [];
  for (let i = 0; i < TFT_HOME_GUARD_SIZE; i++) {
    guard.push(make(pool[Math.floor(Math.random() * pool.length)], i));
  }
  return guard;
}

// 1回の侵攻を即時解決する。
// 戻り値: { attackerId, defenderId, fromCell, toCell, attackerWon, noBattle, raw,
//           attackerDeaths, defenderDeaths, homeLost, eliminatedPlayerId, isHumanInvolved,
//           isMonsterBattle, foodBonus, gameOver }
function tftResolveOneAttack(state, attackerId, fromCell, toCell, unitUids) {
  const cell = state.cells[toCell];
  const defenderId = cell.ownerId; // null = 中立
  const isMonsterBattle = defenderId === null;

  // 厭戦: 侵攻という行為そのもの（勝敗・無血開城を問わず）で攻撃側の全所有セルの支持率が下がる
  for (const c of tftOwnedCells(state, attackerId)) {
    c.support = Math.max(0, c.support - TFT_SUPPORT_INVADE_PENALTY);
  }
  // CPU勢力の本拠地は常に固定編成の守備隊5体が防衛する（実際の駐留とは無関係にスポーン）。
  // プレイヤー枠は guardRanks が null なので該当しない＝自分の駐留で守るしかない。
  const isCpuHome = defenderId !== null
    && toCell === state.players[defenderId].homeCell
    && !!tftFactionKind(state, defenderId).guardRanks;
  const attackUnits = unitUids.map(uid => tftFindUnit(state, attackerId, uid)).filter(Boolean);
  const defenseUnits = isMonsterBattle ? tftSpawnMonsters(state.turn)
    : isCpuHome ? tftSpawnHomeGuard(state, defenderId)
    : tftGarrison(state, toCell);

  let attackerWon, raw = null;
  if (defenseUnits.length === 0) {
    attackerWon = true; // 無血開城（駐留0体の中立/敵地）
  } else {
    const atkMods = buildSideModifiers('attacker', []);
    const defMods = buildSideModifiers('defender', cell.facilities); // DEF+20%+設備が自動で効く
    raw = runBattle(tftPrepTeam(attackUnits), tftPrepTeam(defenseUnits), atkMods, defMods);
    attackerWon = raw.result === 'win'; // 'lose'|'draw' は防衛側勝ち
  }

  // 戦闘（無血開城含む出撃）に関わった全ユニットは疲労+1（AP消費は呼び出し元のtftExecuteRouteが行う）
  for (const u of attackUnits) { u.fatigue++; }
  for (const u of defenseUnits) { u.fatigue++; }

  // 実際に撃破されたユニットはロスターから消滅させる（生存者は今まで通り帰還・退却する）
  const deadAttackerUids = new Set(raw ? raw.playerTeam.filter(u => u.currentHp <= 0).map(u => u.uid) : []);
  const deadDefenderUids = new Set(raw ? raw.cpuTeam.filter(u => u.currentHp <= 0).map(u => u.uid) : []);
  const survivingAttackers = attackUnits.filter(u => !deadAttackerUids.has(u.uid));
  const survivingDefenders = defenseUnits.filter(u => !deadDefenderUids.has(u.uid));
  if (deadAttackerUids.size > 0) {
    const p = state.players[attackerId];
    p.roster = p.roster.filter(u => !deadAttackerUids.has(u.uid));
  }
  if (defenderId !== null && deadDefenderUids.size > 0) {
    const p = state.players[defenderId];
    p.roster = p.roster.filter(u => !deadDefenderUids.has(u.uid));
  }

  // 経験値: 勝って生き残ったユニットだけが、倒した相手のコスト合計に応じてXPを得る（強敵ほど多い）。
  // モンスター・守備隊は使い捨て個体なので、防衛側勝利でも defenderId が実プレイヤーのときだけ意味を持つ。
  const levelUps = [];
  const awardXp = (winners, defeated) => {
    const xp = defeated.reduce((s, u) => s + (u.cost || 0), 0);
    if (xp <= 0) return;
    for (const u of winners) {
      const ups = tftGainXp(u, xp);
      if (ups > 0) levelUps.push({ uid: u.uid, name: u.name, level: u.level });
    }
  };
  if (raw) {
    if (attackerWon) {
      awardXp(survivingAttackers, defenseUnits.filter(u => deadDefenderUids.has(u.uid)));
    } else if (defenderId !== null && !isCpuHome) {
      // isCpuHome の守備隊は使い捨て個体（ロスター非所属）なので育てない
      awardXp(survivingDefenders, attackUnits.filter(u => deadAttackerUids.has(u.uid)));
    }
  }

  let homeLost = false;
  let eliminatedPlayerId = null;
  let grantedKey = null;

  if (attackerWon) {
    const wasHome = defenderId !== null && toCell === state.players[defenderId].homeCell;

    cell.ownerId = attackerId;
    cell.facilities = [];
    cell.townBuild = null; // 進行中の着工は占領で破棄（新所有者が改めて着工する）
    cell.farmBuild = null;
    cell.capturedThisTurn = true; // 無血開城チェイン対策: このセルからは今ターン出撃不可
    cell.ap = 0; // 占領直後は行動力0（奪った直後に即建設/雇用/研究する抜け道を防止）
    cell.support = TFT_SUPPORT_ON_CAPTURE; // 武力占領直後の民心は低い
    for (const u of survivingAttackers) u.pos = toCell;

    if (defenderId !== null && !wasHome) {
      tftRelocateUnits(state, defenderId, survivingDefenders);
    }

    if (wasHome) {
      const loser = state.players[defenderId];
      loser.eliminated = true;
      loser.roster = [];
      // 本拠地喪失=即敗北。残りの領土（本拠地以外）は全て中立化する（建物も廃棄）。
      for (const c of state.cells) if (c.ownerId === defenderId) {
        c.ownerId = null;
        c.townLevel = 0;
        c.farmLevel = 0;
        c.townBuild = null;
        c.farmBuild = null;
        c.facilities = [];
        c.ap = 0;
        c.support = TFT_SUPPORT_START;
      }
      cell.ownerId = attackerId; // 上のループより後に確定（本拠地自体は攻撃側のもの・建物はそのまま奪われる）
      homeLost = true;
      eliminatedPlayerId = defenderId;

      // 撃破報酬の鍵（通常CPU→緑の鍵 / 中ボス→漆黒の鍵）。既に持っていれば null が返る。
      const dropKeyId = tftFactionKind(state, defenderId).dropKeyId;
      if (dropKeyId) grantedKey = tftGrantSpecificItem(state, attackerId, tftKeyItemById(dropKeyId));
    }
  }
  // 防衛成功時: 生存した攻撃ユニットは fromCell に留まる（位置変更なし）

  // 空白地占領: 撃破したモンスターの合計costから食料の一時金を得る
  let foodBonus = 0;
  if (isMonsterBattle && attackerWon) {
    const defeatedCost = defenseUnits.filter(u => deadDefenderUids.has(u.uid)).reduce((s, u) => s + u.cost, 0);
    foodBonus = defeatedCost * TFT_MONSTER_FOOD_MULTIPLIER;
    if (foodBonus > 0) state.players[attackerId].food += foodBonus;
  }

  // 中立地占領時、一定確率でランダムアイテムを獲得（CPUは tftGrantRandomItem 内で自動装備）
  let grantedItem = null;
  if (isMonsterBattle && attackerWon && Math.random() < TFT_ITEM_DROP_CAPTURE) {
    grantedItem = tftGrantRandomItem(state, attackerId);
  }

  const gameOver = tftCheckGameOver(state);
  if (gameOver.over) { state.phase = TFT_PHASE.OVER; state.winner = gameOver.winner; state.winnerReason = gameOver.reason; }

  return {
    attackerId, defenderId, fromCell, toCell,
    attackerWon, noBattle: raw === null, raw,
    attackerDeaths: deadAttackerUids.size, defenderDeaths: deadDefenderUids.size,
    homeLost, eliminatedPlayerId, grantedKey, levelUps,
    isHumanInvolved: attackerId === state.humanPlayerId || defenderId === state.humanPlayerId,
    isMonsterBattle, foodBonus, grantedItem,
    gameOver,
  };
}

// 戦闘結果をログ用の一言テキストにする
function tftBuildAttackLogText(state, report) {
  const atk = state.players[report.attackerId].name;
  const label = tftCellLabel(report.toCell);
  const casualtyNote = (attackerN, defenderN) => {
    const parts = [];
    if (attackerN > 0) parts.push(`攻撃側${attackerN}体消滅`);
    if (defenderN > 0) parts.push(`防衛側${defenderN}体消滅`);
    return parts.length ? `（${parts.join('・')}）` : '';
  };
  const levelNote = (report.levelUps && report.levelUps.length)
    ? ` ⬆️ ${report.levelUps.map(l => `${l.name}がLv${l.level}に！`).join(' ')}` : '';

  if (report.homeLost) {
    const loser = report.eliminatedPlayerId !== null ? state.players[report.eliminatedPlayerId].name : '？';
    const keyNote = report.grantedKey ? `（🗝 ${report.grantedKey.icon}${report.grantedKey.name} を入手！）` : '';
    return `💀 ${atk} が ${label}（${loser}の本拠地）を陥落！ ${loser} は脱落した${keyNote}`;
  }
  const itemNote = report.grantedItem ? `（📦 ${report.grantedItem.icon}${report.grantedItem.name} 入手）` : '';
  if (report.isMonsterBattle) {
    if (report.attackerWon) {
      return `👹 ${atk} が ${label} のモンスターを討伐！占領成功（🌾+${report.foodBonus}）${itemNote}${casualtyNote(report.attackerDeaths, 0)}${levelNote}`;
    }
    return `👹 ${atk} が ${label} のモンスターに撃退された${casualtyNote(report.attackerDeaths, 0)}`;
  }
  if (report.noBattle && report.attackerWon) return `🏳️ ${atk} が ${label} を無血開城で占領`;
  if (report.attackerWon) {
    const def = report.defenderId !== null ? state.players[report.defenderId].name : '中立';
    return `⚔️ ${atk} の侵攻成功！ ${label}（守: ${def}）を占領${casualtyNote(report.attackerDeaths, report.defenderDeaths)}${levelNote}`;
  }
  const def = state.players[report.defenderId].name;
  return `🛡️ ${def} が ${label} を防衛！（攻: ${atk} 撃退）${casualtyNote(report.attackerDeaths, report.defenderDeaths)}${levelNote}`;
}

// 経路(出陣)の実行。tftValidateRouteで検証し、経路上の自領セルのAPを消費した上で、
// 侵攻なら tftResolveOneAttack を、移動なら位置更新を行う。
function tftExecuteRoute(state, playerId, path, unitUids) {
  const check = tftValidateRoute(state, playerId, path, unitUids);
  if (!check.ok) return check;

  for (const idx of check.apCells) state.cells[idx].ap -= check.apCost;

  if (check.isAttack) {
    const report = tftResolveOneAttack(state, playerId, check.fromCell, check.finalCell, unitUids);
    const text = tftBuildAttackLogText(state, report);
    report.logText = text;
    tftLogAction(state, {
      playerId,
      type: 'attack',
      text,
      battleRaw: report.raw,
      isHumanInvolved: report.isHumanInvolved,
      report,
    });
    tftOnBattleResolved(state, report); // 人間が関与する戦闘は即モーダル表示（tft-battle-view.js）
    return { ok: true, isAttack: true, report };
  }

  // 移動: 経路上の中間セルへの滞在は発生しない。選択ユニット全員を最終セルへ直接移動する。
  for (const uid of unitUids) {
    const unit = tftFindUnit(state, playerId, uid);
    if (!unit) continue;
    unit.pos = check.finalCell;
    if (check.finalCell === state.players[playerId].homeCell) unit.fatigue = 0;
  }
  tftLogAction(state, {
    playerId,
    type: 'move',
    text: `${state.players[playerId].name} が ${path.map(tftCellLabel).join('→')} へ移動`,
    isHumanInvolved: playerId === state.humanPlayerId,
  });
  return { ok: true, isAttack: false };
}

// 侵攻宣言の入口（単一隣接ホップの薄いラッパー、AI・既存呼び出し向けに存続）。
function tftDeclareAndResolve(state, playerId, toCell, unitUids) {
  const origin = tftSelectionOriginCell(state, playerId, unitUids);
  if (origin === null) return { ok: false, reason: 'ユニットが同じマスにいません' };
  return tftExecuteRoute(state, playerId, [origin, toCell], unitUids);
}
