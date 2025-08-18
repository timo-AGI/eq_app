// ---------- Small helpers ----------
function apiUrl(p){ return new URL(p, window.location.href).toString(); }
function setMsg(t){ document.getElementById('msg').textContent = t || ''; }
function syncVal(id){
  const v = document.getElementById(id).value;
  const span = document.getElementById(id + '_val');
  if (span) span.textContent = (+v).toFixed(2);
}

// ---------- Global refs ----------
const bodyEl = document.body;
const themeSelect = document.getElementById('themeSelect');
const audio  = document.getElementById('bgm');
const toggle = document.getElementById('bgmToggle');
const note   = document.getElementById('musicNote');

const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');
const origCard = document.getElementById('origCard');
const outCard = document.getElementById('outCard');
const imgOriginal = document.getElementById('imgOriginal');
const imgOutput = document.getElementById('imgOutput');
const downloadLinkOut = document.getElementById('downloadLinkOut');
const overlayOutChk = document.getElementById('overlayOut');
const overlayBoxOut = document.getElementById('overlayBoxOut');

const enableMod = document.getElementById('enable_mod');
const enableEq  = document.getElementById('enable_eq');
const modWrap = document.getElementById('modWrap');
const eqWrap  = document.getElementById('eqWrap');

const applyKnobsBtn = document.getElementById('applyKnobsBtn');
const nControlsEl = document.getElementById('n_controls');
const curveCanvas = document.getElementById('curveCanvas');
const slidersRow = document.getElementById('slidersRow');

const alpha = document.getElementById('alpha');
const gamma = document.getElementById('gamma');
const band_sign = document.getElementById('band_sign');
const preserve_mean = document.getElementById('preserve_mean');

const progressWrap = document.getElementById('progressWrap');

// ---------- Music toggle (start OFF by default) ----------
function setNote(txt = "", isError = false) {
  note.textContent = txt;
  note.classList.toggle('hide', !txt);
  note.style.color = isError ? '#b00' : 'var(--muted)';
}


// Always start unchecked
toggle.checked = false;

function currentThemeBgmSrc(){
  const mode = document.getElementById('themeSelect').value;
  // use the explicit endpoints; add a cache-buster in case browser cached a bad response
  const base = (mode === 'dark') ? '/music/dark' : '/music/light';
  return `${base}?v=${Date.now()}`;
}

// switch audio file (if playing, continue playing new file)
async function switchBgmForTheme(){
  const wasPlaying = !audio.paused && !audio.ended;
  audio.pause();
  audio.src = currentThemeBgmSrc();
  audio.load();
  if (toggle.checked && wasPlaying){
    try {
      await audio.play();
      setNote('Playing…');
    } catch (e) {
      setNote('Autoplay blocked — toggle again.', true);
      toggle.checked = false;
    }
  } else {
    setNote('');
  }
}

toggle.addEventListener('change', async () => {
  if (toggle.checked) {
    audio.src = currentThemeBgmSrc();
    audio.muted = false;
    audio.volume = 0.5;
    audio.currentTime = 0;
    audio.load();
    try {
      await audio.play();
      setNote('Playing…');
    } catch (e) {
      setNote('Autoplay blocked — toggle again.', true);
      toggle.checked = false;
    }
  } else {
    audio.pause();
    setNote('');
  }
});

// ---------- Theme handling ----------
let chart = null;        // Chart.js instance
let gains = [];          // modulation controls
let kernels = [];        // kernel sizes for x ticks
let nBands = 0;

function applyTheme(){
  const mode = themeSelect.value;
  bodyEl.classList.toggle('theme-dark', mode === 'dark');

  // Recolor chart axes/labels/grid
  if (chart){
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#111';
    const grid = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#e5e5e5';
    chart.options.scales.x.ticks.color = fg;
    chart.options.scales.y.ticks.color = fg;
    chart.options.scales.x.grid.color = grid;
    chart.options.scales.y.grid.color = grid;
    chart.options.scales.x.title.color = fg;
    chart.options.scales.y.title.color = fg;
    chart.update();
  }

  // swap music file to match theme
  switchBgmForTheme();
}

themeSelect.addEventListener('change', applyTheme);

// ---------- App logic ----------
fileInput.addEventListener('change', onImageChosen);
enableMod.addEventListener('change', () => { toggleSection(modWrap, enableMod.checked); updateProcessEnabled(); if (enableMod.checked){ if (!gains.length) applyKnobs(); else { renderChart(); updateChartData(); } }});
enableEq.addEventListener('change',  () => { toggleSection(eqWrap,  enableEq.checked); updateProcessEnabled(); });
applyKnobsBtn.addEventListener('click', applyKnobs);
alpha.addEventListener('input', () => syncVal('alpha'));
gamma.addEventListener('input', () => syncVal('gamma'));
processBtn.addEventListener('click', process);

function toggleSection(el, on){ el.classList.toggle('hide', !on); }
function canProcess(){
  const hasImage = !!fileInput.files.length;
  const anyCheck = enableMod.checked || enableEq.checked;
  return hasImage && anyCheck;
}
function updateProcessEnabled(){
  const hasImage = !!fileInput.files.length;
  processBtn.classList.toggle('hide', !hasImage);
  processBtn.disabled = !canProcess();
}
function onImageChosen(){
  setMsg('');
  const f=fileInput.files[0];
  const hasImage = !!f;
  origCard.classList.toggle('hide', !hasImage);
  processBtn.classList.toggle('hide', !hasImage);
  if(hasImage){
    imgOriginal.src = URL.createObjectURL(f);
  }else{
    imgOriginal.src = "";
  }
  updateProcessEnabled();
}
function setBusy(b){
  processBtn.disabled = b || !canProcess();
  fileInput.disabled = b;
  progressWrap.style.display = b ? 'inline-flex' : 'none';
}

// ---------- Modulation controls + Chart ----------
const unityLine = {
  id: 'unityLine',
  afterDraw(chart, args, opts) {
    const yScale = chart.scales.y;
    const ctx = chart.ctx;
    const y = yScale.getPixelForValue(1);
    ctx.save();
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
    ctx.setLineDash([5,4]);
    ctx.beginPath();
    ctx.moveTo(chart.chartArea.left, y);
    ctx.lineTo(chart.chartArea.right, y);
    ctx.stroke();
    ctx.restore();
  }
};

function applyKnobs(){
  const N = Math.max(3, Math.min(10, parseInt(nControlsEl.value||5,10)));
  gains = Array(N).fill(1.0);
  renderSliders();
  renderChart();
  updateChartData();
}
function renderSliders(){
  slidersRow.innerHTML = '';
  gains.forEach((v,i)=>{
    const col = document.createElement('div');
    col.className = 'knobCol';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '10'; slider.step = '0.05';
    slider.value = String(v);
    slider.oninput = (e)=>{
      let val = parseFloat(e.target.value);
      if (Math.abs(val - 1.0) < 0.05) val = 1.0;
      gains[i] = val;
      e.target.value = String(val);
      label.textContent = `b${i+1}: ${gains[i].toFixed(2)}`;
      updateChartData();
    };

    const label = document.createElement('div');
    label.className = 'knobLabel';
    label.textContent = `b${i+1}: ${v.toFixed(2)}`;

    col.appendChild(slider);
    col.appendChild(label);
    slidersRow.appendChild(col);
  });
}
function makeInterpolatedCurve(){
  const nb = nBands || gains.length;
  if (!nb || !gains.length) return [];
  const xCtrl = gains.length === 1 ? [0] : linspace(0, nb-1, gains.length);
  const xs = Array.from({length: nb}, (_,i)=> i);
  const ys = interp1(xCtrl, gains, xs);
  return xs.map((x,i)=> ({x, y: ys[i]}));
}
function controlDatasetPoints(){
  const nb = nBands || gains.length;
  if (!nb || !gains.length) return [];
  const xCtrl = gains.length === 1 ? [0] : linspace(0, nb-1, gains.length);
  return xCtrl.map((x,i)=> ({x, y: gains[i]}));
}
function renderChart(){
  if (!enableMod.checked) return;
  const ctx = curveCanvas.getContext('2d');
  if (chart){ chart.destroy(); }
  const nb = nBands || gains.length;

  const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#111';
  const grid = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#e5e5e5';

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        { label:'Interpolated', data: makeInterpolatedCurve(), borderWidth:2, pointRadius:0, fill:false, tension:0.0 },
        { label:'Controls',     data: controlDatasetPoints(),  borderWidth:2, pointRadius:3, fill:false, tension:0.0 }
      ]
    },
    plugins: [unityLine],
    options: {
      animation: false, responsive: false, parsing: false,
      scales: {
        x: {
          type: 'linear', min: 0, max: Math.max(0, nb-1),
          ticks: {
            color: fg,
            callback: (val) => {
              const idx = Math.round(val);
              if (idx < 0) return '';
              if (kernels && kernels.length && idx < kernels.length) {
                if (idx % 2 === 1) return '';
                return `${kernels[idx]}×${kernels[idx]}`;
              } else {
                return (idx % 1 === 0) ? `b${idx+1}` : '';
              }
            }
          },
          grid: { color: grid },
          title:{display:true, text:'Bands', color: fg}
        },
        y: { min: 0, max: 10, title:{display:true, text:'Gain (0..10)', color: fg}, ticks: { color: fg }, grid: { color: grid } }
      },
      plugins: { legend: { display: false } }
    }
  });
}
function updateChartData(){
  if (!chart) return;
  chart.options.scales.x.max = Math.max(0, (nBands || gains.length) - 1);
  chart.data.datasets[0].data = makeInterpolatedCurve();
  chart.data.datasets[1].data = controlDatasetPoints();
  chart.update();
}

// ---------- Math helpers ----------
function linspace(a,b,n){
  if (n===1) return [a];
  const step=(b-a)/(n-1);
  return Array.from({length:n},(_,i)=> a + i*step);
}
function interp1(x, y, xq){
  const n = x.length, res = [];
  for (const q of xq){
    if (q <= x[0]) { res.push(y[0]); continue; }
    if (q >= x[n-1]) { res.push(y[n-1]); continue; }
    let j=1; while (j<n && x[j] < q) j++;
    const x0=x[j-1], x1=x[j], y0=y[j-1], y1=y[j];
    const t = (q - x0) / (x1 - x0);
    res.push(y0 + t*(y1 - y0));
  }
  return res;
}

// ---------- Processing ----------
async function process(){
  if (!canProcess()) return;
  outCard.classList.add('hide');

  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), 180000);
  try{
    setMsg('');
    const file = fileInput.files[0];
    if (!file){ setMsg("Choose an image first."); return; }
    setBusy(true);

    const do_mod = enableMod.checked;
    const do_eq  = enableEq.checked;
    const gains_csv = (do_mod && gains.length) ? gains.map(v=> v.toFixed(3)).join(',') : '';

    const fd = new FormData();
    fd.append("file", file);

    fd.append("do_equalize", do_eq ? "true" : "false");
    if (do_eq){
      fd.append("alpha", alpha.value);
      fd.append("gamma", gamma.value);
      fd.append("band_sign", band_sign.value);
      fd.append("preserve_mean", preserve_mean.checked ? "true" : "false");
    } else {
      fd.append("preserve_mean", preserve_mean.checked ? "true" : "false");
    }

    fd.append("do_modulation", do_mod ? "true" : "false");
    if (do_mod){
      fd.append("n_controls", String(gains.length));
      fd.append("gains_csv", gains_csv);
    }

    const r = await fetch(apiUrl('api/process'), { method: "POST", body: fd, signal: controller.signal });
    if (!r.ok){
      const text = await r.text().catch(()=>"(no details)");
      throw new Error(text);
    }
    const data = await r.json();

    kernels = data.kernels || [];
    nBands = data.n_bands || (kernels?.length || 0);
    if (do_mod){ renderChart(); updateChartData(); }

    const outUrl = "data:image/png;base64," + data.output_b64;
    imgOutput.src = outUrl;
    outCard.classList.remove('hide');

    downloadLinkOut.href = outUrl; downloadLinkOut.download = "output.png"; downloadLinkOut.style.display = "inline";

    // Overlay text
    const p = data.params || {};
    let overlay = "";
    if (p.do_equalize){
      overlay +=
        `EQ:\n` +
        `  max_kernel: ${p.max_kernel}\n` +
        `  sigma: ${Number(p.sigma_perc).toFixed(2)}\n` +
        `  alpha: ${Number(p.alpha).toFixed(2)}\n` +
        `  gamma: ${Number(p.gamma).toFixed(2)}\n` +
        `  band_sign: ${p.band_sign}\n` +
        `  preserve_mean: ${p.preserve_mean}\n`;
    }
    if (p.do_modulation){
      overlay +=
        `MOD:\n` +
        `  N: ${p.n_controls}\n` +
        `  gains: ${p.gains_csv}\n`;
    }
    setOverlayOut(overlay.trim(), overlayOutChk.checked);
    overlayOutChk.onchange = (e)=> setOverlayOut(overlay.trim(), e.target.checked);

  }catch(err){
    setMsg("Error: " + (err?.message || String(err)));
  }finally{
    clearTimeout(timeout);
    setBusy(false);
    updateProcessEnabled();
  }
}
function setOverlayOut(text, show){
  overlayBoxOut.textContent = text;
  overlayBoxOut.style.display = show ? "block" : "none";
}

// ---------- Init ----------
function init(){
  // Start in BRIGHT mode
  themeSelect.value = 'bright';
  applyTheme();

  // Start with music OFF
  toggle.checked = false;

  // init UI
  updateProcessEnabled();
  syncVal('alpha'); syncVal('gamma');
}
init();
