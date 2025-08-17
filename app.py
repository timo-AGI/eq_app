<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Adaptive Equalizer</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
  body { font-family: Arial, system-ui; max-width: 1040px; margin: 24px auto; padding: 0 12px; }
  .row { display:flex; gap:20px; margin:12px 0; flex-wrap:wrap; align-items:center; }
  label { font-size:12px; display:block; opacity:.85; }
  input[type=range]{ width:240px; }
  img { max-width:100%; border-radius:6px; }
  button{padding:8px 14px; cursor:pointer;}
  button[disabled]{ opacity:.6; cursor:not-allowed;}
  #msg{ color:#b00; margin:8px 0; min-height:1.2em; }
  .val { min-width: 42px; display:inline-block; text-align:right; }
  #progressWrap { display:none; align-items:center; gap:10px; }
  .spinner { width:16px; height:16px; border:2px solid #ccc; border-top-color:#333; border-radius:50%; animation:spin .8s linear infinite;}
  @keyframes spin { to{ transform:rotate(360deg)} }

  /* Modulation section */
  #modWrap{ border:1px solid #e5e5e5; border-radius:10px; padding:12px; }
  #curveArea{ display:flex; flex-direction:column; align-items:center; }
  #curveCanvas{ width: 800px; height: 220px; }
  /* Sliders aligned under curve points */
  #slidersRow{ display:flex; justify-content:space-between; width:800px; margin-top:14px; }
  .knobCol{ display:flex; flex-direction:column; align-items:center; user-select:none; }
  .knobCol input[type=range]{
    writing-mode: bt-lr; -webkit-appearance: slider-vertical;
    height: 140px; width: 28px;
  }
  .knobLabel{ font-size:11px; margin-top:6px; }
</style>
</head>
<body>
<h2>Adaptive Equalizer</h2>

<div class="row">
  <div>
    <label>Upload image</label>
    <input type="file" id="fileInput" accept="image/*" onchange="preview()"/>
  </div>
  <div>
    <label>band_sign</label>
    <select id="band_sign">
      <option value="dog" selected>dog</option>
      <option value="literal">literal</option>
    </select>
  </div>
  <label><input type="checkbox" id="preserve_mean" checked/> preserve mean</label>
</div>

<div class="row">
  <div>
    <label>alpha: <span id="alpha_val" class="val">1.00</span></label>
    <input type="range" id="alpha" min="0" max="3" step="0.05" value="1" oninput="sync('alpha')"/>
  </div>
  <div>
    <label>gamma: <span id="gamma_val" class="val">1.20</span></label>
    <input type="range" id="gamma" min="0.5" max="3" step="0.05" value="1.2" oninput="sync('gamma')"/>
  </div>
</div>

<div class="row">
  <div>
    <label>sigma_perc: <span id="sigma_val" class="val">0.33</span></label>
    <input type="range" id="sigma_perc" min="0.05" max="0.8" step="0.01" value="0.33" oninput="sync('sigma_perc')"/>
  </div>
  <div>
    <label>max_kernel (odd ≥3): <span id="mk_val" class="val">63</span></label>
    <input type="range" id="max_kernel" min="3" max="127" step="2" value="63" oninput="sync('max_kernel')"/>
  </div>
</div>

<!-- Modulation controls -->
<div id="modWrap">
  <div class="row" style="justify-content:space-between; align-items:center;">
    <strong>Band Modulation</strong>
    <div>
      <label>N knobs (3..10)</label>
      <input type="number" id="n_controls" min="3" max="10" step="1" value="5" style="width:64px;"/>
      <button onclick="applyKnobs()">Apply</button>
    </div>
  </div>

  <div id="curveArea">
    <canvas id="curveCanvas" width="800" height="220"></canvas>
    <div id="slidersRow"><!-- sliders inserted dynamically --></div>
  </div>
</div>

<div class="row">
  <button id="processBtn" onclick="process()">Process</button>
  <a id="downloadLink" style="display:none;margin-left:8px;">Download</a>
  <div id="progressWrap"><div class="spinner"></div><span id="progressText">Processing…</span></div>
</div>

<div id="msg"></div>

<div>
  <h3>Preview</h3>
  <img id="previewImg" style="display:none"/>
  <h3>Result</h3>
  <img id="resultImg"/>
</div>

<script>
function apiUrl(p){ return new URL(p, window.location.href).toString(); }
function setMsg(t){ document.getElementById('msg').textContent = t || ''; }
function sync(id){
  const v = document.getElementById(id).value;
  const span = document.getElementById(
    id==='sigma_perc' ? 'sigma_val' :
    id==='max_kernel' ? 'mk_val' :
    id + '_val'
  );
  if (span) span.textContent = (id==='max_kernel') ? v : (+v).toFixed(2);
}
function preview(){
  setMsg('');
  const f=document.getElementById("fileInput").files[0];
  if(!f) return;
  const url=URL.createObjectURL(f);
  const img=document.getElementById("previewImg");
  img.src=url; img.style.display="block";
}

/* ---------- Modulation knobs + curve (Chart.js) ---------- */
let gains = []; // length N, values [0..4]
let chart = null;

function applyKnobs(){
  const N = Math.max(3, Math.min(10, parseInt(document.getElementById('n_controls').value||5,10)));
  gains = Array(N).fill(1.0);
  renderSliders();
  renderChart();
  updateChartData();
}

function renderSliders(){
  const row = document.getElementById('slidersRow');
  row.innerHTML = '';
  gains.forEach((v,i)=>{
    const col = document.createElement('div');
    col.className = 'knobCol';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '4'; slider.step = '0.05';
    slider.value = String(v);
    slider.oninput = (e)=>{
      gains[i] = parseFloat(e.target.value);
      updateChartData();
      label.textContent = `b${i+1}: ${gains[i].toFixed(2)}`;
    };

    const label = document.createElement('div');
    label.className = 'knobLabel';
    label.textContent = `b${i+1}: ${v.toFixed(2)}`;

    col.appendChild(slider);
    col.appendChild(label);
    row.appendChild(col);
  });
}

function renderChart(){
  const ctx = document.getElementById('curveCanvas').getContext('2d');
  if (chart){ chart.destroy(); }
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: gains.map((_,i)=> `Band ${i+1}`),
      datasets: [{
        label: 'Modulation',
        data: gains,
        fill: false,
        borderWidth: 2,
        pointRadius: 3,
        cubicInterpolationMode: 'monotone'
      }]
    },
    options: {
      animation: false,
      responsive: false,
      scales: {
        y: { min: 0, max: 4, title:{display:true, text:'Gain (0..4)'} },
        x: { title:{display:true, text:'Control points (first = 3x3 band, last = widest band)'} }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function updateChartData(){
  if (!chart) return;
  chart.data.labels = gains.map((_,i)=> `Band ${i+1}`);
  chart.data.datasets[0].data = gains;
  chart.update();
}

/* ---------- Busy UI ---------- */
function setBusy(b){
  document.getElementById('processBtn').disabled = b;
  document.getElementById('fileInput').disabled = b;
  document.getElementById('progressWrap').style.display = b ? 'inline-flex' : 'none';
}

/* ---------- Init ---------- */
applyKnobs();

/* ---------- Processing ---------- */
async function process(){
  if (document.getElementById('processBtn').disabled) return;

  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), 180000);
  try{
    setMsg('');
    const file = document.getElementById("fileInput").files[0];
    if (!file){ setMsg("Choose an image first."); return; }
    setBusy(true);

    const gains_csv = gains.map(v=> v.toFixed(3)).join(',');

    const fd = new FormData();
    fd.append("file", file);
    fd.append("alpha", alpha.value);
    fd.append("gamma", gamma.value);
    fd.append("sigma_perc", sigma_perc.value);
    fd.append("max_kernel", max_kernel.value);
    fd.append("band_sign", band_sign.value);
    fd.append("preserve_mean", document.getElementById('preserve_mean').checked ? "true" : "false");
    fd.append("n_controls", String(gains.length));
    fd.append("gains_csv", gains_csv);

    const r = await fetch(apiUrl('api/process'), { method: "POST", body: fd, signal: controller.signal });
    if (!r.ok){
      const text = await r.text().catch(()=>"(no details)");
      throw new Error(text);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    document.getElementById("resultImg").src = url;

    const dl = document.getElementById("downloadLink");
    dl.href = url; dl.download = "result.png"; dl.style.display = "inline";
  }catch(err){
    setMsg("Error: " + (err?.message || String(err)));
  }finally{
    clearTimeout(timeout);
    setBusy(false);
  }
}
</script>
</body>
</html>
