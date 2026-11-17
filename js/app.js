(() => {
  const MODES = [
    { cols: 4, rows: 3, label: "4×3" },
    { cols: 4, rows: 4, label: "4×4" }
  ];

  // Round length in seconds, picked from the "Durasi" dropdown and remembered
  // in this browser. Choices live in index.html (#duration-select).
  const DEFAULT_DURATION = 90;
  const DURATION_KEY = "budgex-duration";
  const durationSelect = document.getElementById("duration-select");
  const durationChoices = [...durationSelect.options].map((o) => Number(o.value));
  let duration = DEFAULT_DURATION;
  try {
    const saved = Number(localStorage.getItem(DURATION_KEY));
    if (durationChoices.includes(saved)) duration = saved;
  } catch (_) {}
  durationSelect.value = String(duration);

  // MediaPipe landmark indices. The model always sees the whole hand,
  // but the game only reads the thumb tip, the index tip, and two palm
  // points used to measure hand size.
  const LM_WRIST = 0;
  const LM_THUMB_TIP = 4;
  const LM_INDEX_TIP = 8;
  const LM_MIDDLE_MCP = 9;

  // Pinch distance relative to palm length (wrist -> middle knuckle).
  // Grabbing needs a tight pinch; releasing needs a clearly open hand.
  // The gap between the two stops the piece from dropping while pinched.
  const PINCH_ON = 0.32;
  const PINCH_OFF = 0.5;
  const RELEASE_HOLD_MS = 150;
  // How long a hand may vanish (blur, backlight, pinch hiding the fingers)
  // before the cursor is removed and a held piece is dropped.
  const LOST_HAND_GRACE_MS = 800;
  const GRAB_PADDING = 14;
  // With the other fingers folded, the model sometimes puts the "index tip"
  // on the middle or ring finger for a few frames. While a piece is held, an
  // index tip that leaps more than INDEX_JUMP palm lengths in one frame is
  // ignored until it stays at its new spot for INDEX_JUMP_CONFIRM_MS.
  const INDEX_JUMP = 0.45;
  const INDEX_JUMP_CONFIRM_MS = 200;

  const videoEl = document.getElementById("webcam");
  const canvas = document.getElementById("game-canvas");
  const ctx = canvas.getContext("2d");
  const fxCanvas = document.getElementById("fx-canvas");
  const fxCtx = fxCanvas.getContext("2d");

  const statusEl = document.getElementById("camera-status");
  const timerPill = document.getElementById("timer-pill");
  const timerDisplay = document.getElementById("timer-display");
  const progressDisplay = document.getElementById("progress-display");
  const gridLabel = document.getElementById("grid-label");
  const btnGrid = document.getElementById("btn-grid");
  const btnReset = document.getElementById("btn-reset");
  const btnPlayAgain = document.getElementById("btn-play-again");
  const modal = document.getElementById("result-modal");
  const modalIcon = document.getElementById("modal-icon");
  const modalTitle = document.getElementById("modal-title");
  const modalDesc = document.getElementById("modal-desc");
  const statTime = document.getElementById("stat-time");
  const statPieces = document.getElementById("stat-pieces");
  const countdownEl = document.getElementById("countdown");
  const countdownText = document.getElementById("countdown-text");
  const dangerVignette = document.getElementById("danger-vignette");
  const btnStart = document.getElementById("btn-start");
  const startPanel = document.getElementById("start-panel");
  const startHint = document.getElementById("start-hint");
  const startHintText = document.getElementById("start-hint-text");

  // Big hint on the start card, so visitors know whether to wait or play.
  // "camera" -> "loading" -> "ready" ("hand" while a hand is seen), or "nocam"/"error".
  let trackerState = "camera";
  const HINTS = {
    camera: "Menyiapkan kamera...",
    loading: "Memuat pelacak tangan... tunggu sebentar",
    ready: "Siap! Angkat tanganmu ke kamera",
    hand: "Tangan terdeteksi! Arahkan lingkaran kuning ke Mulai, lalu cubit gaya OK 👌",
    nocam: "Kamera tidak tersedia. Klik Mulai untuk main pakai mouse/sentuh",
    error: "Pelacak tangan bermasalah. Klik Mulai untuk main pakai mouse/sentuh"
  };

  function updateStartHint() {
    const state = trackerState === "ready" && smoothedCursor.active ? "hand" : trackerState;
    if (startHint.dataset.state === state) return;
    startHint.dataset.state = state;
    startHintText.textContent = HINTS[state];
  }
  const startDuration = document.getElementById("start-duration");
  const DANGER_FROM_SECONDS = 10;

  const COUNTDOWN_STEP_MS = 1000;
  const WIN_MODAL_DELAY_MS = 1600;

  let modeIndex = 0;
  let pieces = [];
  let boardRect = { x: 0, y: 0, w: 640, h: 360 };
  let activePiece = null;
  let dragOffset = { x: 0, y: 0 };
  let inputSource = null;

  let timeLeft = duration;
  let timerStarted = false;
  let gameOver = false;
  let timerInterval = null;

  let fingerTips = null;
  let cursorTarget = { x: -100, y: -100 };
  let smoothedCursor = { x: -100, y: -100, active: false };
  let isPinching = false;
  let openSince = 0;
  // Index tip relative to the thumb tip, in palm lengths (camera pixels).
  let indexRel = null;
  let indexJump = null; // { rel, since }: a leap waiting to be confirmed
  let lastHandSeen = 0;
  let lastRenderTime = performance.now();

  // One Euro filter: removes webcam jitter when the hand is still,
  // and adds almost no lag when the hand moves fast.
  function createOneEuro(minCutoff = 1.4, beta = 0.012, dCutoff = 1.0) {
    let prev = null;
    let dPrev = 0;
    let tPrev = 0;
    const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    return {
      filter(value, t) {
        if (prev === null) {
          prev = value;
          tPrev = t;
          return value;
        }
        const dt = Math.max((t - tPrev) / 1000, 1e-3);
        tPrev = t;
        dPrev += alpha(dCutoff, dt) * ((value - prev) / dt - dPrev);
        prev += alpha(minCutoff + beta * Math.abs(dPrev), dt) * (value - prev);
        return prev;
      },
      reset() {
        prev = null;
        dPrev = 0;
      }
    };
  }
  const filterX = createOneEuro();
  const filterY = createOneEuro();

  // "idle" until a hand (or a click) shows up, then "running" 3-2-1,
  // then "done": pieces can be grabbed and the timer runs.
  let countdownState = "idle";
  let countdownTimers = [];
  let winModalTimer = null;
  let winStart = 0;

  let confetti = [];
  let audioCtx = null;
  let audioOut = null;

  const puzzleImg = new Image();
  let imageReady = false;
  let pieceSheet = null;
  let canvasDpr = 1;
  let fxHasContent = false;
  puzzleImg.onload = () => {
    imageReady = true;
    initBoard();
  };
  puzzleImg.src = "assets/puzzle-mascot.jpg";

  // Browsers keep audio muted until the first click/key press on the page,
  // so this is also called from those handlers to unlock sound early.
  function getAudio() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        // Compressor keeps stacked notes (chords + confetti pops) from clipping.
        audioOut = audioCtx.createDynamicsCompressor();
        audioOut.connect(audioCtx.destination);
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    } catch (_) {
      return null;
    }
  }

  function playNote(freq, start, duration, type = "sine", volume = 0.12) {
    const ac = getAudio();
    if (!ac) return;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(audioOut);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function playTone(freq, duration = 0.12, type = "sine") {
    const ac = getAudio();
    if (ac) playNote(freq, ac.currentTime, duration, type);
  }

  // Short filtered noise burst: the "pop" of a confetti cannon.
  function playPop(start) {
    const ac = getAudio();
    if (!ac) return;
    const len = Math.floor(ac.sampleRate * 0.25);
    const buffer = ac.createBuffer(1, len, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1800;
    filter.Q.value = 0.8;
    const gain = ac.createGain();
    gain.gain.value = 0.5;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(audioOut);
    src.start(start);
  }

  function playWinFanfare() {
    const ac = getAudio();
    if (!ac) return;
    const t = ac.currentTime + 0.05;
    playPop(t);
    playPop(t + 0.06);
    // Rising "ta-ta-ta-taa" run...
    const run = [392.0, 523.25, 659.25, 783.99, 659.25, 783.99];
    const at = [0, 0.12, 0.24, 0.36, 0.54, 0.66];
    run.forEach((f, i) => {
      playNote(f, t + at[i], 0.2, "square", 0.06);
      playNote(f, t + at[i], 0.22, "triangle", 0.1);
    });
    // ...landing on a big C-major chord...
    [523.25, 659.25, 783.99, 1046.5].forEach((f) => {
      playNote(f, t + 0.84, 1.4, "triangle", 0.1);
      playNote(f * 1.004, t + 0.84, 1.2, "sawtooth", 0.025);
    });
    playNote(130.81, t + 0.84, 1.3, "sine", 0.18);
    // ...with sparkles on top.
    for (let i = 0; i < 10; i++) {
      playNote(1568 + Math.random() * 1400, t + 0.9 + i * 0.08, 0.14, "sine", 0.045);
    }
  }

  function resizeCanvases() {
    canvasDpr = Math.min(window.devicePixelRatio || 1, 2);
    const dpr = canvasDpr;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    fxCanvas.width = w * dpr;
    fxCanvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    computeBoardRect(w, h);
    repositionPiecesOnResize();
  }

  // The source photo is large (2752×1536). Scaling it down 13 times every
  // frame was the main cost, so it is scaled once to the board size here and
  // each frame only copies pixels 1:1 from this sheet.
  function buildPieceSheet() {
    if (!imageReady) return;
    const sheetW = Math.round(boardRect.w * canvasDpr);
    const sheetH = Math.round(boardRect.h * canvasDpr);
    if (pieceSheet && pieceSheet.width === sheetW && pieceSheet.height === sheetH) return;
    pieceSheet = pieceSheet || document.createElement("canvas");
    pieceSheet.width = sheetW;
    pieceSheet.height = sheetH;
    const g = pieceSheet.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(puzzleImg, 0, 0, sheetW, sheetH);
  }

  function computeBoardRect(vw, vh) {
    const aspect = 16 / 9;
    const maxW = Math.min(vw * 0.56, 860);
    const maxH = Math.min(vh * 0.58, 520);
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    boardRect = {
      x: Math.round((vw - w) / 2),
      y: Math.round((vh - h) / 2) + 8,
      w: Math.round(w),
      h: Math.round(h)
    };
    buildPieceSheet();
  }

  function repositionPiecesOnResize() {
    if (!pieces.length) return;
    const { cols, rows } = MODES[modeIndex];
    const cellW = boardRect.w / cols;
    const cellH = boardRect.h / rows;
    pieces.forEach((p) => {
      p.w = cellW;
      p.h = cellH;
      p.targetX = boardRect.x + p.col * cellW;
      p.targetY = boardRect.y + p.row * cellH;
      if (p.locked) {
        p.x = p.targetX;
        p.y = p.targetY;
      }
    });
  }

  function formatSeconds(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function updateHUD() {
    const total = MODES[modeIndex].cols * MODES[modeIndex].rows;
    const lockedCount = pieces.filter((p) => p.locked).length;
    progressDisplay.textContent = `${lockedCount} / ${total}`;
    timerDisplay.textContent = formatSeconds(timeLeft);

    timerPill.classList.remove("warning", "danger");
    if (timeLeft <= 7 && timerStarted && !gameOver) {
      timerPill.classList.add("danger");
    } else if (timeLeft <= 15 && timerStarted && !gameOver) {
      timerPill.classList.add("warning");
    }
  }

  function startCountdown() {
    if (countdownState !== "idle" || gameOver) return;
    countdownState = "running";
    startPanel.hidden = true;
    btnStart.classList.remove("hand-hover");
    const steps = ["3", "2", "1", "Mulai!"];
    steps.forEach((label, i) => {
      countdownTimers.push(setTimeout(() => showCountdownStep(label, i === steps.length - 1), i * COUNTDOWN_STEP_MS));
    });
    countdownTimers.push(setTimeout(() => countdownEl.classList.add("hidden"), steps.length * COUNTDOWN_STEP_MS));
  }

  function showCountdownStep(label, isGo) {
    countdownEl.classList.remove("hidden");
    countdownText.textContent = label;
    countdownText.classList.toggle("go", isGo);
    // Restart the CSS pop animation for every number.
    countdownText.classList.remove("pop");
    void countdownText.offsetWidth;
    countdownText.classList.add("pop");

    const ac = getAudio();
    if (isGo) {
      if (ac) {
        playNote(783.99, ac.currentTime, 0.18, "triangle", 0.14);
        playNote(1046.5, ac.currentTime + 0.12, 0.4, "triangle", 0.14);
      }
      countdownState = "done";
      startTimer();
    } else {
      playTone(587.33, 0.16, "triangle");
    }
  }

  function cancelCountdown() {
    countdownTimers.forEach(clearTimeout);
    countdownTimers = [];
    countdownState = "idle";
    countdownEl.classList.add("hidden");
  }

  // Called on every timer tick. From 10s down, the red beats once per second,
  // starting faint and getting heavier until the last second (and the 0 flash).
  function pulseDanger() {
    if (timeLeft > DANGER_FROM_SECONDS) return;
    const level = Math.min(1, (DANGER_FROM_SECONDS + 1 - timeLeft) / DANGER_FROM_SECONDS);
    dangerVignette.style.setProperty("--level", level.toFixed(2));
    const rest = (0.3 + level * 0.55).toFixed(2);
    dangerVignette.style.setProperty("--peak", (0.65 + level * 0.35).toFixed(2));
    dangerVignette.style.setProperty("--rest", rest);
    // Resting opacity, used as-is when reduced motion turns the beat off.
    dangerVignette.style.opacity = rest;
    dangerVignette.classList.remove("hidden", "beat");
    void dangerVignette.offsetWidth;
    dangerVignette.classList.add("beat");
  }

  function hideDanger() {
    dangerVignette.classList.remove("beat");
    dangerVignette.classList.add("hidden");
  }

  function startTimer() {
    if (timerStarted || gameOver) return;
    timerStarted = true;
    timerInterval = setInterval(() => {
      if (gameOver) return;
      timeLeft = Math.max(0, timeLeft - 1);
      updateHUD();
      pulseDanger();
      if (timeLeft <= 5 && timeLeft > 0) {
        playTone(440, 0.08, "triangle");
      }
      if (timeLeft === 0) {
        endGame(false);
      }
    }, 1000);
  }

  function initBoard() {
    clearInterval(timerInterval);
    clearTimeout(winModalTimer);
    cancelCountdown();
    hideDanger();
    winStart = 0;
    modal.classList.remove("is-win");
    const mode = MODES[modeIndex];
    timeLeft = duration;
    timerStarted = false;
    gameOver = false;
    activePiece = null;
    inputSource = null;
    confetti = [];
    modal.classList.add("hidden");
    startPanel.hidden = false;
    // "90 detik" -> "90 Detik", "2,5 menit" -> "2,5 Menit": follows the Durasi dropdown.
    startDuration.textContent = durationSelect.selectedOptions[0].textContent.replace(/(^|\s)\S/g, (ch) => ch.toUpperCase());
    gridLabel.textContent = mode.label;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    computeBoardRect(vw, vh);

    const cellW = boardRect.w / mode.cols;
    const cellH = boardRect.h / mode.rows;
    const total = mode.cols * mode.rows;

    const slots = [];
    const perSide = Math.ceil(total / 2);
    const leftMarginX = Math.max(24, (boardRect.x - cellW) / 2);
    const rightMarginX = Math.min(vw - cellW - 24, boardRect.x + boardRect.w + (vw - (boardRect.x + boardRect.w) - cellW) / 2);
    const topStart = 96;
    const usableH = Math.max(200, vh - topStart - 90 - cellH);

    for (let i = 0; i < total; i++) {
      const isLeft = i < perSide;
      const idxInSide = isLeft ? i : i - perSide;
      const countInSide = isLeft ? perSide : total - perSide;
      const stepY = countInSide > 1 ? usableH / (countInSide - 1) : 0;
      const jitterX = (Math.random() - 0.5) * 28;
      const jitterY = (Math.random() - 0.5) * 18;
      const x = Math.max(16, Math.min(vw - cellW - 16, (isLeft ? leftMarginX : rightMarginX) + jitterX));
      const y = Math.max(88, Math.min(vh - cellH - 76, topStart + idxInSide * stepY + jitterY));
      slots.push({ x, y });
    }

    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    pieces = [];
    let idx = 0;
    for (let r = 0; r < mode.rows; r++) {
      for (let c = 0; c < mode.cols; c++) {
        pieces.push({
          id: idx,
          row: r,
          col: c,
          x: slots[idx].x,
          y: slots[idx].y,
          w: cellW,
          h: cellH,
          targetX: boardRect.x + c * cellW,
          targetY: boardRect.y + r * cellH,
          locked: false
        });
        idx++;
      }
    }

    updateHUD();
  }

  function tryGrabAt(x, y, source) {
    if (gameOver || activePiece) return;
    // Nothing can be grabbed before "Mulai!". The round only starts from the
    // Mulai button: clicked, or pinched by the hand (checked here).
    if (countdownState !== "done") {
      if (source === "hand" && isOverStartButton(x, y)) startCountdown();
      return;
    }
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      if (p.locked) continue;
      const pad = source === "hand" ? GRAB_PADDING : 0;
      if (x >= p.x - pad && x <= p.x + p.w + pad && y >= p.y - pad && y <= p.y + p.h + pad) {
        activePiece = p;
        inputSource = source;
        dragOffset.x = x - p.x;
        dragOffset.y = y - p.y;
        pieces.splice(i, 1);
        pieces.push(p);
        playTone(520, 0.06, "sine");
        break;
      }
    }
  }

  function isOverStartButton(x, y) {
    if (startPanel.hidden) return false;
    const r = btnStart.getBoundingClientRect();
    const pad = GRAB_PADDING;
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  function moveActivePiece(x, y) {
    if (!activePiece || gameOver) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    activePiece.x = Math.max(0, Math.min(vw - activePiece.w, x - dragOffset.x));
    activePiece.y = Math.max(72, Math.min(vh - activePiece.h, y - dragOffset.y));

    // Lock the piece the moment it reaches its slot, without waiting for
    // the visitor to let go, so it can't be dragged back out by accident.
    if (isNearTarget(activePiece)) releaseActivePiece();
  }

  function isNearTarget(p) {
    const snapDist = Math.min(p.w, p.h) * 0.36;
    return Math.hypot(p.x - p.targetX, p.y - p.targetY) <= snapDist;
  }

  function releaseActivePiece() {
    if (!activePiece) return;

    if (isNearTarget(activePiece)) {
      activePiece.x = activePiece.targetX;
      activePiece.y = activePiece.targetY;
      activePiece.locked = true;
      const idx = pieces.indexOf(activePiece);
      if (idx > -1) {
        pieces.splice(idx, 1);
        pieces.unshift(activePiece);
      }
      playTone(784, 0.14, "triangle");
    }

    activePiece = null;
    inputSource = null;
    updateHUD();

    if (pieces.length > 0 && pieces.every((p) => p.locked)) {
      endGame(true);
    }
  }

  function endGame(won) {
    gameOver = true;
    clearInterval(timerInterval);
    activePiece = null;

    const total = pieces.length;
    const lockedCount = pieces.filter((p) => p.locked).length;
    statTime.textContent = formatSeconds(timeLeft);
    statPieces.textContent = `${lockedCount} / ${total}`;

    if (won) {
      modalIcon.className = "modal-icon win";
      modalIcon.innerHTML = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
      modalTitle.textContent = "Kamu Menang!";
      modalDesc.textContent = "Keren! Tunjukkan layar ini ke penjaga booth untuk klaim Stiker Maskot BudgEx kamu.";
      // Celebrate on the finished picture first, then bring in the card.
      hideDanger();
      winStart = performance.now();
      spawnConfetti();
      playWinFanfare();
      modal.classList.add("is-win");
      winModalTimer = setTimeout(() => modal.classList.remove("hidden"), WIN_MODAL_DELAY_MS);
    } else {
      modalIcon.className = "modal-icon timeout";
      modalIcon.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
      modalTitle.textContent = "Waktu Habis!";
      modalDesc.textContent = "Belum sempat selesai kali ini. Tekan tombol di bawah untuk coba lagi!";
      playTone(220, 0.28, "sawtooth");
      modal.classList.remove("hidden");
    }
  }

  const CONFETTI_COLORS = ["#16a34a", "#f59e0b", "#facc15", "#ef4444", "#3b82f6", "#10b981", "#ffffff"];

  function makeConfetti(x, y, vx, vy) {
    return {
      x,
      y,
      w: 7 + Math.random() * 7,
      h: 5 + Math.random() * 6,
      vx,
      vy,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.3,
      flip: Math.random() * Math.PI * 2,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]
    };
  }

  // Two cannons fire from the bottom corners, then a second wave rains from the top.
  function spawnConfetti() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    confetti = [];
    for (let i = 0; i < 60; i++) {
      const speed = 14 + Math.random() * 10;
      const angle = (-60 - Math.random() * 25) * (Math.PI / 180);
      confetti.push(makeConfetti(0, vh, Math.cos(angle) * speed, Math.sin(angle) * speed));
      confetti.push(makeConfetti(vw, vh, -Math.cos(angle) * speed, Math.sin(angle) * speed));
    }
    setTimeout(() => {
      if (!winStart) return;
      for (let i = 0; i < 80; i++) {
        confetti.push(makeConfetti(Math.random() * vw, -20 - Math.random() * 240, (Math.random() - 0.5) * 3, 2 + Math.random() * 3));
      }
    }, 700);
  }

  // The top layer holds confetti and the hand cursor, so the cursor stays
  // visible over the start card and the result modal.
  function updateAndDrawConfetti(vw, vh, dt, handOn) {
    // Skip clearing the full-screen effects layer when nothing is on it.
    if (!confetti.length && !fxHasContent && !handOn) return;
    fxCtx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    fxCtx.clearRect(0, 0, vw, vh);
    fxHasContent = confetti.length > 0 || handOn;

    const step = dt * 60;
    const drag = Math.pow(0.985, step);
    const d = canvasDpr;
    confetti = confetti.filter((c) => c.y < vh + 40);
    for (const c of confetti) {
      c.vy = Math.min(c.vy + 0.35 * step, 6);
      c.vx *= drag;
      c.x += c.vx * step;
      c.y += c.vy * step;
      c.rot += c.vrot * step;
      c.flip += 0.15 * step;
      // One setTransform = translate + rotate + squash (the flutter),
      // much cheaper than save/translate/rotate/scale/restore per piece.
      const cos = Math.cos(c.rot);
      const sin = Math.sin(c.rot);
      const squash = Math.cos(c.flip);
      fxCtx.setTransform(cos * d, sin * d, -sin * squash * d, cos * squash * d, c.x * d, c.y * d);
      fxCtx.fillStyle = c.color;
      fxCtx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    }
    fxCtx.setTransform(d, 0, 0, d, 0, 0);
  }

  // Golden glow around the finished picture plus a shine sweeping across it.
  function drawWinEffects(now) {
    if (!winStart) return;
    const t = (now - winStart) / 1000;
    const { x, y, w, h } = boardRect;

    ctx.save();
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    ctx.shadowColor = "rgba(250, 204, 21, 0.9)";
    ctx.shadowBlur = 18 + pulse * 26;
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = 4 + pulse * 2;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();

    const sweep = (t % 2.2) / 1.1;
    if (sweep <= 1) {
      const sx = x - w * 0.4 + sweep * w * 1.8;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const grad = ctx.createLinearGradient(sx - 120, y, sx + 120, y + h * 0.4);
      grad.addColorStop(0, "rgba(255, 255, 255, 0)");
      grad.addColorStop(0.5, "rgba(255, 255, 255, 0.45)");
      grad.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }

  // Maps a landmark onto the screen the same way CSS shows the video
  // (object-fit: cover + mirrored), so the cursor sits on the real fingertip.
  function landmarkToScreen(lm, vw, vh) {
    const vidW = videoEl.videoWidth || 1280;
    const vidH = videoEl.videoHeight || 720;
    const scale = Math.max(vw / vidW, vh / vidH);
    const offsetX = (vw - vidW * scale) / 2;
    const offsetY = (vh - vidH * scale) / 2;
    return {
      x: vw - (offsetX + lm.x * vidW * scale),
      y: offsetY + lm.y * vidH * scale
    };
  }

  function drawBoardFrame() {
    const { cols, rows } = MODES[modeIndex];
    const cellW = boardRect.w / cols;
    const cellH = boardRect.h / rows;

    // The camera is shown in natural color, so only the board gets a dark
    // backing to keep the ghost picture and grid readable.
    ctx.fillStyle = "rgba(9, 17, 14, 0.45)";
    ctx.fillRect(boardRect.x, boardRect.y, boardRect.w, boardRect.h);

    if (pieceSheet) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.drawImage(pieceSheet, boardRect.x, boardRect.y, boardRect.w, boardRect.h);
      ctx.restore();
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 1.5;
    for (let c = 1; c < cols; c++) {
      const gx = boardRect.x + c * cellW;
      ctx.beginPath();
      ctx.moveTo(gx, boardRect.y);
      ctx.lineTo(gx, boardRect.y + boardRect.h);
      ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      const gy = boardRect.y + r * cellH;
      ctx.beginPath();
      ctx.moveTo(boardRect.x, gy);
      ctx.lineTo(boardRect.x + boardRect.w, gy);
      ctx.stroke();
    }

    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 3;
    ctx.strokeRect(boardRect.x, boardRect.y, boardRect.w, boardRect.h);
  }

  function drawPieces() {
    if (!pieceSheet) return;
    const { cols, rows } = MODES[modeIndex];
    const srcW = pieceSheet.width / cols;
    const srcH = pieceSheet.height / rows;

    pieces.forEach((p) => {
      const isGrabbed = p === activePiece;
      ctx.save();
      if (isGrabbed) {
        // Cheap drop shadow (layered rects instead of shadowBlur).
        ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
        ctx.fillRect(p.x + 4, p.y + 10, p.w + 4, p.h + 4);
        ctx.fillRect(p.x + 2, p.y + 6, p.w + 2, p.h + 2);
      }

      ctx.drawImage(
        pieceSheet,
        p.col * srcW,
        p.row * srcH,
        srcW,
        srcH,
        p.x,
        p.y,
        p.w,
        p.h
      );

      ctx.lineWidth = isGrabbed ? 3.5 : 2;
      ctx.strokeStyle = p.locked
        ? "#22c55e"
        : isGrabbed
          ? "#facc15"
          : "rgba(255, 255, 255, 0.75)";
      ctx.strokeRect(p.x, p.y, p.w, p.h);
      ctx.restore();
    });
  }

  function drawHandOverlay() {
    if (!fingerTips || !smoothedCursor.active) return;

    const color = isPinching ? "#22c55e" : "#facc15";
    const { thumb, index } = fingerTips;

    fxCtx.save();
    fxCtx.strokeStyle = color;
    fxCtx.lineWidth = 2.5;
    fxCtx.beginPath();
    fxCtx.moveTo(thumb.x, thumb.y);
    fxCtx.lineTo(index.x, index.y);
    fxCtx.stroke();

    fxCtx.fillStyle = color;
    [thumb, index].forEach((pt) => {
      fxCtx.beginPath();
      fxCtx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
      fxCtx.fill();
    });

    fxCtx.beginPath();
    fxCtx.arc(smoothedCursor.x, smoothedCursor.y, isPinching ? 14 : 20, 0, Math.PI * 2);
    fxCtx.lineWidth = 3.5;
    fxCtx.stroke();
    fxCtx.restore();
  }

  // Returns the index tip position (relative to the thumb) to trust this frame.
  // Only filters while a piece is held, so grabbing stays instant.
  function trustIndex(raw, now) {
    const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    if (!isPinching || !indexRel || gap(raw, indexRel) <= INDEX_JUMP) {
      indexJump = null;
      return raw;
    }
    if (indexJump && gap(raw, indexJump.rel) <= INDEX_JUMP) {
      if (now - indexJump.since >= INDEX_JUMP_CONFIRM_MS) {
        indexJump = null;
        return raw;
      }
      indexJump.rel = raw;
    } else {
      indexJump = { rel: raw, since: now };
    }
    return indexRel;
  }

  function dropHand() {
    fingerTips = null;
    smoothedCursor.active = false;
    filterX.reset();
    filterY.reset();
    indexRel = null;
    indexJump = null;
    if (isPinching) {
      isPinching = false;
      if (inputSource === "hand") releaseActivePiece();
    }
  }

  function renderLoop(now = performance.now()) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dt = Math.min((now - lastRenderTime) / 1000, 0.1);
    lastRenderTime = now;

    // Brief tracking dropouts keep the piece in hand instead of dropping it.
    if (smoothedCursor.active && now - lastHandSeen > LOST_HAND_GRACE_MS) {
      dropHand();
    }

    // Detection runs at camera speed (~30 fps); the cursor glides toward the
    // latest position every display frame so the piece moves smoothly.
    if (smoothedCursor.active) {
      const k = 1 - Math.exp(-dt * 30);
      smoothedCursor.x += (cursorTarget.x - smoothedCursor.x) * k;
      smoothedCursor.y += (cursorTarget.y - smoothedCursor.y) * k;
      if (inputSource === "hand") moveActivePiece(smoothedCursor.x, smoothedCursor.y);
    }
    if (!startPanel.hidden) {
      updateStartHint();
      btnStart.classList.toggle("hand-hover", smoothedCursor.active && isOverStartButton(smoothedCursor.x, smoothedCursor.y));
    }

    ctx.clearRect(0, 0, vw, vh);
    drawBoardFrame();
    drawPieces();
    drawWinEffects(now);

    updateAndDrawConfetti(vw, vh, dt, smoothedCursor.active && !!fingerTips);
    drawHandOverlay();

    requestAnimationFrame(renderLoop);
  }

  // Any click or key press unlocks browser audio for the rest of the session.
  window.addEventListener("pointerdown", getAudio);

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    tryGrabAt(e.clientX, e.clientY, "pointer");
  });

  canvas.addEventListener("pointermove", (e) => {
    if (inputSource === "pointer") {
      moveActivePiece(e.clientX, e.clientY);
    }
  });

  canvas.addEventListener("pointerup", () => {
    if (inputSource === "pointer") {
      releaseActivePiece();
    }
  });

  btnGrid.addEventListener("click", () => {
    modeIndex = (modeIndex + 1) % MODES.length;
    initBoard();
  });

  // Changing the length starts a fresh round with the new time.
  function setDuration(seconds) {
    duration = seconds;
    durationSelect.value = String(seconds);
    try {
      localStorage.setItem(DURATION_KEY, String(seconds));
    } catch (_) {}
    initBoard();
  }

  durationSelect.addEventListener("change", () => {
    setDuration(Number(durationSelect.value));
    // Hand focus back so R / G / T shortcuts don't type into the dropdown.
    durationSelect.blur();
  });

  btnStart.addEventListener("click", startCountdown);
  btnReset.addEventListener("click", () => initBoard());
  btnPlayAgain.addEventListener("click", () => initBoard());

  window.addEventListener("keydown", (e) => {
    getAudio();
    if (e.target === durationSelect) return;
    if (e.key === "r" || e.key === "R") initBoard();
    if (e.key === "t" || e.key === "T") {
      const next = durationChoices[(durationChoices.indexOf(duration) + 1) % durationChoices.length];
      setDuration(next);
    }
    if (e.key === "g" || e.key === "G") {
      modeIndex = (modeIndex + 1) % MODES.length;
      initBoard();
    }
  });

  window.addEventListener("resize", resizeCanvases);

  // Camera choice is remembered, so a phone used as a webcam (Windows Phone Link,
  // DroidCam, Iriun, Camo...) stays selected after a refresh.
  const CAMERA_KEY = "budgex-camera-id";
  const btnCamera = document.getElementById("btn-camera");

  function savedCameraId() {
    try {
      return localStorage.getItem(CAMERA_KEY);
    } catch (_) {
      return null;
    }
  }

  async function openCamera(deviceId) {
    const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    const video = deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: "user" };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      // Saved camera unplugged: fall back to the default one.
      if (!deviceId) throw err;
      return openCamera(null);
    }
    if (videoEl.srcObject) videoEl.srcObject.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = stream;
    await videoEl.play();
    const label = stream.getVideoTracks()[0]?.label || "Kamera";
    statusEl.textContent = `${label} • Arahkan tangan ke layar`;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    btnCamera.hidden = cams.length < 2;
  }

  async function switchCamera() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    if (cams.length < 2) return;
    const currentId = videoEl.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
    const next = cams[(cams.findIndex((c) => c.deviceId === currentId) + 1) % cams.length];
    try {
      localStorage.setItem(CAMERA_KEY, next.deviceId);
    } catch (_) {}
    try {
      await openCamera(next.deviceId);
    } catch (_) {
      statusEl.textContent = "Kamera itu tidak bisa dibuka • Coba lagi";
    }
  }

  btnCamera.addEventListener("click", switchCamera);
  window.addEventListener("keydown", (e) => {
    if (e.key === "c" || e.key === "C") switchCamera();
  });

  async function initCameraAndHands() {
    try {
      await openCamera(savedCameraId());
    } catch (err) {
      trackerState = "nocam";
      statusEl.textContent = "Kamera tidak tersedia • Mode Sentuh/Mouse aktif";
      return;
    }

    if (typeof Hands === "undefined") {
      trackerState = "nocam";
      statusEl.textContent = "Kamera aktif • Gunakan Sentuh/Mouse";
      return;
    }

    const hands = new Hands({
      // Model + wasm files are bundled locally (MediaPipe Hands 0.4.1675469240).
      locateFile: (file) => `vendor/mediapipe-hands/${file}`
    });

    hands.setOptions({
      maxNumHands: 1,
      // Full model (vendor/.../hand_landmark_full.tflite): steadier fingertips and
      // fewer dropouts than lite, at more CPU per frame. Set 0 to go back to lite
      // if a slow laptop starts to lag.
      modelComplexity: 1,
      // Lower thresholds: finds the hand again sooner in dim/backlit booths and
      // keeps following it through a pinch instead of re-searching the frame.
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.35
    });

    hands.onResults((results) => {
      // No hand this frame: renderLoop drops it after LOST_HAND_GRACE_MS.
      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return;

      const lm = results.multiHandLandmarks[0];
      const now = performance.now();
      lastHandSeen = now;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const thumbLm = lm[LM_THUMB_TIP];
      const thumb = landmarkToScreen(thumbLm, vw, vh);

      // The cursor follows the thumb tip only. The model rarely mixes up the
      // thumb, so a misread index finger can no longer drag the cursor away.
      cursorTarget.x = filterX.filter(thumb.x, now);
      cursorTarget.y = filterY.filter(thumb.y, now);
      if (!smoothedCursor.active) {
        smoothedCursor = { x: cursorTarget.x, y: cursorTarget.y, active: true };
      }

      // Measured in camera pixels, relative to palm length, so it works
      // whether the visitor stands close to or far from the camera.
      const vidW = videoEl.videoWidth || 1280;
      const vidH = videoEl.videoHeight || 720;
      const palm = Math.hypot(
        (lm[LM_WRIST].x - lm[LM_MIDDLE_MCP].x) * vidW,
        (lm[LM_WRIST].y - lm[LM_MIDDLE_MCP].y) * vidH
      ) || 1;
      indexRel = trustIndex({
        x: (lm[LM_INDEX_TIP].x - thumbLm.x) * vidW / palm,
        y: (lm[LM_INDEX_TIP].y - thumbLm.y) * vidH / palm
      }, now);
      const pinchRatio = Math.hypot(indexRel.x, indexRel.y);

      const index = landmarkToScreen({
        x: thumbLm.x + indexRel.x * palm / vidW,
        y: thumbLm.y + indexRel.y * palm / vidH
      }, vw, vh);
      fingerTips = { thumb, index };

      if (!isPinching) {
        if (pinchRatio < PINCH_ON) {
          isPinching = true;
          openSince = 0;
          tryGrabAt(cursorTarget.x, cursorTarget.y, "hand");
        }
      } else if (pinchRatio > PINCH_OFF) {
        if (!openSince) openSince = now;
        if (now - openSince >= RELEASE_HOLD_MS) {
          isPinching = false;
          openSince = 0;
          if (inputSource === "hand") releaseActivePiece();
        }
      } else {
        openSince = 0;
      }
    });

    // The model takes a few seconds to load; say so instead of "ready".
    const cameraLabel = () => videoEl.srcObject?.getVideoTracks()[0]?.label || "Kamera";
    trackerState = "loading";
    statusEl.textContent = `${cameraLabel()} • Memuat pelacak tangan...`;
    let trackerReady = false;
    let usingFullModel = true;

    // The full model blocks the page for ~100 ms per frame on an ordinary
    // laptop (Intel UHD), which makes everything stutter. Time the first frames
    // that contain a hand and drop to lite if full is too slow on this machine.
    const SLOW_FRAME_MS = 50;
    const SPEED_SAMPLES = 30;
    let handFrameTimes = [];
    window.__tracker = { model: "full", medianMs: null };

    function checkTrackerSpeed(ms) {
      if (!usingFullModel || handFrameTimes.length >= SPEED_SAMPLES) return;
      handFrameTimes.push(ms);
      if (handFrameTimes.length < SPEED_SAMPLES) return;
      const sorted = [...handFrameTimes].sort((a, b) => a - b);
      const median = Math.round(sorted[sorted.length >> 1]);
      window.__tracker.medianMs = median;
      console.info(`Hand tracker (full model): ${median} ms per frame`);
      if (median > SLOW_FRAME_MS) {
        usingFullModel = false;
        window.__tracker.model = "lite";
        hands.setOptions({ modelComplexity: 0 });
        statusEl.textContent = `${cameraLabel()} • Pelacak tangan siap (model lite, laptop ini lebih cepat pakai lite)`;
      }
    }

    let busy = false;
    const scheduleNext = () => {
      if (videoEl.requestVideoFrameCallback) {
        videoEl.requestVideoFrameCallback(processFrame);
      } else {
        requestAnimationFrame(processFrame);
      }
    };
    // Runs once per new camera frame instead of every display frame.
    async function processFrame() {
      // Hand tracking is the heaviest thing on the page. It is paused while the
      // round is over (win celebration / result card) so the animation stays smooth.
      if (!busy && !gameOver && videoEl.readyState >= 2) {
        busy = true;
        try {
          const t0 = performance.now();
          await hands.send({ image: videoEl });
          // Only frames with a hand run the landmark model, the part that differs.
          const sendMs = performance.now() - t0;
          window.__tracker.avgMs = Math.round((window.__tracker.avgMs || sendMs) * 0.9 + sendMs * 0.1);
          if (trackerReady && lastHandSeen >= t0) checkTrackerSpeed(sendMs);
          if (!trackerReady) {
            trackerReady = true;
            trackerState = "ready";
            statusEl.textContent = `${cameraLabel()} • Pelacak tangan siap (model ${usingFullModel ? "full" : "lite"})`;
          }
        } catch (err) {
          console.error("Hand tracker failed:", err);
          if (usingFullModel) {
            // Full model can't run here (memory, slow device...): fall back to lite.
            usingFullModel = false;
            trackerReady = false;
            window.__tracker.model = "lite";
            trackerState = "loading";
            statusEl.textContent = `${cameraLabel()} • Model full gagal, pindah ke model lite...`;
            hands.setOptions({ modelComplexity: 0 });
          } else {
            trackerState = "error";
            statusEl.textContent = "Pelacak tangan error • Mode Sentuh/Mouse aktif (lihat Console, F12)";
          }
        }
        busy = false;
      }
      scheduleNext();
    }
    scheduleNext();
  }

  resizeCanvases();
  initBoard();
  renderLoop();
  initCameraAndHands();
})();
