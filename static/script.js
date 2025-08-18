// =====================
// Tiny DOM helpers
// =====================
function $(id) { return document.getElementById(id); }
function setVisible(elOrId, on) {
  const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
  if (!el) return;
  el.style.display = on ? "" : "none";
}
function setMsg(txt) { const m = $("msg"); if (m) m.textContent = txt || ""; }
function apiUrl(p){ return new URL(p, window.location.href).toString(); }

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
const imageCompare = $("imageCompare");
const outputImageContainer = $("outputImageContainer");
const outputImage = $("outputImage");

// =====================
// App state
// =====================
let gains = []; // modulation control points

// =====================
// Theme + Music (no awaits before play)
// =====================
function currentThemeMusicUrl() {
  const dark = themeSelector.value === "dark";
  return {
    endpoint: dark ? "/music/dark" : "/music/light",
    fallback: dark ? "/static/bgm_dark.mp3" : "/static/bgm_light.mp3",
  };
}

// On error, fall back to static asset automatically
function wireAudioErrorFallback() {
  audioEl.addEventListener("error", () => {
    const { fallback } = currentThemeMusicUrl();
    if (!audioEl.dataset._fellBack) {
      audioEl.dataset._fellBack = "1";
      audioEl.src = fallback + "?v=" + Date.now();
      audioEl.load();
      audioEl.play().catch(() => { /* user might need to click again */ });
    }
  });
}
wireAudioErrorFallback();

function setThemeClasses() {
  const dark = themeSelector.value === "dark";
  document.body.classList.toggle("bright-mode", !dark);
  document.body.classList.toggle("dark-mode", dark);
  document.body.classList.toggle("theme-dark", dark);
}

function startMusicForTheme() {
  // IMPORTANT: no awaits here — keep the user activation alive
  const { endpoint } = currentThemeMusicUrl();
  audioEl.dataset._fellBack = ""; // reset fallback flag
  audioEl.src = endpoint + "?v=" + Date.now();
  audioEl.load();
  audioEl.muted = false;
  audioEl.volume = 0.8;
  audioEl.play().then(() => {
    setMsg("Music playing.");
  }).catch(() => {
    setMsg("Autoplay blocked — click the music checkbox again.");
    musicCheckbox.checked = false;
  });
}

themeSelector.addEventListener("change", () => {
  setThemeClasses();
  if (musicCheckbox.checked) {
    startMusicForTheme(); // swap track synchronously
  }
});

musicCheckbox.addEventListener("change", () => {
  if (musicCheckbox.checked) {
    startMusicForTheme(); // called directly on click
  } else {
    audioEl.pause();
    setMsg("Music stopped.");
  }
});

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
  if (has) {
    originalImage.src = URL.createObjectURL(f);
    setVisible(imageCompare, true);      // show side-by-side wrapper
  } else {
    originalImage.src = "";
    setVisible(imageCompare, false);
  }
  // Do not hide output container if you want to keep last result visible when new file chosen:
  // setVisible(outputImageContainer, false);
  updateProcessButtonState();
});

// =====================
// Modulation UI
// =====================
function renderModulationSliders() {
  const N = Math.max(1, Math.min(10, parseInt(numBandsInput.value || "5", 10)));
  if (!Array.isArray(gains) || gains.length !== N) gains = Array(N).fill(1.0);
  modulationSlersHTML();
  function modulationSlersHTML(){
    modulationSliders.innerHTML = "";
    for (let i = 0; i < N; i++) {
      const wrapper = document.createElement("div");
      wrapper.style.display = "inline-flex";
      wrapper.style.flexDirection = "column";
      wrapper.style.alignItems = "center";

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "10";
      slider.step = "0.05";
      slider.value = String(gains[i]);
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
        if (Math.abs(val - 1.0) < 0.05) val = 1.0; // snap to 1
        gains[i] = val;
        label.textContent = `b${i + 1}: ${val.toFixed(2)}`;
      });

      wrapper.appendChild(slider);
      wrapper.appendChild(label);
      modulationSliders.appendChild(wrapper);
    }
  }
}

modulationCheckbox.addEventListener("change", () => {
  setVisible(modulationControls, modulationCheckbox.checked);
  if (modulationCheckbox.checked) renderModulationSliders();
  updateProcessButtonState();
});

numBandsInput.addEventListener("change", () => {
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
// Processing
// =====================
processButton.addEventListener("click", async () => {
  if (!imageUpload.files.length) return;
  const f = imageUpload.files[0];
  setMsg("");

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

    // Equalisation params
    fd.append("do_equalize", do_eq ? "true" : "false");
    if (do_eq) {
      const gamma = parseFloat(gammaInput.value || "1.0");
      const alpha = parseFloat(alphaInput.value || "1.0");
      let bandSign = bandSignSelect.value;
      if (bandSign === "positive") bandSign = "dog";
      if (bandSign === "negative") bandSign = "literal";
      fd.append("gamma", String(gamma));
      fd.append("alpha", String(alpha));
      fd.append("band_sign", bandSign);
      fd.append("preserve_mean", "true");
    } else {
      fd.append("preserve_mean", "true");
    }

    // Modulation params
    fd.append("do_modulation", do_mod ? "true" : "false");
    if (do_mod) {
      const N = gains.length || Math.max(1, Math.min(10, parseInt(numBandsInput.value || "5", 10)));
      if (gains.length !== N) gains = Array(N).fill(1.0);
      const gains_csv = gains.map(v => (+v).toFixed(3)).join(",");
      fd.append("n_controls", String(N));
      fd.append("gains_csv", gains_csv);
    }

    const r = await fetch(apiUrl("api/process"),
