// ═══════════════════════════════════════════════════════════════
//  Arduino Oscilloscope — Single File
//  Web Serial API (Chrome/Edge only)
// ═══════════════════════════════════════════════════════════════

// ── Tabs ──────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// ── DOM refs ──────────────────────────────────────────────────
const valuesList     = document.getElementById('values-list');
const pointsToggleEl = document.getElementById('points-toggle');
const logScaleToggle = document.getElementById('log-scale-toggle');
const overlayCanvas  = document.getElementById('grid-overlay');
const plotCanvas     = document.getElementById('plot');
const msdivDisplayEl = document.getElementById('msdiv-display');
const infoFreqEl     = document.getElementById('info-freq');
const infoDelayEl    = document.getElementById('info-delay');
const infoBufferEl   = document.getElementById('info-buffer');
const pauseBtn       = document.getElementById('pause-btn');

// ── Channels ──────────────────────────────────────────────────
const CHANNELS = [
  { key:'v1', color:'#008184', label:'CH1', toggleId:'ch1-toggle' },
  { key:'v2', color:'#FF9900', label:'CH2', toggleId:'ch2-toggle' },
  { key:'v3', color:'#FF2B2B', label:'CH3', toggleId:'ch3-toggle' },
];
const channelActive  = { v1:false, v2:false, v3:false };
const channelVisible = { v1:true,  v2:true,  v3:true  };

// ── State ─────────────────────────────────────────────────────
let yRange=512, yOffset=0, xSamples=200, paused=false;
const Y_MIN=1, Y_MAX=1024, X_MIN=10, X_MAX=500, MAX_BUFFER=500, MAX_LOG=100;
const allSamples = [];
let displayIntervalMs=16, lastStoredT=0;

// ── Trigger ───────────────────────────────────────────────────
const trigger = { enabled:false, channel:'v1', edge:'rising', level:0, armed:true, lastVal:null, holdTimer:null };

// ── Chart ─────────────────────────────────────────────────────
const chart = new Chart(document.getElementById('plot').getContext('2d'), {
  type:'line',
  data:{ labels:[], datasets:CHANNELS.map(ch=>({ label:ch.label, data:[], borderColor:ch.color, backgroundColor:ch.color+'15', borderWidth:1.5, pointRadius:0, tension:0.3, fill:false })) },
  options:{ animation:false, responsive:true, maintainAspectRatio:true, aspectRatio:3,
    scales:{ x:{display:false}, y:{ min:-512, max:512, grid:{color:'#e9ecef'}, ticks:{color:'#5D6A6B', font:{family:'Courier New,monospace',size:11}, maxTicksLimit:6} } },
    plugins:{legend:{display:false}} }
});

// ── Throttled refresh ─────────────────────────────────────────
const CHART_INTERVAL=100; let chartDirty=false, chartTimerId=null;
function scheduleChartRefresh(){
  if(trigger.enabled&&!trigger.armed)return;
  chartDirty=true;
  if(chartTimerId===null){ chartTimerId=setInterval(()=>{ if(chartDirty){chartDirty=false;doRefreshChart();}else{clearInterval(chartTimerId);chartTimerId=null;} },CHART_INTERVAL); }
}

// ── Markers ───────────────────────────────────────────────────
const hMarkers=[]; let draggingMarker=null, markerJustCreated=false, draggingTrigger=false;
function yValueToPx(v,mT,h){const yMin=yOffset-yRange,yMax=yOffset+yRange;return mT+h*(1-(v-yMin)/(yMax-yMin));}
function yPxToValue(px,mT,h){const yMin=yOffset-yRange,yMax=yOffset+yRange;return yMax-((px-mT)/h)*(yMax-yMin);}
function markerAtY(px,py,ov){if(!ov._chartArea)return -1;const{marginTop:mT,h}=ov._chartArea;return hMarkers.findIndex(m=>Math.abs(yValueToPx(m.value,mT,h)-py)<8);}

// ── Selection ─────────────────────────────────────────────────
const selection={active:false,startX:null,endX:null};
function xPxToSampleIndex(px,ov){const ca=ov._chartArea||{marginLeft:40,w:ov.offsetWidth-50};const r=Math.max(0,Math.min(1,(px-ca.marginLeft)/ca.w));return Math.round(r*(allSamples.slice(-xSamples).length-1));}
function updateSelectionInfo(){
  const el=document.getElementById('selection-info');
  if(!el||selection.startX===null||selection.endX===null)return;
  const visible=allSamples.slice(-xSamples);
  const i0=Math.min(xPxToSampleIndex(selection.startX,overlayCanvas),xPxToSampleIndex(selection.endX,overlayCanvas));
  const i1=Math.max(xPxToSampleIndex(selection.startX,overlayCanvas),xPxToSampleIndex(selection.endX,overlayCanvas));
  const sl=visible.slice(i0,i1+1); if(sl.length<2){el.style.display='none';return;}
  const dMs=(sl[sl.length-1].t-sl[0].t)*1000;
  document.getElementById('sel-duration').textContent=dMs>=1000?`Δt:${(dMs/1000).toFixed(2)}s`:`Δt:${Math.round(dMs)}ms`;
  const avg=CHANNELS.filter(ch=>channelActive[ch.key]&&channelVisible[ch.key]).map(ch=>{const vs=sl.map(s=>s[ch.key]).filter(v=>v!=null);if(!vs.length)return null;return`<span style="color:${ch.color}">${ch.label}:${(vs.reduce((a,b)=>a+b,0)/vs.length).toFixed(1)}</span>`;}).filter(Boolean).join(' &nbsp;');
  document.getElementById('sel-avg').innerHTML=avg||'—'; el.style.display='flex';
}

// ── Trigger helpers ───────────────────────────────────────────
function updateTriggerStatus(){
  const el=document.getElementById('trigger-status'),lvEl=document.getElementById('trigger-level-display');
  if(!el)return;
  if(!trigger.enabled){el.textContent='OFF';el.className='trig-status off';}
  else if(trigger.armed){el.textContent='ARMED';el.className='trig-status';}
  else{el.textContent='TRIGGERED';el.className='trig-status triggered';}
  if(lvEl)lvEl.textContent=trigger.enabled?trigger.level.toFixed(1):'—';
}
function checkTrigger(s){
  if(!trigger.enabled||!trigger.armed)return false;
  const val=s[trigger.channel];if(val==null)return false;
  const prev=trigger.lastVal;trigger.lastVal=val;if(prev==null)return false;
  return(trigger.edge==='rising'&&prev<trigger.level&&val>=trigger.level)||(trigger.edge==='falling'&&prev>trigger.level&&val<=trigger.level)||(trigger.edge==='both'&&((prev<trigger.level&&val>=trigger.level)||(prev>trigger.level&&val<=trigger.level)));
}
function drawTriggerLine(gctx,mL,mT,w,h){
  if(!trigger.enabled)return;
  const yPx=yValueToPx(trigger.level,mT,h),tri=7;
  gctx.fillStyle='rgba(40,120,40,0.9)';gctx.beginPath();gctx.moveTo(mL,yPx);gctx.lineTo(mL-tri*1.4,yPx-tri);gctx.lineTo(mL-tri*1.4,yPx+tri);gctx.closePath();gctx.fill();
  gctx.strokeStyle='rgba(40,150,40,0.6)';gctx.lineWidth=1.5;gctx.setLineDash([4,4]);gctx.beginPath();gctx.moveTo(mL,yPx);gctx.lineTo(mL+w,yPx);gctx.stroke();gctx.setLineDash([]);
  const lbl=`T:${trigger.level.toFixed(1)}`;gctx.font='bold 10px Courier New,monospace';const tw=gctx.measureText(lbl).width+8;
  gctx.fillStyle='rgba(40,120,40,0.9)';gctx.fillRect(mL+w-tw-4,yPx-10,tw,14);gctx.fillStyle='#fff';gctx.fillText(lbl,mL+w-tw,yPx+1);
}

// ── doRefreshChart ────────────────────────────────────────────
function doRefreshChart(){
  const visible=allSamples.slice(-xSamples),N=10;
  chart.data.labels=visible.map(()=>'');
  CHANNELS.forEach((ch,i)=>{chart.data.datasets[i].data=visible.map(s=>s[ch.key]??null);chart.data.datasets[i].hidden=!channelVisible[ch.key];});
  const isLog=logScaleToggle&&logScaleToggle.checked;
  chart.options.scales.y.min=isLog?Math.max(1,yOffset-yRange):yOffset-yRange;
  chart.options.scales.y.max=yOffset+yRange;
  chart.update('none');

  // Overlay
  if(overlayCanvas&&plotCanvas){
    const pw=plotCanvas.offsetWidth,ph=plotCanvas.offsetHeight;
    if(overlayCanvas.width!==pw||overlayCanvas.height!==ph){overlayCanvas.width=pw;overlayCanvas.height=ph;}
    const gctx=overlayCanvas.getContext('2d');gctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
    const mL=40,mR=10,mT=10,mB=10,w=overlayCanvas.width-mL-mR,h=overlayCanvas.height-mT-mB;
    gctx.strokeStyle='rgba(0,0,0,0.08)';gctx.lineWidth=1;gctx.beginPath();
    for(let i=0;i<=N;i++){const x=mL+(w/N)*i;gctx.moveTo(x,mT);gctx.lineTo(x,mT+h);}gctx.stroke();
    if(selection.active||(selection.startX!==null&&selection.endX!==null)){
      const sx=Math.min(selection.startX,selection.endX??selection.startX),ex=Math.max(selection.startX,selection.endX??selection.startX);
      gctx.fillStyle='rgba(0,129,132,0.15)';gctx.fillRect(sx,mT,ex-sx,h);
      gctx.strokeStyle='rgba(0,129,132,0.6)';gctx.lineWidth=1;
      gctx.beginPath();gctx.moveTo(sx,mT);gctx.lineTo(sx,mT+h);gctx.stroke();
      gctx.beginPath();gctx.moveTo(ex,mT);gctx.lineTo(ex,mT+h);gctx.stroke();
    }
    hMarkers.forEach(marker=>{
      const yPx=yValueToPx(marker.value,mT,h),tri=7;
      gctx.fillStyle='rgba(180,40,40,0.9)';gctx.beginPath();gctx.moveTo(mL,yPx);gctx.lineTo(mL-tri*1.4,yPx-tri);gctx.lineTo(mL-tri*1.4,yPx+tri);gctx.closePath();gctx.fill();
      gctx.strokeStyle='rgba(180,40,40,0.75)';gctx.lineWidth=1.5;gctx.setLineDash([6,3]);gctx.beginPath();gctx.moveTo(mL,yPx);gctx.lineTo(mL+w,yPx);gctx.stroke();gctx.setLineDash([]);
      const lbl=marker.value.toFixed(1);gctx.font='bold 10px Courier New,monospace';const tw=gctx.measureText(lbl).width+8;
      gctx.fillStyle='rgba(180,40,40,0.9)';gctx.fillRect(mL+4,yPx-10,tw,14);gctx.fillStyle='#fff';gctx.fillText(lbl,mL+8,yPx+1);
    });
    drawTriggerLine(gctx,mL,mT,w,h);
    overlayCanvas._chartArea={marginLeft:mL,marginRight:mR,marginTop:mT,marginBottom:mB,w,h};
  }

  // ms/div
  if(msdivDisplayEl&&visible.length>=2){const ms=(visible[visible.length-1].t-visible[0].t)*1000,mpd=Math.round(ms/N);msdivDisplayEl.textContent=mpd>=1000?`${(mpd/1000).toFixed(1)}s/div`:`${mpd}ms/div`;}
  else if(msdivDisplayEl)msdivDisplayEl.textContent='—';

  // Stats
  CHANNELS.forEach((ch,i)=>{
    const row=document.getElementById(`stats-ch${i+1}`);
    if(!channelActive[ch.key]||!channelVisible[ch.key]){row.style.display='none';return;}
    const vals=visible.map(s=>s[ch.key]).filter(v=>v!=null);row.style.display='grid';
    if(vals.length>0){let mn=vals[0],mx=vals[0],sum=0;for(const v of vals){if(v<mn)mn=v;if(v>mx)mx=v;sum+=v;}
      document.getElementById(`stat-ch${i+1}-min`).textContent=mn.toFixed(2);
      document.getElementById(`stat-ch${i+1}-max`).textContent=mx.toFixed(2);
      document.getElementById(`stat-ch${i+1}-avg`).textContent=(sum/vals.length).toFixed(2);}
    else{document.getElementById(`stat-ch${i+1}-min`).textContent=document.getElementById(`stat-ch${i+1}-max`).textContent=document.getElementById(`stat-ch${i+1}-avg`).textContent='—';}
  });
}
function refreshChart(){chartDirty=false;doRefreshChart();}

// ── Checkboxes ────────────────────────────────────────────────
CHANNELS.forEach((ch,i)=>{document.getElementById(ch.toggleId).addEventListener('change',e=>{channelVisible[ch.key]=e.target.checked;chart.data.datasets[i].hidden=!e.target.checked;chart.update('none');});});
function updateChannelToggles(){CHANNELS.forEach(ch=>{const t=document.getElementById(ch.toggleId),l=t.closest('label');if(channelActive[ch.key]){t.disabled=false;l.classList.remove('disabled');}else{t.disabled=true;t.checked=false;channelVisible[ch.key]=false;l.classList.add('disabled');}});}
if(pointsToggleEl){pointsToggleEl.addEventListener('change',()=>{const r=pointsToggleEl.checked?1:0;CHANNELS.forEach((_,i)=>{chart.data.datasets[i].pointRadius=r;chart.data.datasets[i].pointHoverRadius=r+1;});chart.update();});}
if(logScaleToggle){logScaleToggle.addEventListener('change',()=>{const isLog=logScaleToggle.checked;chart.options.scales.y.type=isLog?'logarithmic':'linear';chart.options.scales.y.min=isLog?Math.max(1,yOffset-yRange):yOffset-yRange;chart.options.scales.y.max=yOffset+yRange;chart.update();});}

// ── Pause ─────────────────────────────────────────────────────
if(pauseBtn){pauseBtn.addEventListener('click',()=>{paused=!paused;pauseBtn.textContent=paused?'▶':'⏸';pauseBtn.classList.toggle('active',paused);});}

// ── Zoom ──────────────────────────────────────────────────────
document.getElementById('y-zoom-in').addEventListener('click',()=>{yRange=Math.max(Y_MIN,Math.round(yRange/2));refreshChart();});
document.getElementById('y-zoom-out').addEventListener('click',()=>{yRange=Math.min(Y_MAX,yRange*2);refreshChart();});
document.getElementById('y-offset-up').addEventListener('click',()=>{yOffset+=Math.round(yRange/2);refreshChart();});
document.getElementById('y-offset-down').addEventListener('click',()=>{yOffset-=Math.round(yRange/2);refreshChart();});
document.getElementById('x-zoom-in').addEventListener('click',()=>{xSamples=Math.min(X_MAX,xSamples*2);refreshChart();updateSelectionInfo();});
document.getElementById('x-zoom-out').addEventListener('click',()=>{xSamples=Math.max(X_MIN,Math.round(xSamples/2));refreshChart();updateSelectionInfo();});

// ── Interval ──────────────────────────────────────────────────
document.getElementById('interval-slider').addEventListener('input',e=>{displayIntervalMs=parseInt(e.target.value);document.getElementById('interval-display').textContent=`${displayIntervalMs} ms`;});

// ── Trigger listeners ─────────────────────────────────────────
document.getElementById('trigger-enabled').addEventListener('change',e=>{trigger.enabled=e.target.checked;trigger.armed=true;trigger.lastVal=null;updateTriggerStatus();});
document.getElementById('trigger-channel').addEventListener('change',e=>{trigger.channel=e.target.value;trigger.armed=true;trigger.lastVal=null;});
document.getElementById('trigger-edge').addEventListener('change',e=>{trigger.edge=e.target.value;trigger.armed=true;trigger.lastVal=null;});
const tsEl=document.getElementById('trigger-status');
tsEl.style.cursor='pointer';tsEl.title='Click to re-arm';
tsEl.addEventListener('click',()=>{if(trigger.enabled&&!trigger.armed){trigger.armed=true;trigger.lastVal=null;updateTriggerStatus();}});
updateTriggerStatus();

// ── Overlay mouse ─────────────────────────────────────────────
function inYMargin(x){const ca=overlayCanvas._chartArea;return ca?x<ca.marginLeft:x<40;}
overlayCanvas.addEventListener('mousedown',e=>{
  const r=overlayCanvas.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;
  if(inYMargin(px)){
    if(!overlayCanvas._chartArea)doRefreshChart();if(!overlayCanvas._chartArea)return;
    if(trigger.enabled){const{marginTop:mT,h}=overlayCanvas._chartArea;if(Math.abs(yValueToPx(trigger.level,mT,h)-py)<8){draggingTrigger=true;return;}}
    const idx=markerAtY(px,py,overlayCanvas);
    if(idx>=0){draggingMarker=idx;}else{const{marginTop:mT,h}=overlayCanvas._chartArea;hMarkers.push({value:yPxToValue(py,mT,h)});markerJustCreated=true;doRefreshChart();}
  }else{selection.active=true;selection.startX=px;selection.endX=null;doRefreshChart();}
});
overlayCanvas.addEventListener('mousemove',e=>{
  const r=overlayCanvas.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;
  if(inYMargin(px)){let c=false;if(trigger.enabled&&overlayCanvas._chartArea){const{marginTop:mT,h}=overlayCanvas._chartArea;if(Math.abs(yValueToPx(trigger.level,mT,h)-py)<8){overlayCanvas.style.cursor='ns-resize';c=true;}}if(!c)overlayCanvas.style.cursor=(overlayCanvas._chartArea&&markerAtY(px,py,overlayCanvas)>=0)?'ns-resize':'crosshair';}
  else overlayCanvas.style.cursor='crosshair';
  if(draggingTrigger){const{marginTop:mT,h}=overlayCanvas._chartArea;trigger.level=yPxToValue(py,mT,h);trigger.armed=true;updateTriggerStatus();doRefreshChart();return;}
  if(draggingMarker!==null){const{marginTop:mT,h}=overlayCanvas._chartArea;hMarkers[draggingMarker].value=yPxToValue(py,mT,h);doRefreshChart();return;}
  if(selection.active){selection.endX=px;doRefreshChart();}
});
overlayCanvas.addEventListener('mouseup',e=>{
  const r=overlayCanvas.getBoundingClientRect(),px=e.clientX-r.left;
  if(draggingTrigger){draggingTrigger=false;return;}if(draggingMarker!==null){draggingMarker=null;return;}
  selection.endX=px;selection.active=false;doRefreshChart();updateSelectionInfo();
});
overlayCanvas.addEventListener('click',e=>{
  const r=overlayCanvas.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;
  if(inYMargin(px)){if(markerJustCreated){markerJustCreated=false;return;}const idx=markerAtY(px,py,overlayCanvas);if(idx>=0){hMarkers.splice(idx,1);doRefreshChart();}return;}
  if(selection.startX!==null&&Math.abs((selection.endX??selection.startX)-selection.startX)<4){selection.startX=null;selection.endX=null;document.getElementById('selection-info').style.display='none';doRefreshChart();}
});

// ── Log ───────────────────────────────────────────────────────
function formatTime(ts){return new Date(ts*1000).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
const LOG_INTERVAL=200;let pendingLogEntry=null,logTimerId=null;
function scheduleLogUpdate(entry){
  pendingLogEntry=entry;
  if(logTimerId===null){logTimerId=setInterval(()=>{if(pendingLogEntry!==null){valuesList.appendChild(pendingLogEntry);pendingLogEntry=null;while(valuesList.children.length>MAX_LOG)valuesList.removeChild(valuesList.firstChild);valuesList.scrollTop=valuesList.scrollHeight;}else{clearInterval(logTimerId);logTimerId=null;}},LOG_INTERVAL);}
}

// ── pushSample ────────────────────────────────────────────────
function pushSample(s){
  if(paused)return;
  const nowMs=s.t*1000;if(nowMs-lastStoredT<displayIntervalMs)return;lastStoredT=nowMs;
  allSamples.push(s);if(allSamples.length>MAX_BUFFER)allSamples.shift();
  let changed=false;
  CHANNELS.forEach(ch=>{if(!channelActive[ch.key]&&s[ch.key]!=null){channelActive[ch.key]=true;channelVisible[ch.key]=true;changed=true;}});
  if(changed)updateChannelToggles();
  if(allSamples.length>=2){const dMs=(s.t-allSamples[allSamples.length-2].t)*1000;if(infoFreqEl)infoFreqEl.textContent=dMs>0?`${Math.round(1000/dMs)} Hz`:'—';if(infoDelayEl)infoDelayEl.textContent=`${Math.round(dMs)} ms`;if(infoBufferEl)infoBufferEl.textContent=`${allSamples.length}/${MAX_BUFFER}`;}
  if(checkTrigger(s)){trigger.armed=false;updateTriggerStatus();const hEl=document.getElementById('trigger-hold');const hMs=hEl?parseInt(hEl.value):500;if(hMs>0){if(trigger.holdTimer)clearTimeout(trigger.holdTimer);trigger.holdTimer=setTimeout(()=>{trigger.holdTimer=null;trigger.armed=true;trigger.lastVal=null;updateTriggerStatus();},hMs);}}
  scheduleChartRefresh();
  const parts=CHANNELS.filter(ch=>channelActive[ch.key]&&s[ch.key]!=null).map(ch=>`<span class="vchip" style="border-color:${ch.color}">${ch.label}:<b>${parseFloat(s[ch.key]).toFixed(1)}</b></span>`).join('');
  const entry=document.createElement('div');entry.className='ventry';entry.innerHTML=`<span class="vtime">${formatTime(s.t)}</span><span class="vchips">${parts}</span>`;scheduleLogUpdate(entry);
}

// ── CSV ───────────────────────────────────────────────────────
document.getElementById('download-csv').addEventListener('click',()=>{
  if(!allSamples.length)return;
  const active=CHANNELS.filter(ch=>channelActive[ch.key]),t0=allSamples[0].t;
  const header=['time_ms',...active.map(ch=>ch.label)].join(',');
  const rows=allSamples.map(s=>[Math.round((s.t-t0)*1000),...active.map(ch=>s[ch.key]??'')].join(','));
  const blob=new Blob([[header,...rows].join('\n')],{type:'text/csv'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`sensor_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;a.click();URL.revokeObjectURL(url);
});

// ── Analysis ──────────────────────────────────────────────────
const analysisEnabledEl=document.getElementById('analysis-enabled');
const analysisChannelEl=document.getElementById('analysis-channel');
const analysisFitEl=document.getElementById('analysis-fit');
const analysisResultEl=document.getElementById('analysis-result');
const analysisFormulaEl=document.getElementById('analysis-formula');
const analysisR2El=document.getElementById('analysis-r2');
const analysisPausedEl=document.getElementById('analysis-paused');
let analysisSnapshot=null;

function getAnalysisData(){
  const visible=allSamples.slice(-xSamples),ch=analysisChannelEl?analysisChannelEl.value:'v1';
  let slice=visible;
  if(selection.startX!==null&&selection.endX!==null&&overlayCanvas._chartArea){const i0=Math.min(xPxToSampleIndex(selection.startX,overlayCanvas),xPxToSampleIndex(selection.endX,overlayCanvas)),i1=Math.max(xPxToSampleIndex(selection.startX,overlayCanvas),xPxToSampleIndex(selection.endX,overlayCanvas));slice=visible.slice(i0,i1+1);}
  return slice.map((s,i)=>({x:i,y:s[ch]})).filter(p=>p.y!=null);
}
function fitHorizontal(pts){const a=pts.reduce((s,p)=>s+p.y,0)/pts.length;return{fn:()=>a,label:`y=${a.toFixed(3)}`};}
function fitLinear(pts){const n=pts.length,sx=pts.reduce((s,p)=>s+p.x,0),sy=pts.reduce((s,p)=>s+p.y,0),sxx=pts.reduce((s,p)=>s+p.x*p.x,0),sxy=pts.reduce((s,p)=>s+p.x*p.y,0),det=n*sxx-sx*sx;if(Math.abs(det)<1e-10)return fitHorizontal(pts);const a=(n*sxy-sx*sy)/det,b=(sy-a*sx)/n;return{fn:x=>a*x+b,label:`y=${a.toFixed(3)}x+${b.toFixed(3)}`};}
function fitLogarithmic(pts){const r=fitLinear(pts.map(p=>({x:Math.log(p.x+1),y:p.y})));return{fn:x=>r.fn(Math.log(x+1)),label:`y=a·ln(x+1)+b [${r.label}]`};}
function fitPower(pts){const v=pts.filter(p=>p.x>0&&p.y>0);if(v.length<2)return fitLinear(pts);const r=fitLinear(v.map(p=>({x:Math.log(p.x),y:Math.log(p.y)})));const b=r.fn(1)-r.fn(0),a=Math.exp(r.fn(0));return{fn:x=>a*Math.pow(Math.max(x,1e-9),b),label:`y=${a.toFixed(3)}x^${b.toFixed(3)}`};}
function fitExponential(pts){const v=pts.filter(p=>p.y>0);if(v.length<2)return fitLinear(pts);const r=fitLinear(v.map(p=>({x:p.x,y:Math.log(p.y)})));const b=r.fn(1)-r.fn(0),a=Math.exp(r.fn(0));return{fn:x=>a*Math.exp(b*x),label:`y=${a.toFixed(3)}e^(${b.toFixed(3)}x)`};}
function fitSinusoidal(pts){const ys=pts.map(p=>p.y),d=ys.reduce((s,v)=>s+v,0)/ys.length;let mn=ys[0],mx=ys[0];for(const v of ys){if(v<mn)mn=v;if(v>mx)mx=v;}const centered=ys.map(v=>v-d);let cr=0;for(let i=1;i<centered.length;i++)if(centered[i-1]*centered[i]<0)cr++;const period=cr>1?(2*pts[pts.length-1].x)/cr:pts.length,b=(2*Math.PI)/Math.max(period,1);let s1=0,s2=0,s3=0,s4=0,s5=0;for(const p of pts){const si=Math.sin(b*p.x),co=Math.cos(b*p.x),yc=p.y-d;s1+=si*si;s2+=co*co;s3+=si*co;s4+=yc*si;s5+=yc*co;}const det=s1*s2-s3*s3,A=Math.abs(det)<1e-10?(mx-mn)/2:(s4*s2-s5*s3)/det,B=Math.abs(det)<1e-10?0:(s5*s1-s4*s3)/det,aF=Math.sqrt(A*A+B*B),cF=Math.atan2(B,A);return{fn:x=>aF*Math.sin(b*x+cF)+d,label:`y=${aF.toFixed(2)}sin(${b.toFixed(4)}x+${cF.toFixed(3)})+${d.toFixed(2)}`};}
function computeR2(pts,fn){const m=pts.reduce((s,p)=>s+p.y,0)/pts.length;let sT=0,sR=0;for(const p of pts){sT+=(p.y-m)**2;sR+=(p.y-fn(p.x))**2;}return sT<1e-10?1:Math.max(0,1-sR/sT);}
function runFit(){
  if(!analysisSnapshot||analysisSnapshot.length<2)return;
  const pts=analysisSnapshot,type=analysisFitEl?analysisFitEl.value:'linear';
  let r;switch(type){case'horizontal':r=fitHorizontal(pts);break;case'power':r=fitPower(pts);break;case'exponential':r=fitExponential(pts);break;case'sinusoidal':r=fitSinusoidal(pts);break;case'logarithmic':r=fitLogarithmic(pts);break;default:r=fitLinear(pts);}
  const r2=computeR2(pts,r.fn);
  if(analysisFormulaEl)analysisFormulaEl.textContent=r.label;if(analysisR2El)analysisR2El.textContent=r2.toFixed(4);if(analysisResultEl)analysisResultEl.style.display='flex';
  const visible=allSamples.slice(-xSamples),fitData=visible.map((_,i)=>{try{const v=r.fn(i);return isFinite(v)?v:null;}catch{return null;}});
  if(chart.data.datasets.length>3)chart.data.datasets[3].data=fitData;
  else chart.data.datasets.push({label:'fit',data:fitData,borderColor:'rgba(255,180,0,0.9)',borderWidth:1.5,borderDash:[5,3],pointRadius:0,fill:false});
  chart.update('none');
}
if(analysisEnabledEl){analysisEnabledEl.addEventListener('change',()=>{
  if(analysisEnabledEl.checked){paused=true;if(pauseBtn){pauseBtn.textContent='▶';pauseBtn.classList.add('active');}if(analysisPausedEl)analysisPausedEl.style.display='inline';analysisSnapshot=getAnalysisData();runFit();}
  else{paused=false;if(pauseBtn){pauseBtn.textContent='⏸';pauseBtn.classList.remove('active');}if(analysisPausedEl)analysisPausedEl.style.display='none';analysisSnapshot=null;if(analysisResultEl)analysisResultEl.style.display='none';if(chart.data.datasets.length>3){chart.data.datasets.splice(3);chart.update('none');}}
});}
if(analysisFitEl)analysisFitEl.addEventListener('change',()=>{if(analysisEnabledEl&&analysisEnabledEl.checked)runFit();});
if(analysisChannelEl)analysisChannelEl.addEventListener('change',()=>{if(analysisEnabledEl&&analysisEnabledEl.checked){analysisSnapshot=getAnalysisData();runFit();}});

// ── Signal Generator (multi-channel) ─────────────────────────
const GEN_TICK=16;

// Per-generator state: 3 independent generators
const generators=[
  {id:'1',phase:0,timer:null},
  {id:'2',phase:0,timer:null},
  {id:'3',phase:0,timer:null},
];

function calcGenVal(id,phase){
  const wave=document.getElementById(`gen-wave-${id}`).value;
  const amp=parseFloat(document.getElementById(`gen-amp-${id}`).value);
  const off=parseFloat(document.getElementById(`gen-off-${id}`).value);
  const freq=parseFloat(document.getElementById(`gen-freq-${id}`).value);
  const duty=parseFloat(document.getElementById(`gen-duty-${id}`).value)/100;
  const noise=parseFloat(document.getElementById(`gen-noise-${id}`).value);
  const period=1/freq;
  const norm=(phase%period)/period;
  switch(wave){
    case'sine':     return off+amp*Math.sin(2*Math.PI*norm);
    case'square':   return off+amp*(norm<duty?1:-1);
    case'sawtooth': return off+amp*(2*norm-1);
    case'triangle': return off+amp*(norm<0.5?4*norm-1:3-4*norm);
    case'noise':    return off+(Math.random()*2-1)*noise;
    case'dc':       return off;
    default:        return off;
  }
}

// Shared tick — all active generators fire together so samples merge
let genSharedTimer=null;
function genTick(){
  const s={t:Date.now()/1000,v1:null,v2:null,v3:null};
  let any=false;
  generators.forEach((g,i)=>{
    const el=document.getElementById(`gen-enabled-${g.id}`);
    if(!el||!el.checked)return;
    const ch=document.getElementById(`gen-channel-${g.id}`).value;
    const freq=parseFloat(document.getElementById(`gen-freq-${g.id}`).value);
    const wave=document.getElementById(`gen-wave-${g.id}`).value;
    if(wave!=='dc'&&wave!=='noise') g.phase+=GEN_TICK/1000;
    else g.phase+=GEN_TICK/1000;
    s[ch]=parseFloat(calcGenVal(g.id,g.phase).toFixed(3));
    any=true;
  });
  if(any) pushSample(s);
}
function updateSharedTimer(){
  const anyOn=generators.some(g=>{ const el=document.getElementById(`gen-enabled-${g.id}`); return el&&el.checked; });
  if(anyOn&&!genSharedTimer){ genSharedTimer=setInterval(genTick,GEN_TICK); }
  else if(!anyOn&&genSharedTimer){ clearInterval(genSharedTimer);genSharedTimer=null; }
}

generators.forEach(g=>{
  const el=document.getElementById(`gen-enabled-${g.id}`);
  if(el) el.addEventListener('change',()=>{ g.phase=0; updateSharedTimer(); });
  // wave change → toggle param rows
  const waveEl=document.getElementById(`gen-wave-${g.id}`);
  if(waveEl) waveEl.addEventListener('change',()=>{
    const w=waveEl.value;
    document.getElementById(`gen-freq-row-${g.id}`).style.display=(w==='dc'||w==='noise')?'none':'';
    document.getElementById(`gen-duty-row-${g.id}`).style.display=w==='square'?'':'none';
    document.getElementById(`gen-noise-row-${g.id}`).style.display=w==='noise'?'':'none';
  });
});

function bindSlider(id,valId,fmt){const sl=document.getElementById(id),vl=document.getElementById(valId);if(sl&&vl)sl.addEventListener('input',()=>{vl.textContent=fmt(sl.value);});}
generators.forEach(g=>{
  bindSlider(`gen-amp-${g.id}`,`gen-amp-val-${g.id}`,v=>parseFloat(v).toFixed(0));
  bindSlider(`gen-off-${g.id}`,`gen-off-val-${g.id}`,v=>parseFloat(v).toFixed(0));
  bindSlider(`gen-freq-${g.id}`,`gen-freq-val-${g.id}`,v=>`${parseFloat(v).toFixed(1)} Hz`);
  bindSlider(`gen-duty-${g.id}`,`gen-duty-val-${g.id}`,v=>`${v}%`);
  bindSlider(`gen-noise-${g.id}`,`gen-noise-val-${g.id}`,v=>Math.round(v));
});

// ── Web Serial ────────────────────────────────────────────────
const connBtn=document.getElementById('conn-btn'),connStatus=document.getElementById('conn-status'),baudSel=document.getElementById('baud-sel');
let serialPort=null,serialReader=null,serialRunning=false,lineBuffer='';

if(!('serial' in navigator)){document.getElementById('no-serial-warn').style.display='block';connBtn.disabled=true;}

async function connectSerial(){
  try{
    serialPort=await navigator.serial.requestPort();
    await serialPort.open({baudRate:parseInt(baudSel.value)});
    serialRunning=true;connBtn.textContent='🔌 Disconnect';connBtn.classList.add('connected');connStatus.textContent='● connected';connStatus.classList.add('connected');
    readSerial();
  }catch(e){if(e.name!=='NotFoundError')alert('Errore: '+e.message);}
}
async function disconnectSerial(){
  serialRunning=false;
  try{if(serialReader){await serialReader.cancel();serialReader=null;}await serialPort.close();}catch(e){}
  serialPort=null;connBtn.textContent='🔌 Connect Serial';connBtn.classList.remove('connected');connStatus.textContent='● disconnected';connStatus.classList.remove('connected');
}
async function readSerial(){
  const decoder=new TextDecoderStream();serialPort.readable.pipeTo(decoder.writable);serialReader=decoder.readable.getReader();
  try{
    while(serialRunning){
      const{value,done}=await serialReader.read();if(done)break;
      lineBuffer+=value;const lines=lineBuffer.split('\n');lineBuffer=lines.pop();
      for(const line of lines){const t=line.trim();if(!t)continue;const parts=t.split(',');const values=parts.slice(0,3).map(p=>{const n=parseFloat(p.trim());return isNaN(n)?null:n;});while(values.length<3)values.push(null);pushSample({t:Date.now()/1000,v1:values[0],v2:values[1],v3:values[2]});}
    }
  }catch(e){if(serialRunning)console.warn('Serial:',e);}
  finally{try{serialReader.releaseLock();}catch(e){}}
}
connBtn.addEventListener('click',()=>{if(serialPort)disconnectSerial();else connectSerial();});

// ── Init ──────────────────────────────────────────────────────
updateChannelToggles();
refreshChart();
