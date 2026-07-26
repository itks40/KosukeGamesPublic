const shopState = {
  role: 'attacker',    // 'attacker' | 'defender'
  gold: ATTACKER_GOLD,
  team: [],
  items: {},           // itemId -> 所持数（未装備のインベントリ）
  facilities: [],      // 購入済み防衛設備のid配列（各1個・防衛側のみ）
};

// 役割の初期資金を返す
function roleStartGold(role) {
  return role === 'defender' ? DEFENDER_GOLD : ATTACKER_GOLD;
}

function shopReset(role = 'attacker') {
  shopState.role = role;
  shopState.gold = roleStartGold(role);
  shopState.team = [];
  shopState.items = {};
  shopState.facilities = [];
}

function shopBuy(unitData) {
  if (shopState.team.length >= MAX_TEAM_SIZE) return { ok: false, reason: 'チームが満員です（最大5体）' };
  if (shopState.gold < unitData.cost) return { ok: false, reason: 'ゴールドが足りません' };
  if (shopState.team.some(u => u.id === unitData.id)) return { ok: false, reason: '同じユニットはすでにいます' };

  shopState.gold -= unitData.cost;
  shopState.team.push({ ...unitData, item: null, maxMp: unitMaxMp(unitData) });
  return { ok: true };
}

function shopSell(unitId) {
  const idx = shopState.team.findIndex(u => u.id === unitId);
  if (idx === -1) return { ok: false };

  const unit = shopState.team[idx];
  if (unit.item) {
    shopState.items[unit.item.id] = (shopState.items[unit.item.id] || 0) + 1;
  }
  shopState.gold += unit.cost;
  shopState.team.splice(idx, 1);
  return { ok: true };
}

// アイテムを購入してインベントリに追加する
function shopBuyItem(itemId) {
  const item = ITEMS_LIST.find(it => it.id === itemId);
  if (!item) return { ok: false, reason: 'アイテムが見つかりません' };
  if (shopState.gold < item.cost) return { ok: false, reason: 'ゴールドが足りません' };

  shopState.gold -= item.cost;
  shopState.items[itemId] = (shopState.items[itemId] || 0) + 1;
  return { ok: true };
}

// インベントリから取り出してユニットに装備する（既に装備中のアイテムはインベントリに戻る）
function shopEquipItem(unitId, itemId) {
  const unit = shopState.team.find(u => u.id === unitId);
  if (!unit) return { ok: false };
  if (!shopState.items[itemId] || shopState.items[itemId] <= 0) return { ok: false, reason: 'アイテムを所持していません' };

  const item = ITEMS_LIST.find(it => it.id === itemId);
  if (!item) return { ok: false };
  if (item.lineage && unit.lineage.id !== item.lineage) {
    const label = Object.values(LINEAGES).find(l => l.id === item.lineage)?.label || item.lineage;
    return { ok: false, reason: `${item.name}は${label}専用の装備です` };
  }

  if (unit.item) {
    shopState.items[unit.item.id] = (shopState.items[unit.item.id] || 0) + 1;
  }
  shopState.items[itemId] -= 1;
  unit.item = item;
  return { ok: true };
}

// ユニットの装備を外してインベントリに戻す
function shopUnequipItem(unitId) {
  const unit = shopState.team.find(u => u.id === unitId);
  if (!unit || !unit.item) return { ok: false };

  shopState.items[unit.item.id] = (shopState.items[unit.item.id] || 0) + 1;
  unit.item = null;
  return { ok: true };
}

// 防衛設備を購入する（防衛側のみ・全体で MAX_FACILITIES 個まで）
function shopBuyFacility(facilityId) {
  if (shopState.role !== 'defender') return { ok: false, reason: '防衛設備は防衛側のみ購入できます' };
  if (shopState.facilities.includes(facilityId)) return { ok: false, reason: 'すでに建設済みです' };
  if (shopState.facilities.length >= MAX_FACILITIES) return { ok: false, reason: `防衛設備は${MAX_FACILITIES}つまでです（売却してから建て替えてください）` };

  const facility = FACILITIES_LIST.find(f => f.id === facilityId);
  if (!facility) return { ok: false, reason: '設備が見つかりません' };
  if (shopState.gold < facility.cost) return { ok: false, reason: 'ゴールドが足りません' };

  shopState.gold -= facility.cost;
  shopState.facilities.push(facilityId);
  return { ok: true };
}

// 防衛設備を撤去して費用を全額返金する
function shopSellFacility(facilityId) {
  const idx = shopState.facilities.indexOf(facilityId);
  if (idx === -1) return { ok: false };

  const facility = FACILITIES_LIST.find(f => f.id === facilityId);
  if (facility) shopState.gold += facility.cost;
  shopState.facilities.splice(idx, 1);
  return { ok: true };
}

function getShopSynergySummary() {
  return getActiveSynergies(shopState.team);
}
