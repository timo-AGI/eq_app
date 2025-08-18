from fastapi import FastAPI, File, UploadFile, Form, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import cv2, numpy as np, base64

app = FastAPI()


@app.get("/music/light")
def music_light():
    return FileResponse(
        "static/bgm_light.mp3",
        media_type="audio/mpeg",
        headers={"Accept-Ranges": "bytes"}
    )

@app.get("/music/dark")
def music_dark():
    return FileResponse(
        "static/bgm_dark.mp3",
        media_type="audio/mpeg",
        headers={"Accept-Ranges": "bytes"}
    )

from starlette.middleware.cors import CORSMiddleware

# (optional but fine to keep)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_frame_headers(request, call_next):
    resp = await call_next(request)

    # 1) Remove X-Frame-Options if any (blocks embedding)
    for k in ("x-frame-options", "X-Frame-Options"):
        try:
            del resp.headers[k]
        except KeyError:
            pass

    # 2) Ensure CSP allows your Wix site(s) to frame this app
    allowed = (
        "frame-ancestors 'self' "
        "https://*.wixsite.com "
        "https://*.wixstudio.io "
        "https://fourierimagelab.com "
        "https://www.fourierimagelab.com"
    )

    # If a CSP already exists, replace/append the frame-ancestors directive
    existing_csp = resp.headers.get("Content-Security-Policy", "")
    if existing_csp:
        directives = [d.strip() for d in existing_csp.split(";") if d.strip()]
        directives = [d for d in directives if not d.lower().startswith("frame-ancestors")]
        directives.append(allowed)
        resp.headers["Content-Security-Policy"] = "; ".join(directives)
    else:
        resp.headers["Content-Security-Policy"] = allowed

    return resp

# Serve static and homepage
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def index():
    return FileResponse("static/index.html")

@app.get("/api/health")
def health():
    return {"ok": True}

@app.head("/")
def head_root():
    return Response(status_code=200)

@app.head("/api/health")
def head_health():
    return Response(status_code=200)

# ----------------- Fixed parameters -----------------
FIXED_SIGMA_PERC = 0.05
FIXED_MAX_KERNEL = 25

# ----------------- Core helpers -----------------
def _to_float(img: np.ndarray):
    info = {"dtype": img.dtype, "scale": 1.0}
    if img.dtype == np.uint8:
        return img.astype(np.float32)/255.0, {"dtype": img.dtype, "scale":255}
    if img.dtype == np.uint16:
        return img.astype(np.float32)/65535.0, {"dtype": img.dtype, "scale":65535}
    return img.astype(np.float32), info

def _from_float(img: np.ndarray, info: dict):
    scale = info.get("scale",1.0); dtype = info["dtype"]
    if dtype == np.uint8:
        return np.clip(img*scale,0,255).astype(np.uint8)
    if dtype == np.uint16:
        return np.clip(img*scale,0,65535).astype(np.uint16)
    return img.astype(np.float32)

def gaussian_blur(img,k,sigma_perc=0.33):
    sigma = max(0.01, sigma_perc*((k-1)/2))
    return cv2.GaussianBlur(img,(k,k),sigmaX=sigma,sigmaY=sigma,borderType=cv2.BORDER_REPLICATE)

def local_std(img,k):
    mu  = cv2.boxFilter(img,-1,(k,k),normalize=True, borderType=cv2.BORDER_REFLECT)
    mu2 = cv2.boxFilter(img*img,-1,(k,k),normalize=True, borderType=cv2.BORDER_REFLECT)
    return np.sqrt(np.maximum(0,mu2-mu*mu)+1e-12)

def build_kernel_list(max_kernel): 
    if max_kernel < 3 or max_kernel % 2 == 0:
        raise ValueError("max_kernel must be odd and >= 3")
    return list(range(3, max_kernel+1, 2))

def compute_bands(img,kernels,sigma_perc,sign):
    """Bands: [ (I - G3), (G3 - G5), (G5 - G7), ... ] or flipped if sign='literal'."""
    blurs=[gaussian_blur(img,k,sigma_perc) for k in kernels]
    bands=[img-blurs[0]]
    for i in range(1,len(kernels)):
        bands.append((blurs[i-1]-blurs[i]) if sign!="literal" else (blurs[i]-blurs[i-1]))
    return bands

def compute_variations(img,kernels):
    stds=[local_std(img,k) for k in kernels]
    vars_=[stds[0]]
    for i in range(1,len(stds)):
        vars_.append(np.maximum(0,stds[i]-stds[i-1]))
    return vars_

def inverse_weights(vars_,gamma=1.0):
    ws=[]
    for v in vars_:
        inv=1.0/(1e-4+v); m=float(inv.max()) if inv.size else 0.0
        ws.append(((inv/m)**gamma).astype(np.float32) if m>0 else np.zeros_like(v, dtype=np.float32))
    return ws

def apply_pipeline(
    img,
    *,
    max_kernel,
    sigma_perc,
    band_sign,
    preserve_mean,
    use_inverse,        # True → equalization path; False → modulation-only path
    gamma,
    alpha,
    per_band_gain       # scalar or list of length n_bands
):
    """
    Build DoG bands; if use_inverse=True use inverse-variance weights^gamma, else weights=1.
    Sum gain*weight*band, scale by alpha (alpha=1 for modulation-only), optional mean preserve.
    """
    f,info=_to_float(img)
    kernels=build_kernel_list(max_kernel)
    bands=compute_bands(f,kernels,sigma_perc,band_sign)

    if use_inverse:
        ws=inverse_weights(compute_variations(f,kernels),gamma)
    else:
        ws=[np.ones_like(b, dtype=np.float32) for b in bands]

    if isinstance(per_band_gain,(int,float)):
        gains=[float(per_band_gain)]*len(bands)
    else:
        gains=list(per_band_gain)
        if len(gains)!=len(bands):
            raise ValueError(f"per_band_gain length mismatch: {len(gains)} vs {len(bands)}")

    total=np.zeros_like(f,dtype=np.float32)
    for b,w,g in zip(bands,ws,gains):
        if f.ndim==3 and w.ndim==2: w=w[...,None]
        total += (g*w*b).astype(np.float32)

    total *= alpha  # alpha=1.0 for modulation-only

    if preserve_mean:
        if f.ndim==2: total -= total.mean()
        else:
            for c in range(f.shape[2]): total[...,c] -= total[...,c].mean()

    out=np.clip(f+total,0,1)
    return _from_float(out,info), kernels

def expand_gains(n_controls, gains_csv, n_bands):
    vals=[v for v in gains_csv.replace(' ','').split(',') if v!='']
    arr=np.array([float(x) for x in vals], dtype=np.float32)
    if len(arr)!=n_controls:
        raise ValueError(f"Expected {n_controls} gains, got {len(arr)}")
    arr=np.clip(arr, 0.0, 10.0)
    if n_controls==n_bands:
        return arr.tolist()
    x_ctrl = np.linspace(0, n_bands-1, n_controls, dtype=np.float32)
    x_full = np.arange(n_bands, dtype=np.float32)
    full   = np.interp(x_full, x_ctrl, arr)
    return full.tolist()

def _encode_png_b64(img_bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", img_bgr)
    if not ok:
        raise RuntimeError("PNG encode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")

# ----------------- API -----------------
MAX_BYTES = 12 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg","image/png","image/webp"}

@app.post("/api/process")
async def api_process(
    file: UploadFile=File(...),
    # toggles
    do_equalize: bool = Form(False),
    do_modulation: bool = Form(False),
    # EQ params (used iff do_equalize)
    alpha: float = Form(1.0),
    gamma: float = Form(1.2),
    band_sign: str = Form("dog"),
    preserve_mean: bool = Form(True),
    # MOD params (used iff do_modulation)
    n_controls: int = Form(5),
    gains_csv: str = Form("1,1,1,1,1"),
):
    try:
        if (not do_equalize) and (not do_modulation):
            return JSONResponse({"error": "Enable equalization and/or modulation to process."}, status_code=400)

        if file.content_type not in ALLOWED_TYPES:
            return JSONResponse({"error": f"Unsupported type {file.content_type}. Use JPG/PNG/WEBP."}, status_code=415)
        buf=await file.read()
        if not buf: return JSONResponse({"error":"Empty upload"}, status_code=400)
        if len(buf)>MAX_BYTES: return JSONResponse({"error":"File too large (>12MB)"}, status_code=413)

        img=cv2.imdecode(np.frombuffer(buf,np.uint8),cv2.IMREAD_COLOR)
        if img is None: return JSONResponse({"error":"Decode failed. Use JPG/PNG/WEBP."}, status_code=400)

        kernels = build_kernel_list(FIXED_MAX_KERNEL)
        n_bands = len(kernels)
        gains_full = expand_gains(n_controls, gains_csv, n_bands) if do_modulation else 1.0

        if do_equalize and do_modulation:
            # BOTH
            out_img, kernels = apply_pipeline(
                img, max_kernel=FIXED_MAX_KERNEL, sigma_perc=FIXED_SIGMA_PERC,
                band_sign=band_sign, preserve_mean=preserve_mean,
                use_inverse=True, gamma=gamma, alpha=alpha, per_band_gain=gains_full
            )
        elif do_equalize:
            # EQ only
            out_img, kernels = apply_pipeline(
                img, max_kernel=FIXED_MAX_KERNEL, sigma_perc=FIXED_SIGMA_PERC,
                band_sign=band_sign, preserve_mean=preserve_mean,
                use_inverse=True, gamma=gamma, alpha=alpha, per_band_gain=1.0
            )
        else:
            # MOD only — no inverse, alpha=1
            out_img, kernels = apply_pipeline(
                img, max_kernel=FIXED_MAX_KERNEL, sigma_perc=FIXED_SIGMA_PERC,
                band_sign="dog", preserve_mean=preserve_mean,
                use_inverse=False, gamma=1.0, alpha=1.0, per_band_gain=gains_full
            )

        return {
            "output_b64": _encode_png_b64(out_img),
            "kernels": kernels,
            "n_bands": n_bands,
            "params": {
                "max_kernel": FIXED_MAX_KERNEL,
                "sigma_perc": FIXED_SIGMA_PERC,
                "do_equalize": bool(do_equalize),
                "do_modulation": bool(do_modulation),
                # EQ overlay (only when EQ is on)
                "alpha": alpha if do_equalize else None,
                "gamma": gamma if do_equalize else None,
                "band_sign": band_sign if do_equalize else None,
                "preserve_mean": bool(preserve_mean) if do_equalize else None,
                # MOD overlay
                "n_controls": n_controls if do_modulation else None,
                "gains_csv": gains_csv if do_modulation else None,
            }
        }
    except Exception as e:
        print("[api_process] ERROR:", repr(e))
        return JSONResponse({"error":str(e)}, status_code=400)
