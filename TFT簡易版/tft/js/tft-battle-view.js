// ============================================================
// TFT向けバトル演出。TFTBS（js/main.js）の演出ロジックを移植したもの。
// main.js は DOMContentLoaded 副作用と TFTBS 専用DOM IDに強く依存する
// ため直接は読み込まず、CSSクラス（css/style.css の .battle-unit 等）と
// runBattle の戻り値（result/log/playerTeam/cpuTeam）だけを再利用する。
//
// 表示方針: 自分が関与する戦闘（攻撃・防衛どちらも）は常に本モーダルで
// 即時表示。人間が関与しない戦闘は行動ログに記録され、「リプレイ」から
// 同じモーダルで後から再生できる。
//
// 注意: TFTのロスターは同一ユニット（同じ UNITS_DATA id）を複数保有できる。
// runBattle のログは unitId に UNITS_DATA の id をそのまま使うため、同じ
// ユニットが1チームに重複していると演出上どちらの個体か区別できない
// （戦闘の勝敗判定そのものはオブジェクト参照で行われるため影響しないが、
// 　アニメーションが重複ユニットのどちらに適用されるか曖昧になる）。
// ============================================================

const tftBattleView = {
  queue: [],   // 表示待ちの { raw, report }
  active: false,
  log: [],
  logIndex: 0,
  timer: null,
  raw: null,
  report: null,
  // 再生速度（×1/×2/×4）。TFTBSと同じlocalStorageキーを共有して好みを引き継ぐ。
  speed: (() => {
    const v = parseInt(localStorage.getItem('tftbs_battle_speed') || '1', 10);
    return [1, 2, 4].includes(v) ? v : 1;
  })(),
  cutinShown: new Set(), // バトル中にカットインを出した caster のキー
};

function tftSetBattleSpeed(v) {
  tftBattleView.speed = v;
  localStorage.setItem('tftbs_battle_speed', String(v));
  tftUpdateSpeedButtons();
}

function tftUpdateSpeedButtons() {
  document.querySelectorAll('.tft-speed-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.speed, 10) === tftBattleView.speed);
  });
}

// 呼び出し口: tft-battle.js の tftDeclareAndResolve から毎回呼ばれるフック。
// 人間が関与し、かつ実際の戦闘があった（無血開城でない）場合のみモーダル表示。
function tftOnBattleResolved(state, report) {
  // 人間が中立地占領でアイテムを入手したらトースト通知
  if (report.grantedItem && report.attackerId === tftUi.myPlayerId) {
    tftToast(`📦 ${report.grantedItem.icon}${report.grantedItem.name} を入手！`);
  }
  // 勢力を撃破して鍵を入手（ボスの解禁）
  if (report.grantedKey && report.attackerId === tftUi.myPlayerId) {
    tftToast(`🗝 ${report.grantedKey.icon}${report.grantedKey.name} を入手！ ${report.grantedKey.desc}`);
  }
  // 自軍ユニットのレベルアップ通知（攻撃側/防衛側どちらでも、人間のユニットが上がったら）
  if (report.levelUps && report.levelUps.length
      && (report.attackerId === tftUi.myPlayerId || report.defenderId === tftUi.myPlayerId)) {
    tftToast(`⬆️ ${report.levelUps.map(l => `${l.name}がLv${l.level}に！`).join(' ')}`);
  }
  if (report.isHumanInvolved && report.raw) {
    tftShowBattleModal(report.raw, report);
  }
}

function tftShowBattleModal(raw, report) {
  if (tftBattleView.active) { tftBattleView.queue.push({ raw, report }); return; }
  tftBattleView.active = true;
  tftRunBattleModal(raw, report);
}

function tftRunBattleModal(raw, report) {
  const state = tftGame;
  tftBattleView.raw = raw;
  tftBattleView.report = report;

  const atkName = state.players[report.attackerId].name;
  const defName = report.defenderId !== null ? state.players[report.defenderId].name : '中立';
  document.getElementById('tft-battle-atk-label').textContent = `⚔️ ${atkName}（攻）`;
  document.getElementById('tft-battle-def-label').textContent = `🛡️ ${defName}（守）@ ${tftCellLabel(report.toCell)}`;

  tftBattleRenderTeam('tft-battle-atk-units', raw.playerTeam);
  tftBattleRenderTeam('tft-battle-def-units', raw.cpuTeam);
  tftBattleRenderSynergies('tft-battle-atk-synergies', raw.playerTeam);
  tftBattleRenderSynergies('tft-battle-def-synergies', raw.cpuTeam);
  document.getElementById('tft-battle-log').innerHTML = '';
  document.getElementById('tft-battle-result-text').textContent = '';
  document.querySelectorAll('#tft-battle-modal .result-portraits').forEach(el => el.remove());
  tftBattleView.cutinShown.clear();
  tftUpdateSpeedButtons();
  document.getElementById('tft-battle-modal').style.display = 'flex';

  tftBattleView.log = raw.log;
  tftBattleView.logIndex = 0;
  tftBattleStep();
}

function tftCloseBattleModal() {
  document.getElementById('tft-battle-modal').style.display = 'none';
  if (tftBattleView.timer) clearTimeout(tftBattleView.timer);
  tftBattleView.active = false;
  if (tftBattleView.queue.length > 0) {
    const next = tftBattleView.queue.shift();
    tftShowBattleModal(next.raw, next.report);
  }
}

// ============ ユニット表示・HP/シールド更新 ============

function tftBattleRenderTeam(containerId, team) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  for (const unit of team) {
    const div = document.createElement('div');
    div.className = 'battle-unit';
    div.id = `tbunit-${containerId}-${unit.id}`;
    div.innerHTML = `
      <div class="battle-unit-portrait unit-sprite" style="${unitSpriteStyle(unit)}"></div>
      <div class="battle-unit-body">
        <div class="unit-name">${unit.name}${(unit.level || 1) > 1 ? tftLevelBadge(unit) : ''}</div>
        <div class="hp-bar-wrap">
          <div class="hp-bar-ghost" style="width:100%"></div>
          <div class="hp-bar hp-high" style="width:100%"></div>
        </div>
        <div class="shield-bar-wrap" style="display:none">
          <div class="shield-bar" style="width:0%"></div>
        </div>
        ${unit.skill ? `<div class="mp-bar-wrap"><div class="mp-bar" style="width:100%"></div></div>` : ''}
        <div class="hp-text">${unit.currentHp}/${unit.maxHp}</div>
      </div>
    `;
    container.appendChild(div);
  }
}

// 発動中のシナジー表示（TFTBS main.js の renderBattleSynergies を移植）。
// モンスターチーム(classes:[])は該当シナジーが無いため自然に空表示になる。
function tftBattleRenderSynergies(containerId, team) {
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

function tftBattleUnitEl(label, unitId) {
  const containerId = label === 'プレイヤー' ? 'tft-battle-atk-units' : 'tft-battle-def-units';
  return document.getElementById(`tbunit-${containerId}-${unitId}`);
}

function tftBattleRetrigger(el, cls, autoRemoveMs = 600) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (autoRemoveMs > 0) setTimeout(() => el.classList.remove(cls), autoRemoveMs);
}

function tftBattleUpdateHp(label, unitId, currentHp, maxHp, shield) {
  const el = tftBattleUnitEl(label, unitId);
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

// MPバーを更新（スキル発動ログの mp/maxMp を受けて残量を反映。TFTBS側のupdateMpと同じ実装）
function tftBattleUpdateMp(label, unitId, mp, maxMp) {
  const el = tftBattleUnitEl(label, unitId);
  if (!el || maxMp === undefined) return;
  const bar = el.querySelector('.mp-bar');
  if (!bar) return;
  const pct = maxMp > 0 ? Math.max(0, Math.round((mp / maxMp) * 100)) : 0;
  bar.style.width = pct + '%';
}

function tftBattleFloatText(el, text, cls) {
  if (!el) return;
  const span = document.createElement('div');
  span.className = 'float-text ' + cls;
  span.textContent = text;
  el.appendChild(span);
  setTimeout(() => span.remove(), 900);
}

function tftBattleScreenShake() {
  const layout = document.querySelector('#tft-battle-modal .tft-battle-layout');
  if (!layout) return;
  tftBattleRetrigger(layout, 'screen-shake', 400);
}

// ============ 演出（TFTBS main.js の各 play* 関数を移植） ============

// ダメージ量に応じたフロート文字のクラス（main.js の dmgFloatClass と同じ規則）
function tftDmgFloatClass(damage, isDead) {
  if (isDead) return 'float-dmg crit';
  if (damage >= 40) return 'float-dmg dmg-big';
  if (damage >= 20) return 'float-dmg dmg-mid';
  return 'float-dmg';
}

function tftBattlePlayAttack(entry) {
  const attackerEl = tftBattleUnitEl(entry.attackerLabel, entry.attackerId);
  const targetLabel = entry.attackerLabel === 'プレイヤー' ? 'CPU' : 'プレイヤー';
  const targetEl = tftBattleUnitEl(targetLabel, entry.targetId);

  if (attackerEl) {
    const lungeClass = entry.attackerLabel === 'プレイヤー' ? 'lunge-right' : 'lunge-left';
    tftBattleRetrigger(attackerEl, lungeClass, 350);
  }
  SoundFX.fx.hit(entry.damage);

  setTimeout(() => {
    if (targetEl) {
      tftBattleRetrigger(targetEl, 'hit', 320);
      tftBattleFloatText(targetEl, '-' + entry.damage, tftDmgFloatClass(entry.damage, entry.isDead));
    }
    tftBattleUpdateHp(targetLabel, entry.targetId, entry.targetHp, entry.targetMaxHp, 0);

    if (entry.isDead) {
      if (targetEl) {
        targetEl.classList.remove('berserk-aura');
        tftBattleRetrigger(targetEl, 'defeated', 0);
        targetEl.classList.add('dead');
      }
      tftBattleScreenShake();
      SoundFX.fx.defeat();
      tftBattleFloatText(targetEl, '撃破！', 'float-dmg crit');
    } else if (entry.damage >= 30) {
      tftBattleScreenShake();
    }
  }, 150 / tftBattleView.speed);
}

function tftBattlePlayBerserk(entry) {
  const el = tftBattleUnitEl(entry.label, entry.unitId);
  if (el) {
    el.classList.add('berserk-aura');
    tftBattleFloatText(el, '⚡覚醒！', 'float-awaken');
  }
  SoundFX.fx.berserk();
}

// スキル発動カットイン（main.js の playSkillCutin の移植。初回発動時のみ表示）
function tftBattlePlaySkillCutin(entry) {
  if (entry.casterId === undefined) return;
  const key = entry.casterLabel + ':' + entry.casterId;
  if (tftBattleView.cutinShown.has(key)) return;
  tftBattleView.cutinShown.add(key);
  const layout = document.querySelector('#tft-battle-modal .tft-battle-layout');
  const raw = tftBattleView.raw;
  if (!layout || !raw) return;
  const team = entry.casterLabel === 'プレイヤー' ? raw.playerTeam : raw.cpuTeam;
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

function tftBattlePlaySkill(entry) {
  const casterEl = entry.casterId !== undefined ? tftBattleUnitEl(entry.casterLabel, entry.casterId) : null;
  tftBattlePlaySkillCutin(entry);
  if (casterEl) {
    tftBattleRetrigger(casterEl, 'skill-flash', 550);
    tftBattleFloatText(casterEl, `【${entry.skillName}】`, 'float-skill');
  }
  SoundFX.fx.skill();
  if (entry.maxMp !== undefined) {
    tftBattleUpdateMp(entry.casterLabel, entry.casterId, entry.mp, entry.maxMp);
  }

  if (entry.targetId !== undefined && entry.damage !== undefined) {
    const targetEl = tftBattleUnitEl(entry.targetLabel, entry.targetId);
    if (targetEl) {
      tftBattleRetrigger(targetEl, 'hit', 320);
      tftBattleFloatText(targetEl, '-' + entry.damage, tftDmgFloatClass(entry.damage, entry.isDead));
      tftBattleUpdateHp(entry.targetLabel, entry.targetId, entry.targetHp, entry.targetMaxHp, 0);
      if (entry.isDead) {
        tftBattleRetrigger(targetEl, 'defeated', 0);
        targetEl.classList.add('dead');
        tftBattleScreenShake();
        SoundFX.fx.defeat();
      } else {
        SoundFX.fx.hit(entry.damage);
      }
    }
  }

  if (entry.healed !== undefined) {
    const targetEl = tftBattleUnitEl(entry.targetLabel, entry.targetId);
    if (targetEl) {
      tftBattleRetrigger(targetEl, 'heal-flash', 500);
      tftBattleFloatText(targetEl, '+' + entry.healed, 'float-heal');
      tftBattleUpdateHp(entry.targetLabel, entry.targetId, entry.currentHp, entry.maxHp, 0);
    }
    SoundFX.fx.heal();
  }
}

function tftBattlePlayFacility(entry) {
  const el = tftBattleUnitEl(entry.label, entry.unitId);
  if (entry.kind === 'damage') {
    if (el) {
      tftBattleRetrigger(el, 'hit', 320);
      tftBattleFloatText(el, '-' + entry.damage, entry.isDead ? 'float-dmg crit' : 'float-facility');
    }
    tftBattleUpdateHp(entry.label, entry.unitId, entry.targetHp, entry.targetMaxHp, 0);
    SoundFX.fx.hit(entry.damage);
    if (entry.isDead) {
      if (el) { tftBattleRetrigger(el, 'defeated', 0); el.classList.add('dead'); }
      tftBattleScreenShake();
      SoundFX.fx.defeat();
      tftBattleFloatText(el, '撃破！', 'float-dmg crit');
    }
  } else if (entry.kind === 'heal') {
    if (el) {
      tftBattleRetrigger(el, 'heal-flash', 500);
      tftBattleFloatText(el, '+' + entry.healed, 'float-heal');
    }
    tftBattleUpdateHp(entry.label, entry.unitId, entry.currentHp, entry.maxHp, 0);
    SoundFX.fx.heal();
  }
}

function tftBattlePlayHeal(entry) {
  const el = tftBattleUnitEl(entry.label, entry.unitId);
  if (el) {
    tftBattleRetrigger(el, 'heal-flash', 500);
    tftBattleFloatText(el, '+' + entry.healed, 'float-heal');
  }
  tftBattleUpdateHp(entry.label, entry.unitId, entry.currentHp, entry.maxHp, 0);
  SoundFX.fx.heal();
}

// ============ ログ逐次再生 ============

function tftBattleAppendLogLine(entry) {
  const logEl = document.getElementById('tft-battle-log');
  const line = document.createElement('div');
  line.className = 'log-line log-' + entry.type;
  line.textContent = entry.text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function tftBattleStep() {
  if (tftBattleView.logIndex >= tftBattleView.log.length) {
    tftBattleShowResult();
    return;
  }
  const entry = tftBattleView.log[tftBattleView.logIndex++];
  tftBattleAppendLogLine(entry);

  let delay = 400;
  if (entry.type === 'attack') {
    tftBattlePlayAttack(entry);
    delay = entry.isDead ? 750 : 400;
  } else if (entry.type === 'berserk') {
    tftBattlePlayBerserk(entry);
    delay = 700;
  } else if (entry.type === 'heal') {
    tftBattlePlayHeal(entry);
    delay = 350;
  } else if (entry.type === 'shield') {
    const el = tftBattleUnitEl(entry.label, entry.unitId);
    if (el) tftBattleFloatText(el, '🛡-' + entry.absorbed, 'float-shield');
    tftBattleUpdateHp(entry.label, entry.unitId, null, null, entry.shieldLeft);
    delay = 200;
  } else if (entry.type === 'skill') {
    tftBattlePlaySkill(entry);
    delay = entry.damage ? 400 : 300;
  } else if (entry.type === 'facility') {
    tftBattlePlayFacility(entry);
    delay = entry.isDead ? 700 : (entry.kind === 'heal' ? 300 : 350);
  }

  tftBattleView.timer = setTimeout(tftBattleStep, delay / tftBattleView.speed);
}

// ============ スキップ（main.js の skipBattle/applyEntryState の移植） ============

function tftBattleApplyEntryState(entry) {
  if (entry.type === 'attack') {
    const targetLabel = entry.attackerLabel === 'プレイヤー' ? 'CPU' : 'プレイヤー';
    tftBattleUpdateHp(targetLabel, entry.targetId, entry.targetHp, entry.targetMaxHp, 0);
    if (entry.isDead) tftBattleMarkDead(targetLabel, entry.targetId);
  } else if (entry.type === 'heal') {
    tftBattleUpdateHp(entry.label, entry.unitId, entry.currentHp, entry.maxHp, 0);
  } else if (entry.type === 'shield') {
    tftBattleUpdateHp(entry.label, entry.unitId, null, null, entry.shieldLeft);
  } else if (entry.type === 'skill') {
    if (entry.maxMp !== undefined) tftBattleUpdateMp(entry.casterLabel, entry.casterId, entry.mp, entry.maxMp);
    if (entry.targetId !== undefined && entry.damage !== undefined) {
      tftBattleUpdateHp(entry.targetLabel, entry.targetId, entry.targetHp, entry.targetMaxHp, 0);
      if (entry.isDead) tftBattleMarkDead(entry.targetLabel, entry.targetId);
    }
    if (entry.healed !== undefined) {
      tftBattleUpdateHp(entry.targetLabel, entry.targetId, entry.currentHp, entry.maxHp, 0);
    }
  } else if (entry.type === 'facility') {
    if (entry.kind === 'damage') {
      tftBattleUpdateHp(entry.label, entry.unitId, entry.targetHp, entry.targetMaxHp, 0);
      if (entry.isDead) tftBattleMarkDead(entry.label, entry.unitId);
    } else if (entry.kind === 'heal') {
      tftBattleUpdateHp(entry.label, entry.unitId, entry.currentHp, entry.maxHp, 0);
    }
  }
}

function tftBattleMarkDead(label, unitId) {
  const el = tftBattleUnitEl(label, unitId);
  if (el) {
    el.classList.remove('berserk-aura');
    el.classList.add('dead');
  }
}

function tftBattleSkip() {
  if (tftBattleView.logIndex >= tftBattleView.log.length) return;
  if (tftBattleView.timer) clearTimeout(tftBattleView.timer);
  while (tftBattleView.logIndex < tftBattleView.log.length) {
    const entry = tftBattleView.log[tftBattleView.logIndex++];
    tftBattleAppendLogLine(entry);
    tftBattleApplyEntryState(entry);
  }
  tftBattleShowResult();
}

// 結果表示: 人間視点（攻撃/防衛どちらでも）で勝敗を分かりやすく表現する
function tftBattleShowResult() {
  const raw = tftBattleView.raw;
  const report = tftBattleView.report;
  const state = tftGame;
  const humanId = tftUi.myPlayerId;
  const atkName = state.players[report.attackerId].name;
  const defName = report.defenderId !== null ? state.players[report.defenderId].name : '中立';
  const attackerWon = raw.result === 'win';

  const resultEl = document.getElementById('tft-battle-result-text');
  resultEl.textContent = attackerWon ? `⚔️ ${atkName} の勝利！` : `🛡️ ${defName} の防衛成功！`;

  // 勝者チームの生存ユニットをポートレート列で表示
  const winners = (attackerWon ? raw.playerTeam : raw.cpuTeam).filter(u => u.currentHp > 0);
  const portraits = document.createElement('div');
  portraits.className = 'result-portraits';
  portraits.innerHTML = winners
    .map(u => `<div class="unit-sprite" style="${unitSpriteStyle(u)}" title="${u.name}"></div>`).join('');
  resultEl.insertAdjacentElement('afterend', portraits);

  // 人間が関与する勝敗のみ全画面演出（勝ち=紙吹雪 / 負け=赤ビネット）
  const humanWon = (report.attackerId === humanId && attackerWon)
    || (report.defenderId === humanId && !attackerWon);
  if (report.attackerId === humanId || report.defenderId === humanId) {
    if (humanWon) {
      SoundFX.fx.win();
      tftSpawnConfetti();
    } else {
      SoundFX.fx.lose();
      tftSpawnVignette();
    }
  } else {
    SoundFX.fx.hit(20);
  }
}

// 勝利紙吹雪／敗北ビネット（main.js の spawnConfetti/spawnVignette の移植）
function tftSpawnConfetti() {
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

function tftSpawnVignette() {
  const v = document.createElement('div');
  v.className = 'vignette-lose';
  document.body.appendChild(v);
  setTimeout(() => v.remove(), 2500);
}

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('tft-battle-close');
  if (closeBtn) closeBtn.addEventListener('click', tftCloseBattleModal);
  document.querySelectorAll('.tft-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => tftSetBattleSpeed(parseInt(btn.dataset.speed, 10)));
  });
  tftUpdateSpeedButtons();
  const skipBtn = document.getElementById('tft-battle-skip');
  if (skipBtn) skipBtn.addEventListener('click', tftBattleSkip);
});
