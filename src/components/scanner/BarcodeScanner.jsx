/* eslint-disable no-empty */
import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { CameraOff, RefreshCw, Zap } from 'lucide-react'

const BADGE_REGEX = /^(FB(597[1-9]|59[89]\d|600\d|601[01])(GA|LA)\d{4}|BH\d{4}[A-Z]{1,2}\d{4}|VS[A-Z0-9]+)$/i

const RESOLUTION_CHAIN = [
  { width: { max: 1280, ideal: 720 }, height: { max: 720, ideal: 480 } },
  { width: { max: 640, ideal: 480 }, height: { max: 480, ideal: 360 } },
  { width: { max: 480, ideal: 360 }, height: { max: 360, ideal: 270 } },
  { width: { max: 320, ideal: 240 }, height: { max: 240, ideal: 180 } },
]

const QUALITY = { MIN_BRIGHTNESS: 25, MAX_BRIGHTNESS: 230, MIN_VARIANCE: 400 }
const DEVICE_PROFILES = {
  fast:   { resolutionIndex: 0, confirmWindow: 3, confirmThreshold: 2, minInterval: 50,  maxInterval: 150, frameSkip: 0, useQualityGate: false },
  medium: { resolutionIndex: 1, confirmWindow: 4, confirmThreshold: 2, minInterval: 100, maxInterval: 300, frameSkip: 1, useQualityGate: true },
  slow:   { resolutionIndex: 2, confirmWindow: 3, confirmThreshold: 1, minInterval: 200, maxInterval: 500, frameSkip: 2, useQualityGate: true },
}

async function hasLinearBarcodeSupport() {
  if (!('BarcodeDetector' in window)) return false
  try {
    const fmts = await window.BarcodeDetector.getSupportedFormats()
    return fmts.includes('code_39') || fmts.includes('code_128')
  } catch { return false }
}
async function loadPolyfill() {
  const { BarcodeDetectorPolyfill } = await import(/* @vite-ignore */ '@undecaf/barcode-detector-polyfill')
  window.BarcodeDetector = BarcodeDetectorPolyfill
}

function createQualityChecker() {
  const c = document.createElement('canvas'); c.width = 48; c.height = 36
  const ctx = c.getContext('2d', { willReadFrequently: true })
  return (video) => {
    try {
      ctx.drawImage(video, 0, 0, 48, 36)
      const d = ctx.getImageData(0,0,48,36).data
      let sum=0,sum2=0,n=48*36
      for (let i=0;i<n;i++){ const r=d[i*4],g=d[i*4+1],b=d[i*4+2]; const l=0.299*r+0.587*g+0.114*b; sum+=l; sum2+=l*l }
      const mean=sum/n, vari=sum2/n-mean*mean
      if (mean<QUALITY.MIN_BRIGHTNESS) return { ok:false, reason:'dark' }
      if (mean>QUALITY.MAX_BRIGHTNESS) return { ok:false, reason:'bright' }
      if (vari<QUALITY.MIN_VARIANCE) return { ok:false, reason:'blurry' }
      return { ok:true }
    } catch { return { ok:true } }
  }
}

function getGuidanceMessage(qualityResult, barcodeFound, elapsed, hasEverDetected) {
  if (elapsed < 2000) return null
  if (!qualityResult.ok) {
    if (qualityResult.reason === 'dark') return 'Better lighting needed'
    if (qualityResult.reason === 'bright') return 'Reduce glare'
    if (qualityResult.reason === 'blurry') return 'Hold steady'
  }
  if (barcodeFound && !hasEverDetected) return null
  if (elapsed > 5000 && !barcodeFound) return 'Align barcode within frame'
  if (elapsed > 15000 && !barcodeFound) return 'Having trouble? Use manual entry'
  return null
}

const BarcodeScanner = forwardRef(function BarcodeScanner({ onScan, debug = false }, ref) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const detectorRef = useRef(null)
  const zxingRef = useRef(null)
  const mountedRef = useRef(true)
  const onScanRef = useRef(onScan)
  const lastScanRef = useRef({ badge:null, time:0 })
  const slidingWindowRef = useRef([])
  const configRef = useRef(DEVICE_PROFILES.medium)
  const profileDone = useRef(false)
  const qualityRef = useRef(null)
  const hasEverDetectedRef = useRef(false)
  const frameCountRef = useRef(0)
  const fpsRef = useRef({ frames:0, last: Date.now() })
  const startTimeRef = useRef(Date.now())

  const [status, setStatus] = useState('starting')
  const [errorMsg, setErrorMsg] = useState('')
  const [engineLabel, setEngineLabel] = useState('')
  const [fps, setFps] = useState(0)
  const [guidanceMsg, setGuidanceMsg] = useState(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [lastRaw, setLastRaw] = useState(null)
  const [debugLogs, setDebugLogs] = useState([])
  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent || '')

  onScanRef.current = onScan

  const stopScanner = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    if (streamRef.current) streamRef.current.getTracks().forEach(t=>t.stop())
    streamRef.current = null
    if (videoRef.current) { videoRef.current.srcObject=null; try{ videoRef.current.load()}catch{} }
    slidingWindowRef.current=[]; frameCountRef.current=0; profileDone.current=false; hasEverDetectedRef.current=false
  }

  const pushDebug = (msg) => {
    if (!debug) return
    setDebugLogs(prev => [`${new Date().toLocaleTimeString()} ${msg}`, ...prev].slice(0, 20))
    // also console for remote debugging
    try { console.log('[Scanner]', msg) } catch {}
  }

  const updateWindow = (badge, cfg) => {
    const now=Date.now()
    const w=slidingWindowRef.current
    w.push({ badge, time: now })
    let t=w.filter(e=>e.time>now-3000)
    if (t.length>cfg.confirmWindow) t=t.slice(-cfg.confirmWindow)
    slidingWindowRef.current=t
    const c=t.filter(e=>e.badge===badge).length
    return { confirmed: c>=cfg.confirmThreshold, count:c }
  }

  const tryZXingDecode = async (video) => {
    try {
      if (!zxingRef.current) {
        const { BrowserMultiFormatReader } = await import('@zxing/library')
        zxingRef.current = new BrowserMultiFormatReader()
      }
      const canvas=document.createElement('canvas')
      canvas.width=video.videoWidth||640; canvas.height=video.videoHeight||480
      const ctx=canvas.getContext('2d')
      ctx.drawImage(video,0,0,canvas.width,canvas.height)
      const result = zxingRef.current.decodeFromCanvas(canvas)
      if (result) return result.getText()
    } catch {}
    return null
  }

  const detectLoop = async () => {
    if (!mountedRef.current || !detectorRef.current || !videoRef.current) return
    const cfg=configRef.current
    frameCountRef.current++
    if (cfg.frameSkip && frameCountRef.current % (cfg.frameSkip+1) !==0) { rafRef.current=requestAnimationFrame(()=>detectLoop()); return }
    // quality gate — disabled by default for dark halls; only enable if not iOS and after 5s, and allow to pass even if blurry if debug
    const elapsed=Date.now()-startTimeRef.current
    if (cfg.useQualityGate && qualityRef.current && elapsed>5000 && !debug) {
      const q=qualityRef.current(videoRef.current)
      const msg=getGuidanceMessage(q,false,elapsed,hasEverDetectedRef.current)
      if (msg) setGuidanceMsg(msg)
      if (!q.ok && !isIOS) { pushDebug(`quality blocked: ${q.reason}`); rafRef.current=requestAnimationFrame(()=>detectLoop()); return }
    }
    const t0=performance.now()
    let barcodes=[]
    let engineUsed = engineLabel
    try { barcodes = await detectorRef.current.detect(videoRef.current) } catch (e) { pushDebug(`detect error: ${e?.message}`) }
    // Always try ZXing as secondary if native found nothing OR if debug (to catch all)
    let zxingTried = false
    if ((!barcodes || !barcodes.length)) {
      // lazy-load ZXing if not yet loaded
      if (!zxingRef.current) {
        try { const { BrowserMultiFormatReader } = await import('@zxing/library'); zxingRef.current = new BrowserMultiFormatReader(); pushDebug('ZXing loaded') } catch (e) { pushDebug(`ZXing load fail: ${e?.message}`) }
      }
      if (zxingRef.current) {
        zxingTried = true
        const zx=await tryZXingDecode(videoRef.current)
        if (zx) { barcodes=[{ rawValue: zx, cornerPoints:[] }]; engineUsed = 'ZXing'; pushDebug(`ZXing found: ${zx}`) }
      }
    }
    const elapsedMs=performance.now()-t0
    const nextDelay=Math.max(cfg.minInterval, Math.min(cfg.maxInterval, elapsedMs/0.5))
    fpsRef.current.frames++
    if (Date.now()-fpsRef.current.last>1000){ setFps(fpsRef.current.frames); fpsRef.current={frames:0,last:Date.now()} }
    if (debug && barcodes?.length) pushDebug(`${engineUsed} raw: ${barcodes.map(b=>b.rawValue).join(', ')}`)
    if (barcodes && barcodes.length){
      for(const b of barcodes){
        const raw=String(b.rawValue||'').trim().toUpperCase()
        setLastRaw(raw)
        if (!BADGE_REGEX.test(raw)) { if (debug) pushDebug(`regex reject: ${raw}`); continue }
        // margin check — disabled in debug, relaxed to 2% otherwise
        const margin = debug ? 0 : 0.02
        if (margin>0 && b.cornerPoints && b.cornerPoints.length>=4 && videoRef.current.videoWidth){
          const cx=b.cornerPoints.reduce((s,p)=>s+p.x,0)/4
          const cy=b.cornerPoints.reduce((s,p)=>s+p.y,0)/4
          const vw=videoRef.current.videoWidth, vh=videoRef.current.videoHeight
          const mx=vw*margin, my=vh*margin
          if (cx<mx||cx>vw-mx||cy<my||cy>vh-my) { if (debug) pushDebug(`margin reject: ${raw} at ${Math.round(cx)},${Math.round(cy)}`); continue }
        }
        hasEverDetectedRef.current=true
        const { confirmed, count } = updateWindow(raw,cfg)
        if (debug) pushDebug(`window ${raw}: ${count}/${cfg.confirmThreshold} ${confirmed?'CONFIRMED':''}`)
        if (confirmed){
          const now=Date.now()
          if (lastScanRef.current.badge===raw && now-lastScanRef.current.time<2000) { if (debug) pushDebug(`debounce skip: ${raw}`); break }
          lastScanRef.current={ badge:raw, time:now }
          try{ navigator.vibrate?.(80) }catch{}
          pushDebug(`SCAN OK: ${raw}`)
          onScanRef.current?.(raw)
          break
        }
      }
    } else if (debug && elapsed > 3000 && frameCountRef.current % 30 === 0) {
      // periodic heartbeat when nothing detected
      pushDebug(`no barcode — fps ${fps} engine ${engineUsed} zxingTried:${zxingTried}`)
    }
    rafRef.current=setTimeout(()=>{ if(mountedRef.current) requestAnimationFrame(detectLoop) }, nextDelay)
  }

  const startScanner = async () => {
    if (!mountedRef.current) return
    stopScanner()
    setStatus('loading'); setErrorMsg(''); setGuidanceMsg(null); setDebugLogs([]); setLastRaw(null); startTimeRef.current=Date.now()
    pushDebug('startScanner init')
    const hasNative=await hasLinearBarcodeSupport()
    pushDebug(`hasNative: ${hasNative} UA:${navigator.userAgent.slice(0,60)}`)
    // iOS: force ZXing if WASM fails
    let useZXingFallback=false
    if (!hasNative){
      try{ await loadPolyfill(); setEngineLabel('WASM'); pushDebug('polyfill loaded WASM') }catch(e){ useZXingFallback=true; setEngineLabel('ZXing'); pushDebug(`polyfill fail: ${e?.message} -> ZXing`) }
    } else { setEngineLabel('Native'); pushDebug('using Native') }
    try{
      if (!useZXingFallback) { detectorRef.current=new window.BarcodeDetector({ formats:['code_39','code_128','codabar', 'code_93', 'ean_13', 'ean_8'] }); pushDebug('BarcodeDetector created') }
      else { const {BrowserMultiFormatReader}=await import('@zxing/library'); zxingRef.current=new BrowserMultiFormatReader(); detectorRef.current={ detect: async(v)=>{ const t=await tryZXingDecode(v); return t?[{rawValue:t, cornerPoints:[]}]:[] } }; pushDebug('ZXing detector created') }
    }catch(e){ pushDebug(`detector create fail: ${e?.message}`); setStatus('error'); setErrorMsg('Failed to start barcode detector'); return }
    // camera — iOS needs ideal facingMode, no max, inside user gesture
    let stream=null
    const isIOSUA=/iPad|iPhone|iPod/.test(navigator.userAgent)
    const chain = isIOSUA ? RESOLUTION_CHAIN.slice(1) : RESOLUTION_CHAIN
    const startIdx = hasNative ? 0 : 1
    for(let i=startIdx;i<chain.length;i++){
      try{
        stream=await navigator.mediaDevices.getUserMedia({ video:{ ...chain[i], facingMode:{ ideal:'environment' } }, audio:false })
        break
      }catch{
        if(i===chain.length-1){
          try{ stream=await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' } }, audio:false }); break }catch(err){
            setStatus('error'); setErrorMsg(err.name==='NotAllowedError' ? 'Camera permission denied — allow camera and tap Retry.' : 'No camera found.')
            return
          }
        }
      }
    }
    if(!mountedRef.current){ stream?.getTracks().forEach(t=>t.stop()); return }
    streamRef.current=stream
    videoRef.current.srcObject=stream
    try{ const caps=stream.getVideoTracks()[0]?.getCapabilities?.(); setTorchSupported(!!caps?.torch) }catch{}
    try{ await videoRef.current.play() }catch{ setStatus('error'); setErrorMsg('Could not start video playback.'); return }
    // profile device (5 frames)
    qualityRef.current=createQualityChecker()
    try{
      const times=[]
      for(let i=0;i<5;i++){ const t0=performance.now(); try{ await detectorRef.current.detect(videoRef.current)}catch{}; times.push(performance.now()-t0) }
      const avg=times.reduce((a,b)=>a+b,0)/times.length
      const prof=avg<30?'fast':avg<120?'medium':'slow'
      configRef.current=DEVICE_PROFILES[prof]
      // iOS halls: relax variance
      if(isIOSUA) configRef.current={ ...configRef.current, useQualityGate:false }
    }catch{}
    setStatus('ready')
    detectLoop()
  }

  useEffect(()=>{ mountedRef.current=true; startScanner(); return()=>{ mountedRef.current=false; stopScanner() }},[]) // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref,()=>({ restart:startScanner, stop:stopScanner }))

  const toggleTorch=async()=>{
    if(!streamRef.current) return
    const track=streamRef.current.getVideoTracks()[0]
    try{ await track.applyConstraints({ advanced:[{torch:!torchOn}] }); setTorchOn(!torchOn) }catch{}
  }

  if(status==='error') return (
    <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:12, padding:'1.25rem', textAlign:'center' }}>
      <div style={{ display:'flex', justifyContent:'center', marginBottom:'0.6rem' }}><CameraOff size={28} style={{ color:'#b91c1c' }} /></div>
      <div style={{ fontWeight:700, marginBottom:'0.4rem' }}>Camera error</div>
      <div style={{ fontSize:'0.85rem', color:'#64748b', marginBottom:'0.9rem' }}>{errorMsg}</div>
      <button onClick={startScanner} className="btn btn-primary"><RefreshCw size={14}/> Retry</button>
    </div>
  )

  return (
    <div style={{ position:'relative', background:'#000', borderRadius:12, overflow:'hidden' }}>
      <video ref={videoRef} playsInline muted autoPlay webkit-playsinline="true" style={{ width:'100%', height: 320, objectFit:'cover', display:'block' }} />
      {status==='loading' && <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.55)', color:'#fff', fontWeight:600 }}>Loading camera… {engineLabel}</div>}
      <div style={{ position:'absolute', top:8, left:8, display:'flex', gap:6 }}>
        <span className="pill" style={{ background:'rgba(0,0,0,0.6)', color:'#fff', fontSize:'0.65rem' }}>{engineLabel || '…'} {fps?`${fps} fps`:''}</span>
        {isIOS && <span className="pill" style={{ background:'rgba(16,185,129,0.9)', color:'#fff', fontSize:'0.62rem' }}>iOS</span>}
        {lastRaw && <span className="pill" style={{ background:'rgba(59,130,246,0.9)', color:'#fff', fontSize:'0.62rem' }}>{lastRaw}</span>}
      </div>
      {torchSupported && <button onClick={toggleTorch} style={{ position:'absolute', top:8, right:8, background: torchOn?'#f59e0b':'rgba(0,0,0,0.6)', color:'#fff', border:'none', borderRadius:8, padding:'0.35rem 0.6rem', fontWeight:700, fontSize:'0.75rem' }}><Zap size={12}/> {torchOn?'Torch ON':'Torch'}</button>}
      {guidanceMsg && <div style={{ position:'absolute', bottom:10, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.7)', color:'#fff', padding:'0.35rem 0.7rem', borderRadius:999, fontSize:'0.78rem', fontWeight:600, whiteSpace:'nowrap' }}>{guidanceMsg}</div>}
      <div style={{ position:'absolute', inset:0, pointerEvents:'none', border:'2px solid rgba(255,255,255,0.35)', borderRadius:12, margin: 24 }} />
      {debug && (
        <div style={{ position:'absolute', bottom:0, left:0, right:0, maxHeight:110, overflow:'auto', background:'rgba(0,0,0,0.85)', color:'#a7f3d0', fontSize:'0.65rem', fontFamily:'monospace', padding:'0.4rem 0.6rem', borderTop:'1px solid #333' }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}><span style={{fontWeight:700}}>DEBUG</span><button onClick={()=>setDebugLogs([])} style={{background:'#333', color:'#fff', border:'none', borderRadius:4, padding:'2px 6px', fontSize:'0.6rem'}}>Clear</button></div>
          {debugLogs.length===0 ? <div style={{opacity:0.6}}>waiting… point at FB/BH/VS badge, ensure good light, hold 15cm away</div> : debugLogs.map((l,i)=><div key={i} style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{l}</div>)}
        </div>
      )}
      <button onClick={()=>onScanRef.current?.('FB5982GA0025')} style={{ position:'absolute', top:40, right:8, background:'rgba(59,130,246,0.9)', color:'#fff', border:'none', borderRadius:6, padding:'0.3rem 0.5rem', fontSize:'0.65rem', fontWeight:700 }}>Test FB</button>
    </div>
  )
})

export default BarcodeScanner
export { BADGE_REGEX }
