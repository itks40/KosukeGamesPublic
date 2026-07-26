// ============================================================
// ターン境界処理（tftRunTurnBoundary）。
// document/window に依存しない純粋な状態遷移関数のみをこのファイルに閉じる
// （tft-turn.js 側のブラウザ専用タイマーループ・visibilitychange ハンドラとは無関係に
//   Cloudflare Worker 等の非ブラウザ環境からも読み込めるようにするための分離）。
// ============================================================

// ターン境界処理: 建設・研究の完成判定 → 収入・食料/維持費 → 行動力(AP)回復/占領直後フラグのリセット → CPU行動
function tftRunTurnBoundary(state) {
  const completed = tftTickConstructions(state);
  for (const ev of completed) {
    if (ev.type === 'research' && ev.playerId === state.humanPlayerId) {
      const lineage = Object.values(LINEAGES).find(l => l.id === ev.lineageId);
      tftToast(`🔬 ${lineage.label} の研究が完了！R${ev.rank}まで解禁`);
    } else if (ev.type === 'schemeResearch' && ev.playerId === state.humanPlayerId) {
      tftToast(`📜 計略研究が完了！「${TFT_SCHEME_LEVEL_LABELS[ev.level - 1]}」が使用可能に`);
    } else if ((ev.type === 'townBuild' || ev.type === 'farmBuild') && ev.ownerId === state.humanPlayerId) {
      tftToast(`🏗️ ${ev.type === 'townBuild' ? '町' : '農場'}が Lv${ev.level} に完成！`);
    }
  }

  tftApplyIncome(state);
  const shortages = tftApplyFoodAndUpkeep(state);
  const shortagePlayerIds = new Set(shortages.map(ev => ev.playerId));
  for (const ev of shortages) {
    if (ev.playerId === state.humanPlayerId) {
      tftToast(`🌾 食料不足！ ユニット${ev.shortage}体が疲労し、全領土の支持率が下がった`);
    }
  }

  for (const c of state.cells) {
    const regenerated = Math.min(TFT_CELL_AP_MAX, c.ap + TFT_CELL_AP_REGEN);
    // 回復分が上限に切り捨てられ無駄になる場合、自動的に金の探索を行ったことにする
    if (c.ownerId !== null && regenerated === TFT_CELL_AP_MAX) {
      const owner = state.players[c.ownerId];
      const amount = tftRollExploreAmount(TFT_AP_OVERFLOW_GOLD_RANGE);
      owner.gold += amount;
      tftLogAction(state, {
        playerId: c.ownerId,
        type: 'explore',
        text: `${owner.name} の ${tftCellLabel(c.index)} が行動力上限で自動探索 → 💰+${amount}G`,
        isHumanInvolved: c.ownerId === state.humanPlayerId,
      });
    }
    c.ap = regenerated;
    c.capturedThisTurn = false;
    // 支持率は基準値(TFT_SUPPORT_BASELINE)へ双方向に収束する（商人在庫の基準値復元と同じ考え方）。
    // 下回る分は回復（食料不足だったプレイヤーの領土はこのターン回復しない）、
    // 上回る分（宣撫工作等で押し上げた分）は減衰して基準値へ戻る＝100は一時的にしか作れない。
    if (c.ownerId !== null) {
      if (c.support < TFT_SUPPORT_BASELINE) {
        if (!shortagePlayerIds.has(c.ownerId)) {
          c.support = Math.min(TFT_SUPPORT_BASELINE, c.support + TFT_SUPPORT_REGEN);
        }
      } else if (c.support > TFT_SUPPORT_BASELINE) {
        c.support = Math.max(TFT_SUPPORT_BASELINE, c.support - TFT_SUPPORT_DECAY);
      }
    }
  }

  // 商人在庫を基準値へ双方向に復元（買い占め後は補充、売られ過ぎ後は減衰）
  const m = state.merchant;
  if (m.food < TFT_MERCHANT_FOOD_BASELINE) {
    m.food = Math.min(TFT_MERCHANT_FOOD_BASELINE, m.food + TFT_MERCHANT_RESTOCK_STEP);
  } else if (m.food > TFT_MERCHANT_FOOD_BASELINE) {
    m.food = Math.max(TFT_MERCHANT_FOOD_BASELINE, m.food - TFT_MERCHANT_RESTOCK_STEP);
  }

  // オークション: 締切到達ロットの解決（落札/流札）→ system出品の補充
  tftTickAuction(state);

  for (const p of tftActivePlayers(state)) {
    if (p.isHuman) continue;
    tftAiEconomy(state, p.id);
    tftAiOrders(state, p.id); // 即時解決なのでこの場で全て完了する
    tftAiTraining(state, p.id); // 軍事の後（拡張に要るAPを訓練が食わないよう最低優先度）
    tftAiAuctionBid(state, p.id);
    if (state.phase === TFT_PHASE.OVER) break;
  }

  state.turnBoundaryAt = Date.now() + state.turnMs;
}
