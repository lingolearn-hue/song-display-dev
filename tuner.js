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

  // ── Smoothing — average last few readings to reduce jitter ──
  let recentFreqs = [];
  function smooth(freq) {
    recentFreqs.push(freq);
    if (recentFreqs.length > 5) recentFreqs.shift();
    const sorted = [...recentFreqs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]; // median — robust to outliers
  }

  // ── UI update ──────────────────────────────────────────────
  function updateDisplay(freq) {
    const noteEl   = $('tuner-note');
    const freqEl   = $('tuner-freq');
    const needleEl = $('tuner-needle');
    const centsEl  = $('tuner-cents');

    if (freq < 0) {
      noteEl.textContent = '—';
      freqEl.textContent = '0.0 Hz';
      needleEl.style.transform = 'translateX(-50%)';
      needleEl.classList.remove('in-tune','sharp','flat');
      centsEl.textContent = '';
      clearStringHighlight();
      return;
    }

    const smoothed = smooth(freq);
    const info = freqToNote(smoothed);
    if (!info) return;

    noteEl.textContent = info.name + info.octave;
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
  function tick() {
    if (!running) return;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    const freq = autoCorrelate(buf, audioCtx.sampleRate);
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
    updateDisplay(-1);
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
