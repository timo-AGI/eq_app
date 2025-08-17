from fastapi import FastAPI, File, UploadFile, Form, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import cv2, numpy as np, tempfile, time

app = FastAPI()

# Serve static files at /static and homepage at /
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

# ----------------- Equalizer core -----------------
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

def apply_equalizer(img,max_kernel=63,sigma_perc=0.33,alpha=1.0,gamma=1.2,sign="dog",
                    preserve_mean=True, per_band_gain=1.0):
    f,info=_to_float(img)
    ks=build_kernel_list(max_kernel)
    bands=compute_bands(f,ks,sigma_perc,sign)
    ws=inverse_weights(compute_variations(f,ks),gamma)

    # per_band_gain: scalar or array (len == len(bands))
    if isinstance(per_band_gain,(int,float)):
        gains=[float(per_band_gain)]*len(bands)
    else:
        gains=list(per_band_gain)
        if len(gains)!=len(bands):
            raise ValueError(f"per_band_gain length mismatch: {len(gains)} vs {len(bands)}")

    total=np.zeros_like(f,dtype=np.float32)
    for b,w,g in zip(bands,ws,gains):
        if f.ndim==3 and w.ndim==2: w=w[...,None]
        total+= (g*w*b).astype(np.float32)
    total*=alpha

    if preserve_mean:
        if f.ndim==2: total-=total.mean()
        else:
            for c in range(f.shape[2]): total[...,c]-=total[...,c].mean()

    out=np.clip(f+total,0,1)
    return _from_float(out,info)

# ------- Expand N control points to full per-band gains (linear) ------
def expand_gains(n_controls, gains_csv, n_bands):
    vals=[v for v in gains_csv.replace(' ','').split(',') if v!='']
    arr=np.array([float(x) for x in vals], dtype=np.float32)
    if len(arr)!=n_controls:
        raise ValueError(f"Expected {n_controls} gains, got {len(arr)}")
    arr=np.clip(arr, 0.0, 4.0)

    if n_controls==n_bands:
        return arr.tolist()

    x_ctrl = np.linspace(0, n_bands-1, n_controls, dtype=np.float32)
    x_full = np.arange(n_bands, dtype=np.float32)
    full   = np.interp(x_full, x_ctrl, arr)
    return full.tolist()

# ----------------- API -----------------
MAX_BYTES = 12 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg","image/png","image/webp"}

def process_image(buf,max_kernel,sigma_perc,alpha,gamma,sign,preserve, gains_full):
    img=cv2.imdecode(np.frombuffer(buf,np.uint8),cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Failed to decode image. Use JPG/PNG/WEBP.")
    t0=time.time()
    out=apply_equalizer(img,max_kernel,sigma_perc,alpha,gamma,sign,preserve, per_band_gain=gains_full)
    print(f"[equalizer] size={img.shape} bands={len(gains_full)} max_k={max_kernel} took={time.time()-t0:.2f}s")
    tmp=tempfile.NamedTemporaryFile(delete=False,suffix=".png")
    cv2.imwrite(tmp.name,out); return tmp.name

@app.post("/api/process")
async def api_process(
    file: UploadFile=File(...),
    max_kernel:int=Form(63),
    sigma_perc:float=Form(0.33),
    alpha:float=Form(1.0),
    gamma:float=Form(1.2),
    band_sign:str=Form("dog"),
    preserve_mean:bool=Form(True),
    n_controls:int=Form(5),                 # number of knobs (3..10)
    gains_csv:str=Form("1,1,1,1,1"),        # CSV of knob values (0..4)
):
    try:
        if file.content_type not in ALLOWED_TYPES:
            return JSONResponse({"error": f"Unsupported type {file.content_type}. Use JPG/PNG/WEBP."}, status_code=415)
        buf=await file.read()
        if not buf: return JSONResponse({"error":"Empty upload"}, status_code=400)
        if len(buf)>MAX_BYTES: return JSONResponse({"error":"File too large (>12MB)"}, status_code=413)

        n_bands = len(build_kernel_list(max_kernel))  # bands = number of kernel sizes
        gains_full = expand_gains(n_controls, gains_csv, n_bands)

        out_path=process_image(buf,max_kernel,sigma_perc,alpha,gamma,band_sign,preserve_mean, gains_full)
        return FileResponse(out_path, media_type="image/png", filename="result.png")
    except Exception as e:
        print("[api_process] ERROR:", repr(e))
        return JSONResponse({"error":str(e)}, status_code=400)
