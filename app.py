from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import cv2, numpy as np, tempfile

app = FastAPI()

# Serve static files at /static and homepage at /
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def index():
    return FileResponse("static/index.html")

@app.get("/api/health")
def health():
    return {"ok": True}

# ---------- Adaptive Equalizer Core ----------
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
    mu  = cv2.boxFilter(img,-1,(k,k),normalize=True)
    mu2 = cv2.boxFilter(img*img,-1,(k,k),normalize=True)
    return np.sqrt(np.maximum(0,mu2-mu*mu)+1e-12)

def build_kernel_list(max_kernel): return list(range(3,max_kernel+1,2))

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
        inv=1.0/(1e-4+v); m=inv.max()
        ws.append(((inv/m)**gamma).astype(np.float32) if m>0 else np.zeros_like(v))
    return ws

def apply_equalizer(img,max_kernel=63,sigma_perc=0.33,alpha=1.0,gamma=1.2,sign="dog",preserve_mean=True):
    f,info=_to_float(img)
    ks=build_kernel_list(max_kernel)
    bands=compute_bands(f,ks,sigma_perc,sign)
    ws=inverse_weights(compute_variations(f,ks),gamma)
    total=np.zeros_like(f)
    for b,w in zip(bands,ws):
        if f.ndim==3 and w.ndim==2: w=w[...,None]
        total+=w*b
    total*=alpha
    if preserve_mean:
        if f.ndim==2: total-=total.mean()
        else:
            for c in range(f.shape[2]): total[...,c]-=total[...,c].mean()
    out=np.clip(f+total,0,1)
    return _from_float(out,info)

# ---------- API ----------
def process_image(buf,max_kernel,sigma_perc,alpha,gamma,sign,preserve):
    img=cv2.imdecode(np.frombuffer(buf,np.uint8),cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Failed to decode image (unsupported format or empty).")
    out=apply_equalizer(img,max_kernel,sigma_perc,alpha,gamma,sign,preserve)
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
):
    try:
        buf=await file.read()
        out=process_image(buf,max_kernel,sigma_perc,alpha,gamma,band_sign,preserve_mean)
        return FileResponse(out,media_type="image/png",filename="result.png")
    except Exception as e:
        return JSONResponse({"error":str(e)},status_code=400)
