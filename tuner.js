// tuner.js — Guitar tuner using Web Audio API + autocorrelation pitch detection
const Tuner = (() => {
  const $ = id => document.getElementById(id);

  let audioCtx    = null;
  let analyser    = null;
  let micStream   = null;
  let sourceNode  = null;
  let rafId       = null;
  let running     = false;
  let starting    = false; // true while a getUserMedia request is in flight
  let leaveRequested = false;

  // Standard guitar tuning, low to high (E2 A2 D3 G3 B3 E4)
  const GUITAR_STRINGS = [
    { note: 'E2', freq: 82.41  },
    { note: 'A2', freq: 110.00 },
    { note: 'D3', freq: 146.83 },
    { note: 'G3', freq: 196.00 },
    { note: 'B3', freq: 246.94 },
    { note: 'E4', freq: 329.63 },
  ];

  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // ── Frequency → nearest note + cents off ──────────────────
  function freqToNote(freq) {
    if (!freq || freq <= 0) return null;
    // MIDI note number relative to A4 = 440Hz = MIDI 69
    const midi = 69 + 12 * Math.log2(freq / 440);
    const rounded = Math.round(midi);
    const cents = Math.round((midi - rounded) * 100);
    const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
    const octave = Math.floor(rounded / 12) - 1;
    const targetFreq = 440 * Math.pow(2, (rounded - 69) / 12);
    return { name, octave, cents, targetFreq, midi: rounded };
  }

  // Find the nearest guitar string to a detected frequency (for auto-detect
  // highlighting — informational only, doesn't restrict what can be tuned)
  function nearestString(freq) {
    let best = null, bestDist = Infinity;
    for (const s of GUITAR_STRINGS) {
      const d = Math.abs(Math.log2(freq / s.freq));
      if (d < bestDist) { bestDist = d; best = s; }
    }
    return best;
  }

  // ── Autocorrelation pitch detection (ACF2+, standard approach) ──
  // Works well for monophonic plucked-string input. Returns frequency in Hz,
  // or -1 if no confident pitch found (silence, noise, or too weak a signal).
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1; // too quiet — likely silence

    // Trim leading/trailing silence within the buffer for a cleaner signal
    let r1 = 0, r2 = SIZE - 1;
    const threshold = 0.2;
    for (let i = 0; i < SIZE / 2; i++) {
      if (Math.abs(buf[i]) < threshold) { r1 = i; break; }
    }
    for (let i = 1; i < SIZE / 2; i++) {
      if (Math.abs(buf[SIZE - i]) < threshold) { r2 = SIZE - i; break; }
    }
    const trimmed = buf.slice(r1, r2);
    const newSize = trimmed.length;
    if (newSize < 2) return -1;

    const c = new Array(newSize).fill(0);
    for (let i = 0; i < newSize; i++) {
      for (let j = 0; j < newSize - i; j++) {
        c[i] += trimmed[j] * trimmed[j + i];
      }
    }

    let d = 0;
    while (d < newSize - 1 && c[d] > c[d + 1]) d++;

    let maxVal = -1, maxPos = -1;
    for (let i = d; i < newSize; i++) {
      if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
    }
    let T0 = maxPos;
    if (T0 <= 0) return -1;

    // Parabolic interpolation around the peak for sub-sample accuracy
    const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);

    const freq = sampleRate / T0;
    // Guitar's usable range: low E (~82Hz) down a bit for detuning headroom,
    // up to well above high E (~330Hz) for harmonics/higher frets
    if (freq < 60 || freq > 1200) return -1;
    return freq;
  }

  // ── Smoothing — median of recent readings to reduce jitter ──
  let recentFreqs = [];
  function smooth(freq) {
    recentFreqs.push(freq);
    if (recentFreqs.length > 8) recentFreqs.shift();
    const sorted = [...recentFreqs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]; // median — robust to outliers
  }

  // ── Hold/hysteresis state ────────────────────────────────────
  // Raw pitch detection drops out for single frames constantly (string
  // decay, pick noise, brief silence between strokes) even while a note is
  // clearly being held. Without smoothing this makes the whole display
  // flicker blank ~10-20 times a second. Instead: only clear the display
  // after a sustained period of no signal, and only update text/needle
  // when the reading has been consistent for a few frames in a row.
  const SILENCE_HOLD_MS = 600;   // keep last reading visible this long after signal drops
  const MIN_STABLE_FRAMES = 3;   // require this many consecutive similar readings before updating display
  let lastSignalTime = 0;
  let lastDisplayedInfo = null;
  let stableCandidate = null;
  let stableCount = 0;

  // ── UI update ──────────────────────────────────────────────
  function updateDisplay(freq) {
    const noteEl   = $('tuner-note');
    const freqEl   = $('tuner-freq');
    const needleEl = $('tuner-needle');
    const centsEl  = $('tuner-cents');
    const now = performance.now();

    if (freq < 0) {
      // No pitch this frame — but don't blank immediately. Keep showing the
      // last confident reading until SILENCE_HOLD_MS has elapsed with no
      // signal at all, so brief gaps between strums don't cause flicker.
      if (lastDisplayedInfo && now - lastSignalTime < SILENCE_HOLD_MS) return;
      if (!lastDisplayedInfo) return; // already idle, nothing to clear

      lastDisplayedInfo = null;
      stableCandidate = null;
      stableCount = 0;
      noteEl.textContent = '—';
      freqEl.textContent = '0.0 Hz';
      needleEl.style.transform = 'translateX(-50%)';
      needleEl.classList.remove('in-tune','sharp','flat');
      centsEl.textContent = '';
      clearStringHighlight();
      return;
    }

    lastSignalTime = now;
    const smoothed = smooth(freq);
    const info = freqToNote(smoothed);
    if (!info) return;

    // Require a few consecutive frames landing on the same note before
    // committing it to the display — prevents the note NAME from flickering
    // between neighbours during attack transients or string noise. The
    // needle/cents can still move continuously once a note is locked in,
    // since that motion is expected and useful, not jitter.
    const noteKey = info.name + info.octave;
    if (stableCandidate === noteKey) {
      stableCount++;
    } else {
      stableCandidate = noteKey;
      stableCount = 1;
    }
    if (stableCount < MIN_STABLE_FRAMES && !lastDisplayedInfo) return;

    lastDisplayedInfo = info;
    noteEl.textContent = noteKey;
    freqEl.textContent = smoothed.toFixed(1) + ' Hz';
    centsEl.textContent = (info.cents > 0 ? '+' : '') + info.cents + ' cents';

    // Needle: cents range roughly -50 to +50 maps to -50% to +50% offset
    const clamped = Math.max(-50, Math.min(50, info.cents));
    needleEl.style.transform = `translateX(${clamped}%)`;

    needleEl.classList.remove('in-tune','sharp','flat');
    if (Math.abs(info.cents) <= 5) {
      needleEl.classList.add('in-tune');
    } else if (info.cents > 0) {
      needleEl.classList.add('sharp');
    } else {
      needleEl.classList.add('flat');
    }

    highlightNearestString(smoothed);
  }

  // Immediately reset the display, bypassing the silence-hold timer.
  // Used when the user explicitly stops the tuner or leaves the screen.
  function forceClearDisplay() {
    lastDisplayedInfo = null;
    stableCandidate = null;
    stableCount = 0;
    lastSignalTime = 0;
    $('tuner-note').textContent = '—';
    $('tuner-freq').textContent = '0.0 Hz';
    $('tuner-needle').style.transform = 'translateX(-50%)';
    $('tuner-needle').classList.remove('in-tune','sharp','flat');
    $('tuner-cents').textContent = '';
    clearStringHighlight();
  }

  function highlightNearestString(freq) {
    const nearest = nearestString(freq);
    document.querySelectorAll('.tuner-string-btn').forEach(btn => {
      btn.classList.toggle('nearest', nearest && btn.dataset.note === nearest.note);
    });
  }
  function clearStringHighlight() {
    document.querySelectorAll('.tuner-string-btn').forEach(btn => btn.classList.remove('nearest'));
  }

  // ── Detection loop ─────────────────────────────────────────
  let lastActivityTouch = 0;
  function tick() {
    if (!running) return;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    const freq = autoCorrelate(buf, audioCtx.sampleRate);
    // A detected pitch means the user is actively playing/tuning — treat it
    // as activity so the screen doesn't lock mid-tuning even if they haven't
    // touched the screen (only their guitar) for a while. Throttled to once
    // every few seconds since this runs inside a 60fps loop.
    if (freq > 0) {
      const now = performance.now();
      if (now - lastActivityTouch > 3000) {
        WakeLockManager.touchActivity();
        lastActivityTouch = now;
      }
    }
    updateDisplay(freq);
    rafId = requestAnimationFrame(tick);
  }

  // ── Start / stop microphone ────────────────────────────────
  async function start() {
    if (running || starting) return;
    starting = true;
    leaveRequested = false;
    const hint = $('tuner-hint');
    const btn  = $('tuner-mic-btn');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        }
      });
    } catch (err) {
      starting = false;
      hint.textContent = 'Microphone access denied or unavailable. Check your browser/site permissions.';
      hint.classList.add('tuner-hint-error');
      return;
    }
    starting = false;

    // If the user navigated away from the Tuner screen while the browser's
    // permission prompt was still open, don't start listening — release the
    // stream immediately instead of leaving the mic on in the background.
    if (leaveRequested) {
      leaveRequested = false;
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
      return;
    }

    audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
    analyser   = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    sourceNode = audioCtx.createMediaStreamSource(micStream);
    sourceNode.connect(analyser);

    running = true;
    recentFreqs = [];
    btn.textContent = '⏹ Stop Tuner';
    btn.classList.add('active');
    hint.textContent = 'Listening… pluck a string and hold it steady.';
    hint.classList.remove('tuner-hint-error');
    tick();
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (sourceNode) sourceNode.disconnect();
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = analyser = micStream = sourceNode = null;
    recentFreqs = [];

    const btn = $('tuner-mic-btn');
    btn.textContent = '🎤 Start Tuner';
    btn.classList.remove('active');
    $('tuner-hint').textContent = 'Tap start and allow microphone access, then pluck a string.';
    $('tuner-hint').classList.remove('tuner-hint-error');
    forceClearDisplay();
  }

  function toggle() { running ? stop() : start(); }

  // ── Init ────────────────────────────────────────────────────
  function init() {
    $('tuner-mic-btn').addEventListener('click', toggle);

    // String preset buttons: informational reference only — tapping shows
    // the target frequency/note as a highlight; detection remains auto.
    document.querySelectorAll('.tuner-string-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tuner-string-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
  }

  // Stop the mic whenever the tuner screen is left, so it doesn't keep
  // listening in the background and draining battery / holding the mic.
  // Also handles the case where the user leaves while the browser's
  // permission prompt is still open — start() checks leaveRequested once
  // the prompt resolves and releases the stream immediately if so.
  function onLeave() {
    if (running) stop();
    if (starting) leaveRequested = true;
  }

  return { init, start, stop, onLeave };
})();
