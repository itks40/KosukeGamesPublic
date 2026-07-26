// Web Audio API による効果音の合成（音声ファイル不要）。
// 各効果音はオシレータ＋ゲインのエンベロープでその場生成する。
const SoundFX = (() => {
  let ctx = null;
  let enabled = (localStorage.getItem('tft_sound') ?? 'on') === 'on';

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  // ユーザー操作後に呼ぶ（自動再生制約の解除）
  function resume() {
    const c = ensureCtx();
    if (c && c.state === 'suspended') c.resume();
  }

  function isEnabled() { return enabled; }

  function setEnabled(v) {
    enabled = v;
    localStorage.setItem('tft_sound', v ? 'on' : 'off');
    if (v) resume();
  }

  function toggle() {
    setEnabled(!enabled);
    return enabled;
  }

  // 基本トーン: 周波数を start→end へスイープしつつ減衰
  function tone({ type = 'sine', start, end = start, dur = 0.15, gain = 0.2, delay = 0 }) {
    const c = ensureCtx();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(start, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(end, 1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // ノイズバースト（打撃のアタック感）
  function noise({ dur = 0.08, gain = 0.18, delay = 0, lowpass = 2200 }) {
    const c = ensureCtx();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const frames = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = c.createBufferSource();
    src.buffer = buf;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp).connect(g).connect(c.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // --- 効果音プリセット ---
  const fx = {
    // 打撃: ノイズ＋低音の一撃。ダメージ量で少し音を強く
    hit(damage = 10) {
      if (!enabled) return;
      const power = Math.min(1, damage / 40);
      noise({ dur: 0.06 + power * 0.04, gain: 0.12 + power * 0.12, lowpass: 1800 + power * 1800 });
      tone({ type: 'square', start: 160 - power * 40, end: 70, dur: 0.1, gain: 0.12 + power * 0.1 });
    },
    // 撃破: 下降スイープ＋ノイズで「やられた」感
    defeat() {
      if (!enabled) return;
      noise({ dur: 0.18, gain: 0.2, lowpass: 1200 });
      tone({ type: 'sawtooth', start: 320, end: 60, dur: 0.32, gain: 0.22 });
    },
    // 回復: 柔らかい上昇トーン
    heal() {
      if (!enabled) return;
      tone({ type: 'sine', start: 520, end: 780, dur: 0.18, gain: 0.13 });
      tone({ type: 'sine', start: 780, end: 980, dur: 0.16, gain: 0.08, delay: 0.06 });
    },
    // スキル発動: きらめく上昇チャイム（全スキル共通の合図音）
    skill() {
      if (!enabled) return;
      tone({ type: 'triangle', start: 700, end: 1100, dur: 0.12, gain: 0.17 });
      tone({ type: 'triangle', start: 1100, end: 1500, dur: 0.1, gain: 0.13, delay: 0.07 });
    },
    // 覚醒: 歪んだ低音の唸り
    berserk() {
      if (!enabled) return;
      tone({ type: 'sawtooth', start: 90, end: 200, dur: 0.35, gain: 0.2 });
      tone({ type: 'square', start: 60, end: 120, dur: 0.35, gain: 0.12 });
    },
    // 勝利: 明るいアルペジオのファンファーレ
    win() {
      if (!enabled) return;
      const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
      notes.forEach((f, i) => tone({ type: 'triangle', start: f, dur: 0.22, gain: 0.18, delay: i * 0.11 }));
    },
    // 敗北: 沈む下降音
    lose() {
      if (!enabled) return;
      const notes = [440, 370, 294, 220]; // A4 → A3 方向
      notes.forEach((f, i) => tone({ type: 'triangle', start: f, dur: 0.3, gain: 0.16, delay: i * 0.13 }));
    },
    // 引き分け: 中立的な2音
    draw() {
      if (!enabled) return;
      tone({ type: 'triangle', start: 440, dur: 0.25, gain: 0.14 });
      tone({ type: 'triangle', start: 440, dur: 0.3, gain: 0.12, delay: 0.18 });
    },
  };

  return { resume, isEnabled, setEnabled, toggle, fx };
})();
