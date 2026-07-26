// ルーム作成・ロビー情報取得・参加。
// ゲーム本体のstate操作はすべて Durable Object "TftGameRoom" 経由（このファイルはD1台帳の管理と
// DOへのRPC中継のみを担当する）。

import * as GameLogic from '../generated/game-logic.js';
import { generateRoomCode, generateToken, hashToken, newId } from '../auth.js';
import { createGame, getGameByCode, getGameById, addPlayer, listPlayers, findOpenSlot, setGameStatus } from '../db.js';

function getRoomStub(env, gameId) {
  const id = env.TFT_GAME_ROOM.idFromName(gameId);
  return env.TFT_GAME_ROOM.get(id);
}

export async function createRoom(request, env) {
  const body = await request.json().catch(() => ({}));
  const hostDisplayName = (body.hostDisplayName || '').trim().slice(0, 24) || 'ホスト';
  const preset = GameLogic.TFT_TURN_PRESETS.find((p) => p.id === body.turnPresetId) || GameLogic.TFT_TURN_PRESETS[0];

  const gameId = newId();
  const roomCode = generateRoomCode();
  await createGame(env.DB, { id: gameId, roomCode, turnMs: preset.ms });
  // 注意: この時点ではDurable Object側にまだ tftCreateState を呼ばない。
  // tftCreateState は「誰が human/off か」を生成時に一括で確定する設計（本拠地割当・初期ロスター等）
  // なので、参加者が全員揃った startGame の時点まで遅らせる必要がある
  // （ここで先に呼ぶと、後から参加したプレイヤーがDO内ではeliminated扱いのまま残ってしまう）。

  // ホストをスロット0で自動join
  const playerId = newId();
  const token = generateToken();
  await addPlayer(env.DB, {
    id: playerId, gameId, slotIndex: 0, displayName: hostDisplayName, tokenHash: await hashToken(token),
  });

  return json({ ok: true, gameId, roomCode, playerId, token, slotIndex: 0 });
}

export async function getRoomInfo(request, env, roomCode) {
  const game = await getGameByCode(env.DB, roomCode);
  if (!game) return json({ ok: false, reason: 'ルームが見つかりません' }, 404);
  const players = await listPlayers(env.DB, game.id);
  return json({
    ok: true,
    gameId: game.id,
    roomCode: game.room_code,
    status: game.status,
    turnMs: game.turn_ms,
    maxSlots: GameLogic.TFT_NUM_PLAYER_SLOTS,
    players: players.map((p) => ({ slotIndex: p.slot_index, displayName: p.display_name })),
  });
}

export async function joinRoom(request, env, roomCode) {
  const game = await getGameByCode(env.DB, roomCode);
  if (!game) return json({ ok: false, reason: 'ルームが見つかりません' }, 404);
  if (game.status !== 'lobby') return json({ ok: false, reason: 'このルームは既に開始しています（途中参加は非対応）' }, 409);

  const body = await request.json().catch(() => ({}));
  const displayName = (body.displayName || '').trim().slice(0, 24) || 'プレイヤー';

  const slotIndex = await findOpenSlot(env.DB, game.id, GameLogic.TFT_NUM_PLAYER_SLOTS);
  if (slotIndex === null) return json({ ok: false, reason: '満員です' }, 409);

  const playerId = newId();
  const token = generateToken();
  await addPlayer(env.DB, {
    id: playerId, gameId: game.id, slotIndex, displayName, tokenHash: await hashToken(token),
  });

  return json({ ok: true, gameId: game.id, roomCode: game.room_code, playerId, token, slotIndex });
}

export async function startGame(request, env, gameId) {
  const game = await getGameById(env.DB, gameId);
  if (!game) return json({ ok: false, reason: 'ゲームが見つかりません' }, 404);
  if (game.status !== 'lobby') return json({ ok: false, reason: '既に開始しています' }, 409);

  const players = await listPlayers(env.DB, gameId);
  if (players.length < 1) return json({ ok: false, reason: '参加者がいません' }, 409);

  // 実際にD1へjoin済みのスロットだけ'human'、それ以外は'off'。ここで初めて tftCreateState を呼ぶ
  // （本拠地割当・初期ロスター生成は一度きりなので、全員揃ってから確定させる）。
  const joinedSlots = new Set(players.map((p) => p.slot_index));
  const slots = new Array(GameLogic.TFT_NUM_PLAYER_SLOTS).fill('off');
  for (const idx of joinedSlots) slots[idx] = 'human';

  const stub = getRoomStub(env, gameId);
  const createRes = await stub.fetch('https://do/internal/create', {
    method: 'POST',
    body: JSON.stringify({ slots, turnMs: game.turn_ms, gameId }),
  });
  if (!createRes.ok) return errorResponse(createRes);

  const startRes = await stub.fetch('https://do/internal/start', { method: 'POST' });
  if (!startRes.ok) return errorResponse(startRes);

  await setGameStatus(env.DB, gameId, 'live');
  const data = await startRes.json();
  return json({ ok: true, state: data.state, joinedPlayers: players.length });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function errorResponse(res) {
  const data = await res.json().catch(() => ({ reason: 'internal error' }));
  return json({ ok: false, reason: data.reason || 'internal error' }, res.status);
}
