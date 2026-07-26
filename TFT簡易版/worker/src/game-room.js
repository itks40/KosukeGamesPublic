// Durable Object "TftGameRoom": ゲーム1つ=1インスタンス。
// 同一インスタンスへのリクエストはCloudflareのInput/Output Gateにより実質1件ずつ順次処理されるため、
// 複数プレイヤーの同時アクションが自然に直列化される（乱数同期問題が発生しない設計の要）。
//
// 公開API（Worker本体・handlers/経由でのみ叩かれる内部エンドポイント。外部に直接は公開しない）:
//   POST /internal/create { slots, turnMs }        ゲーム初期化（tftCreateState）
//   POST /internal/start                            ゲーム開始（phase→live、初回tftRunTurnBoundary、Alarm予約）
//   POST /internal/action { playerId, type, args }   アクション実行（ACTION_TABLE経由）
//   GET  /internal/state                             現在のstate全体を返す

import * as GameLogic from './generated/game-logic.js';
import { ACTION_TABLE } from './action-table.js';
import { updateGameTurnBoundary, setGameStatus } from './db.js';

// tft-battle-view.js（ブラウザ専用UI）が提供するはずのフックをサーバー環境向けにスタブする。
// 両方とも副作用のみ（戻り値は使われない）なので no-op で安全。
globalThis.tftToast = () => {};
globalThis.tftOnBattleResolved = () => {};

export class TftGameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.game = null;
    this.gameId = null; // D1台帳（games行）を更新するために自分のゲームIDを覚えておく
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.game = (await ctx.storage.get('game')) ?? null;
      this.gameId = (await ctx.storage.get('gameId')) ?? null;
      // DOのコールドスタートでモジュールレベルの tftUidCounter/tftAuctionLotCounter が
      // 0にリセットされている。永続化済みstateから最大値を復元してから以降のリクエストを処理する
      // （「発見した罠1」対応。復元しないと新規生成ユニットのuidが既存ユニットと衝突する）。
      if (this.game) GameLogic.tftRehydrateCounters(this.game);
    });
  }

  async persist() {
    await this.ctx.storage.put('game', this.game);
  }

  // D1台帳（games行）を実際のゲーム状況に追従させる。
  // turn_boundary_at は安全網Cron（index.js の scheduled）が「Alarmを取りこぼしたゲーム」を
  // 探すための唯一の手がかりなので、ここで書かないと安全網が永久に何も拾わない。
  // D1書き込みの失敗でゲーム進行そのものを止めたくないので、例外は握りつぶしてログだけ残す。
  async syncLedger() {
    if (!this.gameId || !this.env.DB || !this.game) return;
    try {
      await updateGameTurnBoundary(this.env.DB, this.gameId, this.game.turnBoundaryAt);
      if (this.game.phase === 'over') await setGameStatus(this.env.DB, this.gameId, 'over');
    } catch (err) {
      console.error('[TftGameRoom] D1台帳の同期に失敗', err);
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/internal/create') {
        return this.handleCreate(await request.json());
      }
      if (request.method === 'POST' && url.pathname === '/internal/start') {
        return this.handleStart();
      }
      if (request.method === 'POST' && url.pathname === '/internal/action') {
        return this.handleAction(await request.json());
      }
      if (request.method === 'GET' && url.pathname === '/internal/state') {
        return this.handleGetState();
      }
      if (request.method === 'POST' && url.pathname === '/internal/check-turn-boundary') {
        return this.handleCheckTurnBoundary();
      }
      return new Response(JSON.stringify({ ok: false, reason: 'not found' }), { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, reason: String(err && err.message || err) }), { status: 500 });
    }
  }

  async handleCreate({ slots, turnMs, gameId }) {
    if (this.game) {
      return new Response(JSON.stringify({ ok: false, reason: 'already created' }), { status: 409 });
    }
    this.game = GameLogic.tftCreateState(slots, turnMs);
    this.game.phase = 'lobby';
    if (gameId) {
      this.gameId = gameId;
      await this.ctx.storage.put('gameId', gameId);
    }
    await this.persist();
    return new Response(JSON.stringify({ ok: true, state: this.game }));
  }

  async handleStart() {
    if (!this.game) return new Response(JSON.stringify({ ok: false, reason: 'not created' }), { status: 404 });
    if (this.game.phase !== 'lobby') {
      return new Response(JSON.stringify({ ok: false, reason: 'already started' }), { status: 409 });
    }
    this.game.phase = 'live';
    GameLogic.tftRunTurnBoundary(this.game); // ターン1の経済処理・CPU行動（tftStartGame相当）
    await this.persist();
    if (this.game.phase === 'live') await this.ctx.storage.setAlarm(this.game.turnBoundaryAt);
    await this.syncLedger();
    return new Response(JSON.stringify({ ok: true, state: this.game }));
  }

  async handleAction({ playerId, type, args }) {
    if (!this.game) return new Response(JSON.stringify({ ok: false, reason: 'not created' }), { status: 404 });
    if (this.game.phase !== 'live') {
      return new Response(JSON.stringify({ ok: false, reason: 'game is not live' }), { status: 409 });
    }
    const handler = ACTION_TABLE[type];
    if (!handler) return new Response(JSON.stringify({ ok: false, reason: `unknown action type: ${type}` }), { status: 400 });
    const result = handler(GameLogic, this.game, playerId, args || {});
    await this.persist();
    // 侵攻でラスボスを倒した等、アクション1回で決着することがある。その場合だけ台帳を更新して
    // 安全網Cronのスキャン対象から外す（毎アクションでD1に書くのは無駄なのでover時のみ）。
    if (this.game.phase === 'over') await this.syncLedger();
    return new Response(JSON.stringify({ ok: true, result, state: this.game }));
  }

  async handleGetState() {
    if (!this.game) return new Response(JSON.stringify({ ok: false, reason: 'not created' }), { status: 404 });
    return new Response(JSON.stringify({ ok: true, state: this.game }));
  }

  // 安全網Cron（scheduled）から呼ばれる。Alarmの取りこぼしに備え、ターン境界超過なら強制的に進める。
  async handleCheckTurnBoundary() {
    if (this.game && this.game.phase === 'live' && Date.now() >= this.game.turnBoundaryAt) {
      await this.alarm();
    }
    return new Response(JSON.stringify({ ok: true }));
  }

  // Durable Object Alarm: 次のターン境界で自動発火する（誰もタブを開いていなくてもターンが進む）。
  async alarm() {
    if (!this.game || this.game.phase !== 'live') return;
    if (Date.now() < this.game.turnBoundaryAt) {
      // 早すぎる発火（稀）は再予約するだけ
      await this.ctx.storage.setAlarm(this.game.turnBoundaryAt);
      return;
    }
    this.game.turn++;
    GameLogic.tftRunTurnBoundary(this.game);
    await this.persist();
    if (this.game.phase === 'live') await this.ctx.storage.setAlarm(this.game.turnBoundaryAt);
    await this.syncLedger();
  }
}
