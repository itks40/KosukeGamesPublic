// トークン生成・ハッシュ化・ルームコード生成。
// Cloudflare WorkersはWeb標準の crypto.subtle / crypto.randomUUID / crypto.getRandomValues を
// そのまま持っているので追加ライブラリは不要。

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい 0/O/1/I を除外

export function generateRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (const b of bytes) code += ROOM_CODE_CHARS[b % ROOM_CODE_CHARS.length];
  return code;
}

export function generateToken() {
  // 32byte(256bit)のランダムトークンをhex文字列にする
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newId() {
  return crypto.randomUUID();
}

// Authorization: Bearer <token> ヘッダからトークンを取り出す。無ければ null。
export function extractBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? m[1] : null;
}
