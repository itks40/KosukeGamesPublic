function runBattle(playerTeamBase, cpuTeamBase, playerMods = {}, cpuMods = {}) {
  const playerTeam = applyStatSynergies(playerTeamBase, playerMods);
  const cpuTeam   = applyStatSynergies(cpuTeamBase, cpuMods);

  // 防衛設備・役割ボーナスの修飾子をラベルで引けるようにする
  const modsByLabel = { 'プレイヤー': playerMods, 'CPU': cpuMods };
  const teamByLabel = { 'プレイヤー': playerTeam, 'CPU': cpuTeam };
  const otherLabel = (label) => (label === 'プレイヤー' ? 'CPU' : 'プレイヤー');

  // タイムライン方式: 各ユニットに「次回行動時刻」を持たせ、最も早いユニットが行動する。
  const allUnits = [
    ...playerTeam.map(u => ({ unit: u, team: playerTeam, enemies: cpuTeam, label: 'プレイヤー', nextTime: 1 / u.spd })),
    ...cpuTeam.map(u =>    ({ unit: u, team: cpuTeam,   enemies: playerTeam, label: 'CPU',       nextTime: 1 / u.spd })),
  ];

  const log = [];
  let actionCount = 0;

  function alive(team) {
    return team.filter(u => u.currentHp > 0);
  }

  function getBerserkerAtk(unit) {
    if (unit.berserkerBonus > 0 && unit.currentHp <= unit.maxHp * 0.5) {
      return Math.floor(unit.baseAtk * (1 + unit.berserkerBonus));
    }
    return unit.baseAtk;
  }

  // 挑発（taunt）持ちは被選択重みが2倍になるランダム抽選
  function pickRandom(arr) {
    const weights = arr.map(u => (u.taunt ? 2 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  function healTeam(team, label) {
    // 敵の「呪術結界」による回復量減少
    const reduction = modsByLabel[otherLabel(label)]?.enemyHealReduction || 0;
    for (const unit of alive(team)) {
      // 各ユニット自身の healPerTurn を使う（モンスターは0。team[0]依存だと先頭がモンスターだと全体が回復しない）
      let healAmount = unit.healPerTurn || 0;
      if (healAmount <= 0) continue;
      if (reduction > 0) healAmount = Math.floor(healAmount * (1 - reduction));
      if (healAmount <= 0) continue;
      const before = unit.currentHp;
      unit.currentHp = Math.min(unit.currentHp + healAmount, unit.maxHp);
      const healed = unit.currentHp - before;
      if (healed > 0) {
        log.push({
          type: 'heal',
          unitId: unit.id,
          label,
          healed,
          currentHp: unit.currentHp,
          maxHp: unit.maxHp,
          text: `[${label}] ${unit.name} がHPを ${healed} 回復 (${unit.currentHp}/${unit.maxHp})`,
        });
      }
    }
  }

  // ======== スキルヘルパー ========

  // MP要素（TFT専用機能）。maxMpが未設定のユニット（TFTBS等）は常にtrue＝無制限のまま。
  function hasMp(unit) {
    return unit.maxMp === undefined || unit.mp > 0;
  }
  function spendMp(unit) {
    if (unit.maxMp !== undefined) unit.mp -= 1;
  }

  // on_defend スキル: 防御側のダメージを変更して返す
  function applyDefendSkill(tgt, dmg, tgtLabel) {
    const sk = tgt.skill;
    if (!sk || sk.trigger !== 'on_defend' || dmg <= 0) return dmg;
    const bonus = modsByLabel[tgtLabel]?.skillChanceBonus || 0; // 古代遺跡
    if (hasMp(tgt) && sk.effect === 'reduce' && Math.random() < sk.chance + bonus) {
      spendMp(tgt);
      const reduced = Math.max(1, Math.floor(dmg * (1 - sk.value)));
      log.push({ type: 'skill', casterId: tgt.id, casterLabel: tgtLabel, skillName: sk.name,
        mp: tgt.mp, maxMp: tgt.maxMp,
        text: `🛡 ${tgt.name}（${tgtLabel}）【${sk.name}】発動！ダメージ${dmg}→${reduced}に軽減` });
      return reduced;
    }
    return dmg;
  }

  // on_attack スキル: 攻撃後の追加効果
  function applyAttackSkill(attacker, mainTarget, enemies, mainDmg, attackerLabel, targetLabel) {
    const sk = attacker.skill;
    if (!sk || sk.trigger !== 'on_attack') return;
    const bonus = modsByLabel[attackerLabel]?.skillChanceBonus || 0; // 古代遺跡

    // chain: 確率で別の敵に波及ダメージ
    if (hasMp(attacker) && sk.effect === 'chain' && Math.random() < sk.chance + bonus) {
      const others = alive(enemies).filter(t => t !== mainTarget);
      if (others.length > 0) {
        spendMp(attacker);
        const secondary = pickRandom(others);
        const chainDmg = Math.max(1, Math.floor(mainDmg * sk.value));
        secondary.currentHp -= chainDmg;
        const dead = secondary.currentHp <= 0;
        log.push({ type: 'skill', casterId: attacker.id, casterLabel: attackerLabel,
          targetId: secondary.id, targetLabel, skillName: sk.name,
          damage: chainDmg, targetHp: Math.max(0, secondary.currentHp), targetMaxHp: secondary.maxHp, isDead: dead,
          mp: attacker.mp, maxMp: attacker.maxMp,
          text: `⚡ ${attacker.name}（${attackerLabel}）【${sk.name}】${secondary.name}に${chainDmg}の連鎖ダメージ${dead ? '（撃破！）' : ''}` });
      }
    }

    // extra_attack: 確率で追加攻撃
    if (hasMp(attacker) && sk.effect === 'extra_attack' && Math.random() < sk.chance + bonus) {
      const tgts = alive(enemies);
      if (tgts.length > 0) {
        spendMp(attacker);
        const t2 = pickRandom(tgts);
        const currentAtk2 = getBerserkerAtk(attacker);
        const dmg2 = Math.max(1, Math.floor(currentAtk2 * DEFENSE_CONSTANT / (DEFENSE_CONSTANT + t2.def)));
        t2.currentHp -= dmg2;
        const dead = t2.currentHp <= 0;
        log.push({ type: 'skill', casterId: attacker.id, casterLabel: attackerLabel,
          targetId: t2.id, targetLabel, skillName: sk.name,
          damage: dmg2, targetHp: Math.max(0, t2.currentHp), targetMaxHp: t2.maxHp, isDead: dead,
          mp: attacker.mp, maxMp: attacker.maxMp,
          text: `🏹 ${attacker.name}（${attackerLabel}）【${sk.name}】${t2.name}を追加攻撃！${dmg2}ダメージ${dead ? '（撃破！）' : ''}` });
      }
    }
  }

  // on_turn_end スキル: ターン終了時の効果
  function applyTurnEndSkills(team, teamLabel) {
    const reduction = modsByLabel[otherLabel(teamLabel)]?.enemyHealReduction || 0; // 呪術結界
    for (const u of alive(team)) {
      const sk = u.skill;
      if (!sk || sk.trigger !== 'on_turn_end' || !hasMp(u)) continue;
      if (sk.effect === 'heal_lowest' || sk.effect === 'heal_lowest_2') {
        const count = sk.effect === 'heal_lowest_2' ? 2 : 1;
        const healRaw = reduction > 0 ? Math.floor(sk.value * (1 - reduction)) : sk.value;
        if (healRaw <= 0) continue;
        const sorted = alive(team).sort((a, b) => a.currentHp - b.currentHp);
        const targets = sorted.slice(0, count).filter(w => w.currentHp < w.maxHp);
        // 実際に誰かを回復できる時だけMPを消費する（既に全員満タンなら不発＝MPは減らない）。
        // ログに載る mp/maxMp が消費後の値になるよう、ログをpushする前に先に消費する。
        if (targets.length > 0) {
          spendMp(u);
          for (const weakest of targets) {
            const healed = Math.min(healRaw, weakest.maxHp - weakest.currentHp);
            weakest.currentHp += healed;
            log.push({ type: 'skill', casterId: u.id, casterLabel: teamLabel,
              targetId: weakest.id, targetLabel: teamLabel, skillName: sk.name,
              healed, currentHp: weakest.currentHp, maxHp: weakest.maxHp,
              mp: u.mp, maxMp: u.maxMp,
              text: `💚 ${u.name}（${teamLabel}）【${sk.name}】${weakest.name}のHPを${healed}回復` });
          }
        }
      }
    }
  }

  // ======== 防衛設備ヘルパー ========

  // 開幕: opening_damage（落とし穴）を保有側→敵全員へ適用（シールドは貫通）
  function applyOpeningFacilities() {
    for (const label of ['プレイヤー', 'CPU']) {
      const dmg = modsByLabel[label]?.openingDamage || 0;
      if (dmg <= 0) continue;
      const foeLabel = otherLabel(label);
      for (const foe of alive(teamByLabel[foeLabel])) {
        foe.currentHp -= dmg;
        const dead = foe.currentHp <= 0;
        log.push({ type: 'facility', kind: 'damage', label: foeLabel, unitId: foe.id,
          damage: dmg, targetHp: Math.max(0, foe.currentHp), targetMaxHp: foe.maxHp, isDead: dead,
          text: `🕳️ ${foe.name}（${foeLabel}）が落とし穴で${dmg}ダメージ${dead ? '（撃破！）' : ''}` });
      }
    }
  }

  // ラウンド境界: turn_heal（治療所）と turn_damage（弓塔/魔導砲）を発火
  function fireTurnFacilities() {
    for (const label of ['プレイヤー', 'CPU']) {
      const mods = modsByLabel[label];
      if (!mods) continue;
      const foeLabel = otherLabel(label);

      // 治療所: 味方全員回復（敵の呪術結界で減少）
      if (mods.turnHeal > 0) {
        const reduction = modsByLabel[foeLabel]?.enemyHealReduction || 0;
        const heal = reduction > 0 ? Math.floor(mods.turnHeal * (1 - reduction)) : mods.turnHeal;
        if (heal > 0) {
          for (const u of alive(teamByLabel[label])) {
            if (u.currentHp >= u.maxHp) continue;
            const healed = Math.min(heal, u.maxHp - u.currentHp);
            u.currentHp += healed;
            log.push({ type: 'facility', kind: 'heal', label, unitId: u.id,
              healed, currentHp: u.currentHp, maxHp: u.maxHp,
              text: `⛑️ ${u.name}（${label}）が治療所で${healed}回復 (${u.currentHp}/${u.maxHp})` });
          }
        }
      }

      // 弓塔/魔導砲: ランダムな敵 targets 体へ（シールド貫通・重複なし）
      for (const td of (mods.turnDamage || [])) {
        const pool = alive(teamByLabel[foeLabel]).slice();
        const hitCount = Math.min(td.targets, pool.length);
        for (let i = 0; i < hitCount; i++) {
          const foe = pickRandom(pool);
          pool.splice(pool.indexOf(foe), 1);
          foe.currentHp -= td.value;
          const dead = foe.currentHp <= 0;
          log.push({ type: 'facility', kind: 'damage', label: foeLabel, unitId: foe.id,
            damage: td.value, targetHp: Math.max(0, foe.currentHp), targetMaxHp: foe.maxHp, isDead: dead,
            text: `🎯 ${foe.name}（${foeLabel}）が防衛設備で${td.value}ダメージ${dead ? '（撃破！）' : ''}` });
        }
      }
    }
  }

  // ======== メインループ ========

  // 開幕の設備効果（落とし穴）を先に発火
  applyOpeningFacilities();

  // 「1ラウンド」= 全生存ユニットが概ね1回行動する区切り。境界で毎ラウンド系設備を発火する。
  let roundBoundary = allUnits.filter(e => e.unit.currentHp > 0).length;

  while (actionCount < MAX_ACTIONS) {
    const livingEntries = allUnits.filter(e => e.unit.currentHp > 0);
    if (livingEntries.length === 0) break;

    // 次回行動時刻が最も早いユニットが行動（同時刻はSPD高い方を優先）
    livingEntries.sort((a, b) => a.nextTime - b.nextTime || b.unit.spd - a.unit.spd);
    const actor = livingEntries[0];
    actor.nextTime += 1 / actor.unit.spd;

    const { unit, enemies, label } = actor;

    const targets = alive(enemies);
    if (targets.length === 0) break;

    const currentAtk = getBerserkerAtk(unit);
    const targetLabel = label === 'プレイヤー' ? 'CPU' : 'プレイヤー';

    // 1ヒット分の解決（通常攻撃・アイテムcleaveの全体攻撃で共用）。戻り値 { isDead, finalDmg }。
    function resolveHit(defender, atkMultiplier) {
      // スキル: pierce（DEFを一定割合無視）。他のon_attackスキルと同様にhasMp/spendMpゲートを通す。
      let effectiveDef = defender.def;
      if (unit.skill?.trigger === 'on_attack' && unit.skill.effect === 'pierce'
          && hasMp(unit) && Math.random() < unit.skill.chance) {
        spendMp(unit);
        effectiveDef = Math.max(0, Math.floor(defender.def * (1 - unit.skill.value)));
        log.push({ type: 'skill', casterId: unit.id, casterLabel: label, skillName: unit.skill.name,
          mp: unit.mp, maxMp: unit.maxMp,
          text: `🎯 ${unit.name}（${label}）【${unit.skill.name}】発動！DEFを${Math.round(unit.skill.value * 100)}%無視` });
      }
      // アイテム: pierce（スキルpierceと重ね掛け可・常時発動のため無音）
      const itemPierce = unit.item?.type === 'pierce' ? unit.item.value : unit.item?.type === 'relic' ? (unit.item.pierceValue || 0) : 0;
      if (itemPierce > 0) effectiveDef = Math.max(0, Math.floor(effectiveDef * (1 - itemPierce)));

      // 割合軽減方式: ATK × 100/(100+DEF)。floor で0になっても最低1ダメージは保証
      let finalDmg = Math.max(Math.floor(currentAtk * atkMultiplier * DEFENSE_CONSTANT / (DEFENSE_CONSTANT + effectiveDef)), 1);

      // 聖なる盾: シールドがある場合はダメージをシールドで吸収
      if (defender.shield > 0) {
        const absorbed = Math.min(defender.shield, finalDmg);
        defender.shield -= absorbed;
        defender.shieldHitsLeft--;
        finalDmg -= absorbed;
        if (defender.shieldHitsLeft <= 0) defender.shield = 0;
        log.push({
          type: 'shield',
          unitId: defender.id,
          label: targetLabel,
          absorbed,
          shieldLeft: defender.shield,
          shieldHitsLeft: Math.max(defender.shieldHitsLeft, 0),
          text: `🛡 ${defender.name}（${targetLabel}）のシールドが ${absorbed} を吸収（残シールド: ${defender.shield}）`,
        });
      }

      // スキル: on_defend（受け流し・不動）
      finalDmg = applyDefendSkill(defender, finalDmg, targetLabel);

      defender.currentHp -= finalDmg;

      const isDead = defender.currentHp <= 0;
      log.push({
        type: 'attack',
        action: actionCount + 1,
        attacker: unit.name,
        attackerId: unit.id,
        attackerLabel: label,
        target: defender.name,
        targetId: defender.id,
        damage: finalDmg,
        targetHp: Math.max(defender.currentHp, 0),
        targetMaxHp: defender.maxHp,
        isDead,
        text: `[行動${actionCount + 1}] ${unit.name}（${label}）→ ${defender.name} に ${finalDmg} ダメージ` + (isDead ? '（撃破！）' : ` (残HP: ${Math.max(defender.currentHp,0)}/${defender.maxHp})`),
      });

      // 覚醒（バーサーカー）: 被弾でHP50%以下を初めて下回った瞬間に演出イベントを発火
      if (defender.berserkerBonus > 0 && !defender._awakened && defender.currentHp > 0 && defender.currentHp <= defender.maxHp * 0.5) {
        defender._awakened = true;
        log.push({
          type: 'berserk',
          unitId: defender.id,
          label: targetLabel,
          text: `⚡ ${defender.name}（${targetLabel}）が覚醒！ 攻撃力アップ！`,
        });
      }

      // アイテム: lifesteal（攻撃者が与ダメージの一部を回復。通常攻撃のみ対象・スキル由来ダメージは対象外）
      const lifesteal = unit.item?.type === 'lifesteal' ? unit.item.value : unit.item?.type === 'relic' ? (unit.item.lifestealValue || 0) : 0;
      if (lifesteal > 0 && finalDmg > 0 && unit.currentHp > 0 && unit.currentHp < unit.maxHp) {
        const healed = Math.min(Math.floor(finalDmg * lifesteal), unit.maxHp - unit.currentHp);
        if (healed > 0) {
          unit.currentHp += healed;
          log.push({ type: 'skill', casterId: unit.id, casterLabel: label, skillName: unit.item.name,
            healed, currentHp: unit.currentHp, maxHp: unit.maxHp,
            text: `🩸 ${unit.name}（${label}）が【${unit.item.name}】で${healed}回復` });
        }
      }
      // アイテム: thorns（被弾側が反射ダメージを攻撃者へ返す）
      const thorns = defender.item?.type === 'thorns' ? defender.item.value : defender.item?.type === 'relic' ? (defender.item.thornsValue || 0) : 0;
      if (thorns > 0 && finalDmg > 0 && unit.currentHp > 0) {
        const reflected = Math.max(1, Math.floor(finalDmg * thorns));
        unit.currentHp -= reflected;
        const attackerDead = unit.currentHp <= 0;
        log.push({ type: 'skill', casterId: defender.id, casterLabel: targetLabel, skillName: defender.item.name,
          targetId: unit.id, targetLabel: label,
          damage: reflected, targetHp: Math.max(0, unit.currentHp), targetMaxHp: unit.maxHp, isDead: attackerDead,
          text: `🌵 ${defender.name}（${targetLabel}）の【${defender.item.name}】が${reflected}反射ダメージ${attackerDead ? '（撃破！）' : ''}` });
      }

      return { isDead, finalDmg };
    }

    let mainTarget, mainResult;
    const cleaveValue = unit.item?.type === 'cleave' ? unit.item.value : 0;
    if (cleaveValue > 0) {
      // アイテム: cleave（ATKを割合適用して生存する敵全員を同時攻撃）
      for (const enemy of targets) {
        if (enemy.currentHp <= 0) continue;
        const r = resolveHit(enemy, cleaveValue);
        if (!mainTarget) { mainTarget = enemy; mainResult = r; }
      }
    } else {
      mainTarget = pickRandom(targets);
      mainResult = resolveHit(mainTarget, 1);
    }

    actionCount++;

    // スキル: on_attack 追加効果（arcane_bolt / chain_lightning / extra_attack）
    // cleave発動時は複数対象への波及仕様が煩雑になるため対象外とする。
    if (cleaveValue === 0 && !mainResult.isDead) {
      applyAttackSkill(unit, mainTarget, enemies, mainResult.finalDmg, label, targetLabel);
    }

    healTeam(playerTeam, 'プレイヤー');
    healTeam(cpuTeam, 'CPU');

    // スキル: on_turn_end
    applyTurnEndSkills(playerTeam, 'プレイヤー');
    applyTurnEndSkills(cpuTeam, 'CPU');

    // ラウンド境界に到達したら毎ラウンド系設備（治療所/弓塔/魔導砲）を発火
    if (actionCount >= roundBoundary) {
      fireTurnFacilities();
      roundBoundary += Math.max(1, allUnits.filter(e => e.unit.currentHp > 0).length);
    }

    if (alive(playerTeam).length === 0 || alive(cpuTeam).length === 0) break;
  }

  const playerAlive = alive(playerTeam).length;
  const cpuAlive    = alive(cpuTeam).length;

  let result;
  if (playerAlive > 0 && cpuAlive === 0) {
    result = 'win';
  } else if (cpuAlive > 0 && playerAlive === 0) {
    result = 'lose';
  } else {
    result = 'draw';
  }

  return { log, result, playerTeam, cpuTeam, actionCount };
}
