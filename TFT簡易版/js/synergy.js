// アイテムで追加されたクラスを含めた実効クラス一覧を返す（集計はcountClasses側で行うため未使用。
// 「このユニットが実質どのクラスに属するか」を単純集合で知りたい用途向けに残置）。
function getEffectiveClasses(unit) {
  if (unit.isMonster) return [];
  const classes = [...unit.classes];
  if (unit.item?.type === 'class' && !classes.includes(unit.item.addClass)) {
    classes.push(unit.item.addClass);
  }
  return classes;
}

// チームの各クラスの員数を数える。
// - 同じユニット（同じid）を複数体編成しても1体分しか数えない（TFTは同一ユニットを複数雇用できるため）。
// - モンスターはシナジー非対象。
// - クラス紋章アイテムは「そのクラスの追加の1体分」として素のクラス保有に上乗せ加算する
//   （素で同じクラスを持っていても+1）。これにより紋章を投資した編成はcountを編成上限5を超えて
//   伸ばせる（6体以上の上位シナジーが発動可能になる）。
function countClasses(team) {
  const counts = {};
  const seenIds = new Set();
  for (const unit of team) {
    if (seenIds.has(unit.id)) continue;
    seenIds.add(unit.id);
    if (unit.isMonster) continue;
    for (const cls of unit.classes) counts[cls] = (counts[cls] || 0) + 1;
    if (unit.item?.type === 'class') {
      counts[unit.item.addClass] = (counts[unit.item.addClass] || 0) + 1;
    }
  }
  return counts;
}

// ステータスアイテムによる1段階アップ（STAT_TIERS上で1つ上の値に揃える。既に最大なら変化なし）
function bumpTier(stat, value) {
  const tiers = STAT_TIERS[stat];
  const idx = tiers.indexOf(value);
  if (idx === -1) return value;
  return tiers[Math.min(idx + 1, tiers.length - 1)];
}

function getActiveSynergies(team) {
  const counts = countClasses(team);
  const active = [];

  for (const rule of SYNERGY_RULES) {
    const count = counts[rule.classId] || 0;
    const triggered = rule.thresholds.find(t => count >= t.count);
    const next = rule.thresholds.slice().reverse().find(t => count < t.count);

    active.push({
      classId: rule.classId,
      type: rule.type,
      count,
      triggered: triggered || null,
      nextThreshold: next ? next.count : null,
      rule,
    });
  }

  return active;
}

// 役割（攻撃/防衛）と保有設備から、そのチームに掛かる修飾子を集約して返す。
// 編成時に効くもの（atkMul/defMul/spdMul/shieldPct）と、バトル中に効くもの
// （turnHeal/turnDamage/openingDamage/enemyHealReduction/skillChanceBonus）を分けて返す。
function buildSideModifiers(role, facilityIds = []) {
  const mods = {
    atkMul: 0, defMul: 0, spdMul: 0, shieldPct: 0,
    turnHeal: 0,
    turnDamage: [],          // [{ targets, value }]
    openingDamage: 0,
    enemyHealReduction: 0,
    skillChanceBonus: 0,
  };

  // 防衛側の常時DEFボーナス
  if (role === 'defender') mods.defMul += DEFENDER_DEF_BONUS;

  for (const id of facilityIds) {
    const facility = FACILITIES_LIST.find(f => f.id === id);
    if (!facility) continue;
    const e = facility.effect;
    switch (e.type) {
      case 'stat':
        if (e.stat === 'atk') mods.atkMul += e.value;
        else if (e.stat === 'def') mods.defMul += e.value;
        else if (e.stat === 'spd') mods.spdMul += e.value;
        break;
      case 'shield':               mods.shieldPct += e.value; break;
      case 'turn_heal':            mods.turnHeal += e.value; break;
      case 'turn_damage':          mods.turnDamage.push({ targets: e.targets, value: e.value }); break;
      case 'opening_damage':       mods.openingDamage += e.value; break;
      case 'enemy_heal_reduction': mods.enemyHealReduction = Math.max(mods.enemyHealReduction, e.value); break;
      case 'skill_chance':         mods.skillChanceBonus += e.value; break;
    }
  }
  return mods;
}

function applyStatSynergies(team, mods = {}) {
  const counts = countClasses(team);

  // シナジー由来（クラス数から算出）の加算倍率・効果
  const syn = { atk: 0, def: 0, spd: 0, hp: 0 };
  let synHeal = 0;
  let synBerserk = 0;
  let synShield = 0;

  for (const rule of SYNERGY_RULES) {
    const count = counts[rule.classId] || 0;
    const triggered = rule.thresholds.find(t => count >= t.count);
    if (!triggered) continue;

    if (rule.type === 'multiplier') {
      syn[triggered.stat] += triggered.multiplier;
    } else if (rule.type === 'heal') {
      synHeal = triggered.healPerTurn;
    } else if (rule.type === 'berserker') {
      synBerserk = triggered.bonus;
    } else if (rule.type === 'shield') {
      synShield = triggered.shieldPct;
    }
  }

  // 設備・役割ボーナス（buildSideModifiers の集約値）由来の加算倍率・効果
  const modAtk = mods.atkMul || 0;
  const modDef = mods.defMul || 0;
  const modSpd = mods.spdMul || 0;
  const modShield = mods.shieldPct || 0;

  return team.map(base => {
    // モンスターはシナジーを一切受けない（設備・役割の拠点バフは受ける）
    const isMon = !!base.isMonster;
    const mAtk = 1 + (isMon ? 0 : syn.atk) + modAtk;
    const mDef = 1 + (isMon ? 0 : syn.def) + modDef;
    const mSpd = 1 + (isMon ? 0 : syn.spd) + modSpd;
    const mHp  = 1 + (isMon ? 0 : syn.hp);
    const berserkerBonus = isMon ? 0 : synBerserk;

    // ステータスアイテム（stat型・relic型のtierフィールド）は合成シナジー適用前のベース値をtier段階アップする
    const it = base.item;
    let hp = base.hp, atk = base.atk, def = base.def, spd = base.spd;
    if (it?.type === 'stat') {
      const t = it.tier || 1;
      for (let i = 0; i < t; i++) {
        if (it.stat === 'hp') hp = bumpTier('hp', hp);
        else if (it.stat === 'atk') atk = bumpTier('atk', atk);
        else if (it.stat === 'def') def = bumpTier('def', def);
        else if (it.stat === 'spd') spd = bumpTier('spd', spd);
      }
    } else if (it?.type === 'relic') {
      for (let i = 0; i < (it.hpTier || 0); i++) hp = bumpTier('hp', hp);
      for (let i = 0; i < (it.atkTier || 0); i++) atk = bumpTier('atk', atk);
      for (let i = 0; i < (it.defTier || 0); i++) def = bumpTier('def', def);
      for (let i = 0; i < (it.spdTier || 0); i++) spd = bumpTier('spd', spd);
    }

    // アイテム由来のshield/regen/mp_max（typeまたはrelicの対応フィールド）をシナジー由来の値に加算
    const itemShieldPct = it?.type === 'shield' ? it.value : it?.type === 'relic' ? (it.shieldValue || 0) : 0;
    const itemRegen = it?.type === 'regen' ? it.value : it?.type === 'relic' ? (it.regenValue || 0) : 0;
    const itemMpMax = it?.type === 'mp_max' ? it.value : it?.type === 'relic' ? (it.mpMaxValue || 0) : 0;

    const healPerTurn = (isMon ? 0 : synHeal) + (isMon ? 0 : itemRegen);
    const shieldPct = (isMon ? 0 : synShield) + modShield + (isMon ? 0 : itemShieldPct);
    const boostedMaxMp = base.maxMp !== undefined ? base.maxMp + (isMon ? 0 : itemMpMax) : undefined;

    // 汎用の per-unit 最終ステータス倍率。シナジー・アイテムを適用しきった最後に一律で掛かる。
    // TFTのユニットレベルがここに tftLevelStatMultiplier(level) を載せる（tft-battle.js の tftPrepTeam）。
    // ベース値のティア段上げ（bumpTier）はこの乗算より前に済むので、レベルとアイテムは共存する。
    // TFTBS本体のユニットは statMul を持たないため extraMul=1 で従来と完全一致（後方互換）。
    const extraMul = base.statMul || 1;
    const maxHp = Math.floor(hp * mHp * extraMul);
    const unit = {
      ...base,
      currentHp: maxHp,
      maxHp,
      baseAtk: Math.floor(atk * mAtk * extraMul),
      def: Math.floor(def * mDef * extraMul),
      spd: Math.floor(spd * mSpd * extraMul),
      berserkerBonus,
      healPerTurn,
      shield: Math.floor(maxHp * shieldPct),
      shieldHitsLeft: shieldPct > 0 ? 5 : 0,
      skill: base.skill || null,
      taunt: base.item?.type === 'taunt',
      // MP要素。TFTBSはjs/data.jsのunitMaxMp()、TFTはtft-data.jsのtftMaxMp()がbase.maxMpを付与する。
      // base.maxMpが未設定なら undefined のままで、battle.js側のhasMp()は「MP未設定=無制限」として扱う。
      maxMp: boostedMaxMp,
      mp: boostedMaxMp !== undefined ? boostedMaxMp : undefined,
    };
    unit.atk = unit.baseAtk;
    return unit;
  });
}
