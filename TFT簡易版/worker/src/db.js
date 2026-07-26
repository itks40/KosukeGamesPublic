// D1クエリのヘルパ。games/players テーブル（ルーム・認証台帳）へのアクセスをここに集約する。
// ゲーム本体のstate（盤面等）はここでは扱わない（Durable Object storage側の責務）。

export async function createGame(db, { id, roomCode, turnMs }) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO games (id, room_code, turn_ms, status, created_at) VALUES (?, ?, ?, 'lobby', ?)`
  ).bind(id, roomCode, turnMs, now).run();
}

export async function getGameByCode(db, roomCode) {
  return db.prepare(`SELECT * FROM games WHERE room_code = ?`).bind(roomCode).first();
}

export async function getGameById(db, id) {
  return db.prepare(`SELECT * FROM games WHERE id = ?`).bind(id).first();
}

export async function setGameStatus(db, id, status) {
  await db.prepare(`UPDATE games SET status = ? WHERE id = ?`).bind(status, id).run();
}

export async function updateGameTurnBoundary(db, id, turnBoundaryAt) {
  await db.prepare(`UPDATE games SET turn_boundary_at = ? WHERE id = ?`).bind(turnBoundaryAt, id).run();
}

export async function listPlayers(db, gameId) {
  const { results } = await db.prepare(
    `SELECT id, slot_index, display_name FROM players WHERE game_id = ? ORDER BY slot_index`
  ).bind(gameId).all();
  return results;
}

export async function addPlayer(db, { id, gameId, slotIndex, displayName, tokenHash }) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO players (id, game_id, slot_index, display_name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, gameId, slotIndex, displayName, tokenHash, now).run();
}

// トークンのハッシュから本人（gameId・slotIndex）を逆引きする。他人のplayerIdを騙れないための要。
export async function findPlayerByTokenHash(db, gameId, tokenHash) {
  return db.prepare(
    `SELECT * FROM players WHERE game_id = ? AND token_hash = ?`
  ).bind(gameId, tokenHash).first();
}

// 満員でない最小のスロット番号を返す（0-3）。満員なら null。
export async function findOpenSlot(db, gameId, maxSlots) {
  const taken = await listPlayers(db, gameId);
  const takenSet = new Set(taken.map((p) => p.slot_index));
  for (let i = 0; i < maxSlots; i++) if (!takenSet.has(i)) return i;
  return null;
}

// 安全網Cron用: ターン境界を超過しているのに live のままのゲームIDを列挙する。
export async function listOverdueLiveGames(db, now) {
  const { results } = await db.prepare(
    `SELECT id FROM games WHERE status = 'live' AND turn_boundary_at IS NOT NULL AND turn_boundary_at <= ?`
  ).bind(now).all();
  return results.map((r) => r.id);
}
