// =====================
// Utility helpers
// =====================
function $(id) { return document.getElementById(id); }
function setVisible(el, on) { el.style.display = on ? "" : "none"; }
function setMsg(txt) { const m = $("msg"); if (m) m.textContent = txt || ""; }
function apiUrl(p){ return new URL(p, window.location.href).toString(); }

// Try to HEAD a URL to see if it exists
async function headExists(url) {
  try {
    const r = await fetch(url, { method: "HEAD", cache: "no-store" });
    return r.ok;
  } catch { return false; }
}

// =====================
// DOM refs
// =====================
const imageUpload = $("imageUpload");
const originalImageContainer = $("originalImageContainer");
const originalImage = $("originalImage");

const modulationCheckbox = $("modulationCheckbox");
const modulationControls = $("modulationControls");
const numBandsInput = $("numBands");
const modulationSliders = $("modulationSliders");

const equalisationCheckbox = $("equalisationCheckbox");
const equalisationControls = $("equalisationControls");
const gammaInput = $("gamma");
const alphaInput = $("alpha");
const bandSignSelect = $("band_sign");

const themeSelector = $("themeSelector");
const musicCheckbox = $("musicCheckbox");
const audioEl = $("bgm");

const processButton = $("processButton");
const outputImageContainer = $("outputImageContainer");
const outputImage = $("outputImage");

// =====================
// App state
// =====================
let gains = []; // modulation control points

// =====================
// Theme + Music
// =====================
function currentThemeMusicUrl() {
  const mode = themeSelector.value === "dark" ? "dark" : "light";
  // Prefer explicit endpoints if you added them in app.py; else fallback to static files.
  const endpoint = mode === "dark" ? "/music/dark" : "/music/light";
  const staticUrl = mode === "dark" ? "/static/bgm_dark.mp3" : "/static/bgm_light.mp3";
  // Add a cache-buster to avoid stale cached responses during dev
  return { endpoint: `${endpoint}?v=${Date.now()}`, fallback: `${staticUrl}?v=${Date.now()}` };
}

async function setAudioSrcForTheme(autoPlayIfChecked = true) {
  const { endpoint, fallback } = currentThemeMusicUrl();
  // Try endpoint first
  let src = endpoint;
  if (!(await headExists(endpoint))) {
    // Fall back to static URL
    if (await headExists(fallback)) {
      src = fallback;
    } else {
      // Neither exists; stop music
      audioEl.pause();
      musicCheckbox.checked = false;
      return;
    }
  }
  const wasPlaying = !audioEl.paused && !audioEl.ended;
  audioEl.pause();
  audioEl.src = src;
  audioEl.load();

  if (musicCheckbox.checked && autoPlayIfChecked) {
    try {
      audioEl.muted = false;
      audioEl.volume = 0.8;
      await audioEl.play();
    } catch {
      // Gesture may be needed; uncheck and show a gentle message in console
      musicCheckbox.checked = false;
      console.warn("Autoplay blocked — user must click the music checkbox to start playback.");
    }
  }
}

function applyTheme() {
  const mode = themeSelector.value === "dark" ? "dark" : "bright";
  document.body.classList.toggle("bright-mode", mode === "bright"); // if you use CSS classes
  document.body.classList.toggle("dark-mode", mode === "dark");
  // If you rely on CSS variables, attach the class the CSS expects (e.g., .theme-dark)
  document.body.classList.toggle("theme-dark", mode === "dark");
  // Swap music source for theme
  setAudioSrcForTheme(true);
}

// =====================
// Image upload + UI gating
// =====================
function updateProcessButtonState() {
  const imageLoaded = !!imageUpload.files.length;
  const anyEnabled = modulationCheckbox.checked || equalisationCheckbox.checked;
  setVisible(processButton, imageLoaded);
  processButton.disabled = !(imageLoaded && anyEnabled);
}

imageUpload.addEventListener("change", () => {
  setMsg("");
  const f = imageUpload.files[0];
  const has = !!f;
  setVisible(originalImageContainer, has);
  setVisible(processButton, has);
  if (has) {
    originalImage.src = URL.createObjectURL(f);
  } else {
    originalImage.src = "";
  }
  // Hide output until processed
  setVisible(outputImageContainer, false);
  updateProcessButtonState();
});

// =====================
// Modulation UI
// =====================
function renderModulationSliders() {
  const N = Math.max(1, Math.min(10, parseInt(numBandsInput.value || "5", 10)));
  if (!Array.isArray(gains) || gains.length !== N) {
    gains = Array(N).fill(1.0);
  }
  modulationSliders.innerHTML = "";

  // Create vertical sliders
  for (let i = 0; i < N; i++) {
    const wrapper = document.createElement("div");
    wrapper.style.display = "inline-flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.marginRight = "10px";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "10";
    slider.step = "0.05";
    slider.value = String(gains[i]);
    // vertical styling (works cross-browser reasonably)
    slider.style.writingMode = "bt-lr";
    slider.style.webkitAppearance = "slider-vertical";
    slider.style.height = "150px";
    slider.style.width = "28px";

    const label = document.createElement("div");
    label.style.fontSize = "11px";
    label.style.marginTop = "6px";
    label.textContent = `b${i + 1}: ${(+gains[i]).toFixed(2)}`;

    slider.addEventListener("input", (e) => {
      let val = parseFloat(e.target.value);
      if (Math.abs(val - 1.0) < 0.05) val = 1.0; // snap near 1.0
      gains[i] = val;
      label.textContent = `b${i + 1}: ${val.toFixed(2)}`;
    });

    wrapper.appendChild(slider);
    wrapper.appendChild(label);
    modulationSliders.appendChild(wrapper);
  }
}

modulationCheckbox.addEventListener("change", () => {
  setVisible(modulationControls, modulationCheckbox.checked);
  if (modulationCheckbox.checked) {
    renderModulationSliders();
  }
  updateProcessButtonState();
});
numBandsInput.addEventListener("change", () => {
  // Reset gains when number of bands changes
  gains = [];
  renderModulationSliders();
});

// =====================
// Equalisation UI
// =====================
equalisationCheckbox.addEventListener("change", () => {
  setVisible(equalisationControls, equalisationCheckbox.checked);
  updateProcessButtonState();
});

// =====================
// Music toggle
// =====================
musicCheckbox.addEventListener("change", async () => {
  if (musicCheckbox.checked) {
    // Ensure source is set for current theme and try to play
    await setAudioSrcForTheme(false);
    try {
      audioEl.muted = false;
      audioEl.volume = 0.8;
      await audioEl.play();
    } catch {
      console.warn("Autoplay blocked — click the checkbox again.");
      musicCheckbox.checked = false;
    }
  } else {
    audioEl.pause();
  }
});

// =====================
// Theme selector
// =====================
themeSelector.addEventListener("change", applyTheme);

// =====================
// Processing
// =====================
processButton.addEventListener("click", async () => {
  if (!imageUpload.files.length) return;
  const f = imageUpload.files[0];
  setMsg("");

  // Build form-data matching the backend /api/process
  const do_mod = modulationCheckbox.checked;
  const do_eq = equalisationCheckbox.checked;

  if (!do_mod && !do_eq) {
    setMsg("Enable modulation and/or equalisation first.");
    return;
  }

  processButton.disabled = true;

  try {
    const fd = new FormData();
    fd.append("file", f);

    // Equalisation params (only if enabled)
    fd.append("do_equalize", do_eq ? "true" : "false");
    if (do_eq) {
      const gamma = parseFloat(gammaInput.value || "1.0");
      const alpha = parseFloat(alphaInput.value || "1.0");
      // Map UI values to backend expected strings
      let bandSign = bandSignSelect.value;
      // Support both styles: if you used "positive/negative" in HTML, map to dog/literal.
      if (bandSign === "positive") bandSign = "dog";
      if (bandSign === "negative") bandSign = "literal";

      fd.append("gamma", String(gamma));
      fd.append("alpha", String(alpha));
      fd.append("band_sign", bandSign);
      // Preserve mean default true on server in our earlier code; pass it explicitly if you need:
      fd.append("preserve_mean", "true");
    } else {
      // still pass preserve_mean for mod-only path if your backend expects it
      fd.append("preserve_mean", "true");
    }

    // Modulation params (only if enabled)
    fd.append("do_modulation", do_mod ? "true" : "false");
    if (do_mod) {
      const N = gains.length || Math.max(1, Math.min(10, parseInt(numBandsInput.value || "5", 10)));
      if (gains.length !== N) {
        gains = Array(N).fill(1.0);
      }
      const gains_csv = gains.map(v => (+v).toFixed(3)).join(",");
      fd.append("n_controls", String(N));
      fd.append("gains_csv", gains_csv);
    }

    const r = await fetch(apiUrl("api/process"), { method: "POST", body: fd });
    if (!r.ok) {
      const t = await r.text().catch(() => "(no details)");
      throw new Error(t);
    }
    const data = await r.json();
    if (!data || !data.output_b64) {
      throw new Error("No output returned.");
    }
    const outUrl = "data:image/png;base64," + data.output_b64;

    outputImage.src = outUrl;
    setVisible(outputImageContainer, true);
    setMsg("");

  } catch (err) {
    console.error(err);
    setMsg("Error: " + (err?.message || String(err)));
  } finally {
    processButton.disabled = false;
  }
});

// =====================
// Init
// =====================
(function init(){
  // Start with panels hidden
  setVisible(modulationControls, false);
  setVisible(equalisationControls, false);
  setVisible(originalImageContainer, false);
  setVisible(outputImageContainer, false);

  // Music starts OFF
  musicCheckbox.checked = false;

  // Theme default: bright
  themeSelector.value = "bright";
  applyTheme();

  // Ensure process button is initially hidden/disabled
  setVisible(processButton, false);
  processButton.disabled = true;
})();
