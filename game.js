/* 虚無ビート — シュール・ワンボタンリズムゲーム
 *
 * - BGMはWebAudioでリアルタイム合成(キック/ハット/スネア/ベース/リード)
 * - ゲーム時刻は performance.now() 基準。音は AudioContext 時刻へ都度換算して
 *   先読みスケジューリングする(AudioContextが動かない環境でも進行は破綻しない)
 * - 判定: |Δt| ≤ 0.09s → 悟り(300+コンボボーナス) / ≤ 0.18s → 概念(100) / 遅延 → 無
 *   ノーツが無い所でタップ → 素振り(コンボが虚無に還る)
 */
(() => {
  const $ = (id) => document.getElementById(id);

  // ---- 定数 ----
  const PERFECT_WIN = 0.09;
  const GOOD_WIN = 0.18;
  const LEAD_TIME = 1.7;            // ノーツが画面に現れてから判定円まで(秒)
  const EMOJIS = ["🗿", "🥒", "🍞", "🦆", "🫠", "🐟", "🧻", "🍄"];
  const QUOTES = [
    "なぜ 叩くのか",
    "豆腐は 急がない",
    "きゅうりに 罪はない",
    "モアイも 昔は 石だった",
    "無とは タップの 隙間である",
    "食パンは 落ちる時 バター面を選ぶ",
    "アヒルは すべてを 知っている",
    "君が円を見る時 円もまた 君を見ている",
  ];
  const SEGMENTS = [                 // テンポマップ(合計 112拍 ≒ 60秒)
    { bpm: 95, beats: 32 },
    { bpm: 110, beats: 32 },
    { bpm: 125, beats: 32 },
    { bpm: 140, beats: 16 },
  ];
  const PENTA = [0, 3, 5, 7, 10];    // マイナーペンタトニック

  // ---- 状態 ----
  const S = {
    phase: "title",                  // title | play | result
    notes: [],                       // {time, emoji, judged, result}
    beats: [],                       // {time, index} BGM用の拍グリッド
    startTime: 0,                    // ゲーム時刻(performance秒)での開始点
    score: 0, combo: 0, maxCombo: 0,
    counts: { perfect: 0, good: 0, miss: 0, whiff: 0 },
    scheduled: 0,                    // 音のスケジュール済み拍index
    endTime: 0,
    floats: [],                      // 浮かぶ判定テキスト {text,color,x,y,born}
    lastBeatTime: 0,
    quoteIdx: 0,
    running: false,
  };

  let AC = null;
  let acOffset = 0;                  // AC.currentTime - gameNow() の差

  const nowSec = () => performance.now() / 1000;
  const gameNow = () => nowSec() - S.startTime;

  // ---- 譜面とビートの生成 ----
  function buildChart() {
    S.notes = [];
    S.beats = [];
    let t = 2.0;                     // 2秒の予備動作
    let index = 0;
    SEGMENTS.forEach((seg, si) => {
      const step = 60 / seg.bpm;
      for (let b = 0; b < seg.beats; b++) {
        S.beats.push({ time: t, index });
        const inIntro = index < 4;   // 最初の4拍はノーツ無し(音だけ)
        if (!inIntro && Math.random() > 0.15) {
          S.notes.push(makeNote(t));
        }
        // 後半ほど裏拍が増えて忙しくなる
        const offbeatProb = [0.05, 0.15, 0.28, 0.4][si];
        if (!inIntro && Math.random() < offbeatProb) {
          S.notes.push(makeNote(t + step / 2));
        }
        t += step;
        index++;
      }
    });
    S.notes.sort((a, b) => a.time - b.time);
    S.endTime = t + 1.5;
  }

  function makeNote(time) {
    return {
      time,
      emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
      judged: false,
      result: null,
    };
  }

  // ---- サウンド合成 ----
  function ac() {
    if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
    return AC;
  }
  function acTime(gameT) {
    return gameT + acOffset;
  }
  function env(g, t, peak, dur) {
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  }
  function kick(t) {
    const o = AC.createOscillator(), g = AC.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.11);
    env(g, t, 0.9, 0.13);
    o.connect(g).connect(AC.destination);
    o.start(t); o.stop(t + 0.15);
  }
  function noiseBuf() {
    if (noiseBuf.b) return noiseBuf.b;
    const b = AC.createBuffer(1, AC.sampleRate * 0.2, AC.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return (noiseBuf.b = b);
  }
  function hat(t) {
    const s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
    s.buffer = noiseBuf();
    f.type = "highpass"; f.frequency.value = 7000;
    env(g, t, 0.18, 0.04);
    s.connect(f).connect(g).connect(AC.destination);
    s.start(t); s.stop(t + 0.05);
  }
  function snare(t) {
    const s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
    s.buffer = noiseBuf();
    f.type = "bandpass"; f.frequency.value = 1800;
    env(g, t, 0.4, 0.12);
    s.connect(f).connect(g).connect(AC.destination);
    s.start(t); s.stop(t + 0.13);
  }
  function bass(t, semi) {
    const o = AC.createOscillator(), f = AC.createBiquadFilter(), g = AC.createGain();
    o.type = "sawtooth";
    o.frequency.value = 55 * Math.pow(2, semi / 12);
    f.type = "lowpass"; f.frequency.value = 320;
    env(g, t, 0.3, 0.22);
    o.connect(f).connect(g).connect(AC.destination);
    o.start(t); o.stop(t + 0.24);
  }
  function blip(t, semi) {
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = "square";
    o.frequency.value = 440 * Math.pow(2, semi / 12);
    env(g, t, 0.08, 0.09);
    o.connect(g).connect(AC.destination);
    o.start(t); o.stop(t + 0.1);
  }
  function sePerfect() {
    if (!AC || AC.state !== "running") return;
    const t = AC.currentTime;
    const o = AC.createOscillator(), g = AC.createGain();
    o.frequency.setValueAtTime(500, t);
    o.frequency.exponentialRampToValueAtTime(1100, t + 0.12);
    env(g, t, 0.2, 0.15);
    o.connect(g).connect(AC.destination);
    o.start(t); o.stop(t + 0.16);
  }
  function seMiss() {
    if (!AC || AC.state !== "running") return;
    const t = AC.currentTime;
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.25);
    env(g, t, 0.25, 0.3);
    o.connect(g).connect(AC.destination);
    o.start(t); o.stop(t + 0.32);
  }

  // 先読みスケジューラ: 0.15秒先までの拍の音を予約する
  function scheduleAudio() {
    if (!AC || AC.state !== "running") return;
    const horizon = gameNow() + 0.15;
    while (S.scheduled < S.beats.length && S.beats[S.scheduled].time < horizon) {
      const { time, index } = S.beats[S.scheduled];
      const t = Math.max(acTime(time), AC.currentTime + 0.005);
      kick(t);
      hat(t); hat(acTime(time + beatLen(index) / 2));
      if (index % 4 === 1 || index % 4 === 3) snare(t);
      bass(t, PENTA[index % PENTA.length] + (index % 8 >= 4 ? -2 : 0));
      if (index % 2 === 1) blip(acTime(time + beatLen(index) / 2), PENTA[(index * 3) % PENTA.length] + 12);
      S.scheduled++;
    }
  }
  function beatLen(index) {
    let acc = 0;
    for (const seg of SEGMENTS) {
      acc += seg.beats;
      if (index < acc) return 60 / seg.bpm;
    }
    return 60 / 140;
  }

  // ---- ゲーム進行 ----
  async function startGame() {
    buildChart();
    S.phase = "play";
    S.score = 0; S.combo = 0; S.maxCombo = 0;
    S.counts = { perfect: 0, good: 0, miss: 0, whiff: 0 };
    S.scheduled = 0;
    S.floats = [];
    S.quoteIdx = 0;
    hideAllNoteEls();
    showScreen("play");
    resizeCanvas();
    // 画面切り替え直後はレイアウトが確定していないことがあるため、
    // 次フレーム以降にもう一度サイズを取り直す(iOS Safari対策)
    requestAnimationFrame(() => requestAnimationFrame(resizeCanvas));

    try {
      const ctx = ac();
      if (ctx.state !== "running") await ctx.resume();
    } catch (e) { /* 音が出なくてもゲームは進行させる */ }

    S.startTime = nowSec();
    if (AC) acOffset = AC.currentTime - 0;   // gameNow()==0 の瞬間に対応するAC時刻
    S.running = true;
    updateHud();
  }

  function endGame() {
    S.running = false;
    S.phase = "result";
    hideAllNoteEls();
    const total = S.notes.length;
    const rate = S.score / (total * 300);
    const rank =
      rate >= 0.9 ? "解脱" : rate >= 0.7 ? "悟り" : rate >= 0.45 ? "凡夫" : rate >= 0.2 ? "迷い" : "無";
    const face = { "解脱": "🫥", "悟り": "🗿", "凡夫": "🙂", "迷い": "😵‍💫", "無": "🫠" }[rank];
    $("result-rank").textContent = rank;
    $("result-face").textContent = face;
    $("result-score").textContent = `${S.score} pt / 最大コンボ ${S.maxCombo}`;
    $("result-stats").innerHTML = `
      <span><b>${S.counts.perfect}</b>悟り</span>
      <span><b>${S.counts.good}</b>概念</span>
      <span><b>${S.counts.miss}</b>無</span>
      <span><b>${S.counts.whiff}</b>素振り</span>`;
    showScreen("result");
  }

  function showScreen(name) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $("screen-" + name).classList.add("active");
  }

  // ---- 入力と判定 ----
  function tap() {
    if (!S.running) return;
    const t = gameNow();
    // 未判定ノーツのうち最もタップ時刻に近いもの
    let best = null, bestAbs = Infinity;
    for (const n of S.notes) {
      if (n.judged) continue;
      const d = Math.abs(n.time - t);
      if (d < bestAbs) { bestAbs = d; best = n; }
      if (n.time - t > GOOD_WIN) break;   // これ以降は未来すぎる
    }
    if (best && bestAbs <= GOOD_WIN) {
      best.judged = true;
      if (bestAbs <= PERFECT_WIN) {
        best.result = "perfect";
        S.counts.perfect++;
        S.combo++;
        S.score += 300 + Math.min(200, S.combo * 2);
        addFloat("悟り", "#b6ff3c");
        sePerfect();
      } else {
        best.result = "good";
        S.counts.good++;
        S.combo++;
        S.score += 100 + Math.min(100, S.combo);
        addFloat("概念", "#7ecbff");
      }
      S.maxCombo = Math.max(S.maxCombo, S.combo);
    } else {
      S.counts.whiff++;
      S.combo = 0;
      addFloat("素振り", "#8a8496");
    }
    updateHud();
  }

  function addFloat(text, color) {
    S.floats.push({ text, color, born: gameNow() });
  }

  function updateHud() {
    $("hud-score").textContent = S.score;
    $("hud-combo").textContent = S.combo >= 2 ? S.combo + " COMBO" : "";
  }

  // ---- 描画 ----
  const canvas = $("game-canvas");
  const g2d = canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1;

  // 絵文字はDOM要素で重ねて描画する(一部端末でcanvasのfillTextが
  // 絵文字グリフだけ描画に失敗する不具合の回避策。漢字/記号はcanvasのまま)
  const fxLayer = $("fx-layer");
  const moaiEl = $("moai-el");
  const NOTE_POOL_SIZE = 24;
  const notePool = [];
  for (let i = 0; i < NOTE_POOL_SIZE; i++) {
    const el = document.createElement("div");
    el.className = "note-el";
    el.style.display = "none";
    fxLayer.appendChild(el);
    notePool.push(el);
  }
  function hideAllNoteEls() {
    notePool.forEach((el) => { el.style.display = "none"; });
    moaiEl.style.display = "none";
  }

  function resizeCanvas() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    g2d.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 150));
  // iOSはツールバーの出没でvisualViewportだけが変化することがあるため個別に監視
  if (window.visualViewport) window.visualViewport.addEventListener("resize", resizeCanvas);

  // iOS Safari は絵文字を極端に大きいフォントサイズでcanvas描画すると
  // グリフが出ない/欠けることがあるため、巨大モアイのサイズに上限を設ける
  const MOAI_MAX_PX = 130;

  function frame() {
    if (S.phase !== "play") return;
    try {
      drawFrame();
    } catch (err) {
      g2d.fillStyle = "#0a0714";
      g2d.fillRect(0, 0, W, H);
      g2d.fillStyle = "#ff5f7e";
      g2d.font = "14px sans-serif";
      g2d.textAlign = "left";
      g2d.fillText("エラー: " + (err && err.message || err), 16, 40);
    }
  }

  function drawFrame() {
    const t = gameNow();
    scheduleAudio();

    // 進行チェック
    for (const n of S.notes) {
      if (!n.judged && t - n.time > GOOD_WIN) {
        n.judged = true;
        n.result = "miss";
        S.counts.miss++;
        S.combo = 0;
        addFloat("無", "#ff5f7e");
        seMiss();
        updateHud();
      }
    }
    if (t > S.endTime) { endGame(); return; }

    // 直近の拍(モアイの脈動と背景用)
    let beatIdx = 0;
    for (const b of S.beats) { if (b.time <= t) { S.lastBeatTime = b.time; beatIdx = b.index; } else break; }

    // 格言: 16拍ごとに切り替え
    const qi = Math.floor(beatIdx / 16);
    if (qi !== S.quoteIdx || !$("quote").classList.contains("show")) {
      S.quoteIdx = qi;
      $("quote").textContent = QUOTES[qi % QUOTES.length];
      $("quote").classList.add("show");
    }

    // ---- 描画 ----
    const hue = (beatIdx * 4) % 360;
    const grad = g2d.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, `hsl(${255 + hue * 0.2}, 45%, 7%)`);
    grad.addColorStop(1, `hsl(${(265 + hue) % 360}, 55%, 14%)`);
    g2d.fillStyle = grad;
    g2d.fillRect(0, 0, W, H);

    // 中央の巨大モアイ(拍で脈動、後半は回る)。DOM要素として重ねて描画
    const pulse = Math.max(0, 1 - (t - S.lastBeatTime) / 0.18);
    const moaiSize = Math.min(H * 0.28, MOAI_MAX_PX) * (1 + pulse * 0.06);
    const moaiRot = Math.sin(t * 0.5) * 0.08 + (beatIdx > 64 ? t * 0.15 : 0);
    moaiEl.style.display = "block";
    moaiEl.style.left = W / 2 + "px";
    moaiEl.style.top = H * 0.32 + "px";
    moaiEl.style.fontSize = Math.round(moaiSize) + "px";
    moaiEl.style.opacity = (0.28 + pulse * 0.14).toFixed(2);
    moaiEl.style.transform = `translate(-50%, -50%) rotate(${moaiRot}rad)`;

    // レーンと判定円
    const laneY = H * 0.62;
    const judgeX = W * 0.22;
    const speed = (W - judgeX + 60) / LEAD_TIME;
    g2d.strokeStyle = "rgba(255,255,255,0.12)";
    g2d.lineWidth = 2;
    g2d.beginPath(); g2d.moveTo(0, laneY); g2d.lineTo(W, laneY); g2d.stroke();

    g2d.strokeStyle = `rgba(182,255,60,${0.55 + pulse * 0.45})`;
    g2d.lineWidth = 3;
    g2d.beginPath();
    g2d.arc(judgeX, laneY, 34 + pulse * 6, 0, Math.PI * 2);
    g2d.stroke();

    // ノーツ(DOM要素のプールを使い回して表示位置だけ更新する)
    let poolIdx = 0;
    for (const n of S.notes) {
      const dt = n.time - t;
      if (dt > LEAD_TIME || (n.judged && n.result !== "miss" && dt < -0.05)) continue;
      if (dt < -0.4) continue;
      if (poolIdx >= notePool.length) break;   // プール上限(通常は届かない)
      const el = notePool[poolIdx++];
      const x = judgeX + dt * speed;
      const wob = Math.sin((t + n.time) * 6) * 5;   // ふわふわ漂う
      el.textContent = n.emoji;
      el.style.display = "block";
      el.style.opacity = n.judged && n.result !== "miss" ? "0.15" : "1";
      el.style.transform = `translate(${x}px, ${laneY + wob}px) translate(-50%, -50%)`;
    }
    for (; poolIdx < notePool.length; poolIdx++) {
      notePool[poolIdx].style.display = "none";
    }

    // 判定テキスト
    for (let i = S.floats.length - 1; i >= 0; i--) {
      const f = S.floats[i];
      const age = t - f.born;
      if (age > 0.9) { S.floats.splice(i, 1); continue; }
      g2d.globalAlpha = 1 - age / 0.9;
      g2d.fillStyle = f.color;
      g2d.font = "900 34px sans-serif";
      g2d.fillText(f.text, judgeX, laneY - 70 - age * 60);
      g2d.globalAlpha = 1;
    }
  }

  // rAFが止まる環境(非表示WebView等)でも進行するようウォッチドッグ併用
  let lastFrame = 0;
  function rafLoop(ts) {
    lastFrame = performance.now();
    frame();
    requestAnimationFrame(rafLoop);
  }
  requestAnimationFrame(rafLoop);
  setInterval(() => {
    if (performance.now() - lastFrame > 200) frame();
  }, 66);

  // ---- イベント ----
  $("btn-start").addEventListener("click", startGame);
  $("btn-retry").addEventListener("click", startGame);
  $("btn-title").addEventListener("click", () => { S.phase = "title"; showScreen("title"); });
  $("screen-play").addEventListener("pointerdown", tap);

  // 検証・デバッグ用フック
  window.__kyomu = { S, tap, gameNow, startGame, endGame };
})();
