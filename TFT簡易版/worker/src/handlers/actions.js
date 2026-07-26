// アクション実行・state取得。トークン認証を通してから Durable Object へ中継する。

import { extractBearerToken, hashToken } from '../auth.js';
import { getGameById, findPlayerByTokenHash } from '../db.js';

function getRoomStub(env, gameId) {
  const id = env.TFT_GAME_ROOM.idFromName(gameId);
  return env.TFT_GAME_ROOM.get(id);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// トークンを検証し、本人の slot_index（＝ state.players 配列のid）を返す。
// サーバーはこの値だけを信頼する――クライアントが送ってきた playerId は一切信用しない
// （他人になりすまして操作されることを防ぐ）。
async function authenticate(request, env, gameId) {
  const token = extractBearerToken(request);
  if (!token) return { ok: false, reason: '認証トークンがありません' };
  const game = await getGameById(env.DB, gameId);
  if (!game) return { ok: false, reason: 'ゲームが見つかりません' };
  const tokenHash = await hashToken(token);
  const player = await findPlayerByTokenHash(env.DB, gameId, tokenHash);
  if (!player) return { ok: false, reason: '認証に失敗しました' };
  return { ok: true, slotIndex: player.slot_index };
}

export async function applyAction(request, env, gameId, type) {
  const auth = await authenticate(request, env, gameId);
  if (!auth.ok) return json({ ok: false, reason: auth.reason }, 401);

  const body = await request.json().catch(() => ({}));
  const stub = getRoomStub(env, gameId);
  const res = await stub.fetch('https://do/internal/action', {
    method: 'POST',
    body: JSON.stringify({ playerId: auth.slotIndex, type, args: body }),
  });
  const data = await res.json();
  return json(data, res.status);
}

export async function getGameState(request, env, gameId) {
  const auth = await authenticate(request, env, gameId);
  if (!auth.ok) return json({ ok: false, reason: auth.reason }, 401);

  const stub = getRoomStub(env, gameId);
  const res = await stub.fetch('https://do/internal/state');
  const data = await res.json();
  return json(data, res.status);
}
