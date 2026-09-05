// wakelock.js — App-wide Screen Wake Lock manager
//
// Keeps the screen from sleeping for up to 10 minutes after the last user
// activity (tap, swipe, click, key press) anywhere in the app — Songbook,
// Tuner, Trainer, or the song viewer. Previously this only ran inside the
// song viewer, so the Tuner screen had no protection and the display would
// dim/lock mid-tuning.
//
// Re-acquires automatically if the OS releases the lock for reasons outside
// our control, and releases cleanly when the app is hidden or the idle
// timer runs out, so it's not held indefinitely in the background or while
// the app is simply left open and unused.

const WakeLockManager = (() => {
  const IDLE_MS = 10 * 60 * 1000; // 10 minutes
  let wakeLock  = null;
  let idleTimer = null;
  const supported = 'wakeLock' in navigator;

  async function acquire() {
    if (!supported) return;
    if (document.visibilityState !== 'visible') return;
    try {
      if (wakeLock) return; // already held
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) {
      // Permission denied, unsupported context (e.g. non-HTTPS), or the
      // page isn't visible yet — safe to ignore, next activity retries it
    }
  }

  function release() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  // Call on any user activity anywhere in the app — acquires the lock if
  // not already held, and (re)starts the 10-minute idle countdown.
  function touchActivity() {
    acquire();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(release, IDLE_MS);
  }

  function init() {
    if (!supported) return;

    // Any interaction anywhere counts as activity. Passive + capture so
    // this never interferes with existing click/touch handlers elsewhere.
    ['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
      document.addEventListener(evt, touchActivity, { passive: true, capture: true });
    });

    // Re-acquire if the OS took the lock away while still within the idle
    // window (e.g. briefly backgrounded then foregrounded again); release
    // immediately if the app goes to the background, since a hidden tab
    // doesn't need the display kept awake regardless of the idle timer.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (idleTimer) acquire(); // only if still within an active idle window
      } else {
        release();
      }
    });

    touchActivity(); // start the first countdown on load
  }

  return { init, touchActivity, release };
})();
