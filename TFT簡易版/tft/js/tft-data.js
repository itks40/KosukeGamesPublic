// ============================================================
// TFT（戦略シミュレーション）専用の定数と盤面ヘルパ。
// 既存 data.js のグローバル（UNITS_DATA 等）と衝突しないよう、
// 新規グローバルはすべて TFT_ / tft 接頭辞で命名する。
// ============================================================

// --- 盤面（可変幅ヘックス・ハニカムパッキング）---
// 上から 6,5,6,5,6,5,6 の7行。短い行(5マス)は長い行(6マス)の間に
// 半マスずれて挟まる（本物のハニカムのように隙間なく組む）。
const TFT_ROW_LENGTHS = [6, 5, 6, 5, 6, 5, 6];
const TFT_ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const TFT_NUM_ROWS = TFT_ROW_LENGTHS.length; // 7
const TFT_CELLS = TFT_ROW_LENGTHS.reduce((a, b) => a + b, 0); // 39

// 各行の先頭インデックス（累積和）
const TFT_ROW_START = (() => {
  const out = [];
  let acc = 0;
  for (const len of TFT_ROW_LENGTHS) { out.push(acc); acc += len; }
  return out;
})();

function tftRowOf(idx) {
  for (let r = TFT_NUM_ROWS - 1; r >= 0; r--) {
    if (idx >= TFT_ROW_START[r]) return r;
  }
  return 0;
}
function tftSeatOf(idx) { return idx - TFT_ROW_START[tftRowOf(idx)]; }
function tftIdx(row, seat) { return TFT_ROW_START[row] + seat; }
function tftCellLabel(idx) {
  const row = tftRowOf(idx);
  return TFT_ROW_LETTERS[row] + (tftSeatOf(idx) + 1);
}

// 初期占有マップ: 本拠地1マスのみ所有（他は全て中立）。
// 本拠地セル自体は tftCreateState 内で個別に設定する。
const TFT_INITIAL_OWNER = new Array(TFT_CELLS).fill(null);

// ============================================================
// 勢力（プレイヤー枠 + 常設CPU勢力）
// ============================================================
// 勢力IDは state.players の添字であり、そのまま cells[].ownerId でもある。
//   id 0..3  = プレイヤー枠（human/off）。ホットシート未実装のため現状 P1 のみ操作可能。
//   id 4..10 = 常設CPU勢力（TFT_CPU_FACTIONS の順）。人数に関係なく必ず盤面に居る。
const TFT_NUM_PLAYER_SLOTS = 4;

// プレイヤーの開始候補 C2/C5/E2/E5（この中からランダムに割り当てる）。
// 盤面を総当たりした結果、「CPU勢力のどれにも隣接せず、互いにも隣接しない」4マスの組は
// この1通りしかない。どこから始めても 隣接6マスが全て中立 / 最寄りの通常CPUまで2ホップ /
// 最寄りの中ボスまで2ホップ / TFT帝国(D3)まで2ホップ と条件が完全に揃う。
const TFT_PLAYER_START_CELLS = [tftIdx(2, 1), tftIdx(2, 4), tftIdx(4, 1), tftIdx(4, 4)];

// 本拠地の守備隊（攻撃されるたびに生成される固定防衛部隊。中立地モンスターと同じ戦闘時スポーン方式）。
// 実際の駐留とは無関係にスポーンするため、CPUは全ユニットを攻めに回せる。
const TFT_HOME_GUARD_SIZE = 5;          // 常にこの体数で守る
const TFT_HOME_GUARD_RANKS = [4, 5, 6]; // 通常CPUの守備隊ランク（この中からランダム構成）

// 勢力の種別ごとの性質。
//   guardRanks: 本拠地守備隊のランク（null = 守備隊なし＝プレイヤー枠）。単一ランクを指定すると
//               「そのランクの全5系統」= ちょうど TFT_HOME_GUARD_SIZE 体になる（tftSpawnHomeGuard参照）。
//   dropKeyId : この勢力を撃破（本拠地陥落）させた側に渡る鍵
//   lockKeyId : この勢力の本拠地へ侵攻・計略するのに必要な鍵（null = ロックなし）
//   passive   : true なら内政も侵攻も計略もせず本拠地1マスに座り続ける（＝討伐されるだけの存在）
const TFT_FACTION_KINDS = {
  player:   { passive: false, guardRanks: null,                 dropKeyId: null,        lockKeyId: null },
  normal:   { passive: false, guardRanks: TFT_HOME_GUARD_RANKS, dropKeyId: 'key_green', lockKeyId: null },
  midboss:  { passive: false, guardRanks: [7],                  dropKeyId: 'key_black', lockKeyId: 'key_green' },
  lastboss: { passive: true,  guardRanks: [8],                  dropKeyId: null,        lockKeyId: 'key_black' },
};

// 常設CPU勢力（id 4..10）。名前・色・配置・種別はこのテーブルだけ直せば全UIに反映される。
const TFT_CPU_FACTIONS = [
  { home: tftIdx(0, 0), name: '北西軍',     color: '#f97316', kind: 'normal' },   // A1
  { home: tftIdx(0, 5), name: '北東軍',     color: '#a3e635', kind: 'normal' },   // A6
  { home: tftIdx(6, 0), name: '南西軍',     color: '#22d3ee', kind: 'normal' },   // G1
  { home: tftIdx(6, 5), name: '南東軍',     color: '#f472b6', kind: 'normal' },   // G6
  { home: tftIdx(1, 2), name: '北の守護者', color: '#a855f7', kind: 'midboss' },  // B3
  { home: tftIdx(5, 2), name: '南の守護者', color: '#14b8a6', kind: 'midboss' },  // F3
  { home: tftIdx(3, 2), name: 'TFT帝国',    color: '#cbd5e1', kind: 'lastboss' }, // D3
];

const TFT_NUM_PLAYERS = TFT_NUM_PLAYER_SLOTS + TFT_CPU_FACTIONS.length; // 11

const TFT_PLAYER_COLORS = ['#7ab4ff', '#e94560', '#4ade80', '#fbbf24'].concat(TFT_CPU_FACTIONS.map(f => f.color));
const TFT_PLAYER_NAMES = ['P1', 'P2', 'P3', 'P4'].concat(TFT_CPU_FACTIONS.map(f => f.name));

function tftIsCpuFaction(playerId) { return playerId >= TFT_NUM_PLAYER_SLOTS; }
function tftFactionKind(state, playerId) { return TFT_FACTION_KINDS[state.players[playerId].kind]; }
function tftIsPassiveFaction(state, playerId) { return tftFactionKind(state, playerId).passive; }
// ボス = 本拠地に鍵が要る勢力（中ボス・ラスボス）
function tftIsBossFaction(state, playerId) { return !!tftFactionKind(state, playerId).lockKeyId; }

// --- 鍵（ボスの本拠地を解禁する特殊アイテム） ---
// js/data.js の ITEMS には入れない: TFT_ITEM_POOL = ITEMS_LIST が中立地ドロップとオークション
// 出品の抽選元なので、そちらに混ぜると鍵が商品として並んでしまう。
// type:'key' はバトルエンジン側の item?.type === 'xxx' 判定のどれにも一致しない＝完全に不活性。
const TFT_KEY_ITEMS = {
  GREEN: { id: 'key_green', name: '緑の鍵',   icon: '🟩', type: 'key', cost: 0,
    desc: '中ボス（北の守護者・南の守護者）の本拠地に侵攻できるようになる。通常CPU（北西軍・北東軍・南西軍・南東軍）のいずれかを撃破すると手に入る' },
  BLACK: { id: 'key_black', name: '漆黒の鍵', icon: '🖤', type: 'key', cost: 0,
    desc: 'TFT帝国の本拠地に侵攻できるようになる。中ボスのいずれかを撃破すると手に入る' },
};
const TFT_KEY_ITEMS_LIST = Object.values(TFT_KEY_ITEMS);
function tftKeyItemById(keyId) { return TFT_KEY_ITEMS_LIST.find(k => k.id === keyId) || null; }
function tftIsKeyItem(item) { return !!item && item.type === 'key'; }

// --- フェーズ（リアルタイム化: 進軍/解決フェーズは廃止し live 一本化）---
const TFT_PHASE = { LOBBY: 'lobby', LIVE: 'live', OVER: 'over' };
// ターン長はロビーで選択（テスト=1分）。ターンは経済ティック・行動済リセットの周期。
const TFT_TURN_PRESETS = [
  { id: '1m', label: '1分（テスト）', ms: 60 * 1000 },
  { id: '6h', label: '6時間', ms: 6 * 60 * 60 * 1000 },
  { id: '12h', label: '12時間', ms: 12 * 60 * 60 * 1000 },
];
const TFT_MAX_TURNS = 50;
const TFT_WIN_CELL_COUNT = 19; // このマス数を占領した時点で即勝利

// --- 暦（1ターン=1ヶ月。ターン1が1年目1月。TFT_MAX_TURNS=50 は約4年2ヶ月） ---
// 収入は平坦ではなく季節で集約される: 金は四半期ごと（年4回）、食料は収穫期（年2回）。
// 維持費は毎月かかるため、「収穫で備蓄し次の収穫まで凌ぐ」備蓄管理が生まれる。
const TFT_MONTHS_PER_YEAR = 12;
const TFT_GOLD_INCOME_MONTHS = [1, 4, 7, 10]; // 金の収入月
const TFT_FOOD_HARVEST_MONTHS = [3, 9];       // 食料の収穫月
// 収入1回がカバーする月数（収入テーブルはこの倍率で「1回あたり」に換算済み＝年間総量は平坦時と同じ）
const TFT_GOLD_INCOME_INTERVAL = TFT_MONTHS_PER_YEAR / TFT_GOLD_INCOME_MONTHS.length;   // 3
const TFT_FOOD_HARVEST_INTERVAL = TFT_MONTHS_PER_YEAR / TFT_FOOD_HARVEST_MONTHS.length; // 6

function tftMonthOf(turn) { return ((turn - 1) % TFT_MONTHS_PER_YEAR) + 1; }
function tftYearOf(turn) { return Math.floor((turn - 1) / TFT_MONTHS_PER_YEAR) + 1; }
function tftIsGoldIncomeTurn(turn) { return TFT_GOLD_INCOME_MONTHS.includes(tftMonthOf(turn)); }
function tftIsFoodHarvestTurn(turn) { return TFT_FOOD_HARVEST_MONTHS.includes(tftMonthOf(turn)); }
// 次に months のいずれかの月が来るまでの残り月数（0=今月が該当月）。HUDの予告表示に使う。
function tftMonthsUntil(turn, months) {
  const cur = tftMonthOf(turn);
  let best = TFT_MONTHS_PER_YEAR;
  for (const m of months) {
    const diff = (m - cur + TFT_MONTHS_PER_YEAR) % TFT_MONTHS_PER_YEAR;
    if (diff < best) best = diff;
  }
  return best;
}
// 次の該当月そのもの（HUD表示用）
function tftNextMonthOf(turn, months) {
  return tftMonthOf(turn + tftMonthsUntil(turn, months));
}

// --- 経済（すべて調整可能なバランス定数） ---
const TFT_START_GOLD = 33;          // 初期編成資金（ATTACKER_GOLD=25 に+8）
// 初期食料: 初期編成5体+本拠地1マスで毎月約7消費する。収穫が年2回（3/9月）になったため、
// 開幕から最初の収穫サイクルを凌げるよう約6ヶ月分の滑走路を持たせる（旧: 毎ターン収入時代は20）。
const TFT_START_FOOD = 45;
const TFT_INCOME_PER_CELL = 3;      // 金の収入月ごと: 所有セル数×3G（＝毎月1G相当×3ヶ月分）
const TFT_TOWN_COST = [5, 8, 12];   // 町 Lv1/2/3 への建設・増築費
const TFT_FARM_COST = [4, 6, 9];    // 農場 Lv1/2/3
const TFT_BUILDING_MAX_LV = 3;
// 食料維持費: ユニットはランク比例、加えて所有セル1つにつき一定量を消費する
// ランク別・1体あたり毎ターン消費。8ランク化に伴い ceil(rank/2)。旧remap済ランクの旧値を維持
// （旧R1=新R2=1, 旧R2=新R4=2, 旧R3=新R6=3, 旧R4=新R8=4）。
const TFT_UPKEEP_BY_RANK = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4 };
const TFT_UPKEEP_PER_CELL = 2;       // 所有セル1つにつき毎ターン消費（カツカツ調整で1→2。領土拡大の食料コストを明確化）

// 建設（着工制）: レベルが上がるほど期間・効果の増分の両方が大きくなる加速カーブ
const TFT_BUILD_DURATION = [2, 5, 9];        // Lv1/2/3 着工にかかるターン数（町・農場共通）
// 収入テーブルは「1回あたり」の量。年間総量は毎ターン配っていた頃と同じで、配られ方だけが季節で集約される。
const TFT_TOWN_INCOME_TABLE = [0, 6, 15, 27];  // インデックス=Lv。金の収入月ごとの収入(G)（＝毎月2/5/9G相当×3ヶ月分）
const TFT_FARM_INCOME_TABLE = [0, 12, 24, 42]; // インデックス=Lv。収穫月ごとの食料収入（＝毎月2/4/7相当×6ヶ月分）

// --- 行動力(AP): セル(領土)単位。acted(ユニット単位の1ターン1行動)を置き換える資源。 ---
const TFT_CELL_AP_MAX = 8;
const TFT_CELL_AP_START = 8;   // ゲーム開始時の全セル初期値
const TFT_CELL_AP_REGEN = 2;   // 毎ターン回復量
// 現状は全操作一律1だが、将来の個別調整に備えテーブル形式で保持する
const TFT_AP_COST = {
  move: 1, attack: 1, hire: 1, dismiss: 1, build: 1, research: 1, facility: 1, explore: 1, trade: 1,
};

// --- 探索: APを消費して金/食料をランダムに獲得する ---
const TFT_EXPLORE_GOLD_RANGE = [2, 6]; // 金の探索: 獲得量(乱数、両端含む)
const TFT_EXPLORE_FOOD_RANGE = [2, 6]; // 食料の探索: 獲得量(乱数、両端含む)
// AP上限到達時の「無駄になる回復分」を自動探索したことにする際のボーナス（ターン境界処理）。
// 意図的な探索行動（AP消費）とは別枠。カツカツ調整のため通常の探索より控えめな量にする
// （行動しなくても毎ターン確定で入る不労所得のため、ここが緩いと金の余裕感に直結する）。
const TFT_AP_OVERFLOW_GOLD_RANGE = [1, 3];
function tftRollExploreAmount(range) {
  return range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
}

// --- アイテム: ユニットに1個装備できる（js/data.jsのITEMS機構をそのまま使う）。 ---
// spdを含む全statがjs/synergy.js側で正式対応済みのため、TFT専用の前適用回避策は不要。
const TFT_ITEM_POOL = ITEMS_LIST;
const TFT_ITEM_DROP_CAPTURE = 0.40; // 中立地占領時のドロップ率
const TFT_ITEM_DROP_EXPLORE = 0.20; // アイテム探索での入手率

// --- オークション: 毎ターン1点ずつ新規出品（最大4点まで同時進行・4ターンで締切） ---
const TFT_AUCTION_MAX_LOTS = 4;             // 同時出品の上限
const TFT_AUCTION_DURATION = 4;             // 出品から締切までのターン数
const TFT_AUCTION_MIN_BID = 4;              // 入札が無いロットの最低入札額
const TFT_AUCTION_BID_STEP = 2;             // 現在の最高額からの最小上乗せ幅
const TFT_AUCTION_CPU_BID_CHANCE = 0.2;     // CPUがそのターンに入札を試みる確率
const TFT_AUCTION_CPU_MAX_GOLD_RATIO = 0.5; // CPUが1回の入札に使う上限（手持ちゴールドに対する割合）

// --- NPC商人の食料市場（全プレイヤー共有・在庫連動レート） ---
const TFT_MERCHANT_FOOD_BASELINE = 100; // 在庫の基準値（毎ターンここへ復元）
const TFT_MERCHANT_RESTOCK_STEP  = 10;  // 毎ターン基準へ近づく量（双方向）
const TFT_MERCHANT_TRADE_UNIT    = 10;  // 1取引の食料量
const TFT_MERCHANT_BASE_BUY      = 10;  // 在庫基準時の買値（食料10あたりG）
const TFT_MERCHANT_BASE_SELL     = 10;  // 在庫基準時の売値（食料10あたりG）＝買値と同額（スプレッドなし）
// 在庫が基準を下回る（希少）ほど係数が上がり買値・売値ともに上昇。0.5〜2.0でクランプ。
function tftMerchantPriceFactor(food) {
  const raw = TFT_MERCHANT_FOOD_BASELINE / Math.max(food, 1);
  return Math.min(2.0, Math.max(0.5, raw));
}
function tftMerchantBuyPrice(food)  { return Math.round(TFT_MERCHANT_BASE_BUY  * tftMerchantPriceFactor(food)); }
function tftMerchantSellPrice(food) { return Math.round(TFT_MERCHANT_BASE_SELL * tftMerchantPriceFactor(food)); }

// --- 軍事 ---
const TFT_ROSTER_MAX = 20;          // 保有ユニット上限
const TFT_GARRISON_MAX = 5;         // 1セル駐留上限（= MAX_TEAM_SIZE）
const TFT_FATIGUE_STEP = 0.10;      // 戦闘1回ごとの最大HP減少率
const TFT_FATIGUE_FLOOR = 0.30;     // 疲労による最大HPの下限割合

// --- ユニットのレベル（戦闘・訓練で成長。ランクとは独立した個体の成長軸） ---
// レベル倍率は全ステータス(HP/ATK/DEF/SPD)に一律で掛かり、シナジー・アイテムの上に乗算でスタックする
// （applyStatSynergies の base.statMul フック経由。ベース値のティア整合は保たれアイテム段上げと共存する）。
const TFT_LEVEL_MAX = 6;
const TFT_LEVEL_STAT_STEP = 0.08;   // 1レベルごとの全ステータス上昇率（Lv1=+0%, Lv6=+40%）
// Lv L→L+1 に必要なXP（index=現在レベル。強敵ほど多いXP設計と噛み合う上昇カーブ）。
const TFT_LEVEL_XP_TABLE = [0, 30, 50, 75, 105, 140];
const TFT_TRAIN_AP_COST = 2;        // 訓練1回のAP消費（金は不要。APが唯一の制約）

function tftLevelStatMultiplier(level) { return 1 + TFT_LEVEL_STAT_STEP * ((level || 1) - 1); }
// 現在レベルから次レベルへ必要なXP。最大レベルは Infinity（もう上がらない）。
function tftLevelXpNeeded(level) { return TFT_LEVEL_XP_TABLE[level] !== undefined ? TFT_LEVEL_XP_TABLE[level] : Infinity; }

// --- 空白地モンスター（中立セルへの侵攻で出現） ---
const TFT_MONSTER_LINEAGE_ID = 'goblin';
// ゲーム全体の経過ターンに応じて出現ランクが変わる（TFT_MAX_TURNS=50が目安）
const TFT_MONSTER_STAGES = [
  { untilTurn: 12, ranks: [1] },
  { untilTurn: 25, ranks: [1, 2] },
  { untilTurn: 37, ranks: [2, 3] },
  { untilTurn: 50, ranks: [3, 4] },
];
// 体数はターン経過とともに増える: 1T目=2体, 2T目=3体, 3T目=4体, 4T目以降=5体（駐留上限と同数）で頭打ち
const TFT_MONSTER_COUNT_BY_TURN = { 1: 2, 2: 3, 3: 4 };
const TFT_MONSTER_MAX_COUNT = 5;
function tftMonsterCountForTurn(turn) {
  return TFT_MONSTER_COUNT_BY_TURN[turn] || TFT_MONSTER_MAX_COUNT;
}
const TFT_MONSTER_FOOD_MULTIPLIER = 2; // 占領時の一時金 = 撃破モンスターの合計cost × この係数
// AIが中立地へ攻め込むのに必要な戦力の余裕（戦力コスト合計 ÷ tftMonsterThreatEstimate）。
// モンスター弱体化（同ランク+1相当）に合わせて再調整。旧1.2は「約2ランク強」時代の値で、
// 弱体化後は攻撃機会を過度に潰して拡張が止まっていた（30ターンで平均2.06セル＝ほぼ停滞）。
// 30ターンCPUシミュで掃引した結果 0.6 が最適点: 平均2.85セルまで拡張しつつロスターは4.6/5と健全。
// これ未満（0.5/0.4）は勝率の低い攻撃に突っ込んでユニットを失い始める（ロスターが3台に崩れる）。
const TFT_AI_MONSTER_FORCE_MARGIN = 0.6;

// --- 支持率（セルごとの0〜100。所有セルのみ意味を持つ） ---
// カツカツ経済と連動する自己均衡ループ: 食料難・連続侵攻で下がり、下がった領土は計略に弱くなる。
// 平時は BASELINE(70) へ双方向に収束する（tft-turn.js）。100は宣撫工作等で一時的にしか作れない。
const TFT_SUPPORT_BASELINE = 70;          // 平時の標準値。毎ターンここへ収束する
const TFT_SUPPORT_START = 70;             // 初期値（本拠地・脱落時の中立化リセットも同値）＝基準値
const TFT_SUPPORT_MAX = 100;              // ハードキャップ（宣撫工作・バックラッシュの加算上限）
const TFT_SUPPORT_REGEN = 5;              // 基準値までの毎ターン回復（食料不足だったプレイヤーのセルはそのターン回復なし）
const TFT_SUPPORT_DECAY = 3;              // 基準値を超えた分の毎ターン減衰（宣撫の+20が約7ターン持続）
const TFT_SUPPORT_INVADE_PENALTY = 3;     // 侵攻1回ごとに攻撃側の全所有セルが減少（厭戦）
const TFT_SUPPORT_SHORTAGE_PENALTY = 10;  // 食料不足ターンに全所有セルが減少
const TFT_SUPPORT_ON_CAPTURE = 40;        // 武力占領したセルの初期支持率
const TFT_SUPPORT_ON_AGITATE = 60;        // 扇動で寝返ったセル
const TFT_SUPPORT_ON_PACIFY = 70;         // 懐柔で獲得した中立地
const TFT_SUPPORT_FAIL_BACKLASH = 5;      // 引き抜き・扇動の失敗時に対象セルが上がる（陰謀の露見）
const TFT_SUPPORT_POACH_MAX = 50;         // 引き抜きの対象になる支持率上限
const TFT_SUPPORT_AGITATE_MAX = 30;       // 扇動の対象になる支持率上限

// --- 計略（一本鎖の研究 p.schemeLevel 0〜7 で段階解禁。射程は盤面全域） ---
// level はその計略が解禁される schemeLevel。ap は発動元セルから消費する行動力。
// schemeLevel 3 は「流言Lv2」（rumor の効果が -10 → -20 に強化されるアップグレード。スロット追加なし）。
const TFT_SCHEMES = [
  { id: 'rumor',      level: 1, name: '流言',           icon: '🗣️', ap: 3, chance: 1.0, target: 'enemy',
    desc: '敵領土の支持率を下げる' },
  { id: 'propaganda', level: 2, name: '宣撫工作',       icon: '📢', ap: 3, chance: 1.0, target: 'own',
    desc: '自領土の支持率を上げる' },
  { id: 'foodraid',   level: 4, name: '兵糧強奪',       icon: '🌾', ap: 4, chance: 1.0, target: 'enemy',
    desc: '対象領土の所有者から食料を奪う' },
  { id: 'poach',      level: 5, name: '戦士の引き抜き', icon: '🕵️', ap: 4, chance: 0.5, target: 'enemy',
    desc: `支持率${TFT_SUPPORT_POACH_MAX}以下の敵領土から駐留ユニット1体を自軍へ` },
  { id: 'pacify',     level: 6, name: '懐柔',           icon: '🤝', ap: 4, chance: 0.6, target: 'neutral',
    desc: '中立地を戦わずに自国領土にする（戦利品なし）' },
  { id: 'agitate',    level: 7, name: '扇動',           icon: '🔥', ap: 5, chance: 0.3, target: 'enemy',
    desc: `支持率${TFT_SUPPORT_AGITATE_MAX}以下の敵領土を自国領土にする（本拠地は不可）` },
];
const TFT_SCHEME_RESEARCH_COST = [8, 10, 12, 16, 20, 24, 30];   // schemeLevel 1..7 への解禁コスト
const TFT_SCHEME_RESEARCH_DURATION = [3, 3, 3, 4, 4, 4, 5];     // 同・着工ターン数
const TFT_SCHEME_LEVEL_LABELS = ['流言', '宣撫工作', '流言Lv2', '兵糧強奪', '戦士の引き抜き', '懐柔', '扇動'];
const TFT_SCHEME_MAX_LEVEL = TFT_SCHEME_LEVEL_LABELS.length; // 7
const TFT_RUMOR_VALUE = 10;               // 流言の支持率低下量（schemeLevel>=3 で2倍の20）
const TFT_PROPAGANDA_VALUE = 20;          // 宣撫工作の支持率上昇量
const TFT_FOODRAID_AMOUNT = 8;            // 兵糧強奪の最大奪取量
function tftSchemeById(id) { return TFT_SCHEMES.find(s => s.id === id); }
function tftRumorValue(schemeLevel) { return schemeLevel >= 3 ? TFT_RUMOR_VALUE * 2 : TFT_RUMOR_VALUE; }

// --- 研究（系統ごとのランク解禁。着工制・R2〜R7の6段階） ---
const TFT_RESEARCH_COST = [6, 10, 14, 20, 26, 34];  // →R2,→R3,…,→R7 の解禁コスト
const TFT_RESEARCH_DURATION = [3, 4, 4, 5, 5, 6];   // 同・着工にかかるターン数
const TFT_MAX_RESEARCHABLE_RANK = 7;   // 研究で届くのはR7まで（R8=ヒーローは別枠）
const TFT_LINEAGE_IDS = ['warrior', 'mage', 'rogue', 'archer', 'monk'];

// --- ヘックス隣接（可変幅パッキングの接続規則） ---
// 同一行内は seat±1。上下の行は幅違い（長い行⇄短い行）で必ず接続する。
//   長い行(6)→短い行(5): 隣接seatは [seat-1, seat]（境界はクリップ）
//   短い行(5)→長い行(6): 隣接seatは [seat, seat+1]（常に両方存在）
function tftNeighbors(idx) {
  const row = tftRowOf(idx), seat = tftSeatOf(idx);
  const out = [];
  if (seat > 0) out.push(tftIdx(row, seat - 1));
  if (seat < TFT_ROW_LENGTHS[row] - 1) out.push(tftIdx(row, seat + 1));
  const isThisLong = TFT_ROW_LENGTHS[row] === 6;
  for (const nr of [row - 1, row + 1]) {
    if (nr < 0 || nr >= TFT_NUM_ROWS) continue;
    const seats = isThisLong ? [seat - 1, seat] : [seat, seat + 1];
    for (const s of seats) if (s >= 0 && s < TFT_ROW_LENGTHS[nr]) out.push(tftIdx(nr, s));
  }
  return out;
}

function tftIsAdjacent(a, b) { return tftNeighbors(a).includes(b); }

// --- ヘックス幾何（描画・SVG矢印の座標計算用）---
const TFT_HEX_W = 92;                           // ヘックス幅(px)。臨場感重視でマス数はそのまま表示を拡大。
const TFT_HEX_H = TFT_HEX_W * 2 / Math.sqrt(3); // 高さ ≈69.3（pointy-top）

// セル中心のピクセル座標。短い行は長い行に対し半マス右にシフトして中央に挟まる。
function tftHexCenter(idx) {
  const row = tftRowOf(idx), seat = tftSeatOf(idx);
  const isShort = TFT_ROW_LENGTHS[row] === 5;
  const x = seat * TFT_HEX_W + (isShort ? TFT_HEX_W : TFT_HEX_W / 2);
  const y = row * (TFT_HEX_H * 0.75) + TFT_HEX_H / 2;
  return { x, y };
}

// 盤面全体のピクセルサイズ（コンテナ・SVG viewBox 用）
function tftHexBoardSize() {
  return {
    w: TFT_HEX_W * 6.5,
    h: TFT_HEX_H * 0.75 * (TFT_NUM_ROWS - 1) + TFT_HEX_H,
  };
}

// 疲労を反映した実効最大HP
function tftEffectiveHp(unit) {
  const ratio = Math.max(TFT_FATIGUE_FLOOR, 1 - TFT_FATIGUE_STEP * (unit.fatigue || 0));
  return Math.max(1, Math.floor(unit.hp * ratio));
}

// --- MP要素 ---
// スキル発動にはMPを1消費する（js/battle.jsのhasMp/spendMpが共通で判定）。ランクごとの最大MPで発動回数の上限を作る。
// TFTBS側は js/data.js の MP_BY_RANK/unitMaxMp() が同じ考え方・同じ値で独立定義されている
// （TFTはロスターがバトルを跨いで永続するためこの専用テーブルを維持し、値だけ揃えている）。
// バトルは tftPrepTeam が毎回ベースコピーを作り直すため、MPは自動的に「バトル終了で全回復」する
// （ロスター本体にはMPを書き戻さないため、次のバトルはこのtftMaxMpから毎回作り直される）。
// 8ランク化。旧remap済ランクの旧値を維持（旧R2=新R4=3, 旧R3=新R6=4, 旧R4=新R8=5）。
// ゴブリン(rank1-4)もこの表を参照する。
const TFT_MP_BY_RANK = { 1: 0, 2: 0, 3: 3, 4: 3, 5: 4, 6: 4, 7: 5, 8: 5 };
function tftMaxMp(unit) {
  return unit.skill ? (TFT_MP_BY_RANK[unit.rank] || 0) : 0;
}
