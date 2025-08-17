from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import cv2, numpy as np, tempfile

app = FastAPI()
# Serve the frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

# -------- Adaptive Equalizer (integrated) --------
def _to_float(img: np.ndarray):
    info = {"dtype": img.dtype, "scale": 1.0}
    if img.dtype == np.uint8:
        out = img.astype(np.float32) / 255.0; info["scale"] = 255.0; return out, info
    elif img.dtype == np.uint16:
        out = img.astype(np.float32) / 65535.0; info["scale"] = 65535.0; return out, info
    elif img.dtype in (np.float32, np.float64):
        return img.astype(np.float32), info
    else:
        maxv = float(np.max(img)) if np.max(img) > 0 else 1.0
        out = (img.astype(np.float32) / maxv) if maxv > 0 else img.astype(np.float32)
        info["scale"] = maxv
        return out, info

def _from_float(img_f: np.ndarray, info: dict) -> np.ndarray:
    dtype = info["dtype"]; scale = info.get("scale", 1.0)
    if dtype == np.uint8:  return np.clip(np.round(img_f * scale), 0, 255).astype(np.uint8)
    if dtype == np.uint16: return np.clip(np.round(img_f * scale), 0, 65535).astype(np.uint16)
    return img_f.astype(np.float32)

def gaussian_blur(img: np.ndarray, k: int, sigma_perc: float = 0.33) -> np.ndarray:
    assert k % 2 == 1 and k >= 3
    sigma = max(0.01, sigma_perc * ((k - 1) / 2.0))
    return cv2.GaussianBlur(img, (k, k), sigmaX=sigma, sigmaY=sigma, borderType=cv2.BORDER_REPLICATE)

def local_std(img: np.ndarray, k: int) -> np.ndarray:
    if img.ndim == 2:
        mu  = cv2.boxFilter(img, ddepth=-1, ksize=(k, k), normalize=True, borderType=cv2.BORDER_REFLECT)
        mu2 = cv2.boxFilter(img*img, ddepth=-1, ksize=(k, k), normalize=True, borderType=cv2.BORDER_REFLECT)
        var = np.maximum(0.0, mu2 - mu*mu)
        return np.sqrt(var + 1e-12)
    chans=[]
    for c in range(img.shape[2]):
        chan=img[...,c]
        mu  = cv2.boxFilter(chan, ddepth=-1, ksize=(k, k), normalize=True, borderType=cv2.BORDER_REFLECT)
        mu2 = cv2.boxFilter(chan*chan, ddepth=-1, ksize=(k, k), normalize=True, borderType=cv2.BORDER_REFLECT)
        var = np.maximum(0.0, mu2 - mu*mu)
        chans.append(np.sqrt(var + 1e-12))
    return np.stack(chans, axis=2)

def build_kernel_list(max_kernel: int):
    if max_kernel < 3 or max_kernel % 2 == 0:
        raise ValueError("max_kernel must be odd and >= 3")
    return list(range(3, max_kernel + 1, 2))

def compute_bands(img_f: np.ndarray, kernels, sigma_perc: float, band_sign: str):
    blurs = [gaussian_blur(img_f, k, sigma_perc) for k in kernels]
    bands = [img_f - blurs[0]]  # first band
    for i in range(1, len(kernels)):
        prev, curr = blurs[i-1], blurs[i]
        band = (prev - curr) if band_sign.lower() != "literal" else (curr - prev)
        bands.append(band)
    return bands

def compute_variations(img_f: np.ndarray, kernels):
    stds = [local_std(img_f, k) for k in kernels]
    vars_ = [stds[0]]
    for i in range(1, len(stds)):
        vars_.append(np.maximum(0.0, stds[i] - stds[i-1]))
    return vars_

def inverse_variation_weights(variations, gamma: float = 1.0, eps: float = 1e-4):
    weights=[]
    for var in variations:
        inv = 1.0 / (eps + var)
        maxv= float(np.max(inv))
        w   = (inv / maxv) ** gamma if maxv > 0 else np.zeros_like(inv, dtype=np.float32)
        weights.append(w.astype(np.float32))
    return weights

def apply_adaptive_equalizer(img: np.ndarray, max_kernel=63, sigma_perc=0.33, alpha=1.0, gamma=1.0,
                             band_sign="dog", per_band_gain=1.0, preserve_mean=True) -> np.ndarray:
    img_f, info = _to_float(img)
    kernels = build_kernel_list(max_kernel)
    bands   = compute_bands(img_f, kernels, sigma_perc, band_sign)
    vars_   = compute_variations(img_f, kernels)
    weights = inverse_variation_weights(vars_, gamma=gamma, eps=1e-4)
    gains = [float(per_band_gain)] * len(bands) if isinstance(per_band_gain, (int,float)) else list(per_band_gain)
    if len(gains) != len(bands): raise ValueError("per_band_gain length mismatch")

    total_add = np.zeros_like(img_f, dtype=np.float32)
    for i, band in enumerate(bands):
        w = weights[i]
        if img_f.ndim == 3 and w.ndim == 2: w = w[..., None]
        total_add += (gains[i] * w * band).astype(np.float32)
    total_add *= float(alpha)

    if preserve_mean:
        if img_f.ndim == 2: total_add -= np.mean(total_add)
        else:
            for c in range(img_f.shape[2]):
                total_add[..., c] -= np.mean(total_add[..., c])

    out = np.clip(img_f + total_add, 0.0, 1.0)
    return _from_float(out, info)
# ---------------------------------------------------

def process_image(img_bytes, max_kernel, sigma_perc, alpha, gamma, band_sign, preserve_mean):
    file_bytes = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
    out = apply_adaptive_equalizer(
        img,
        max_kernel=max_kernel,
        sigma_perc=sigma_perc,
        alpha=alpha,
        gamma=gamma,
        band_sign=band_sign,
        per_band_gain=1.0,
        preserve_mean=preserve_mean,
    )
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    cv2.imwrite(tmp.name, out)
    return tmp.name

@app.post("/process")
async def process(
    file: UploadFile = File(...),
    max_kernel: int = Form(63),
    sigma_perc: float = Form(0.33),
    alpha: float = Form(1.0),
    gamma: float = Form(1.2),
    band_sign: str = Form("dog"),
    preserve_mean: bool = Form(True),
):
    try:
        contents = await file.read()
        out_path = process_image(contents, max_kernel, sigma_perc, alpha, gamma, band_sign, preserve_mean)
        return FileResponse(out_path, media_type="image/png", filename="result.png")
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
