// ============================================================
// CPU の内政・軍事AI。ターン境界処理の中で呼ばれる。
// リアルタイム化により、侵攻宣言はその場で即時解決される
// （tftDeclareAndResolve）。方針は変わらず、多始点BFSで
// 「狙う方向」を決め、実際の攻撃先は必ず自領土に隣接する
// セルから選ぶ（隣接1マス侵攻の制約）。
// ============================================================

// CPU勢力同士は不可侵。CPUが侵攻・計略で狙ってよいのは中立地とプレイヤーの領土だけで、
// 他のCPU勢力の領土には一切手を出さない（結果としてボスの本拠地もAIの対象から自動的に外れるため、
// AI側に鍵チェックを足す必要はない）。一方 開幕保護はプレイヤーの本拠地も対象にするので、
// tftCellLockReason はここで明示的に見る ―― 見ないとCPUが毎ターン通らない侵攻を試み続けることになる。
// 注: tftBorderTargets 自体は絞らないこと ―― 同関数は tftValidateRoute から人間の侵攻可否判定にも
// 使われているため、あちらを絞ると人間がCPUを攻められなくなる。
function tftAiCanTarget(state, playerId, cellIndex) {
  const owner = state.cells[cellIndex].ownerId;
  if (owner === null) return true;      // 中立地は誰でも取りに行く
  if (owner === playerId) return false; // 自領
  if (tftCellLockReason(state, playerId, cellIndex)) return false; // 開幕保護中の本拠地・鍵ロック
  return !(tftIsCpuFaction(playerId) && tftIsCpuFaction(owner));
}

// 多始点BFS: 自領土全セルを距離0の始点とし、最近接の敵所有セルまでの距離を返す
function tftBfsNearestEnemy(state, playerId) {
  const dist = new Array(TFT_CELLS).fill(Infinity);
  const queue = [];
  for (const cell of tftOwnedCells(state, playerId)) {
    dist[cell.index] = 0;
    queue.push(cell.index);
  }
  let head = 0;
  let best = null;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const nb of tftNeighbors(cur)) {
      if (dist[nb] !== Infinity) continue;
      dist[nb] = dist[cur] + 1;
      const owner = state.cells[nb].ownerId;
      if (owner !== null && owner !== playerId) {
        if (!best || dist[nb] < best.dist) best = { target: nb, dist: dist[nb] };
      }
      queue.push(nb);
    }
  }
  return best; // null = 敵なし
}

// AP消費元セルの選定: 本拠地優先、なければAP残量最大の自領セル
function tftAiPickApCell(state, playerId, apCost) {
  const home = state.cells[state.players[playerId].homeCell];
  if (home.ownerId === playerId && home.ap >= apCost) return home;
  const owned = tftOwnedCells(state, playerId).filter(c => c.ap >= apCost);
  if (owned.length === 0) return null;
  owned.sort((a, b) => b.ap - a.ap);
  return owned[0];
}

// 町/農場の増築先セルを選ぶ: 同種の建物レベルが最も低い自領土セルを優先（同レベルなら本拠地優先）
// 既に着工中のセルは候補から除外する（二重着工エラーの回避）。
function tftPickBuildCell(state, playerId, kind) {
  const buildKey = kind === 'town' ? 'townBuild' : 'farmBuild';
  const owned = tftOwnedCells(state, playerId).filter(c => !c[buildKey]);
  if (owned.length === 0) return null;
  const homeCell = state.players[playerId].homeCell;
  const levelOf = c => (kind === 'town' ? c.townLevel : c.farmLevel);
  const sorted = [...owned].sort((a, b) => {
    const diff = levelOf(a) - levelOf(b);
    if (diff !== 0) return diff;
    if (a.index === homeCell) return -1;
    if (b.index === homeCell) return 1;
    return 0;
  });
  return sorted[0];
}

// 内政: 農場 → 町 → 雇用 → 前線の防衛設備 → 余剰資金で研究 の優先度で資金を使う
function tftAiEconomy(state, playerId) {
  const p = state.players[playerId];
  if (p.eliminated || tftIsPassiveFaction(state, playerId)) return;

  // ① 食料が赤字なら農場を増築。農場テーブルは「収穫1回=6ヶ月分」なので、
  //    毎月かかる維持費と比べるには月次換算する（そのまま比べると足りていると誤判定する）。
  const farmPerMonth = tftBuildingIncomeSum(state, playerId, 'farm') / TFT_FOOD_HARVEST_INTERVAL;
  if (farmPerMonth < tftFoodUpkeep(state, playerId)) {
    const cell = tftPickBuildCell(state, playerId, 'farm');
    if (cell && cell.farmLevel < TFT_BUILDING_MAX_LV) tftUpgradeBuilding(state, playerId, cell.index, 'farm');
  }

  // ② 序盤は町を建てて経済を伸ばす
  if (state.turn <= 3 && tftBuildingLevelSum(state, playerId, 'town') === 0) {
    const cell = tftPickBuildCell(state, playerId, 'town');
    if (cell) tftUpgradeBuilding(state, playerId, cell.index, 'town');
  }

  // 研究済みランクで雇える中で最も強い（＝最もコストの高い）ユニット
  const bestHirable = (budget) => UNITS_DATA
    .filter(u => !u.isMonster && u.cost <= budget && u.rank <= p.research[u.lineage.id])
    .sort((a, b) => b.cost - a.cost)[0] || null;

  // ③ ロスターが薄ければ雇用（3Gは手元に残す・研究済みランクのみ）
  while (p.roster.length < 5 && p.gold >= 8) {
    const apCell = tftAiPickApCell(state, playerId, TFT_AP_COST.hire);
    if (!apCell) break;
    const best = bestHirable(p.gold - 3);
    if (!best) break;
    if (!tftHireUnit(state, playerId, best.id, apCell.index).ok) break;
  }

  // ③.5 軍の質を上げる: ロスターが埋まっていても、研究で上位ユニットが解禁されていれば
  //     最弱の1体を解雇して置き換える（1ターン1体まで）。解雇は購入コストを全額返金するので
  //     必要なのは差額だけ。
  //     これが無いと研究の成果が永久に軍へ反映されない: 初期ロスターは既に5体なので上の雇用
  //     ループは一度も回らず、攻撃部隊も最大5体でしか組めないため、中立地のモンスターを抜く
  //     のに必要な戦力（コスト合計）にランク1編成のままでは永久に届かない＝CPUが拡張不能になる。
  {
    const swappable = p.roster
      .filter(u => {
        const c = state.cells[u.pos];
        return c && c.ownerId === playerId && c.ap >= TFT_AP_COST.dismiss + TFT_AP_COST.hire;
      })
      .sort((a, b) => a.cost - b.cost);
    const weakest = swappable[0];
    if (weakest) {
      const best = bestHirable(p.gold + weakest.cost - 3); // 解雇の返金を見込んだ予算
      if (best && best.cost > weakest.cost) {
        const cellIndex = weakest.pos;
        if (tftDismissUnit(state, playerId, weakest.uid, cellIndex).ok) {
          tftHireUnit(state, playerId, best.id, cellIndex);
        }
      }
    }
  }

  // ④ 敵と接する前線セルに安い設備を建てる（4G以上あるときだけ）
  // 防衛設備はいったん廃止中のためコメントアウト
  // if (p.gold >= 4) {
  //   const frontier = tftOwnedCells(state, playerId).filter(c =>
  //     tftNeighbors(c.index).some(nb => {
  //       const o = state.cells[nb].ownerId;
  //       return o !== null && o !== playerId;
  //     }));
  //   const cheap = FACILITIES_LIST.filter(f => f.cost === 1);
  //   for (const cell of frontier) {
  //     if (p.gold < 4) break;
  //     const buildable = cheap.filter(f => !cell.facilities.includes(f.id));
  //     if (buildable.length > 0) {
  //       tftBuildFacility(state, playerId, cell.index, buildable[Math.floor(Math.random() * buildable.length)].id);
  //     }
  //   }
  // }

  // ⑤ 余剰資金があれば安い系統から研究（次段階のコストが最も安い系統に投資）
  if (p.gold >= TFT_RESEARCH_COST[0]) {
    const apCell = tftAiPickApCell(state, playerId, TFT_AP_COST.research);
    if (apCell) {
      const candidates = TFT_LINEAGE_IDS.filter(lid => p.research[lid] < TFT_MAX_RESEARCHABLE_RANK && !p.researchInProgress[lid]);
      candidates.sort((a, b) => TFT_RESEARCH_COST[p.research[a] - 1] - TFT_RESEARCH_COST[p.research[b] - 1]);
      if (candidates.length > 0) tftResearchRank(state, playerId, candidates[0], apCell.index);
    }
  }

  // ⑥ さらに余裕があれば計略研究（内政・軍事研究を圧迫しないよう次コストの1.5倍の資金が条件）
  if (!p.schemeInProgress && p.schemeLevel < TFT_SCHEME_MAX_LEVEL
      && p.gold >= TFT_SCHEME_RESEARCH_COST[p.schemeLevel] * 1.5) {
    const apCell = tftAiPickApCell(state, playerId, TFT_AP_COST.research);
    if (apCell) tftResearchScheme(state, playerId, apCell.index);
  }

}

// 余ったAPで訓練（金は使わない・最低優先度のAP用途）。軍事(tftAiOrders)の後に呼ぶこと ――
// 内政に混ぜると、初手の中立地占領に必要なAPを訓練が食いつぶして拡張できなくなる。
// APと訓練可能な駐留ユニットの両方を持つ自領セルを走査し、低レベルの個体から均等に底上げする。
function tftAiTraining(state, playerId) {
  const p = state.players[playerId];
  if (p.eliminated || tftIsPassiveFaction(state, playerId)) return;
  let guard = 0;
  while (guard++ < 30) {
    let best = null; // { cellIndex, unit }
    for (const cell of tftOwnedCells(state, playerId)) {
      if (cell.ap < TFT_TRAIN_AP_COST) continue;
      for (const u of tftGarrison(state, cell.index)) {
        if ((u.level || 1) >= TFT_LEVEL_MAX) continue;
        // 低レベルの個体を優先（同レベルならコスト＝価値の高い方から）。1体だけ突出させず軍全体を底上げ。
        if (!best || u.level < best.unit.level || (u.level === best.unit.level && u.cost > best.unit.cost)) {
          best = { cellIndex: cell.index, unit: u };
        }
      }
    }
    if (!best) break;
    if (!tftTrainUnit(state, playerId, best.unit.uid, best.cellIndex).ok) break;
  }
}

// 計略の発動（1ターン1回まで・機会主義）。優先度: 扇動 > 引き抜き > 懐柔 > 兵糧強奪 > 流言 > 宣撫。
function tftAiSchemes(state, playerId) {
  const p = state.players[playerId];
  if (p.eliminated || p.schemeLevel < 1 || tftIsPassiveFaction(state, playerId)) return;

  const tryScheme = (schemeId, targetCell) => {
    const scheme = tftSchemeById(schemeId);
    if (p.schemeLevel < scheme.level) return false;
    const apCell = tftAiPickApCell(state, playerId, scheme.ap);
    if (!apCell) return false;
    const victimId = state.cells[targetCell].ownerId; // 発動前に控える（扇動成功で所有者が変わるため）
    const r = tftUseScheme(state, playerId, schemeId, apCell.index, targetCell);
    if (r.ok && victimId === state.humanPlayerId) {
      tftToast(r.success ? `⚠️ ${r.text}` : `🛡 敵の計略を退けた（${scheme.name}）`);
    }
    return r.ok;
  };
  const enemyCells = state.cells.filter(c => c.ownerId !== null && tftAiCanTarget(state, playerId, c.index));

  // ① 扇動: 対象があれば最優先（成功で領土＋建物を無血奪取）
  const agitatable = enemyCells.find(c => tftSchemeTargetValid(state, playerId, 'agitate', c.index));
  if (agitatable && tryScheme('agitate', agitatable.index)) return;

  // ② 引き抜き: 支持率の下がった敵駐留から戦力を奪う
  const poachable = enemyCells.find(c => tftSchemeTargetValid(state, playerId, 'poach', c.index));
  if (poachable && tryScheme('poach', poachable.index)) return;

  // ③ 懐柔: 自軍が薄い（モンスター戦が危険な）ときの安全な拡張
  if (p.roster.length < 4) {
    const neutral = tftBorderTargets(state, playerId).find(t => state.cells[t.to].ownerId === null);
    if (neutral && tryScheme('pacify', neutral.to)) return;
  }

  // ④ 兵糧強奪: 最も食料を蓄えた敵から奪う（奪われた側は飢餓→支持率低下の布石）
  {
    const richest = enemyCells
      .map(c => ({ cell: c, food: state.players[c.ownerId].food }))
      .sort((a, b) => b.food - a.food)[0];
    if (richest && richest.food >= TFT_FOODRAID_AMOUNT && tryScheme('foodraid', richest.cell.index)) return;
  }

  // ⑤ 流言: 支持率低め（≤60）の敵セルをさらに下げ、引き抜き・扇動圏内へ近づける
  {
    const soft = enemyCells.filter(c => c.support <= 60).sort((a, b) => a.support - b.support)[0];
    if (soft && tryScheme('rumor', soft.index)) return;
  }

  // ⑥ 宣撫工作: 自領の民心が崩れていれば立て直す
  {
    const unhappy = tftOwnedCells(state, playerId).filter(c => c.support < 50).sort((a, b) => a.support - b.support)[0];
    if (unhappy) tryScheme('propaganda', unhappy.index);
  }
}

// オークションへの入札（低確率で「たまに」参加。常に最低額でだけ入札し、資金を大きく割かない）
function tftAiAuctionBid(state, playerId) {
  const p = state.players[playerId];
  if (p.eliminated || tftIsPassiveFaction(state, playerId) || state.auction.lots.length === 0) return;
  if (Math.random() >= TFT_AUCTION_CPU_BID_CHANCE) return;
  const candidates = state.auction.lots.filter(l => l.highestBidderId !== playerId);
  if (candidates.length === 0) return;
  const lot = candidates[Math.floor(Math.random() * candidates.length)];
  const minBid = tftAuctionMinNextBid(lot);
  const budgetCap = Math.floor(p.gold * TFT_AUCTION_CPU_MAX_GOLD_RATIO);
  if (minBid > budgetCap || minBid > p.gold) return;
  tftPlaceBid(state, playerId, lot.id, minBid);
}

// 軍事: 疲労ユニットの退却 → 計略 → 侵攻先決定・即時解決(AP尽きるまでループ) → 空き前線の守備配置
function tftAiOrders(state, playerId) {
  const p = state.players[playerId];
  // passive（ラスボス）は退却も計略も侵攻も守備配置もしない。本拠地1マスに座り続ける。
  if (p.eliminated || p.roster.length === 0 || tftIsPassiveFaction(state, playerId)) return;

  // acted(1ターン1行動)廃止に伴い、同一呼び出し内の二重指示防止をローカルセットで代替する
  const usedThisPass = new Set();
  const homeOwned = state.cells[p.homeCell].ownerId === playerId;

  // ① 疲労が濃いユニットは本拠地へ退却させて回復を狙う（即時移動）
  if (homeOwned) {
    for (const u of p.roster) {
      if (u.fatigue >= 3 && u.pos !== p.homeCell && !usedThisPass.has(u.uid)) {
        const r = tftMoveUnit(state, playerId, u.uid, p.homeCell);
        if (r.ok) usedThisPass.add(u.uid);
      }
    }
  }

  // ①.5 計略（研究済みなら侵攻より先に判断。AP4-5を食うため使いすぎ防止に1ターン1回）
  tftAiSchemes(state, playerId);
  if (state.phase === TFT_PHASE.OVER) return;

  // ② 侵攻先の選定: 中立地(モンスター)は自軍戦力が脅威見積もりを上回る場合のみ優先、
  //    それ以外は守りの薄い敵セルを狙う。AP制導入により1ターンに複数回出撃できるため、
  //    対象がなくなる/どの出撃元セルもAP不足で拒否されるまでループする。
  //    経路システムでは選択ユニット全員が同一セル発である必要があるため、
  //    攻撃チームは出撃元セル(target.from)に実際に駐留するユニットから組む。
  let guard = 0;
  while (guard++ < 20) {
    // CPU勢力同士は不可侵なので、狙えるのは中立地とプレイヤーの領土だけ
    const targets = tftBorderTargets(state, playerId).filter(t => tftAiCanTarget(state, playerId, t.to));
    if (targets.length === 0) break;
    const monsterThreat = tftMonsterThreatEstimate(state.turn);

    // 出撃元セルの動かせる戦力（コスト合計）
    const forceOf = (from) => tftGarrison(state, from)
      .filter(u => !usedThisPass.has(u.uid) && u.fatigue < 3)
      .reduce((s, u) => s + u.cost, 0);

    const scored = targets
      // 勝てる見込みの無い中立地には手を出さない。ここを「優先度を下げるだけ」にすると、
      // 他に狙える相手が無いとき（CPU同士は不可侵なので序盤はほぼこの状態）に、
      // 勝てないと分かっているモンスターへ全滅するまで毎ターン突撃し続けてしまう。
      .filter(t => state.cells[t.to].ownerId !== null
        || forceOf(t.from) >= monsterThreat * TFT_AI_MONSTER_FORCE_MARGIN)
      .map(t => {
        const cell = state.cells[t.to];
        const garrison = tftGarrison(state, t.to);
        // スコアが小さいほど攻めやすい。ここまで残った中立地は勝算があるので最優先。
        const neutralBonus = cell.ownerId === null ? -100 : 0;
        const score = neutralBonus + garrison.length * 10 + cell.facilities.length * 3 + Math.random();
        return { ...t, score };
      }).sort((a, b) => a.score - b.score);
    if (scored.length === 0) break; // 攻められる相手が居ない（戦力を貯めるフェーズ）

    let didAttack = false;
    for (const target of scored) {
      const available = tftGarrison(state, target.from)
        .filter(u => !usedThisPass.has(u.uid) && u.fatigue < 3)
        .sort((a, b) => a.fatigue - b.fatigue || b.cost - a.cost);
      // 本拠地は守備隊(tftSpawnHomeGuard)が常に防衛するため、全ユニットを攻めに回せる
      const attackCount = Math.min(MAX_TEAM_SIZE, available.length);
      if (attackCount < 1) continue;
      const attackTeam = available.slice(0, attackCount).map(u => u.uid);
      const r = tftDeclareAndResolve(state, playerId, target.to, attackTeam);
      if (r.ok) {
        attackTeam.forEach(uid => usedThisPass.add(uid));
        didAttack = true;
        if (state.phase === TFT_PHASE.OVER) return; // 本拠地喪失等でゲーム終了したら以降は不要
        break;
      }
    }
    if (!didAttack) break; // どの対象にも侵攻できなかった（AP不足等）ら終了
  }

  // ③ 攻撃に出ていない余剰ユニットを、駐留ゼロの前線セルへ回す（即時移動）。
  //    不可侵のCPU勢力と接しているだけの境界は脅威にならないので前線とみなさない
  //    （そこへ守備を置いても永久に遊ばせるだけになる）。
  const idle = p.roster.filter(u => !usedThisPass.has(u.uid) && u.fatigue < 3);
  const emptyFrontier = tftOwnedCells(state, playerId).filter(c =>
    tftGarrison(state, c.index).length === 0 &&
    tftNeighbors(c.index).some(nb =>
      state.cells[nb].ownerId !== null && tftAiCanTarget(state, playerId, nb)));
  for (let i = 0; i < Math.min(idle.length, emptyFrontier.length); i++) {
    // 本拠地は守備隊が常に防衛するため、本拠地の駐留ユニットも自由に前線へ回せる
    const r = tftMoveUnit(state, playerId, idle[i].uid, emptyFrontier[i].index);
    if (r.ok) usedThisPass.add(idle[i].uid);
  }
}
