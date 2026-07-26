let battleLog = [];
let battleLogIndex = 0;
let battleTimer = null;

// バトルログの再生速度（×1/×2/×4の3段階・localStorageに保存）
let battleSpeed = parseInt(localStorage.getItem('tftbs_battle_speed') || '1', 10);
if (![1, 2, 4].includes(battleSpeed)) battleSpeed = 1;

function setBattleSpeed(v) {
  battleSpeed = v;
  localStorage.setItem('tftbs_battle_speed', String(v));
  updateSpeedButtons();
}

function updateSpeedButtons() {
  document.querySelectorAll('.speed-btn[data-speed]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.speed, 10) === battleSpeed);
  });
}

// ティア配列のインデックス（0始まり）+1 を星数として返す
function getUnitStars(unit) {
  // ステータスのティア位置を常に5段階へ正規化して表示（STAT_TIERSの段階数が増えても星は最大5）。
  // 5段階時は idx0→1★ … idx4→5★ と従来の挙動に一致する。
  const rank = (key, val) => {
    const tiers = STAT_TIERS[key];
    const idx = tiers.indexOf(val);
    if (idx < 0) return 1;
    return Math.max(1, Math.min(5, Math.round((idx + 1) / tiers.length * 5)));
  };
  return { hp: rank('hp', unit.hp), atk: rank('atk', unit.atk), def: rank('def', unit.def), spd: rank('spd', unit.spd) };
}

function renderStars(n, max = 5) {
  return '<span class="star-filled">' + '★'.repeat(n) + '</span><span class="star-empty">' + '☆'.repeat(max - n) + '</span>';
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function getLineageIcon(lineageId) {
  return { warrior: '⚔️', mage: '🔮', rogue: '🗡️', archer: '🏹', monk: '🙏', goblin: '👹' }[lineageId] || '◆';
}

function renderShop() {
  document.getElementById('gold-display').textContent = `所持金: ${shopState.gold}G`;
  document.getElementById('team-count').textContent = `チーム: ${shopState.team.length}/${MAX_TEAM_SIZE}`;

  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) {
    const isDefender = shopState.role === 'defender';
    roleBadge.textContent = (isDefender ? '🛡️ 防衛側 DEF+20%' : '⚔️ 攻撃側') + ' ⇄';
    roleBadge.className = 'role-badge-shop ' + (isDefender ? 'role-defender' : 'role-attacker');
    roleBadge.title = 'クリックで攻撃側／防衛側を切り替え（編成はリセットされます）';
  }

  const shopGrid = document.getElementById('shop-grid');
  shopGrid.innerHTML = '';

  // 系統順にグループ表示
  for (const lineage of Object.values(LINEAGES)) {
    const units = UNITS_DATA.filter(u => u.lineage === lineage).sort((a, b) => a.rank - b.rank);
    if (units.length === 0) continue;

    const header = document.createElement('div');
    header.className = 'lineage-header';
    header.dataset.lineage = lineage.id;
    header.innerHTML = `<span class="lineage-icon">${getLineageIcon(lineage.id)}</span><span class="lineage-label">${lineage.label}</span>`;
    shopGrid.appendChild(header);

    const row = document.createElement('div');
    row.className = 'lineage-row';

    for (const unit of units) {
      const inTeam = shopState.team.some(u => u.id === unit.id);
      const card = document.createElement('div');
      card.className = 'unit-card shop-card' + (inTeam ? ' in-team' : '') + (shopState.gold < unit.cost && !inTeam ? ' unaffordable' : '');
      card.dataset.lineage = lineage.id;
      const s = getUnitStars(unit);
      const rankStars = '★'.repeat(unit.rank) + '☆'.repeat(Math.max(0, MAX_RANK - unit.rank));
      card.innerHTML = `
        <div class="unit-card-portrait unit-sprite" style="${unitSpriteStyle(unit)}"></div>
        <div class="unit-card-badges">
          <span class="rank-badge rank-${unit.rank}">${rankStars}</span>
        </div>
        <div class="unit-name">${unit.name}</div>
        <div class="unit-cost">${unit.cost}G</div>
        <div class="unit-stars">
          <div><span class="star-label">HP </span>${renderStars(s.hp)}</div>
          <div><span class="star-label">ATK</span>${renderStars(s.atk)}</div>
          <div><span class="star-label">DEF</span>${renderStars(s.def)}</div>
          <div><span class="star-label">SPD</span>${renderStars(s.spd)}</div>
        </div>
        <div class="unit-classes">${unit.classes.length ? unit.classes.join(' / ') : '<span class="no-synergy">シナジーなし</span>'}</div>
        ${unit.skill ? `<div class="unit-skill"><div class="unit-skill-head"><span class="unit-skill-name">${unit.skill.name}</span><span class="skill-mp-badge">MP${unitMaxMp(unit)}</span></div><span class="unit-skill-desc">${unit.skill.desc}</span></div>` : ''}
        ${inTeam ? '<div class="in-team-label">編成中</div>' : ''}
      `;
      if (!inTeam) {
        card.addEventListener('click', () => {
          const result = shopBuy(unit);
          if (!result.ok) showToast(result.reason);
          renderShop();
          renderItemShop();
          renderTeam();
          renderSynergies();
        });
      }
      row.appendChild(card);
    }
    shopGrid.appendChild(row);
  }

  renderFacilityShop();
}

function renderItemShop() {
  const grid = document.getElementById('item-shop-grid');
  if (!grid) return;
  grid.innerHTML = '';

  for (const item of ITEMS_LIST) {
    const owned = shopState.items[item.id] || 0;
    const unaffordable = shopState.gold < item.cost;
    const card = document.createElement('div');
    card.className = 'item-shop-card' + (unaffordable ? ' unaffordable' : '');
    card.innerHTML = `
      <div class="item-shop-icon">${item.icon}</div>
      <div class="item-shop-name">${item.name}</div>
      <div class="item-shop-desc">${item.desc}</div>
      <div class="item-shop-cost">${item.cost}G</div>
      ${owned > 0 ? `<div class="item-owned-badge">所持: ${owned}</div>` : ''}
    `;
    card.addEventListener('click', () => {
      const result = shopBuyItem(item.id);
      if (!result.ok) showToast(result.reason);
      renderShop();
      renderItemShop();
      renderTeam();
    });
    grid.appendChild(card);
  }
}

// 防衛設備パネル（防衛側のときのみ表示）。クリックで建設/撤去をトグルする。
function renderFacilityShop() {
  const title = document.getElementById('facility-shop-title');
  const grid = document.getElementById('facility-shop-grid');
  if (!title || !grid) return;

  const isDefender = shopState.role === 'defender';
  title.style.display = isDefender ? '' : 'none';
  grid.style.display = isDefender ? '' : 'none';
  grid.innerHTML = '';
  if (!isDefender) return;

  for (const facility of FACILITIES_LIST) {
    const owned = shopState.facilities.includes(facility.id);
    const unaffordable = !owned && shopState.gold < facility.cost;
    const card = document.createElement('div');
    card.className = 'facility-shop-card' + (owned ? ' owned' : '') + (unaffordable ? ' unaffordable' : '');
    card.innerHTML = `
      <div class="item-shop-icon">${facility.icon}</div>
      <div class="item-shop-name">${facility.name}</div>
      <div class="item-shop-desc">${facility.desc}</div>
      <div class="item-shop-cost">${facility.cost}G</div>
      ${owned ? '<div class="item-owned-badge">建設済 ✕</div>' : ''}
    `;
    card.addEventListener('click', () => {
      const result = owned ? shopSellFacility(facility.id) : shopBuyFacility(facility.id);
      if (!result.ok && result.reason) showToast(result.reason);
      renderShop();
      renderItemShop();
      renderTeam();
    });
    grid.appendChild(card);
  }
}

function renderTeam() {
  const teamSlots = document.getElementById('team-slots');
  teamSlots.innerHTML = '';
  for (let i = 0; i < MAX_TEAM_SIZE; i++) {
    const unit = shopState.team[i];
    const slot = document.createElement('div');
    slot.className = 'team-slot' + (unit ? ' filled' : ' empty');
    if (unit) {
      const rankStars = '★'.repeat(unit.rank);
      slot.innerHTML = `
        <div class="slot-top">
          <span class="rank-badge rank-${unit.rank}">${rankStars}</span>
          <span class="lineage-badge" style="--lc:${unit.lineage.color}">${unit.lineage.label}</span>
        </div>
        <div class="team-slot-head">
          <div class="team-slot-portrait unit-sprite" style="${unitSpriteStyle(unit)}"></div>
          <div>
            <div class="unit-name">${unit.name}</div>
            <div class="unit-cost">${unit.cost}G</div>
          </div>
        </div>
        <div class="unit-classes">${unit.classes.length ? unit.classes.join('/') : '<span class="no-synergy">シナジーなし</span>'}</div>
        <div class="item-current">
          装備: ${unit.item ? unit.item.icon + ' ' + unit.item.name : 'なし'}
          ${unit.item ? '<button class="item-unequip-btn" title="装備を外す">✕</button>' : ''}
        </div>
        <div class="item-picker">
          ${Object.entries(shopState.items).filter(([, n]) => n > 0).map(([itemId, n]) => {
            const it = ITEMS_LIST.find(i => i.id === itemId);
            return `<button class="item-btn${unit.item?.id === itemId ? ' selected' : ''}" data-item="${itemId}" title="${it.name}: ${it.desc}">${it.icon}<span class="item-btn-count">${n}</span></button>`;
          }).join('') || '<span class="item-picker-empty">所持アイテムなし</span>'}
        </div>
        <button class="sell-btn" title="売却して${unit.cost}G回収">✕ 売却</button>
      `;
      slot.querySelectorAll('.item-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const itemId = btn.dataset.item;
          shopEquipItem(unit.id, itemId);
          renderTeam();
          renderSynergies();
        });
      });
      const unequipBtn = slot.querySelector('.item-unequip-btn');
      if (unequipBtn) {
        unequipBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          shopUnequipItem(unit.id);
          renderTeam();
          renderSynergies();
        });
      }
      slot.querySelector('.sell-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        shopSell(unit.id);
        renderShop();
        renderItemShop();
        renderTeam();
        renderSynergies();
      });
    } else {
      slot.innerHTML = '<div class="empty-label">空きスロット</div>';
    }
    teamSlots.appendChild(slot);
  }

  document.getElementById('btn-battle').disabled = shopState.team.length === 0;
}

function renderSynergies() {
  const synergies = getShopSynergySummary();
  const container = document.getElementById('synergy-list');
  container.innerHTML = '';

  for (const syn of synergies) {
    if (syn.count === 0) continue;
    const item = document.createElement('div');
    item.className = 'synergy-item' + (syn.triggered ? ' active' : '');

    let effectText = '－';
    if (syn.triggered) {
      if (syn.rule.type === 'multiplier') {
        const pct = Math.round(syn.triggered.multiplier * 100);
        effectText = `${syn.triggered.stat.toUpperCase()}+${pct}%`;
      } else if (syn.rule.type === 'heal') {
        effectText = `毎ターン HP+${syn.triggered.healPerTurn}`;
      } else if (syn.rule.type === 'berserker') {
        const pct = Math.round(syn.triggered.bonus * 100);
        effectText = `HP50%以下でATK+${pct}%`;
      } else if (syn.rule.type === 'shield') {
        const pct = Math.round(syn.triggered.shieldPct * 100);
        effectText = `開幕シールド+${pct}%HP（5回被弾で消滅）`;
      }
    }

    const nextText = syn.nextThreshold ? `（次: ${syn.nextThreshold}体）` : '';
    item.innerHTML = `
      <span class="synergy-class">${syn.classId}</span>
      <span class="synergy-count">${syn.count}体</span>
      <span class="synergy-effect">${syn.triggered ? '✓ ' + effectText : nextText || '未発動'}</span>
    `;
    container.appendChild(item);
  }
}

function renderBattleSynergies(containerId, team) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const synergies = getActiveSynergies(team);
  container.innerHTML = '';
  for (const syn of synergies) {
    if (!syn.triggered) continue;
    let effect = '';
    if (syn.rule.type === 'multiplier') {
      effect = `${syn.triggered.stat.toUpperCase()}+${Math.round(syn.triggered.multiplier * 100)}%`;
    } else if (syn.rule.type === 'heal') {
      effect = `HP+${syn.triggered.healPerTurn}/T`;
    } else if (syn.rule.type === 'berserker') {
      effect = `低HP ATK+${Math.round(syn.triggered.bonus * 100)}%`;
    } else if (syn.rule.type === 'shield') {
      effect = `開幕シールド+${Math.round(syn.triggered.shieldPct * 100)}%HP`;
    }
    const badge = document.createElement('div');
    badge.className = 'battle-syn-badge';
    badge.innerHTML = `<span class="syn-name">${syn.classId}</span><span class="syn-count">${syn.count}体</span><span class="syn-effect">${effect}</span>`;
    container.appendChild(badge);
  }
}

// バトル画面の役割タグ（例: 🛡️防衛 / ⚔️攻撃）
function setRoleTag(tagId, role) {
  const el = document.getElementById(tagId);
  if (!el) return;
  const isDefender = role === 'defender';
  el.textContent = isDefender ? '🛡️ 防衛' : '⚔️ 攻撃';
  el.className = 'role-tag ' + (isDefender ? 'role-defender' : 'role-attacker');
}

// バトル画面の防衛設備バー（防衛側のみアイコン表示）
function renderBattleFacilities(containerId, role, facilityIds) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (role !== 'defender' || !facilityIds || facilityIds.length === 0) return;
  for (const id of facilityIds) {
    const f = FACILITIES_LIST.find(x => x.id === id);
    if (!f) continue;
    const badge = document.createElement('div');
    badge.className = 'battle-facility-badge';
    badge.title = `${f.name}: ${f.desc}`;
    badge.innerHTML = `<span class="fac-icon">${f.icon}</span><span class="fac-name">${f.name}</span>`;
    container.appendChild(badge);
  }
}

function renderBattleTeam(containerId, team) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  for (const unit of team) {
    const div = document.createElement('div');
    div.className = 'battle-unit';
    div.id = `bunit-${containerId}-${unit.id}`;
    const shieldPct = unit.shield > 0 ? Math.round((unit.shield / unit.maxHp) * 100) : 0;
    div.innerHTML = `
      <div class="battle-unit-portrait unit-sprite" style="${unitSpriteStyle(unit)}"></div>
      <div class="battle-unit-body">
        <div class="unit-name">${unit.name}</div>
        <div class="hp-bar-wrap">
          <div class="hp-bar-ghost" style="width:100%"></div>
          <div class="hp-bar hp-high" style="width:100%"></div>
        </div>
        <div class="shield-bar-wrap" style="display:${shieldPct > 0 ? 'block' : 'none'}">
          <div class="shield-bar" style="width:${shieldPct}%"></div>
        </div>
        ${unit.skill ? `<div class="mp-bar-wrap"><div class="mp-bar" style="width:100%"></div></div>` : ''}
        <div class="hp-text">${unit.currentHp}/${unit.maxHp}</div>
      </div>
    `;
    container.appendChild(div);
  }
}

// ====== バトル演出ヘルパー ======

// label(プレイヤー/CPU)とunitIdから該当ユニットのDOMを取得
function battleUnitEl(label, unitId) {
  const containerId = label === 'プレイヤー' ? 'player-units' : 'cpu-units';
  return document.getElementById(`bunit-${containerId}-${unitId}`);
}

// アニメーションクラスを付け直す（同じクラスでも再生されるようreflowを挟む）
function retrigger(el, cls, autoRemoveMs = 600) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // reflowでアニメをリセット
  el.classList.add(cls);
  if (autoRemoveMs > 0) {
    setTimeout(() => el.classList.remove(cls), autoRemoveMs);
  }
}

// HPバー（本体＋残像）・シールドバー・テキストを更新
// currentHp が null の場合はシールドバーのみ更新
function updateHp(label, unitId, currentHp, maxHp, shield) {
  const el = battleUnitEl(label, unitId);
  if (!el) return;
  if (currentHp !== null && maxHp) {
    const pct = Math.max(0, Math.round((currentHp / maxHp) * 100));
    const bar = el.querySelector('.hp-bar');
    const ghost = el.querySelector('.hp-bar-ghost');
    if (bar) {
      bar.style.width = pct + '%';
      bar.classList.remove('hp-high', 'hp-mid', 'hp-low');
      bar.classList.add(pct > 50 ? 'hp-high' : pct > 25 ? 'hp-mid' : 'hp-low');
    }
    if (ghost) ghost.style.width = pct + '%';
    const txt = el.querySelector('.hp-text');
    if (txt) txt.textContent = `${Math.max(0, currentHp)}/${maxHp}`;
  }
  // シールドバー更新（shield が undefined でなければ）
  if (shield !== undefined) {
    const shieldWrap = el.querySelector('.shield-bar-wrap');
    const shieldBar = el.querySelector('.shield-bar');
    if (shieldWrap && shieldBar) {
      const hp = maxHp || parseInt(el.querySelector('.hp-text')?.textContent?.split('/')[1] || '1');
      const sPct = (shield > 0) ? Math.round((shield / hp) * 100) : 0;
      shieldWrap.style.display = sPct > 0 ? 'block' : 'none';
      shieldBar.style.width = sPct + '%';
    }
  }
}

// MPバーを更新（スキル発動ログの mp/maxMp を受けて残量を反映）
function updateMp(label, unitId, mp, maxMp) {
  const el = battleUnitEl(label, unitId);
  if (!el || maxMp === undefined) return;
  const bar = el.querySelector('.mp-bar');
  if (!bar) return;
  const pct = maxMp > 0 ? Math.max(0, Math.round((mp / maxMp) * 100)) : 0;
  bar.style.width = pct + '%';
}

// ユニットの上にフローティングテキストを出す
function floatText(el, text, cls) {
  if (!el) return;
  const span = document.createElement('div');
  span.className = 'float-text ' + cls;
  span.textContent = text;
  el.appendChild(span);
  setTimeout(() => span.remove(), 900);
}

// 画面全体を揺らす
function screenShake() {
  const layout = document.querySelector('#screen-battle .battle-layout');
  if (!layout) return;
  retrigger(layout, 'screen-shake', 400);
}

// ダメージ量に応じたフロート文字のクラス（撃破=crit > 40以上=big > 20以上=mid）
function dmgFloatClass(damage, isDead) {
  if (isDead) return 'float-dmg crit';
  if (damage >= 40) return 'float-dmg dmg-big';
  if (damage >= 20) return 'float-dmg dmg-mid';
  return 'float-dmg';
}

// 攻撃演出: ランジ → 被弾シェイク＋ダメージ数字 → HP減 →（撃破なら）崩壊＋画面シェイク
function playAttack(entry) {
  const attackerEl = battleUnitEl(entry.attackerLabel, entry.attackerId);
  const targetLabel = entry.attackerLabel === 'プレイヤー' ? 'CPU' : 'プレイヤー';
  const targetEl = battleUnitEl(targetLabel, entry.targetId);

  if (attackerEl) {
    const lungeClass = entry.attackerLabel === 'プレイヤー' ? 'lunge-right' : 'lunge-left';
    retrigger(attackerEl, lungeClass, 350);
  }
  SoundFX.fx.hit(entry.damage);

  // 攻撃が「届く」少し後に被弾演出（倍速時は間も詰める）
  setTimeout(() => {
    if (targetEl) {
      retrigger(targetEl, 'hit', 320);
      floatText(targetEl, '-' + entry.damage, dmgFloatClass(entry.damage, entry.isDead));
    }
    updateHp(targetLabel, entry.targetId, entry.targetHp, entry.targetMaxHp, 0);

    if (entry.isDead) {
      if (targetEl) {
        targetEl.classList.remove('berserk-aura');
        retrigger(targetEl, 'defeated', 0);
        targetEl.classList.add('dead');
      }
      screenShake();
      SoundFX.fx.defeat();
      floatText(targetEl, '撃破！', 'float-dmg crit');
    } else if (entry.damage >= 30) {
      screenShake();
    }
  }, 150 / battleSpeed);
}

// 覚醒演出: 赤いオーラを継続付与＋「⚡覚醒！」
function playBerserk(entry) {
  const el = battleUnitEl(entry.label, entry.unitId);
  if (el) {
    el.classList.add('berserk-aura');
    floatText(el, '⚡覚醒！', 'float-awaken');
  }
  SoundFX.fx.berserk();
}

// スキル発動カットイン: 発動者ポートレート＋技名が横からスライドイン。
// 連発による鬱陶しさを避けるため「そのユニットのバトル中初回発動時」のみ表示する。
const battleCutinShown = new Set();
function playSkillCutin(entry) {
  if (entry.casterId === undefined) return;
  const key = entry.casterLabel + ':' + entry.casterId;
  if (battleCutinShown.has(key)) return;
  battleCutinShown.add(key);
  const layout = document.querySelector('#screen-battle .battle-layout');
  const result = window._lastBattleResult;
  if (!layout || !result) return;
  const team = entry.casterLabel === 'プレイヤー' ? result.playerTeam : result.cpuTeam;
  const caster = team.find(u => u.id === entry.casterId);
  if (!caster) return;
  const div = document.createElement('div');
  div.className = 'skill-cutin ' + (entry.casterLabel === 'プレイヤー' ? 'from-left' : 'from-right');
  div.innerHTML = `
    <div class="skill-cutin-portrait unit-sprite" style="${unitSpriteStyle(caster)}"></div>
    <div class="skill-cutin-name">【${entry.skillName}】</div>`;
  layout.appendChild(div);
  setTimeout(() => div.remove(), 750);
}

// スキル演出: 発動者に紫グロー＋発動音（全スキル共通）→ ダメージor回復の追加演出
function playSkill(entry) {
  // 発動者にスキル名をフロート表示＋発動グロー＋発動音（被ダメージ無効化などダメージ/回復を伴わないスキルでも必ず分かるように）
  const casterEl = entry.casterId !== undefined ? battleUnitEl(entry.casterLabel, entry.casterId) : null;
  playSkillCutin(entry);
  if (casterEl) {
    retrigger(casterEl, 'skill-flash', 550);
    floatText(casterEl, `【${entry.skillName}】`, 'float-skill');
  }
  SoundFX.fx.skill();
  if (entry.maxMp !== undefined) {
    updateMp(entry.casterLabel, entry.casterId, entry.mp, entry.maxMp);
  }

  // ダメージ系スキル（targetId と damage がある）
  if (entry.targetId !== undefined && entry.damage !== undefined) {
    const targetEl = battleUnitEl(entry.targetLabel, entry.targetId);
    if (targetEl) {
      retrigger(targetEl, 'hit', 320);
      floatText(targetEl, '-' + entry.damage, dmgFloatClass(entry.damage, entry.isDead));
      updateHp(entry.targetLabel, entry.targetId, entry.targetHp, entry.targetMaxHp, 0);
      if (entry.isDead) {
        retrigger(targetEl, 'defeated', 0);
        targetEl.classList.add('dead');
        screenShake();
        SoundFX.fx.defeat();
      } else {
        SoundFX.fx.hit(entry.damage);
      }
    }
  }

  // 回復系スキル（healed がある）
  if (entry.healed !== undefined) {
    const targetEl = battleUnitEl(entry.targetLabel, entry.targetId);
    if (targetEl) {
      retrigger(targetEl, 'heal-flash', 500);
      floatText(targetEl, '+' + entry.healed, 'float-heal');
      updateHp(entry.targetLabel, entry.targetId, entry.currentHp, entry.maxHp, 0);
    }
    SoundFX.fx.heal();
  }
}

// 防衛設備演出: ダメージ（落とし穴/弓塔/魔導砲）または回復（治療所）
function playFacility(entry) {
  const el = battleUnitEl(entry.label, entry.unitId);
  if (entry.kind === 'damage') {
    if (el) {
      retrigger(el, 'hit', 320);
      floatText(el, '-' + entry.damage, entry.isDead ? 'float-dmg crit' : 'float-facility');
    }
    updateHp(entry.label, entry.unitId, entry.targetHp, entry.targetMaxHp, 0);
    SoundFX.fx.hit(entry.damage);
    if (entry.isDead) {
      if (el) { retrigger(el, 'defeated', 0); el.classList.add('dead'); }
      screenShake();
      SoundFX.fx.defeat();
      floatText(el, '撃破！', 'float-dmg crit');
    }
  } else if (entry.kind === 'heal') {
    if (el) {
      retrigger(el, 'heal-flash', 500);
      floatText(el, '+' + entry.healed, 'float-heal');
    }
    updateHp(entry.label, entry.unitId, entry.currentHp, entry.maxHp, 0);
    SoundFX.fx.heal();
  }
}

// 回復演出: 緑フラッシュ＋「+N」＋HP増
function playHeal(entry) {
  const el = battleUnitEl(entry.label, entry.unitId);
  if (el) {
    retrigger(el, 'heal-flash', 500);
    floatText(el, '+' + entry.healed, 'float-heal');
  }
  updateHp(entry.label, entry.unitId, entry.currentHp, entry.maxHp, 0);
  SoundFX.fx.heal();
}

// ====== バトルログの逐次再生（可変テンポ） ======

function appendLogLine(entry) {
  const logEl = document.getElementById('battle-log');
  const line = document.createElement('div');
  line.className = 'log-line log-' + entry.type;
  line.textContent = entry.text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function scheduleBattleLog() {
  if (battleTimer) clearTimeout(battleTimer);
  battleTimer = setTimeout(stepBattleLog, 500 / battleSpeed);
}

function stepBattleLog() {
  if (battleLogIndex >= battleLog.length) {
    showBattleResult();
    return;
  }

  const entry = battleLog[battleLogIndex++];
  appendLogLine(entry);

  // イベント種別ごとに演出と次までの間（タメ）を変える
  let delay = 400;
  if (entry.type === 'attack') {
    playAttack(entry);
    delay = entry.isDead ? 750 : 400;
  } else if (entry.type === 'berserk') {
    playBerserk(entry);
    delay = 700;
  } else if (entry.type === 'heal') {
    playHeal(entry);
    delay = 350;
  } else if (entry.type === 'shield') {
    // シールド吸収演出: 対象ユニットのシールドバーを更新
    const el = battleUnitEl(entry.label, entry.unitId);
    if (el) floatText(el, '🛡-' + entry.absorbed, 'float-shield');
    updateHp(entry.label, entry.unitId, null, null, entry.shieldLeft);
    delay = 200;
  } else if (entry.type === 'skill') {
    playSkill(entry);
    delay = entry.damage ? 400 : 300;
  } else if (entry.type === 'facility') {
    playFacility(entry);
    delay = entry.isDead ? 700 : (entry.kind === 'heal' ? 300 : 350);
  }

  battleTimer = setTimeout(stepBattleLog, delay / battleSpeed);
}

// ====== スキップ（残りログを演出なしで一括適用して即結果へ） ======

// 演出（音・フロート・アニメ）を出さず、ログ1件分の状態だけをバーに反映する
function applyEntryState(entry) {
  if (entry.type === 'attack') {
    const targetLabel = entry.attackerLabel === 'プレイヤー' ? 'CPU' : 'プレイヤー';
    updateHp(targetLabel, entry.targetId, entry.targetHp, entry.targetMaxHp, 0);
    if (entry.isDead) markDead(targetLabel, entry.targetId);
  } else if (entry.type === 'heal') {
    updateHp(entry.label, entry.unitId, entry.currentHp, entry.maxHp, 0);
  } else if (entry.type === 'shield') {
    updateHp(entry.label, entry.unitId, null, null, entry.shieldLeft);
  } else if (entry.type === 'skill') {
    if (entry.maxMp !== undefined) updateMp(entry.casterLabel, entry.casterId, entry.mp, entry.maxMp);
    if (entry.targetId !== undefined && entry.damage !== undefined) {
      updateHp(entry.targetLabel, entry.targetId, entry.targetHp, entry.targetMaxHp, 0);
      if (entry.isDead) markDead(entry.targetLabel, entry.targetId);
    }
    if (entry.healed !== undefined) {
      updateHp(entry.targetLabel, entry.targetId, entry.currentHp, entry.maxHp, 0);
    }
  } else if (entry.type === 'facility') {
    if (entry.kind === 'damage') {
      updateHp(entry.label, entry.unitId, entry.targetHp, entry.targetMaxHp, 0);
      if (entry.isDead) markDead(entry.label, entry.unitId);
    } else if (entry.kind === 'heal') {
      updateHp(entry.label, entry.unitId, entry.currentHp, entry.maxHp, 0);
    }
  }
}

function markDead(label, unitId) {
  const el = battleUnitEl(label, unitId);
  if (el) {
    el.classList.remove('berserk-aura');
    el.classList.add('dead');
  }
}

function skipBattle() {
  if (battleLogIndex >= battleLog.length) return;
  if (battleTimer) clearTimeout(battleTimer);
  while (battleLogIndex < battleLog.length) {
    const entry = battleLog[battleLogIndex++];
    appendLogLine(entry);
    applyEntryState(entry);
  }
  showBattleResult();
}

function showBattleResult() {
  const battleResult = window._lastBattleResult;
  if (!battleResult) return;

  const resultEl = document.getElementById('battle-result');
  resultEl.classList.remove('hidden');

  const messages = {
    win:  { text: '勝利！', cls: 'result-win' },
    lose: { text: '敗北...', cls: 'result-lose' },
    draw: { text: '引き分け', cls: 'result-draw' },
  };
  const m = messages[battleResult.result];
  resultEl.className = 'battle-result ' + m.cls;
  resultEl.querySelector('.result-text').textContent = m.text;

  // 勝者チームの生存ユニットをポートレート列で表示（引き分けは表示なし）
  let portraits = resultEl.querySelector('.result-portraits');
  if (!portraits) {
    portraits = document.createElement('div');
    portraits.className = 'result-portraits';
    const resultText = resultEl.querySelector('.result-text');
    resultText.insertAdjacentElement('afterend', portraits);
  }
  const winners = battleResult.result === 'win' ? battleResult.playerTeam
    : battleResult.result === 'lose' ? battleResult.cpuTeam : null;
  portraits.innerHTML = winners
    ? winners.filter(u => u.currentHp > 0)
        .map(u => `<div class="unit-sprite" style="${unitSpriteStyle(u)}" title="${u.name}"></div>`).join('')
    : '';

  if (battleResult.result === 'win') {
    SoundFX.fx.win();
    spawnConfetti();
  } else if (battleResult.result === 'lose') {
    SoundFX.fx.lose();
    spawnVignette();
  } else {
    SoundFX.fx.draw();
  }
}

function spawnConfetti() {
  const colors = ['#f5a623', '#e94560', '#4caf50', '#7ab4ff', '#ffd54a'];
  for (let i = 0; i < 80; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[Math.floor(Math.random() * colors.length)];
    c.style.animationDuration = (1.5 + Math.random() * 1.5) + 's';
    c.style.animationDelay = (Math.random() * 0.5) + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3500);
  }
}

function spawnVignette() {
  const v = document.createElement('div');
  v.className = 'vignette-lose';
  document.body.appendChild(v);
  setTimeout(() => v.remove(), 2500);
}

function clearResultEffects() {
  document.querySelectorAll('.confetti, .vignette-lose').forEach(el => el.remove());
}

// 役割を選んでショップへ入る
function startWithRole(role) {
  shopReset(role);
  renderShop();
  renderItemShop();
  renderTeam();
  renderSynergies();
  showScreen('screen-shop');
}

// ショップ内で攻撃側／防衛側を切り替える。予算・設備が変わるため編成はリセットする。
function switchRole() {
  const next = shopState.role === 'attacker' ? 'defender' : 'attacker';
  shopReset(next);
  renderShop();
  renderItemShop();
  renderTeam();
  renderSynergies();
  showToast(next === 'defender' ? '🛡️ 防衛側に切替（編成リセット）' : '⚔️ 攻撃側に切替（編成リセット）');
}

function init() {
  showScreen('screen-title');

  document.getElementById('btn-start-attacker').addEventListener('click', () => startWithRole('attacker'));
  document.getElementById('btn-start-defender').addEventListener('click', () => startWithRole('defender'));

  // ショップヘッダーの役割バッジをクリックで攻撃/防衛を切り替え
  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) roleBadge.addEventListener('click', switchRole);

  document.getElementById('btn-battle').addEventListener('click', () => {
    SoundFX.resume();
    clearResultEffects();
    battleCutinShown.clear();
    window._lastBattleResult = null;

    // CPUは反対の役割で編成。両陣営の設備・役割修飾子を組んでバトルへ。
    const playerRole = shopState.role;
    const cpuRole = playerRole === 'attacker' ? 'defender' : 'attacker';
    const cpuSide = buildCpuSide(cpuRole);
    const playerMods = buildSideModifiers(playerRole, shopState.facilities);
    const cpuMods = buildSideModifiers(cpuRole, cpuSide.facilities);
    const result = runBattle(shopState.team, cpuSide.team, playerMods, cpuMods);
    window._lastBattleResult = result;

    renderBattleTeam('player-units', result.playerTeam);
    renderBattleTeam('cpu-units', result.cpuTeam);
    renderBattleSynergies('player-synergies', result.playerTeam);
    renderBattleSynergies('cpu-synergies', result.cpuTeam);
    setRoleTag('player-role-tag', playerRole);
    setRoleTag('cpu-role-tag', cpuRole);
    renderBattleFacilities('player-facilities', playerRole, shopState.facilities);
    renderBattleFacilities('cpu-facilities', cpuRole, cpuSide.facilities);
    document.getElementById('battle-log').innerHTML = '';
    document.getElementById('battle-result').classList.add('hidden');
    document.getElementById('battle-result').classList.remove('result-win', 'result-lose', 'result-draw');

    battleLog = result.log;
    battleLogIndex = 0;
    showScreen('screen-battle');
    scheduleBattleLog();
  });

  document.getElementById('btn-retry').addEventListener('click', () => {
    if (battleTimer) clearTimeout(battleTimer);
    clearResultEffects();
    // 役割から選び直せるようタイトルへ戻る
    showScreen('screen-title');
  });

  const btnSound = document.getElementById('btn-sound');
  if (btnSound) {
    btnSound.textContent = SoundFX.isEnabled() ? '🔊 ON' : '🔇 OFF';
    btnSound.addEventListener('click', () => {
      const on = SoundFX.toggle();
      btnSound.textContent = on ? '🔊 ON' : '🔇 OFF';
    });
  }

  document.querySelectorAll('.speed-btn[data-speed]').forEach(btn => {
    btn.addEventListener('click', () => setBattleSpeed(parseInt(btn.dataset.speed, 10)));
  });
  updateSpeedButtons();

  const btnSkip = document.getElementById('btn-battle-skip');
  if (btnSkip) btnSkip.addEventListener('click', skipBattle);
}

function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

document.addEventListener('DOMContentLoaded', init);
