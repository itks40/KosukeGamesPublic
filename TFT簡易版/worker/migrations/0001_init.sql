-- TFTオンライン対戦: ルーム・認証台帳。
-- ゲーム本体の state（盤面・プレイヤー・ロスター等）は Durable Object storage 側に持つため、
-- ここには「ルームコードからゲームを引く」「トークンから本人を引く」ための最小限の情報のみを置く。

CREATE TABLE games (
  id               TEXT PRIMARY KEY,              -- UUID。Durable Objectの idFromName(id) にそのまま使う
  room_code        TEXT NOT NULL UNIQUE,           -- 招待用の6桁英数字コード
  turn_ms          INTEGER NOT NULL,               -- TFT_TURN_PRESETS のms値
  status           TEXT NOT NULL DEFAULT 'lobby',  -- 'lobby' | 'live' | 'over'（DO側 state.phase の複製・一覧表示用）
  turn_boundary_at INTEGER,                        -- state.turnBoundaryAt の複製（安全網cronのスキャン用）
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_games_status_boundary ON games(status, turn_boundary_at);

CREATE TABLE players (
  id            TEXT PRIMARY KEY,                  -- UUID
  game_id       TEXT NOT NULL REFERENCES games(id),
  slot_index    INTEGER NOT NULL,                  -- 0-3。state.players[slot_index].id と一致
  display_name  TEXT NOT NULL,
  token_hash    TEXT NOT NULL,                      -- SHA-256(bearer token) hex。生トークンは保存しない
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  UNIQUE(game_id, slot_index)
);

CREATE INDEX idx_players_lookup ON players(game_id, token_hash);
