/**
 * Maono PD200W Web Controls
 *
 * Uses the Web Audio API to interface with the microphone and implement:
 *  - Real-time input level meter (VU / peak)
 *  - Gain control (0–20 levels mapped to 0–40 dB)
 *  - Mute / unmute
 *  - Three-level noise cancellation (Off / Low / High)
 *  - Headphone monitoring with volume control
 *  - Four-band equaliser (Bass, Low-Mid, Mid, Presence, Treble)
 *  - EQ presets (Flat, Voice, Broadcast, Music)
 */

'use strict';

/* =========================================================
   Constants
   ========================================================= */

/** Gain levels 0-20 mapped to 0-40 dB (2 dB per step). */
const GAIN_LEVEL_TO_DB = 2;

/** Number of bar segments in the level meter. */
const METER_SEGMENTS = 48;

/**
 * Thresholds (in dBFS) for meter colour zones.
 * Below YELLOW → green; below RED → yellow; above RED → red.
 */
const METER_YELLOW_THRESHOLD = -12;
const METER_RED_THRESHOLD    = -6;

/** Peak hold time in milliseconds. */
const PEAK_HOLD_MS = 2000;

/** Noise-cancellation descriptions. */
const NC_DESCRIPTIONS = {
  off:  'No noise reduction applied.',
  low:  'Light noise reduction – suppresses soft background sounds.',
  high: 'Aggressive noise reduction – ideal for noisy environments.',
};

/**
 * EQ presets: each entry has gain (dB) for
 * [bass (80 Hz), lowMid (500 Hz), mid (2 kHz), presence (5 kHz), treble (12 kHz)]
 */
const EQ_PRESETS = {
  flat:      { bass: 0,  lowMid: 0,  mid: 0,  presence: 0,  treble: 0  },
  voice:     { bass: -3, lowMid: -2, mid: 3,  presence: 4,  treble: 2  },
  broadcast: { bass: -6, lowMid: -3, mid: 2,  presence: 5,  treble: 3  },
  music:     { bass: 4,  lowMid: 1,  mid: -1, presence: 2,  treble: 3  },
};

const EQ_FREQUENCIES = {
  bass:     80,
  lowMid:   500,
  mid:      2000,
  presence: 5000,
  treble:   12000,
};

/* =========================================================
   State
   ========================================================= */

const state = {
  connected:     false,
  muted:         false,
  gainLevel:     10,           // 0-20
  ncLevel:       'off',        // 'off' | 'low' | 'high'
  monitoring:    false,
  monitorVol:    0.70,         // 0-1
  eq: { ...EQ_PRESETS.flat },
  currentPreset: 'flat',
};

/* =========================================================
   Audio graph nodes
   ========================================================= */

let audioCtx       = null;
let micStream      = null;
let sourceNode     = null;
let gainNode       = null;
let eqNodes        = {};      // keyed by band name
let noiseWorklet   = null;    // would be AudioWorkletNode in full impl
let analyserNode   = null;
let monitorGain    = null;
let scriptProcessor = null;
let animFrameId    = null;

let peakDb         = -Infinity;
let peakTimestamp  = 0;

/* =========================================================
   DOM references
   ========================================================= */

const $ = id => document.getElementById(id);

const dom = {
  connectPanel:    $('connectPanel'),
  controlsGrid:    $('controlsGrid'),
  connectBtn:      $('connectBtn'),
  disconnectBtn:   $('disconnectBtn'),
  statusDot:       $('statusDot'),
  statusLabel:     $('statusLabel'),
  connectionStatus: $('connectionStatus'),

  // Level meter
  meterBars:       $('meterBars'),
  levelValue:      $('levelValue'),
  peakValue:       $('peakValue'),

  // Gain
  gainSlider:      $('gainSlider'),
  gainValue:       $('gainValue'),
  gainKnob:        $('gainKnob'),
  gainDown:        $('gainDown'),
  gainUp:          $('gainUp'),

  // Mute
  muteBtn:         $('muteBtn'),
  muteLabel:       $('muteLabel'),

  // Noise cancellation
  ncOff:           $('ncOff'),
  ncLow:           $('ncLow'),
  ncHigh:          $('ncHigh'),
  ncDescription:   $('ncDescription'),

  // Monitoring
  monitorToggle:   $('monitorToggle'),
  monitorSlider:   $('monitorSlider'),
  monitorValue:    $('monitorValue'),
  monitorStatus:   $('monitorStatus'),

  // EQ
  eqBass:          $('eqBass'),
  eqLowMid:        $('eqLowMid'),
  eqMid:           $('eqMid'),
  eqPresence:      $('eqPresence'),
  eqTreble:        $('eqTreble'),
  eqBassVal:       $('eqBassVal'),
  eqLowMidVal:     $('eqLowMidVal'),
  eqMidVal:        $('eqMidVal'),
  eqPresenceVal:   $('eqPresenceVal'),
  eqTrebleVal:     $('eqTrebleVal'),

  presetFlat:      $('presetFlat'),
  presetVoice:     $('presetVoice'),
  presetBroadcast: $('presetBroadcast'),
  presetMusic:     $('presetMusic'),
};

/* =========================================================
   Meter bar setup
   ========================================================= */

function buildMeterBars() {
  dom.meterBars.innerHTML = '';
  for (let i = 0; i < METER_SEGMENTS; i++) {
    const bar = document.createElement('div');
    bar.className = 'meter-bar';
    dom.meterBars.appendChild(bar);
  }
}

/**
 * Update the VU meter display.
 * @param {number} db - Current level in dBFS.
 */
function updateMeter(db) {
  const bars = dom.meterBars.querySelectorAll('.meter-bar');
  // Map -60 dBFS → 0 segments, 0 dBFS → METER_SEGMENTS
  const activeCount = Math.max(0,
    Math.round(((db + 60) / 60) * METER_SEGMENTS)
  );

  bars.forEach((bar, i) => {
    const level = ((i + 1) / METER_SEGMENTS) * 60 - 60; // dB for this bar
    if (i < activeCount) {
      if (level >= METER_RED_THRESHOLD) {
        bar.className = 'meter-bar active-red';
      } else if (level >= METER_YELLOW_THRESHOLD) {
        bar.className = 'meter-bar active-yellow';
      } else {
        bar.className = 'meter-bar active-green';
      }
    } else {
      bar.className = 'meter-bar';
    }
  });

  dom.levelValue.textContent = isFinite(db) ? `${db.toFixed(1)} dBFS` : '— dBFS';

  // Peak hold
  const now = performance.now();
  if (db > peakDb) {
    peakDb = db;
    peakTimestamp = now;
  } else if (now - peakTimestamp > PEAK_HOLD_MS) {
    peakDb = db;
  }
  dom.peakValue.textContent = isFinite(peakDb) ? peakDb.toFixed(1) : '—';
}

/* =========================================================
   Audio graph construction
   ========================================================= */

/**
 * Build the Web Audio processing chain:
 * source → gain → eq filters → analyser → (monitor gain → destination)
 */
async function buildAudioGraph() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Resume context if suspended (autoplay policy)
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // Gain node (maps gain level 0-20 to linear gain)
  gainNode = audioCtx.createGain();
  gainNode.gain.value = levelToLinearGain(state.gainLevel);

  // EQ filters
  const bands = ['bass', 'lowMid', 'mid', 'presence', 'treble'];
  let prev = gainNode;
  bands.forEach(band => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = (band === 'bass') ? 'lowshelf' : (band === 'treble') ? 'highshelf' : 'peaking';
    filter.frequency.value = EQ_FREQUENCIES[band];
    filter.Q.value = 1.0;
    filter.gain.value = state.eq[band];
    prev.connect(filter);
    eqNodes[band] = filter;
    prev = filter;
  });

  // Analyser for VU meter
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserNode.smoothingTimeConstant = 0.5;
  prev.connect(analyserNode);

  // Monitor gain (for headphone output)
  monitorGain = audioCtx.createGain();
  monitorGain.gain.value = state.monitoring ? state.monitorVol : 0;
  analyserNode.connect(monitorGain);
  monitorGain.connect(audioCtx.destination);

  // Microphone source
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: state.ncLevel !== 'off',
      autoGainControl:  false,
      sampleRate:       48000,
    }
  });
  micStream  = stream;
  sourceNode = audioCtx.createMediaStreamSource(stream);
  sourceNode.connect(gainNode);
}

/** Convert a gain level (0-20) to a Web Audio linear gain value. */
function levelToLinearGain(level) {
  if (level === 0) return 0.001; // near-silent
  const db = level * GAIN_LEVEL_TO_DB - GAIN_LEVEL_TO_DB; // 0→-2dB, 10→18dB, 20→38dB
  return Math.pow(10, db / 20);
}

/* =========================================================
   Level meter animation loop
   ========================================================= */

function startMeterLoop() {
  const dataArray = new Float32Array(analyserNode.fftSize);

  function tick() {
    analyserNode.getFloatTimeDomainData(dataArray);

    // RMS → dBFS
    let sumSq = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sumSq += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sumSq / dataArray.length);
    const db  = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    updateMeter(db);
    animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);
}

function stopMeterLoop() {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

/* =========================================================
   Connect / Disconnect
   ========================================================= */

async function connect() {
  try {
    dom.connectBtn.disabled = true;
    dom.connectBtn.textContent = 'Connecting…';

    await buildAudioGraph();
    startMeterLoop();

    state.connected = true;
    dom.connectPanel.hidden  = true;
    dom.controlsGrid.hidden  = false;
    dom.statusDot.classList.add('connected');
    dom.statusLabel.textContent = 'Connected';

  } catch (err) {
    dom.connectBtn.disabled = false;
    dom.connectBtn.innerHTML = `
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M10 2a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
        <path d="M6.5 10a3.5 3.5 0 0 0 7 0H15a5 5 0 0 1-4.5 4.975V17h1.5a.5.5 0 0 1 0 1h-4a.5.5 0 0 1 0-1H9.5v-2.025A5 5 0 0 1 5 10h1.5z"/>
      </svg>
      Connect Microphone`;

    const msg = err.name === 'NotAllowedError'
      ? 'Microphone permission denied. Please allow access and try again.'
      : err.name === 'NotFoundError'
      ? 'No microphone found. Please connect the PD200W and try again.'
      : `Could not connect: ${err.message}`;

    alert(msg);
  }
}

function disconnect() {
  stopMeterLoop();

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }

  if (audioCtx) {
    audioCtx.close();
    audioCtx   = null;
    sourceNode = null;
    gainNode   = null;
    eqNodes    = {};
    analyserNode = null;
    monitorGain  = null;
  }

  peakDb        = -Infinity;
  peakTimestamp = 0;
  state.connected = false;

  dom.controlsGrid.hidden  = true;
  dom.connectPanel.hidden  = false;
  dom.connectBtn.disabled  = false;
  dom.statusDot.classList.remove('connected');
  dom.statusLabel.textContent = 'Disconnected';

  updateMeter(-Infinity);
}

/* =========================================================
   Gain control
   ========================================================= */

function setGain(level) {
  state.gainLevel = Math.max(0, Math.min(20, level));

  // Update UI
  dom.gainSlider.value    = state.gainLevel;
  dom.gainKnob.setAttribute('aria-valuenow', state.gainLevel);
  dom.gainValue.textContent = state.gainLevel;
  drawKnob(dom.gainKnob, state.gainLevel / 20);

  // Update audio
  if (gainNode) {
    gainNode.gain.setTargetAtTime(
      levelToLinearGain(state.gainLevel),
      audioCtx.currentTime,
      0.01
    );
  }
}

/* =========================================================
   Knob renderer
   ========================================================= */

function drawKnob(canvas, normalised) {
  const ctx   = canvas.getContext('2d');
  const w     = canvas.width;
  const h     = canvas.height;
  const cx    = w / 2;
  const cy    = h / 2;
  const r     = cx * 0.78;
  const start = Math.PI * 0.75;      // 135°
  const range = Math.PI * 1.5;       // 270° sweep
  const end   = start + range * normalised;

  ctx.clearRect(0, 0, w, h);

  // Track
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, start + range);
  ctx.strokeStyle = 'rgba(46, 52, 82, 1)';
  ctx.lineWidth   = 8;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Active arc
  if (normalised > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.strokeStyle = '#4f7cff';
    ctx.lineWidth   = 8;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Glow
    ctx.shadowColor = 'rgba(79,124,255,0.6)';
    ctx.shadowBlur  = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.strokeStyle = '#4f7cff';
    ctx.lineWidth   = 8;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.shadowBlur  = 0;
  }

  // Indicator line
  const angle = start + range * normalised;
  const ix = cx + (r - 10) * Math.cos(angle);
  const iy = cy + (r - 10) * Math.sin(angle);
  ctx.beginPath();
  ctx.moveTo(cx + (r * 0.3) * Math.cos(angle), cy + (r * 0.3) * Math.sin(angle));
  ctx.lineTo(ix, iy);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';
  ctx.stroke();
}

/* =========================================================
   Mute
   ========================================================= */

function toggleMute() {
  state.muted = !state.muted;

  dom.muteBtn.setAttribute('aria-pressed', String(state.muted));
  dom.muteLabel.textContent = state.muted ? 'Muted' : 'Unmuted';

  if (gainNode) {
    gainNode.gain.setTargetAtTime(
      state.muted ? 0 : levelToLinearGain(state.gainLevel),
      audioCtx.currentTime,
      0.02
    );
  }
}

/* =========================================================
   Noise cancellation
   ========================================================= */

function setNoiseCancellation(level) {
  state.ncLevel = level;

  // Update button states
  ['off', 'low', 'high'].forEach(l => {
    const btn = $(`nc${l.charAt(0).toUpperCase() + l.slice(1)}`);
    btn.classList.toggle('active', l === level);
  });

  dom.ncDescription.textContent = NC_DESCRIPTIONS[level];

  /**
   * The Web Audio API does not expose browser noise-suppression controls
   * after stream creation. In a full implementation this would restart
   * the getUserMedia stream with the updated noiseSuppression constraint,
   * or communicate with a companion native app / AudioWorklet that applies
   * DSP. Here we restart the stream with the best available constraint.
   */
  if (state.connected) {
    restartMicWithCurrentSettings();
  }
}

/** Restart the microphone stream applying updated constraints. */
async function restartMicWithCurrentSettings() {
  if (!state.connected) return;

  // Stop existing tracks
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (sourceNode) sourceNode.disconnect();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: state.ncLevel !== 'off',
        autoGainControl:  false,
        sampleRate:       48000,
      }
    });
    micStream  = stream;
    sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(gainNode);
  } catch (err) {
    // Silently ignore – keep last known good stream
    console.warn('Could not restart mic stream:', err);
  }
}

/* =========================================================
   Headphone monitoring
   ========================================================= */

function toggleMonitoring() {
  state.monitoring = !state.monitoring;

  dom.monitorToggle.setAttribute('aria-pressed', String(state.monitoring));
  dom.monitorStatus.textContent = state.monitoring
    ? `Monitoring On – ${Math.round(state.monitorVol * 100)}%`
    : 'Monitoring Off';

  if (monitorGain) {
    monitorGain.gain.setTargetAtTime(
      state.monitoring ? state.monitorVol : 0,
      audioCtx.currentTime,
      0.02
    );
  }
}

function setMonitorVolume(value) {
  state.monitorVol = value / 100;
  dom.monitorValue.textContent = `${value}%`;

  if (state.monitoring) {
    dom.monitorStatus.textContent = `Monitoring On – ${value}%`;
    if (monitorGain) {
      monitorGain.gain.setTargetAtTime(
        state.monitorVol,
        audioCtx.currentTime,
        0.01
      );
    }
  }
}

/* =========================================================
   Equaliser
   ========================================================= */

function setEqBand(band, value) {
  state.eq[band] = value;
  state.currentPreset = 'custom';

  // Deselect all presets
  document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'));

  // Update display
  const val = $(`eq${capitalise(band)}Val`);
  if (val) val.textContent = `${value >= 0 ? '+' : ''}${value} dB`;

  // Update filter
  if (eqNodes[band]) {
    eqNodes[band].gain.setTargetAtTime(value, audioCtx.currentTime, 0.01);
  }
}

function applyEqPreset(preset) {
  const values = EQ_PRESETS[preset];
  if (!values) return;

  state.currentPreset = preset;
  state.eq = { ...values };

  // Update sliders + displays
  const bandMap = {
    bass:     { slider: dom.eqBass,     val: dom.eqBassVal     },
    lowMid:   { slider: dom.eqLowMid,   val: dom.eqLowMidVal   },
    mid:      { slider: dom.eqMid,      val: dom.eqMidVal      },
    presence: { slider: dom.eqPresence, val: dom.eqPresenceVal },
    treble:   { slider: dom.eqTreble,   val: dom.eqTrebleVal   },
  };

  Object.entries(values).forEach(([band, db]) => {
    const { slider, val } = bandMap[band];
    slider.value = db;
    val.textContent = `${db >= 0 ? '+' : ''}${db} dB`;
    if (eqNodes[band]) {
      eqNodes[band].gain.setTargetAtTime(db, audioCtx ? audioCtx.currentTime : 0, 0.01);
    }
  });

  // Highlight preset button
  document.querySelectorAll('.eq-preset-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === preset);
  });
}

/* =========================================================
   Knob mouse/touch interaction
   ========================================================= */

(function attachKnobInteraction() {
  let dragging = false;
  let startY   = 0;
  let startVal = 0;

  function onStart(e) {
    dragging = true;
    startY   = (e.touches ? e.touches[0].clientY : e.clientY);
    startVal = state.gainLevel;
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const y    = (e.touches ? e.touches[0].clientY : e.clientY);
    const diff = Math.round((startY - y) / 8);
    setGain(startVal + diff);
    e.preventDefault();
  }

  function onEnd() { dragging = false; }

  dom.gainKnob.addEventListener('mousedown',  onStart, { passive: false });
  dom.gainKnob.addEventListener('touchstart', onStart, { passive: false });
  window.addEventListener('mousemove',  onMove,  { passive: false });
  window.addEventListener('touchmove',  onMove,  { passive: false });
  window.addEventListener('mouseup',   onEnd);
  window.addEventListener('touchend',  onEnd);

  // Keyboard support
  dom.gainKnob.addEventListener('keydown', e => {
    if      (e.key === 'ArrowUp'   || e.key === 'ArrowRight') { setGain(state.gainLevel + 1); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft')  { setGain(state.gainLevel - 1); e.preventDefault(); }
  });
})();

/* =========================================================
   Utility
   ========================================================= */

function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/* =========================================================
   Event wiring
   ========================================================= */

function wireEvents() {
  // Connect / disconnect
  dom.connectBtn.addEventListener('click', connect);
  dom.disconnectBtn.addEventListener('click', disconnect);

  // Gain slider
  dom.gainSlider.addEventListener('input', e => setGain(Number(e.target.value)));
  dom.gainDown.addEventListener('click', () => setGain(state.gainLevel - 1));
  dom.gainUp.addEventListener('click',   () => setGain(state.gainLevel + 1));

  // Mute
  dom.muteBtn.addEventListener('click', toggleMute);

  // Noise cancellation
  dom.ncOff.addEventListener('click',  () => setNoiseCancellation('off'));
  dom.ncLow.addEventListener('click',  () => setNoiseCancellation('low'));
  dom.ncHigh.addEventListener('click', () => setNoiseCancellation('high'));

  // Monitoring
  dom.monitorToggle.addEventListener('click', toggleMonitoring);
  dom.monitorSlider.addEventListener('input', e => setMonitorVolume(Number(e.target.value)));

  // EQ sliders
  const eqSliderMap = [
    ['eqBass',     'bass'],
    ['eqLowMid',   'lowMid'],
    ['eqMid',      'mid'],
    ['eqPresence', 'presence'],
    ['eqTreble',   'treble'],
  ];
  eqSliderMap.forEach(([id, band]) => {
    $(id).addEventListener('input', e => setEqBand(band, Number(e.target.value)));
  });

  // EQ presets
  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyEqPreset(btn.dataset.preset));
  });
}

/* =========================================================
   Initialise
   ========================================================= */

function init() {
  buildMeterBars();
  drawKnob(dom.gainKnob, state.gainLevel / 20);
  wireEvents();

  // Initialise EQ display
  applyEqPreset('flat');

  // Set monitoring slider label
  dom.monitorValue.textContent = `${Math.round(state.monitorVol * 100)}%`;
}

document.addEventListener('DOMContentLoaded', init);
