const CLASSES = {
  HIGHPOWER:   'ハイパワー',
  HIGHSPEED:   'ハイスピード',
  BLOCKER:     'ブロッカー',
  HEALER:      'ヒーラー',
  BERSERKER:   'バーサーカー',
  BRAWLER:     'ブローラー',
  HOLY_SHIELD: '聖なる盾',
};

// 各シナジーの段階（thresholdsは降順。getActiveSynergies/applyStatSynergiesが
// find(count>=t.count)で最上位一致を取るため、必ずcount降順で並べる）。
// count6以上の上位段はクラス紋章アイテムの上乗せ加算（countClasses参照）で到達する上振れ枠。
const SYNERGY_RULES = [
  {
    classId: CLASSES.HIGHPOWER,
    thresholds: [
      { count: 6, stat: 'atk', multiplier: 2.00 },
      { count: 5, stat: 'atk', multiplier: 1.40 },
      { count: 4, stat: 'atk', multiplier: 1.00 },
      { count: 2, stat: 'atk', multiplier: 0.20 },
    ],
    type: 'multiplier',
  },
  {
    classId: CLASSES.HIGHSPEED,
    thresholds: [
      { count: 7, stat: 'spd', multiplier: 3.00 },
      { count: 6, stat: 'spd', multiplier: 2.20 },
      { count: 5, stat: 'spd', multiplier: 1.50 },
      { count: 3, stat: 'spd', multiplier: 0.50 },
      { count: 1, stat: 'spd', multiplier: 0.10 },
    ],
    type: 'multiplier',
  },
  {
    classId: CLASSES.BLOCKER,
    thresholds: [
      { count: 6, stat: 'def', multiplier: 2.40 },
      { count: 5, stat: 'def', multiplier: 1.70 },
      { count: 4, stat: 'def', multiplier: 1.20 },
      { count: 2, stat: 'def', multiplier: 0.35 },
    ],
    type: 'multiplier',
  },
  {
    classId: CLASSES.HEALER,
    thresholds: [
      { count: 5, healPerTurn: 28 },
      { count: 4, healPerTurn: 18 },
      { count: 3, healPerTurn: 11 },
    ],
    type: 'heal',
  },
  {
    classId: CLASSES.BERSERKER,
    thresholds: [
      { count: 6, bonus: 3.00 },
      { count: 5, bonus: 2.10 },
      { count: 4, bonus: 1.50 },
      { count: 2, bonus: 0.50 },
    ],
    type: 'berserker',
  },
  {
    classId: CLASSES.BRAWLER,
    thresholds: [
      { count: 6, stat: 'hp', multiplier: 1.20 },
      { count: 5, stat: 'hp', multiplier: 0.85 },
      { count: 4, stat: 'hp', multiplier: 0.60 },
      { count: 2, stat: 'hp', multiplier: 0.25 },
    ],
    type: 'multiplier',
  },
  {
    classId: CLASSES.HOLY_SHIELD,
    thresholds: [
      { count: 5, shieldPct: 0.58 },
      { count: 4, shieldPct: 0.44 },
      { count: 3, shieldPct: 0.32 },
      { count: 2, shieldPct: 0.22 },
    ],
    type: 'shield',
  },
];

// 各ステータスのティア値。ユニットのhp/atk/def/spdはこの値のいずれかに揃える。
// 8ランク化に伴い段階を拡張（旧5段階値を全て内包するスーパーセット）。アイテムのbumpTierは
// tiers.indexOf(value) で厳密一致を要求するため、全ユニットの各ステータスはこの配列内の値であること。
const STAT_TIERS = {
  hp:  [45, 55, 70, 85, 95, 105, 115, 125, 140],
  atk: [10, 15, 22, 30, 38, 45, 52, 60, 68, 75, 85],
  def: [5,  8,  13, 18, 24, 30, 38, 45, 52, 60, 70],
  spd: [15, 20, 28, 35, 45, 55, 65, 80, 100, 120, 135],
};

// 5系統（lineage）。将来の戦略シミュレーションで「研究」により上位ランクを解放する想定。
const LINEAGES = {
  WARRIOR: { id: 'warrior', label: '戦士系',  color: '#7ab4ff' },
  MAGE:    { id: 'mage',    label: '魔術師系', color: '#c084fc' },
  ROGUE:   { id: 'rogue',   label: '盗賊系',  color: '#4ade80' },
  ARCHER:  { id: 'archer',  label: '弓兵系',  color: '#86efac' },
  MONK:    { id: 'monk',    label: '僧侶系',  color: '#fbbf24' },
  GOBLIN:  { id: 'goblin',  label: 'モンスター系', color: '#a16207' },
};

// 各系統8ランク構成。ランクが上がるほどクラスが増え、スキルが強化される。
// 旧4ランク版からのリスケール: 旧R1→R2, 旧R2→R4, 旧R3→R6, 旧R4→R8（既存ユニットは名前・
// ステータス・スキルとも不変で rank のみ変更）。R1/R3/R5/R7 は新規追加ユニット。
// R8=各系統の「ヒーロー」枠（TFTBSはショップ購入可、TFTは別枠解禁）。
const UNITS_DATA = [
  // ======== 戦士系（被弾軽減・タンク／BLOCKER→BRAWLER→BERSERKER→HOLY_SHIELD） ========
  {
    id: 1, lineage: LINEAGES.WARRIOR, rank: 1,
    name: '見習い兵',
    hp: 55, atk: 22, def: 13, spd: 35,
    classes: [CLASSES.BLOCKER],
    cost: 1,
    skill: null,
  },
  {
    id: 2, lineage: LINEAGES.WARRIOR, rank: 2,
    name: 'ソルジャー',
    hp: 70, atk: 30, def: 18, spd: 35,
    classes: [CLASSES.BLOCKER],
    cost: 2,
    skill: null,
  },
  {
    id: 3, lineage: LINEAGES.WARRIOR, rank: 3,
    name: '重装歩兵',
    hp: 85, atk: 30, def: 30, spd: 35,
    classes: [CLASSES.BLOCKER, CLASSES.BRAWLER],
    cost: 3,
    skill: { id: 'brace', name: '構え', desc: '被弾時常にダメージ8%軽減',
      trigger: 'on_defend', chance: 1.0, effect: 'reduce', value: 0.08 },
  },
  {
    id: 4, lineage: LINEAGES.WARRIOR, rank: 4,
    name: 'ガーディアン',
    hp: 105, atk: 30, def: 45, spd: 35,
    classes: [CLASSES.BLOCKER, CLASSES.BRAWLER],
    cost: 4,
    skill: { id: 'deflect', name: '受け流し', desc: '被弾時常にダメージ10%軽減',
      trigger: 'on_defend', chance: 1.0, effect: 'reduce', value: 0.10 },
  },
  {
    id: 5, lineage: LINEAGES.WARRIOR, rank: 5,
    name: '近衛兵',
    hp: 115, atk: 45, def: 45, spd: 35,
    classes: [CLASSES.BLOCKER, CLASSES.BRAWLER, CLASSES.BERSERKER],
    cost: 5,
    skill: { id: 'parry', name: '見切り', desc: '被弾時常にダメージ15%軽減',
      trigger: 'on_defend', chance: 1.0, effect: 'reduce', value: 0.15 },
  },
  {
    id: 6, lineage: LINEAGES.WARRIOR, rank: 6,
    name: 'ウォーロード',
    hp: 125, atk: 60, def: 45, spd: 35,
    classes: [CLASSES.BLOCKER, CLASSES.BRAWLER, CLASSES.BERSERKER],
    cost: 6,
    skill: { id: 'fortify', name: '不動', desc: '被弾時常にダメージ20%軽減',
      trigger: 'on_defend', chance: 1.0, effect: 'reduce', value: 0.20 },
  },
  {
    id: 7, lineage: LINEAGES.WARRIOR, rank: 7,
    name: '将軍',
    hp: 125, atk: 60, def: 52, spd: 35,
    classes: [CLASSES.BLOCKER, CLASSES.BRAWLER, CLASSES.BERSERKER],
    cost: 7,
    skill: { id: 'ironwall', name: '鉄壁', desc: '被弾時常にダメージ28%軽減',
      trigger: 'on_defend', chance: 1.0, effect: 'reduce', value: 0.28 },
  },
  {
    id: 8, lineage: LINEAGES.WARRIOR, rank: 8,
    name: '剣皇',
    hp: 125, atk: 60, def: 60, spd: 35,
    classes: [CLASSES.BLOCKER, CLASSES.BRAWLER, CLASSES.BERSERKER, CLASSES.HOLY_SHIELD],
    cost: 8,
    skill: { id: 'absolute_guard', name: '絶対防御', desc: '被弾時常にダメージ35%軽減',
      trigger: 'on_defend', chance: 1.0, effect: 'reduce', value: 0.35 },
  },
  // ======== 魔術師系（波及魔法・高火力／HIGHPOWER→BERSERKER→HIGHSPEED→HEALER） ========
  {
    id: 9, lineage: LINEAGES.MAGE, rank: 1,
    name: '弟子',
    hp: 55, atk: 22, def: 8, spd: 55,
    classes: [CLASSES.HIGHPOWER],
    cost: 1,
    skill: null,
  },
  {
    id: 10, lineage: LINEAGES.MAGE, rank: 2,
    name: 'プリースト',
    hp: 70, atk: 30, def: 8, spd: 55,
    classes: [CLASSES.HIGHPOWER],
    cost: 2,
    skill: null,
  },
  {
    id: 11, lineage: LINEAGES.MAGE, rank: 3,
    name: '魔導士',
    hp: 70, atk: 45, def: 8, spd: 55,
    classes: [CLASSES.HIGHPOWER, CLASSES.BERSERKER],
    cost: 3,
    skill: { id: 'spark', name: '火花', desc: '40%の確率でもう1体の敵に35%ダメージ',
      trigger: 'on_attack', chance: 0.40, effect: 'chain', value: 0.35 },
  },
  {
    id: 12, lineage: LINEAGES.MAGE, rank: 4,
    name: 'バトルメイジ',
    hp: 70, atk: 60, def: 18, spd: 55,
    classes: [CLASSES.HIGHPOWER, CLASSES.BERSERKER],
    cost: 4,
    skill: { id: 'arcane_bolt', name: '魔力爆発', desc: '50%の確率でもう1体の敵に50%ダメージ',
      trigger: 'on_attack', chance: 0.50, effect: 'chain', value: 0.5 },
  },
  {
    id: 13, lineage: LINEAGES.MAGE, rank: 5,
    name: '賢者',
    hp: 85, atk: 60, def: 18, spd: 55,
    classes: [CLASSES.HIGHPOWER, CLASSES.BERSERKER, CLASSES.HIGHSPEED],
    cost: 5,
    skill: { id: 'shock', name: '電撃', desc: '50%の確率でもう1体の敵に75%ダメージ',
      trigger: 'on_attack', chance: 0.50, effect: 'chain', value: 0.75 },
  },
  {
    id: 14, lineage: LINEAGES.MAGE, rank: 6,
    name: 'アークメイジ',
    hp: 85, atk: 75, def: 30, spd: 55,
    classes: [CLASSES.HIGHPOWER, CLASSES.HEALER, CLASSES.HIGHSPEED],
    cost: 6,
    skill: { id: 'chain_lightning', name: '連鎖魔法', desc: '50%の確率でもう1体の敵に100%ダメージ',
      trigger: 'on_attack', chance: 0.50, effect: 'chain', value: 1.0 },
  },
  {
    id: 15, lineage: LINEAGES.MAGE, rank: 7,
    name: '大魔導',
    hp: 85, atk: 75, def: 30, spd: 65,
    classes: [CLASSES.HIGHPOWER, CLASSES.HEALER, CLASSES.HIGHSPEED],
    cost: 7,
    skill: { id: 'inferno', name: '業火', desc: '60%の確率でもう1体の敵に100%ダメージ',
      trigger: 'on_attack', chance: 0.60, effect: 'chain', value: 1.0 },
  },
  {
    id: 16, lineage: LINEAGES.MAGE, rank: 8,
    name: '大賢者',
    hp: 85, atk: 75, def: 18, spd: 80,
    classes: [CLASSES.HIGHPOWER, CLASSES.HEALER, CLASSES.HIGHSPEED, CLASSES.BERSERKER],
    cost: 8,
    skill: { id: 'arcane_storm', name: '大魔法陣', desc: '75%の確率で別の敵に100%ダメージが波及',
      trigger: 'on_attack', chance: 0.75, effect: 'chain', value: 1.0 },
  },
  // ======== 盗賊系（連続攻撃・超高速／HIGHSPEED→BERSERKER→HIGHPOWER→BRAWLER） ========
  {
    id: 17, lineage: LINEAGES.ROGUE, rank: 1,
    name: 'こそ泥',
    hp: 55, atk: 22, def: 8, spd: 65,
    classes: [CLASSES.HIGHSPEED],
    cost: 1,
    skill: null,
  },
  {
    id: 18, lineage: LINEAGES.ROGUE, rank: 2,
    name: 'ニンジャ',
    hp: 70, atk: 30, def: 8, spd: 80,
    classes: [CLASSES.HIGHSPEED],
    cost: 2,
    skill: null,
  },
  {
    id: 19, lineage: LINEAGES.ROGUE, rank: 3,
    name: 'スカウト',
    hp: 70, atk: 38, def: 8, spd: 100,
    classes: [CLASSES.HIGHSPEED, CLASSES.BERSERKER],
    cost: 3,
    skill: { id: 'ambush', name: '不意打ち', desc: '15%の確率で2回攻撃',
      trigger: 'on_attack', chance: 0.15, effect: 'extra_attack' },
  },
  {
    id: 20, lineage: LINEAGES.ROGUE, rank: 4,
    name: 'シャドウ',
    hp: 70, atk: 45, def: 8, spd: 120,
    classes: [CLASSES.HIGHSPEED, CLASSES.BERSERKER],
    cost: 4,
    skill: { id: 'critical', name: '急所打ち', desc: '25%の確率で2回攻撃',
      trigger: 'on_attack', chance: 0.25, effect: 'extra_attack' },
  },
  {
    id: 21, lineage: LINEAGES.ROGUE, rank: 5,
    name: '夜叉',
    hp: 85, atk: 52, def: 8, spd: 120,
    classes: [CLASSES.HIGHSPEED, CLASSES.BERSERKER, CLASSES.HIGHPOWER],
    cost: 5,
    skill: { id: 'flurry', name: '連撃', desc: '32%の確率で2回攻撃',
      trigger: 'on_attack', chance: 0.32, effect: 'extra_attack' },
  },
  {
    id: 22, lineage: LINEAGES.ROGUE, rank: 6,
    name: '影の王',
    hp: 85, atk: 60, def: 8, spd: 120,
    classes: [CLASSES.HIGHSPEED, CLASSES.BERSERKER, CLASSES.HIGHPOWER],
    cost: 6,
    skill: { id: 'assassinate', name: '暗殺', desc: '40%の確率で2回攻撃',
      trigger: 'on_attack', chance: 0.40, effect: 'extra_attack' },
  },
  {
    id: 23, lineage: LINEAGES.ROGUE, rank: 7,
    name: '首狩り',
    hp: 95, atk: 60, def: 13, spd: 120,
    classes: [CLASSES.HIGHSPEED, CLASSES.BERSERKER, CLASSES.HIGHPOWER],
    cost: 7,
    skill: { id: 'headhunt', name: '乱刃', desc: '42%の確率で2回攻撃',
      trigger: 'on_attack', chance: 0.42, effect: 'extra_attack' },
  },
  {
    id: 24, lineage: LINEAGES.ROGUE, rank: 8,
    name: '暗殺王',
    hp: 105, atk: 60, def: 18, spd: 120,
    classes: [CLASSES.HIGHSPEED, CLASSES.BERSERKER, CLASSES.HIGHPOWER, CLASSES.BRAWLER],
    cost: 8,
    skill: { id: 'execute', name: '瞬殺', desc: '攻撃後35%でもう1回攻撃',
      trigger: 'on_attack', chance: 0.35, effect: 'extra_attack' },
  },
  // ======== 弓兵系（DEF無視・高速射撃／HIGHPOWER→HIGHSPEED→BRAWLER→BERSERKER） ========
  {
    id: 25, lineage: LINEAGES.ARCHER, rank: 1,
    name: '狩人',
    hp: 55, atk: 38, def: 8, spd: 45,
    classes: [CLASSES.HIGHPOWER],
    cost: 1,
    skill: null,
  },
  {
    id: 26, lineage: LINEAGES.ARCHER, rank: 2,
    name: 'レンジャー',
    hp: 70, atk: 45, def: 8, spd: 55,
    classes: [CLASSES.HIGHPOWER],
    cost: 2,
    skill: null,
  },
  {
    id: 27, lineage: LINEAGES.ARCHER, rank: 3,
    name: '弓兵長',
    hp: 70, atk: 52, def: 8, spd: 65,
    classes: [CLASSES.HIGHPOWER, CLASSES.HIGHSPEED],
    cost: 3,
    skill: { id: 'aimed_shot', name: '狙い撃ち', desc: '攻撃時DEFを15%無視',
      trigger: 'on_attack', chance: 1.0, effect: 'pierce', value: 0.15 },
  },
  {
    id: 28, lineage: LINEAGES.ARCHER, rank: 4,
    name: 'スナイパー',
    hp: 70, atk: 60, def: 8, spd: 80,
    classes: [CLASSES.HIGHPOWER, CLASSES.HIGHSPEED],
    cost: 4,
    skill: { id: 'pierce_shot', name: '貫通射撃', desc: '攻撃時DEFを25%無視',
      trigger: 'on_attack', chance: 1.0, effect: 'pierce', value: 0.25 },
  },
  {
    id: 29, lineage: LINEAGES.ARCHER, rank: 5,
    name: '射手頭',
    hp: 85, atk: 60, def: 13, spd: 100,
    classes: [CLASSES.HIGHPOWER, CLASSES.HIGHSPEED, CLASSES.BRAWLER],
    cost: 5,
    skill: { id: 'quick_shot', name: '速射', desc: '攻撃時DEFを25%無視',
      trigger: 'on_attack', chance: 1.0, effect: 'pierce', value: 0.25 },
  },
  {
    id: 30, lineage: LINEAGES.ARCHER, rank: 6,
    name: '神弓士',
    hp: 85, atk: 60, def: 18, spd: 120,
    classes: [CLASSES.HIGHPOWER, CLASSES.HIGHSPEED, CLASSES.BRAWLER],
    cost: 6,
    skill: { id: 'rapid_fire', name: '連射', desc: '攻撃時DEFを25%無視',
      trigger: 'on_attack', chance: 1.0, effect: 'pierce', value: 0.25 },
  },
  {
    id: 31, lineage: LINEAGES.ARCHER, rank: 7,
    name: '天弓',
    hp: 95, atk: 60, def: 24, spd: 120,
    classes: [CLASSES.HIGHPOWER, CLASSES.HIGHSPEED, CLASSES.BRAWLER],
    cost: 7,
    skill: { id: 'piercing_volley', name: '貫き', desc: '攻撃時DEFを32%無視',
      trigger: 'on_attack', chance: 1.0, effect: 'pierce', value: 0.32 },
  },
  {
    id: 32, lineage: LINEAGES.ARCHER, rank: 8,
    name: '弓聖',
    hp: 105, atk: 60, def: 30, spd: 120,
    classes: [CLASSES.HIGHPOWER, CLASSES.HIGHSPEED, CLASSES.BRAWLER, CLASSES.BERSERKER],
    cost: 8,
    skill: { id: 'godspeed_arrow', name: '神速の矢', desc: '攻撃時DEFを40%無視',
      trigger: 'on_attack', chance: 1.0, effect: 'pierce', value: 0.40 },
  },
  // ======== 僧侶系（回復・聖盾・タンク支援／HEALER→HOLY_SHIELD→BLOCKER→HIGHSPEED） ========
  {
    id: 33, lineage: LINEAGES.MONK, rank: 1,
    name: '修行僧',
    hp: 55, atk: 22, def: 13, spd: 55,
    classes: [CLASSES.HEALER],
    cost: 1,
    skill: null,
  },
  {
    id: 34, lineage: LINEAGES.MONK, rank: 2,
    name: '僧侶',
    hp: 70, atk: 30, def: 18, spd: 55,
    classes: [CLASSES.HEALER],
    cost: 2,
    skill: null,
  },
  {
    id: 35, lineage: LINEAGES.MONK, rank: 3,
    name: '祈祷師',
    hp: 70, atk: 22, def: 24, spd: 55,
    classes: [CLASSES.HEALER, CLASSES.HOLY_SHIELD],
    cost: 3,
    skill: { id: 'first_aid', name: '手当て', desc: 'ターン終了時、最低HP味方に+8HP',
      trigger: 'on_turn_end', effect: 'heal_lowest', value: 8 },
  },
  {
    id: 36, lineage: LINEAGES.MONK, rank: 4,
    name: '司祭',
    hp: 85, atk: 15, def: 30, spd: 55,
    classes: [CLASSES.HEALER, CLASSES.HOLY_SHIELD],
    cost: 4,
    skill: { id: 'minor_blessing', name: '小祝福', desc: 'ターン終了時、最低HP味方に+12HP',
      trigger: 'on_turn_end', effect: 'heal_lowest', value: 12 },
  },
  {
    id: 37, lineage: LINEAGES.MONK, rank: 5,
    name: '高司祭',
    hp: 95, atk: 15, def: 38, spd: 65,
    classes: [CLASSES.HEALER, CLASSES.HOLY_SHIELD, CLASSES.BLOCKER],
    cost: 5,
    skill: { id: 'heal', name: '癒し', desc: 'ターン終了時、最低HP味方に+16HP',
      trigger: 'on_turn_end', effect: 'heal_lowest', value: 16 },
  },
  {
    id: 38, lineage: LINEAGES.MONK, rank: 6,
    name: '大司教',
    hp: 105, atk: 15, def: 45, spd: 80,
    classes: [CLASSES.HEALER, CLASSES.HOLY_SHIELD, CLASSES.BLOCKER],
    cost: 6,
    skill: { id: 'major_blessing', name: '大祝福', desc: 'ターン終了時、最低HP味方2人に+12HP',
      trigger: 'on_turn_end', effect: 'heal_lowest_2', value: 12 },
  },
  {
    id: 39, lineage: LINEAGES.MONK, rank: 7,
    name: '枢機卿',
    hp: 115, atk: 22, def: 52, spd: 80,
    classes: [CLASSES.HEALER, CLASSES.HOLY_SHIELD, CLASSES.BLOCKER],
    cost: 7,
    skill: { id: 'grace', name: '慈愛', desc: 'ターン終了時、最低HP味方2人に+14HP',
      trigger: 'on_turn_end', effect: 'heal_lowest_2', value: 14 },
  },
  {
    id: 40, lineage: LINEAGES.MONK, rank: 8,
    name: '大教皇',
    hp: 125, atk: 30, def: 60, spd: 80,
    classes: [CLASSES.HEALER, CLASSES.HOLY_SHIELD, CLASSES.BLOCKER, CLASSES.HIGHSPEED],
    cost: 8,
    skill: { id: 'grand_prayer', name: '祝福の祈り', desc: 'ターン終了時、最低HP味方2人に+16HP',
      trigger: 'on_turn_end', effect: 'heal_lowest_2', value: 16 },
  },
  // ======== モンスター（ゴブリン系・シナジーなし） ========
  // isMonster:true のユニットはクラスを持たず、チームのシナジー倍率も受けない独立した戦力。
  // その代わり素の能力値が同コストの通常ユニットより高い（数値は既存 STAT_TIERS の上位値）。
  // ゴブリンはPvEの難度軸として独立。ランク1-4のまま（8ランク化の対象外・出現ステージ用の識別子）。
  // モンスターは「同ランクのプレイヤーユニットより約1ランク強い」を狙って調整（旧値は約2ランク強で壁だった）。
  // 中立地は5体スポーン＋防衛側DEF+20%が乗るため、素のステータスは同格ユニットのやや上に留める。
  {
    id: 41, lineage: LINEAGES.GOBLIN, rank: 1, isMonster: true,
    name: 'ゴブリン',
    hp: 70, atk: 30, def: 15, spd: 45, // ≈プレイヤーR2
    classes: [],
    cost: 2,
    skill: null,
  },
  {
    id: 42, lineage: LINEAGES.GOBLIN, rank: 2, isMonster: true,
    name: 'ホブゴブリン',
    hp: 85, atk: 38, def: 22, spd: 45, // ≈プレイヤーR3
    classes: [],
    cost: 4,
    skill: null,
  },
  {
    id: 43, lineage: LINEAGES.GOBLIN, rank: 3, isMonster: true,
    name: 'ゴブリンチャンピオン',
    hp: 95, atk: 45, def: 30, spd: 65, // ≈プレイヤーR4
    classes: [],
    cost: 5,
    skill: { id: 'rampage', name: '乱打', desc: '35%の確率で2回攻撃',
      trigger: 'on_attack', chance: 0.35, effect: 'extra_attack' },
  },
  {
    id: 44, lineage: LINEAGES.GOBLIN, rank: 4, isMonster: true,
    name: 'ゴブリンロード',
    hp: 115, atk: 52, def: 38, spd: 65, // ≈プレイヤーR5
    classes: [],
    cost: 6,
    skill: { id: 'trample', name: '蹂躙', desc: '50%の確率でもう1体の敵に75%ダメージ',
      trigger: 'on_attack', chance: 0.50, effect: 'chain', value: 0.75 },
  },
];

// アイテム: ユニット1体につき1個まで装備可能。ショップで購入してから装備する。
// type別の意味:
//   'stat'      … ステータス(hp/atk/def/spd)を`tier`段階アップ（tier省略時1。STAT_TIERSの値に厳密一致させて揃える）
//   'class'     … クラスを1つ追加（シナジー判定に算入）。素で同じクラスを持つユニットに重ねると
//                 「そのクラスの追加の1体分」として加算され、シナジーcountを編成上限5超まで伸ばせる。
//   'taunt'     … 被ターゲット率を2倍にする
//   'shield'    … 開幕シールドをvalue割合(maxHP比)付与（聖なる盾シナジーと同じ仕組みに加算）
//   'regen'     … 毎ラウンドHPをvalue回復（ヒーラーシナジーと同じ仕組みに加算）
//   'mp_max'    … 最大MPをvalue増加（スキル持ちユニットのみ意味を持つ）
//   'lifesteal' … 与ダメージのvalue割合をHP回復（通常攻撃のみ、スキル由来のダメージは対象外）
//   'pierce'    … 攻撃時DEFをvalue割合無視（スキルpierceと重ね掛け可）
//   'thorns'    … 被弾ダメージのvalue割合を攻撃者へ反射
//   'cleave'    … ATKをvalue倍にして生存する敵全員を同時攻撃（通常のpickRandom単体攻撃の代わりに発動）
//   'relic'     … 系統専用の最強装備。`lineage`で指定した系統のユニットにしか装備できず、
//                 上記の値系フィールド（hpTier/atkTier/defTier/spdTier/shieldValue/regenValue/
//                 mpMaxValue/lifestealValue/pierceValue/thornsValue）を複数同時に持つ複合効果。
const ITEMS = {
  SWORD_OF_POWER:   { id: 'sword_of_power',   name: '力の剣',     desc: 'ATK+1段階',         icon: '⚔️', type: 'stat', stat: 'atk', cost: 1 },
  IRON_ARMOR:       { id: 'iron_armor',       name: '鉄の鎧',     desc: 'DEF+1段階',         icon: '🛡️', type: 'stat', stat: 'def', cost: 1 },
  GIANTS_BELT:      { id: 'giants_belt',      name: '巨人の帯',   desc: 'HP+1段階',          icon: '💪', type: 'stat', stat: 'hp', cost: 1 },
  SPEED_BOOTS:      { id: 'speed_boots',      name: '速さの靴',   desc: 'SPD+1段階',         icon: '👟', type: 'stat', stat: 'spd', cost: 1 },
  TAUNT_SHIELD:     { id: 'taunt_shield',     name: '挑発する盾', desc: '挑発（被弾率2倍）',  icon: '😡', type: 'taunt', cost: 1 },
  EMBLEM_POWER:     { id: 'emblem_power',     name: '力の紋章',     desc: 'ハイパワー追加',     icon: '🔴', type: 'class', addClass: CLASSES.HIGHPOWER, cost: 2 },
  EMBLEM_BRAWLER:   { id: 'emblem_brawler',   name: '闘士の紋章',   desc: 'ブローラー追加',     icon: '🟠', type: 'class', addClass: CLASSES.BRAWLER, cost: 2 },
  EMBLEM_HOLY:      { id: 'emblem_holy',      name: '聖盾の紋章',   desc: '聖なる盾追加',       icon: '🟡', type: 'class', addClass: CLASSES.HOLY_SHIELD, cost: 2 },
  EMBLEM_BERSERKER: { id: 'emblem_berserker', name: '狂戦士の紋章', desc: 'バーサーカー追加',   icon: '🟣', type: 'class', addClass: CLASSES.BERSERKER, cost: 2 },
  EMBLEM_GUARDIAN:  { id: 'emblem_guardian',  name: '守護者の紋章', desc: 'ブロッカー追加',     icon: '🔵', type: 'class', addClass: CLASSES.BLOCKER, cost: 2 },
  EMBLEM_NINJA:     { id: 'emblem_ninja',     name: '忍者の紋章',   desc: 'ハイスピード追加',   icon: '🟢', type: 'class', addClass: CLASSES.HIGHSPEED, cost: 2 },
  EMBLEM_PRIEST:    { id: 'emblem_priest',    name: '神官の紋章',   desc: 'ヒーラー追加',       icon: '⚪', type: 'class', addClass: CLASSES.HEALER, cost: 2 },

  // --- ステータス上位版（tier2） ---
  GREAT_SWORD:   { id: 'great_sword',   name: '力の大剣',   desc: 'ATK+2段階', icon: '🗡️', type: 'stat', stat: 'atk', tier: 2, cost: 3 },
  GREAT_ARMOR:   { id: 'great_armor',   name: '鋼の大鎧',   desc: 'DEF+2段階', icon: '🪖', type: 'stat', stat: 'def', tier: 2, cost: 3 },
  GIANT_HEART:   { id: 'giant_heart',   name: '巨人の心臓', desc: 'HP+2段階',  icon: '💗', type: 'stat', stat: 'hp',  tier: 2, cost: 3 },
  GALE_BOOTS:    { id: 'gale_boots',    name: '疾風の靴',   desc: 'SPD+2段階', icon: '👢', type: 'stat', stat: 'spd', tier: 2, cost: 3 },

  // --- 新規エンジンtype ---
  BLOOD_FANG:      { id: 'blood_fang',      name: '吸血の刃',     desc: '与ダメージの25%をHP回復',       icon: '🩸', type: 'lifesteal', value: 0.25, cost: 2 },
  GREAT_BLOOD_FANG:{ id: 'great_blood_fang', name: '大吸血の刃',   desc: '与ダメージの40%をHP回復',       icon: '🧛', type: 'lifesteal', value: 0.40, cost: 4 },
  PIERCING_TIP:    { id: 'piercing_tip',    name: '貫きの矢尻',   desc: '攻撃時DEF20%無視',              icon: '🎯', type: 'pierce', value: 0.20, cost: 2 },
  SPIRIT_WARD:     { id: 'spirit_ward',     name: '精霊の加護',   desc: '開幕シールド12%maxHP',           icon: '✨', type: 'shield', value: 0.12, cost: 2 },
  RING_OF_REGEN:   { id: 'ring_of_regen',   name: '再生の指輪',   desc: '毎ラウンドHP+6',                icon: '💚', type: 'regen', value: 6, cost: 2 },
  SAGES_ELIXIR:    { id: 'sages_elixir',    name: '賢者の秘薬',   desc: '最大MP+1',                     icon: '🔮', type: 'mp_max', value: 1, cost: 2 },
  THORN_ARMOR:     { id: 'thorn_armor',     name: '棘の鎧',       desc: '被弾ダメージの20%を攻撃者へ反射', icon: '🌵', type: 'thorns', value: 0.20, cost: 2 },
  GREAT_THORN_ARMOR:{ id: 'great_thorn_armor', name: '鉄壁の棘鎧', desc: '被弾ダメージの35%を攻撃者へ反射', icon: '🦔', type: 'thorns', value: 0.35, cost: 4 },

  // --- 全体攻撃 ---
  BATTLE_AXE: { id: 'battle_axe', name: '戦斧・乱撃', desc: 'ATKを50%にして生存する敵全員を同時攻撃', icon: '🪓', type: 'cleave', value: 0.5, cost: 3 },

  // --- 系統専用の最強装備（relic） ---
  RELIC_WARRIOR: { id: 'relic_warrior', name: '英雄の大盾', desc: 'DEF+2段階／常時シールド15%maxHP／被弾ダメージの15%反射',
    icon: '🛡️👑', type: 'relic', lineage: 'warrior', defTier: 2, shieldValue: 0.15, thornsValue: 0.15, cost: 6 },
  RELIC_MAGE: { id: 'relic_mage', name: '大賢者の秘宝', desc: 'ATK+2段階／最大MP+2／与ダメージの15%回復',
    icon: '📜✨', type: 'relic', lineage: 'mage', atkTier: 2, mpMaxValue: 2, lifestealValue: 0.15, cost: 6 },
  RELIC_ROGUE: { id: 'relic_rogue', name: '暗殺者の秘刀', desc: 'SPD+2段階・ATK+1段階／攻撃時DEF25%無視',
    icon: '🗡️🌙', type: 'relic', lineage: 'rogue', spdTier: 2, atkTier: 1, pierceValue: 0.25, cost: 6 },
  RELIC_ARCHER: { id: 'relic_archer', name: '英雄の弓', desc: 'ATK+2段階・SPD+1段階／攻撃時DEF30%無視',
    icon: '🏹👑', type: 'relic', lineage: 'archer', atkTier: 2, spdTier: 1, pierceValue: 0.30, cost: 6 },
  RELIC_MONK: { id: 'relic_monk', name: '大教皇の法衣', desc: 'HP+2段階／毎ラウンドHP+10／開幕シールド15%',
    icon: '⛪✨', type: 'relic', lineage: 'monk', hpTier: 2, regenValue: 10, shieldValue: 0.15, cost: 6 },
};
const ITEMS_LIST = Object.values(ITEMS);

// 防衛設備: 防衛側のみ購入可能な拠点強化。資金はユニット・アイテムと共有する。
// effect.type の分類:
//   'stat'                … 味方全員のステータス倍率(atk/def/spd)を編成時に加算
//   'turn_heal'           … 毎ラウンド味方全員を回復
//   'opening_damage'      … 開幕に敵全員へダメージ
//   'turn_damage'         … 毎ラウンド、ランダムな敵 targets 体へダメージ
//   'shield'              … 開幕に味方全員へ maxHP×value のシールド付与
//   'enemy_heal_reduction'… 敵の回復量を value 割合ぶん減少
//   'skill_chance'        … 味方スキルの発動率に value を加算
// ※前衛/後衛の位置概念が必要な「バリケード」「城門」は現バージョンでは未実装。
// ※効果値はバランス調整済み（少数精鋭の防衛側が5体編成の攻撃側と拮抗するよう、素案から約1.5倍に強化）。
const FACILITIES = {
  WOOD_FENCE:    { id: 'wood_fence',    name: '木柵',     cost: 1, icon: '🪵', desc: '味方全員 DEF+15%',        effect: { type: 'stat', stat: 'def', value: 0.15 } },
  WATCHTOWER:    { id: 'watchtower',    name: '見張り塔', cost: 1, icon: '🗼', desc: '味方全員 SPD+15%',        effect: { type: 'stat', stat: 'spd', value: 0.15 } },
  SUPPLY_DEPOT:  { id: 'supply_depot',  name: '補給庫',   cost: 1, icon: '📦', desc: '味方全員 ATK+15%',        effect: { type: 'stat', stat: 'atk', value: 0.15 } },
  INFIRMARY:     { id: 'infirmary',     name: '治療所',   cost: 1, icon: '⛑️', desc: '毎ラウンド味方全員 +5回復', effect: { type: 'turn_heal', value: 5 } },
  PITFALL:       { id: 'pitfall',       name: '落とし穴', cost: 1, icon: '🕳️', desc: '開幕、敵全員に8ダメージ',   effect: { type: 'opening_damage', value: 8 } },
  ARROW_TOWER:   { id: 'arrow_tower',   name: '弓塔',     cost: 2, icon: '🏹', desc: '毎ラウンド敵1体に15ダメージ', effect: { type: 'turn_damage', targets: 1, value: 15 } },
  CHAPEL:        { id: 'chapel',        name: '聖堂',     cost: 2, icon: '⛪', desc: '開幕シールド15%HP',        effect: { type: 'shield', value: 0.15 } },
  RAMPART:       { id: 'rampart',       name: '城壁',     cost: 2, icon: '🧱', desc: '味方全員 DEF+30%',        effect: { type: 'stat', stat: 'def', value: 0.30 } },
  HEX_WARD:      { id: 'hex_ward',      name: '呪術結界', cost: 2, icon: '🔯', desc: '敵の回復量-50%',           effect: { type: 'enemy_heal_reduction', value: 0.50 } },
  MAGIC_CANNON:  { id: 'magic_cannon',  name: '魔導砲',   cost: 3, icon: '💥', desc: '毎ラウンド敵2体に15ダメージ', effect: { type: 'turn_damage', targets: 2, value: 15 } },
  ANCIENT_RUINS: { id: 'ancient_ruins', name: '古代遺跡', cost: 3, icon: '🏛️', desc: '味方スキル発動率+30%',      effect: { type: 'skill_chance', value: 0.30 } },
  FORTRESS:      { id: 'fortress',      name: '要塞',     cost: 3, icon: '🏰', desc: '味方全員 DEF+45%',        effect: { type: 'stat', stat: 'def', value: 0.45 } },
};
const FACILITIES_LIST = Object.values(FACILITIES);

// 攻撃側/防衛側の初期資金と防衛側の常時DEFボーナス（防衛拠点システム）。
// 資金は非対称（攻撃側が多い）だが、防衛側のDEFボーナス＋設備で拮抗するよう調整済み。
const ATTACKER_GOLD = 25;
const DEFENDER_GOLD = 23;
const DEFENDER_DEF_BONUS = 0.20;
// 防衛設備は同時に1個までしか保有できない（売却して別の設備に建て替えることは可能）。
const MAX_FACILITIES = 1;

const STARTING_GOLD = 15;
const MAX_TEAM_SIZE = 5;
// 防衛拠点導入で資金が増え（25/20G）チームがほぼ満員化したため、30では決着せず引分が急増する。
// 大型化したチーム同士でも決着するよう行動上限を引き上げる。
const MAX_ACTIONS = 50;
const MAX_RANK = 8; // ランク星表示の上限（ランク8=ヒーロー）

// スキル使用に必要なMP上限（ランク別）。rank1-2はskillが無いため常に0。
// battle.jsのhasMp/spendMpがこの値を消費してスキル発動を制限する（TFT側のTFT_MP_BY_RANKと同じ考え方）。
const MP_BY_RANK = { 1: 0, 2: 0, 3: 3, 4: 3, 5: 4, 6: 4, 7: 5, 8: 5 };
function unitMaxMp(unit) {
  return unit.skill ? (MP_BY_RANK[unit.rank] || 0) : 0;
}

// キャラクター画像スプライトシート image/charactor.png（8列×6行）の座標。
// 行=系統（LINEAGES定義順）、列=rank-1。CSSの .unit-sprite と組で使う。
// セル高が非整数(1024/6)のため物理分割ではなく%指定のbackground-positionで切り出す。
const SPRITE_LINEAGE_ROW = { warrior: 0, mage: 1, rogue: 2, archer: 3, monk: 4, goblin: 5 };
function unitSpriteStyle(unit) {
  const row = SPRITE_LINEAGE_ROW[unit.lineage?.id] ?? 0;
  const col = (unit.rank || 1) - 1;
  return `background-position:${(col / 7 * 100).toFixed(3)}% ${(row / 5 * 100).toFixed(3)}%`;
}

// ダメージ計算: ダメージ = ATK × DEFENSE_CONSTANT / (DEFENSE_CONSTANT + DEF)
// 割合軽減方式（TFT/LoL本家と同じ）。DEF は「実効HP倍率」として働く。
// 定数が小さいほど DEF の軽減効果が大きくなる。バランス調整はこの値で行う。
const DEFENSE_CONSTANT = 100;
