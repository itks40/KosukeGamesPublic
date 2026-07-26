// POST /api/games/:id/actions/:type の :type から、既存のtftXxx関数への薄いマッピング。
// クライアントはJSONの args オブジェクトで名前付き引数を送る（順序を気にしなくて済むように）。
// 引数の並び・返り値の形はすべて元関数（tft/js/tft-state.js, tft-battle.js）のシグネチャそのまま。

export const ACTION_TABLE = {
  hireUnit: (GL, state, playerId, args) =>
    GL.tftHireUnit(state, playerId, args.unitDataId, args.targetCellIndex),
  dismissUnit: (GL, state, playerId, args) =>
    GL.tftDismissUnit(state, playerId, args.uid, args.cellIndex),
  trainUnit: (GL, state, playerId, args) =>
    GL.tftTrainUnit(state, playerId, args.uid, args.cellIndex),
  equipItem: (GL, state, playerId, args) =>
    GL.tftEquipItem(state, playerId, args.uid, args.itemId),
  unequipItem: (GL, state, playerId, args) =>
    GL.tftUnequipItem(state, playerId, args.uid),
  listItemForAuction: (GL, state, playerId, args) =>
    GL.tftListItemForAuction(state, playerId, args.itemIndex),
  placeBid: (GL, state, playerId, args) =>
    GL.tftPlaceBid(state, playerId, args.lotId, args.amount),
  explore: (GL, state, playerId, args) =>
    GL.tftExplore(state, playerId, args.cellIndex, args.kind),
  tradeFood: (GL, state, playerId, args) =>
    GL.tftTradeFood(state, playerId, args.cellIndex, args.action),
  upgradeBuilding: (GL, state, playerId, args) =>
    GL.tftUpgradeBuilding(state, playerId, args.cellIndex, args.kind),
  researchRank: (GL, state, playerId, args) =>
    GL.tftResearchRank(state, playerId, args.lineageId, args.apCellIndex),
  researchScheme: (GL, state, playerId, args) =>
    GL.tftResearchScheme(state, playerId, args.apCellIndex),
  useScheme: (GL, state, playerId, args) =>
    GL.tftUseScheme(state, playerId, args.schemeId, args.apCellIndex, args.targetCellIndex),
  // 出陣＝侵攻/移動を統一。人間関与時のtftOnBattleResolved呼び出しはgame-room.js側でno-opスタブ済み
  // （戦闘モーダルはクライアント側がstate/reportを見て自前で判断・表示する）。
  executeRoute: (GL, state, playerId, args) =>
    GL.tftExecuteRoute(state, playerId, args.path, args.unitUids),
};
