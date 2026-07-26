// TFTオンライン対戦API（Cloudflare Worker）。
// 静的サイト（tft/index.html等）とは完全に独立したエントリーポイント。
// ルーティングは手書きの小さな表で足りる規模（エンドポイント数が少ないため外部ルーターは導入しない）。

import { createRoom, getRoomInfo, joinRoom, startGame } from './handlers/rooms.js';
import { applyAction, getGameState } from './handlers/actions.js';
import { listOverdueLiveGames } from './db.js';

export { TftGameRoom } from './game-room.js';

// ALLOWED_ORIGINはカンマ区切りで複数指定できる（同じゲームを複数サイトから配信するため）。
// Access-Control-Allow-Originは単一値しか返せないので、リクエストのOriginを見て許可分だけ返す。
function corsHeaders(env, request) {
  const allowList = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request ? request.headers.get('Origin') : null;
  // 未設定なら従来どおり全許可。許可リスト外のOriginには先頭の許可オリジンを返し、ブラウザ側で弾かせる。
  const allowOrigin = allowList.length === 0
    ? '*'
    : (origin && allowList.includes(origin) ? origin : allowList[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    // 応答がOriginごとに変わるため、CDN・ブラウザが別オリジンの応答を使い回さないようにする。
    Vary: 'Origin',
  };
}

function json(data, init = {}, cors = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...cors, ...(init.headers || {}) },
  });
}

// handlers/ 配下の関数はCORSヘッダを知らない（責務外）ので、ここでまとめて付与する。
async function withCors(responsePromise, cors) {
  const res = await responsePromise;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/api/health') {
      return json({ ok: true, service: 'tft-online-api' }, {}, cors);
    }

    if (method === 'POST' && path === '/api/rooms') {
      return withCors(createRoom(request, env), cors);
    }

    let m;
    if (method === 'GET' && (m = /^\/api\/rooms\/([^/]+)$/.exec(path))) {
      return withCors(getRoomInfo(request, env, m[1]), cors);
    }
    if (method === 'POST' && (m = /^\/api\/rooms\/([^/]+)\/join$/.exec(path))) {
      return withCors(joinRoom(request, env, m[1]), cors);
    }
    if (method === 'POST' && (m = /^\/api\/games\/([^/]+)\/start$/.exec(path))) {
      return withCors(startGame(request, env, m[1]), cors);
    }
    if (method === 'GET' && (m = /^\/api\/games\/([^/]+)\/state$/.exec(path))) {
      return withCors(getGameState(request, env, m[1]), cors);
    }
    if (method === 'POST' && (m = /^\/api\/games\/([^/]+)\/actions\/([^/]+)$/.exec(path))) {
      return withCors(applyAction(request, env, m[1], m[2]), cors);
    }

    return json({ ok: false, reason: 'not found' }, { status: 404 }, cors);
  },

  // 安全網Cron（30分おき）。DO Alarmの取りこぼしに備え、ターン境界を超過した'live'ゲームを
  // D1でスキャンし、該当DOへ強制チェックを送る（AlarmのAt-least-once保証の取りこぼし対策）。
  async scheduled(event, env, ctx) {
    const overdueIds = await listOverdueLiveGames(env.DB, Date.now());
    await Promise.all(overdueIds.map(async (gameId) => {
      const id = env.TFT_GAME_ROOM.idFromName(gameId);
      const stub = env.TFT_GAME_ROOM.get(id);
      await stub.fetch('https://do/internal/check-turn-boundary', { method: 'POST' });
    }));
  },
};
