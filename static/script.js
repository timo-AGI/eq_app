// =====================
// Utility helpers
// =====================
function $(id) { return document.getElementById(id); }
function setVisible(el, on) { el.style.display = on ? "" : "none"; }
function setMsg(txt) { const m = $("msg"); if (m) m.textContent = txt || ""; }
function apiUrl(p){ return new URL(p, window.location.href).toString(); }

// Try to probe a URL (HEAD first, then tiny GET fallback)
async function headExists(url) {
  try {
    const r = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (r.ok) return true;
  } catch {}
  try {
    const r2 = await fetch(url, { method: "GET", cache: "no-store" });
    return r2.ok;
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
// Theme + Music (no awaits before play)
// =====================
function currentThemeMusicUrl() {
  const dark = themeSelector.value === "dark";
  return {
    endpoint: dark ? "/music/dark" : "/music/light",
    fallback: dark ? "/static/bgm_dark.mp3" : "/static/bgm_light.mp3",
  };
}

// Try endpoint first; if it errors, swap to fallback automatically.
function wireAudioErrorFallback() {
  audioEl.addEventListener("error", () => {
    const { fallback } = currentThemeMusicUrl();
    if (!audioEl.dataset._fellBack) {
      audioEl.dataset._fellBack = "1";
      audioEl.src = fallback + "?v=" + Date.now();
      audioEl.load();
      // if we were trying to play, keep trying
      audioEl.play().catch(() => {/* ignore; user may need to click again */});
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
    setMsg && setMsg("Music playing.");
  }).catch(() => {
    // Browser still blocked it; user may need to click once more
    setMsg && setMsg("Autoplay blocked — click the music checkbox again.");
    musicCheckbox.checked = false;
  });
}

themeSelector.addEventListener("change", () => {
  setThemeClasses();
  if (musicCheckbox.checked) {
    // change track immediately, still no awaits
    startMusicForTheme();
  }
});

musicCheckbox.addEventListener("change", () => {
  if (musicCheckbox.checked) {
    startMusicForTheme(); // no awaits, called directly on click
  } else {
    audioEl.pause();
    setMsg && setMsg("Music stopped.");
  }
});

// Init theme once (don’t auto-play)
(function initThemeOnce(){
  setThemeClasses();
})();
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
  if (has) originalImage.src = URL.createObjectURL(f);
  else originalImage.src = "";
  setVisible(outputImageContainer, false);
  updateProcessButtonState();
});

// =====================
// Modulation UI
// =====================
function renderModulationSliders() {
  const N = Math.max(1, Math.min(10, parseInt(numBandsInput.value || "5", 10)));
  if (!Array.isArray(gains) || gains.length !== N) gains = Array(N).fill(1.0);
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
      if (Math.abs(val - 1.0) < 0.05) val = 1.0;
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
  if (modulationCheckbox.checked) renderModulationSliders();
  updateProcessButtonState();
});
numBandsInput.addEventListener("change", () => { gains = []; renderModulationSliders(); });

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
    await setAudioSrcForTheme(false);
    try {
      audioEl.muted = false;
      audioEl.volume = 0.8;
      await audioEl.play();
      setMsg("Music playing.");
    } catch {
      console.warn("Autoplay blocked — click the checkbox again.");
      setMsg("Autoplay blocked — click the checkbox again.");
      musicCheckbox.checked = false;
    }
  } else {
    audioEl.pause();
    setMsg("Music stopped.");
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

    fd.append("do_modulation", do_mod ? "true" : "false");
    if (do_mod) {
      const N = gains.length || Math.max(1, Math.min(10, parseInt(numBandsInput.value || "5", 10)));
      if (gains.length !== N) gains = Array(N).fill(1.0);
      const gains_csv = gains.map(v => (+v).toFixed(3)).join(",");
      fd.append("n_controls", String(N));
      fd.append("gains_csv", gains_csv);
    }

    const r = await fetch(apiUrl("api/process"), { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text().catch(() => "(no details)"));
    const data = await r.json();
    if (!data || !data.output_b64) throw new Error("No output returned.");

    outputImage.src = "data:image/png;base64," + data.output_b64;
    setVisible(outputImageContainer, true);
    setMsg("Done.");

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
  setVisible(modulationControls, false);
  setVisible(equalisationControls, false);
  setVisible(originalImageContainer, false);
  setVisible(outputImageContainer, false);

  musicCheckbox.checked = false;

  themeSelector.value = "bright";
  applyTheme();

  setVisible(processButton, false);
  processButton.disabled = true;
})();
