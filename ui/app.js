
const R=()=>Math.random();
const rng=(a,b)=>a+R()*(b-a);
const cl=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const delay=ms=>new Promise(r=>setTimeout(r,ms));

const TASKS={
  easy:{
    label:'Easy task',budMult:1.20,
    vendorNoise:0.05,denyBase:0.05,denyVar:0.05,
    priceBias:0,stubRange:[0.3,0.55],coopBonus:0.15,
    conflictSignals:0,scenario:'Most vendors active with prices near expected. Agent finds clear winner through straightforward ranking and basic negotiation.',
    tags:['balanced prices','low denial rate','clear ranking','minimal trade-offs'],
    expectedScore:'0.85–0.95'
  },
  medium:{
    label:'Medium task',budMult:1.12,
    vendorNoise:0.12,denyBase:0.18,denyVar:0.12,
    priceBias:0.06,stubRange:[0.5,0.75],coopBonus:0.0,
    conflictSignals:1,scenario:'Several vendors denied. Remaining mix includes cheap-but-slow and fast-but-expensive options. Agent must balance delivery, price and quality — no obvious pick.',
    tags:['some denials','cheap-slow vs fast-costly','quality trade-offs','moderate budget pressure'],
    expectedScore:'0.65–0.82'
  },
  hard:{
    label:'Hard task',budMult:1.04,
    vendorNoise:0.18,denyBase:0.38,denyVar:0.18,
    priceBias:0.14,stubRange:[0.72,0.95],coopBonus:-0.15,
    conflictSignals:2,scenario:'Most vendors deny. Remaining quotes mostly exceed budget. Best quality vendors are most expensive; cheapest have lowest reliability. Agent must find best compromise — there is no perfect answer.',
    tags:['high denial rate','all prices near/over budget','quality ↔ cost conflict','best-effort result'],
    expectedScore:'0.42–0.68'
  }
};

const MARGINS=[0.20,0.18,0.15,0.13,0.12,0.10,0.09,0.08,0.07,0.06];
const VB=[
  {id:'V1',name:'AgriFirst', q:0.88,rel:0.86,bp:182,del:4,arch:'balanced'},
  {id:'V2',name:'CropKing',  q:0.79,rel:0.76,bp:165,del:3,arch:'cheap-fast'},
  {id:'V3',name:'HarvestPro',q:0.93,rel:0.91,bp:205,del:5,arch:'premium'},
  {id:'V4',name:'GrainCo',   q:0.85,rel:0.83,bp:198,del:2,arch:'fast'},
  {id:'V5',name:'PrimeFarm', q:0.77,rel:0.74,bp:168,del:5,arch:'cheap'},
  {id:'V6',name:'SeedTech',  q:0.72,rel:0.68,bp:158,del:3,arch:'cheap-fast'},
  {id:'V7',name:'BulkAgri',  q:0.67,rel:0.62,bp:150,del:6,arch:'bulk'},
  {id:'V8',name:'NatFoods',  q:0.89,rel:0.85,bp:208,del:3,arch:'premium-fast'},
  {id:'V9',name:'EcoGrain',  q:0.82,rel:0.79,bp:172,del:4,arch:'balanced'},
  {id:'V10',name:'QuickCrop',q:0.71,rel:0.67,bp:155,del:5,arch:'cheap'}
];

let G={
  task:'easy',item:'Rice',exp:180,bud:216,qty:1000,spd:380,
  steps:0,cumRew:0,vendors:[],results:[],trace:[],
  running:false,paused:false,confirmed:false,pauseRes:null,
  stochasticVendors:false,
  agent:{r:0.70,deals:0,over:0,runs:0,rewHistory:[],hist:[0.70]}
};

function setVendorMode(stochastic){
  G.stochasticVendors=Boolean(stochastic);
  const det=document.getElementById('mode-deterministic');
  const sto=document.getElementById('mode-stochastic');
  if(!det||!sto)return;
  if(G.stochasticVendors){
    det.classList.remove('active');
    sto.classList.add('active');
    det.textContent='[ ] Deterministic vendors';
    sto.textContent='✓ Stochastic vendors';
  } else {
    sto.classList.remove('active');
    det.classList.add('active');
    sto.textContent='[ ] Stochastic vendors';
    det.textContent='✓ Deterministic vendors';
  }
}

function selectTask(t){
  G.task=t;
  ['easy','medium','hard'].forEach(k=>{
    const el=document.getElementById('tc-'+k);
    el.className='tc tc-'+k+(k===t?' sel':'');
  });
  updateBudget();
  renderScenarioBox();
}

function updateBudget(){
  const exp=parseFloat(document.getElementById('f-exp').value)||180;
  G.exp=exp;
  document.getElementById('f-bud').value=Math.round(exp*TASKS[G.task].budMult);
}

function renderScenarioBox(){
  const t=TASKS[G.task];
  const cls={easy:'sb-easy',medium:'sb-med',hard:'sb-hard'}[G.task];
  const tagCls={easy:'tag-e',medium:'tag-m',hard:'tag-h'}[G.task];
  document.getElementById('scenario-box').innerHTML=`<div class="scenario-box ${cls}">
    <div class="sb-lbl">${t.label} — what the agent faces</div>
    <div style="margin-bottom:6px;line-height:1.5">${t.scenario}</div>
    <div>${t.tags.map(tg=>`<span class="tc-tag ${tagCls}">${tg}</span>`).join('')}</div>
    <div style="margin-top:6px;font-size:10px;opacity:0.8">Expected episode score: ${t.expectedScore}</div>
  </div>`;
}

function mkVendors(){
  const t=TASKS[G.task];
  return VB.map((v,i)=>{
    const noise=G.stochasticVendors ? rng(-t.vendorNoise, t.vendorNoise) : 0;
    const bias=G.stochasticVendors ? t.priceBias*(0.5+R()*0.5) : t.priceBias*0.75;
    const quote=Math.round(v.bp*(1+noise+bias));
    const denyP=cl(t.denyBase+(1-v.rel)*t.denyVar+(G.stochasticVendors&&R()<0.15?0.12:0),0,0.85);
    const denied=G.stochasticVendors ? (R()<denyP) : (denyP>=0.50);
    const baseR=cl(v.q*0.45+v.rel*0.35+(G.stochasticVendors?rng(-0.05,0.05):0),0.1,1.0);
    const stubborn=G.stochasticVendors ? rng(t.stubRange[0],t.stubRange[1]) : ((t.stubRange[0]+t.stubRange[1])/2);
    return{...v,margin:MARGINS[i],oRank:i+1,quote,accepted:null,
      status:denied?'denied':'active',deal:false,
      rating:parseFloat(baseR.toFixed(2)),rHist:[parseFloat(baseR.toFixed(2))],
      stubborn,negAttempts:0};
  });
}

function calcScore(v){
  const done=G.vendors.filter(x=>x.deal);
  if(!done.length)return 0;
  const minP=Math.min(...done.map(x=>x.accepted));
  const minD=Math.min(...G.vendors.filter(x=>x.status!=='denied').map(x=>x.del),99);
  const p=v.accepted;
  const priceFrac=Math.abs(p-G.exp)/Math.max(G.exp,1);
  let sc=0.35*(minP/p)+0.20*(minD/v.del)+0.25*v.q+0.20*v.rel;
  if(v.q<0.75)sc-=0.15;
  if(v.archetype==='bulk')sc-=0.05;
  sc-=0.04*(Math.min(G.steps,14)*0.06);
  sc-=0.08*priceFrac;
  sc+=rng(-0.018,0.018);
  return parseFloat(cl(sc,0,1).toFixed(3));
}

function agentPolicy(){
  const avail=G.vendors.filter(v=>v.status==='active'&&!v.deal);
  if(!avail.length)return{action:'done',target:null,reason:'All vendors processed'};
  const t=TASKS[G.task];
  avail.sort((a,b)=>{
    const ua=0.38*(G.bud/Math.max(a.quote,1))+0.28*a.rel+0.22*a.q+0.12*(6/(a.del+1));
    const ub=0.38*(G.bud/Math.max(b.quote,1))+0.28*b.rel+0.22*b.q+0.12*(6/(b.del+1));
    return ub-ua;
  });
  const target=avail[0];
  const bpRatio=target.quote/G.bud;
  let reason='';
  if(bpRatio<=0.92)reason=`Quote ₹${target.quote} well within budget — standard negotiation`;
  else if(bpRatio<=1.0)reason=`Quote ₹${target.quote} near budget limit — firm counter-offer strategy`;
  else reason=`Quote ₹${target.quote} exceeds budget ₹${G.bud} — margin-cap required`;
  if(t.conflictSignals>0&&target.q<0.75&&target.rel<0.75)reason+=' [quality-cost conflict detected]';
  return{action:'negotiate',target,reason};
}

function addAF(cls,msg){
  const el=document.getElementById('af');
  const d=document.createElement('div');
  d.className='afl '+cls;
  d.textContent='[s'+G.steps+'] '+msg;
  el.appendChild(d);el.scrollTop=el.scrollHeight;
}

function addRew(delta,why){
  G.cumRew=parseFloat(cl(G.cumRew+delta,-3,3).toFixed(3));
  addAF('c-if','REWARD '+(delta>=0?'+':'')+delta.toFixed(3)+' → '+G.cumRew.toFixed(3)+' ('+why+')');
  updSG();
}

function addTrace(v,action,reason,score){
  const cols={immediate_accept:'#1D9E75',negotiated:'#534AB7',quote_settle:'#BA7517',margincap:'#1D9E75',rejection:'#D85A30',skip:'#D85A30'};
  G.trace.push({step:G.steps,vid:v.id,action,reason,score});
  const pt=document.getElementById('ptrace');
  const row=document.createElement('div');row.className='prow';
  const scoreStr=score!==null?` → score ${score.toFixed(3)}`:'';
  row.innerHTML=`<div class="pnum" style="background:${cols[action]||'#888'};color:#fff">${G.steps}</div>
    <div style="flex:1"><span style="font-weight:500">${v.id}</span> <span style="color:var(--color-text-secondary)">${action}</span>${scoreStr}</div>
    <div style="font-size:10px;color:var(--color-text-secondary);max-width:180px;text-align:right">${reason}</div>`;
  pt.appendChild(row);pt.scrollTop=pt.scrollHeight;
}

function bumpAgent(d){
  G.agent.r=parseFloat(cl(G.agent.r+d,0.10,1.0).toFixed(2));
  G.agent.hist.push(G.agent.r);
  updAgentPanel();
}
function bumpVendor(v,ok){
  v.rating=parseFloat(cl(v.rating+(ok?0.025:-0.035),0.1,1).toFixed(2));
  v.rHist.push(v.rating);
  v.q=parseFloat(cl(v.q+(ok?0.003:-0.003),0.1,1).toFixed(3));
  v.rel=parseFloat(cl(v.rel+(ok?0.003:-0.006),0.1,1).toFixed(3));
}

async function negotiateV(v){
  G.steps++;v.status='negotiating';v.negAttempts++;
  renderVendors();updMetrics();updSG();
  const t=TASKS[G.task];
  const maxCap=Math.round(G.exp*(1+v.margin));
  const agBonus=G.agent.r>=0.80?0.10:G.agent.r<=0.55?-0.10:0;
  const sp=G.spd;

  addAF('c-ag',`ACTION negotiate(${v.id}) arch:${v.arch} quote:₹${v.quote} stub:${v.stubborn.toFixed(2)}`);
  await delay(sp);

  if(v.quote<=G.exp){
    v.accepted=v.quote;v.deal=true;v.status='active';
    bumpVendor(v,true);bumpAgent(0.03);G.agent.deals++;
    addRew(0.22,'immediate accept — quote ≤ expected');
    addAF('c-ok',`DEAL ${v.id} ₹${v.quote} — immediate close`);
    addTrace(v,'immediate_accept','Quote ≤ expected price',calcScore(v));
    return;
  }

  G.steps++;
  addAF('c-vn',`${v.id} counter: ₹${v.quote} (stub factor ${v.stubborn.toFixed(2)})`);
  await delay(sp*0.8);

  if(v.quote<=G.bud){
    const floor=Math.round(v.quote*(0.87-v.margin*0.28*v.stubborn));
    const offers=[G.exp, Math.round((G.exp+v.quote)/2), Math.round(v.quote*0.97), v.quote];
    for(let i=0;i<offers.length;i++){
      if(G.paused)await new Promise(r=>{G.pauseRes=r;});
      G.steps++;
      const offer=offers[i];
      addAF('c-ag',`ACTION counter_offer(${v.id}, ₹${offer}) step ${i+1}/4`);
      await delay(sp*0.85);
      updSG();
      const nfloor=Math.round(floor*(1+(G.stochasticVendors ? rng(-0.05,0.05) : 0)));
      if(offer>=nfloor){
        v.accepted=offer;v.deal=true;v.status='active';
        bumpVendor(v,true);bumpAgent(0.025);G.agent.deals++;
        const rw=parseFloat((0.16-i*0.025+agBonus*0.04+t.coopBonus*0.3).toFixed(3));
        addRew(rw,'deal at step '+(i+1));
        addAF('c-ok',`DEAL ${v.id} ₹${offer} step ${i+1}`);
        addTrace(v,'negotiated','Offer ≥ stochastic floor ₹'+nfloor,calcScore(v));
        renderVendors();updMetrics();return;
      }
      addAF('c-fl',`${v.id} rejects ₹${offer} — floor ₹${nfloor}`);
      await delay(sp*0.6);
    }
    v.accepted=v.quote;v.deal=true;v.status='active';
    bumpVendor(v,true);bumpAgent(0.01);G.agent.deals++;
    addRew(0.06,'settled at quote');
    addAF('c-ok',`DEAL ${v.id} settled ₹${v.quote}`);
    addTrace(v,'quote_settle','Negotiation exhausted → quote price',calcScore(v));
  } else {
    G.steps++;
    addAF('c-sy',`POLICY quote ₹${v.quote} > budget ₹${G.bud} → margin cap ₹${maxCap}`);
    await delay(sp);
    if(maxCap>G.bud){
      v.status='denied';
      addRew(-0.09,'unaffordable — even margin cap over budget');
      addAF('c-fl',`SKIP ${v.id} margin-cap ₹${maxCap} > budget`);
      addTrace(v,'skip','Cap > budget',null);
      renderVendors();updMetrics();return;
    }
    addAF('c-ag',`ACTION final_offer(${v.id}, ₹${maxCap}) margin-capped`);
    await delay(sp*0.9);
    const coopBase=v.rel>0.82?0.62:v.rel>0.68?0.48:0.30;
    const coopNoise=G.stochasticVendors ? rng(-0.14,0.14) : 0;
    const coopP=cl(coopBase+agBonus*0.12+t.coopBonus*0.25+coopNoise,0.04,0.88);
    const accepted=G.stochasticVendors ? (R()<coopP) : (coopP>=0.50);
    if(accepted){
      v.accepted=maxCap;v.deal=true;v.status='active';
      bumpVendor(v,true);bumpAgent(0.015);G.agent.deals++;
      addRew(0.09,'margin-cap accepted');
      addAF('c-ok',`DEAL ${v.id} ₹${maxCap} margin-cap`);
      addTrace(v,'margincap',`Coop prob ${coopP.toFixed(2)} passed`,calcScore(v));
    } else {
      v.status='denied';
      bumpVendor(v,false);bumpAgent(-0.02);
      addRew(-0.07,'margin-cap rejected');
      addAF('c-fl',`FAIL ${v.id} rejected ₹${maxCap} (p=${coopP.toFixed(2)})`);
      addTrace(v,'rejection','Stochastic rejection',null);
    }
  }
  renderVendors();updMetrics();
}

let agentRunning=false;
async function runEpisode(){
  agentRunning=true;G.running=true;
  document.getElementById('pause-btn').disabled=false;
  updTopbar();
  addAF('c-if',`=== Episode start · task:${G.task} · budget ₹${G.bud} · vendors:${G.vendors.filter(v=>v.status!=='denied').length} active ===`);
  addAF('c-if',`=== Vendor mode: ${G.stochasticVendors?'stochastic':'deterministic'} ===`);
  while(true){
    if(G.paused)await new Promise(r=>{G.pauseRes=r;});
    const pol=agentPolicy();
    if(pol.action==='done')break;
    addAF('c-sy','POLICY: '+pol.reason);
    await negotiateV(pol.target);
    await delay(G.spd*0.3);
    if(!G.vendors.filter(x=>x.status==='active'&&!x.deal).length)break;
  }
  agentRunning=false;G.running=false;
  document.getElementById('pause-btn').disabled=true;
  addAF('c-if',`=== Episode done · steps:${G.steps} · cumulative reward:${G.cumRew.toFixed(3)} ===`);
  computeResults();
  document.getElementById('tab-results-btn').classList.add('notify');
  gTab('results',document.getElementById('tab-results-btn'));
  updTopbar();
}

async function runAgent(){
  if(agentRunning)return;
  G.item=document.getElementById('f-item').value||'Item';
  G.exp=parseFloat(document.getElementById('f-exp').value)||180;
  G.bud=parseFloat(document.getElementById('f-bud').value)||216;
  G.qty=parseInt(document.getElementById('f-qty').value)||1000;
  G.spd=parseInt(document.getElementById('f-spd').value)||380;
  G.steps=0;G.cumRew=0;G.results=[];G.trace=[];G.confirmed=false;G.paused=false;
  G.agent.runs++;G.agent.deals=0;G.agent.over=0;
  G.vendors=mkVendors();
  document.getElementById('af').innerHTML='';
  document.getElementById('ptrace').innerHTML='';
  document.getElementById('res-main').style.display='none';
  document.getElementById('res-ph').style.display='block';
  document.getElementById('conf-area').innerHTML='';
  document.getElementById('human-loop').style.display='none';
  document.getElementById('conf-btn').disabled=false;
  document.getElementById('conf-btn').textContent='Accept agent recommendation';
  document.getElementById('tab-results-btn').classList.remove('notify');
  G.agent={...G.agent,deals:0,over:0};
  renderVendors();updMetrics();updAgentPanel();updSG();
  gTab('agent',document.querySelectorAll('.tab')[1]);
  await runEpisode();
}

function pauseResume(){
  G.paused=!G.paused;
  document.getElementById('pause-btn').textContent=G.paused?'Resume':'Pause';
  if(!G.paused&&G.pauseRes){G.pauseRes();G.pauseRes=null;}
}

function computeResults(){
  const done=G.vendors.filter(v=>v.deal).map(v=>({...v,sc:calcScore(v),ok:v.accepted<=G.bud}));
  const denied=G.vendors.filter(v=>!v.deal&&v.status==='denied').map(v=>({...v,sc:0,ok:false}));
  G.results=[...done.sort((a,b)=>b.sc-a.sc),...denied];
  const best=G.results.find(v=>v.ok&&v.deal);
  const eff=G.steps<=10?0.12:G.steps<=16?0.06:0;
  const finalRew=best?parseFloat(cl(best.sc+eff,0,1).toFixed(3)):-0.25;
  G.agent.reward=finalRew;
  G.agent.rewHistory.push(finalRew);
  const avg=G.agent.rewHistory.length?parseFloat((G.agent.rewHistory.reduce((a,b)=>a+b,0)/G.agent.rewHistory.length).toFixed(3)):null;
  document.getElementById('ag-avg').textContent=avg!==null?avg.toFixed(3):'—';
  renderResults();
}

function stars(r){const s=Math.round(r*5);return'<span style="color:#BA7517;font-size:10px">'+'★'.repeat(s)+'<span style="color:var(--color-border-secondary)">'+'★'.repeat(5-s)+'</span></span>';}
function bbar(val,col){return`<div class="bbar"><div class="bt2"><div class="bf2" style="width:${Math.round(val*100)}%;background:${col}"></div></div><span style="font-size:10px">${Math.round(val*100)}%</span></div>`;}

function renderVendors(){
  const sorted=[...G.vendors].sort((a,b)=>{
    const sa=a.q*0.4+a.rel*0.3+a.rating*0.2+(a.deal?0.1:0);
    const sb=b.q*0.4+b.rel*0.3+b.rating*0.2+(b.deal?0.1:0);
    return sb-sa;
  });
  document.getElementById('vtbody').innerHTML=sorted.map((v,i)=>{
    const pc=v.accepted?`<span style="font-weight:500;color:#1D9E75">₹${v.accepted}</span><span style="font-size:9px;color:#1D9E75"> ✓</span>`:`₹${v.quote}`;
    const sc=v.deal?'pk':v.status==='denied'?'pd':v.status==='negotiating'?'pn':'pw';
    const sl=v.deal?'deal done':v.status==='denied'?'denied':v.status==='negotiating'?'negotiating':'pending';
    const dots=v.rHist.slice(-5).map(rv=>`<span class="hdot" style="background:${rv>=0.80?'#1D9E75':rv>=0.63?'#BA7517':'#D85A30'}"></span>`).join('');
    return`<tr class="${v.deal&&v.accepted<=G.bud?'vhl':''}">
      <td style="color:var(--color-text-secondary);font-size:10px">${i+1}</td>
      <td><div style="font-weight:500;font-size:11px">${v.id}</div><div style="font-size:10px;color:var(--color-text-secondary)">${v.name}</div></td>
      <td style="font-size:11px">${pc}</td><td style="font-size:11px">${v.del}d</td>
      <td>${bbar(v.q,'#1D9E75')}</td><td>${bbar(v.rel,'#378ADD')}</td>
      <td style="font-size:10px;color:var(--color-text-secondary)">+${Math.round(v.margin*100)}%</td>
      <td><span class="pill ${sc}">${sl}</span></td>
      <td>${stars(v.rating)}<div style="display:flex;gap:2px;margin-top:1px">${dots}</div></td>
    </tr>`;
  }).join('');
}

function updMetrics(){
  document.getElementById('mv-tot').textContent=G.vendors.length;
  document.getElementById('mv-act').textContent=G.vendors.filter(v=>v.status==='active'||v.deal).length;
  document.getElementById('mv-den').textContent=G.vendors.filter(v=>v.status==='denied').length;
  document.getElementById('mv-don').textContent=G.vendors.filter(v=>v.deal).length;
  updTopbar();
}

function updTopbar(){
  document.getElementById('sbadge').textContent='step '+G.steps;
  const p=document.getElementById('epill');
  const s=G.confirmed?'done':G.running?'run':G.vendors.length?'live':'';
  const l=G.confirmed?'Confirmed':G.running?'Running':G.vendors.length?'Ready':'Idle';
  p.textContent=l;p.className='ep'+(s?' '+s:'');
}

function updSG(){
  document.getElementById('sg-step').textContent=G.steps;
  const rem=G.vendors.filter(v=>v.status==='active'&&!v.deal).length;
  const deals=G.vendors.filter(v=>v.deal).length;
  const bp=deals?Math.min(...G.vendors.filter(v=>v.deal).map(v=>v.accepted)):null;
  const hd=bp?Math.round((G.bud-bp)/G.bud*100):null;
  document.getElementById('sg-rem').textContent=rem||'—';
  document.getElementById('sg-deals').textContent=deals||'—';
  document.getElementById('sg-bp').textContent=bp?'₹'+bp:'—';
  const hdEl=document.getElementById('sg-hd');
  hdEl.textContent=hd!==null?hd+'%':'—';
  hdEl.className='sgv'+(hd===null?'':hd>15?' ok':hd>0?' warn':' bad');
  const crEl=document.getElementById('sg-cr');
  crEl.textContent=G.cumRew.toFixed(3);
  crEl.className='sgv'+(G.cumRew>0.2?' ok':G.cumRew>-0.1?' warn':' bad');
}

function updAgentPanel(){
  const box=document.getElementById('agbox');
  box.style.display='block';
  const r=G.agent.r;
  document.getElementById('ag-bar').style.width=(r*100)+'%';
  document.getElementById('ag-val').textContent=r.toFixed(2);
  document.getElementById('ag-deals').textContent=G.agent.deals;
  document.getElementById('ag-over').textContent=G.agent.over;
  document.getElementById('ag-runs').textContent=G.agent.runs;
  const h=G.agent.hist;
  if(h.length>=2){
    const d=parseFloat((h[h.length-1]-h[h.length-2]).toFixed(2));
    const dEl=document.getElementById('ag-dlt');
    if(d>0.005){dEl.className='dlt dup';dEl.textContent='+'+d.toFixed(2);}
    else if(d<-0.005){dEl.className='dlt ddn';dEl.textContent=d.toFixed(2);}
    else{dEl.className='dlt dnu';dEl.textContent='±0';}
  }
  document.getElementById('ag-note').textContent=r>=0.82?'High — vendors more cooperative':r>=0.62?'Moderate — standard cooperation':'Low — vendors less flexible';
  document.getElementById('ag-dots').innerHTML=G.agent.hist.slice(-10).map(rv=>`<span class="hdot" style="background:${rv>=0.80?'#1D9E75':rv>=0.62?'#BA7517':'#D85A30'};width:7px;height:7px"></span>`).join('');
}

function renderResults(){
  document.getElementById('res-ph').style.display='none';
  document.getElementById('res-main').style.display='block';
  const res=G.results;
  const best=res.find(v=>v.ok&&v.deal);
  const t=TASKS[G.task];
  const allDenied=G.vendors.every(v=>v.status==='denied');
  const allOver=res.filter(v=>v.deal).length>0&&res.filter(v=>v.deal).every(v=>!v.ok);

  const scoreVal=G.agent.reward||0;
  const scolor=G.task==='easy'?'score-easy':G.task==='medium'?'score-med':'score-hard';
  const taskLabel={easy:'Easy task result',medium:'Medium task result',hard:'Hard task result'}[G.task];
  document.getElementById('score-banner').innerHTML=`<div class="score-banner">
    <div><div style="font-size:10px;color:var(--color-text-secondary)">${taskLabel} · ${t.label}</div>
    <div class="score-num ${scolor}">${scoreVal.toFixed(3)}</div>
    <div style="font-size:10px;color:var(--color-text-secondary)">expected range ${t.expectedScore}</div></div>
    <div style="flex:1;margin:0 12px">
      <div style="height:10px;border-radius:5px;background:var(--color-border-tertiary);overflow:hidden">
        <div style="height:100%;border-radius:5px;background:${G.task==='easy'?'#1D9E75':G.task==='medium'?'#534AB7':'#D85A30'};width:${Math.round(scoreVal*100)}%;transition:width .5s"></div>
      </div>
      <div style="font-size:10px;color:var(--color-text-secondary);margin-top:3px">Cumulative reward: ${G.cumRew.toFixed(3)} · Steps: ${G.steps}</div>
    </div>
  </div>`;

  if(t.conflictSignals>0){
    const cheapLowQ=G.vendors.filter(v=>v.deal&&v.q<0.76&&v.accepted<G.exp*1.05);
    const expHighQ=G.vendors.filter(v=>v.deal&&v.q>0.85&&v.accepted>G.exp*1.12);
    if(cheapLowQ.length&&expHighQ.length){
      document.getElementById('conflict-area').innerHTML=`<div class="conflict-box">
        <span style="font-weight:500">Trade-off detected:</span> Cost vs Quality -> resolved via weighted policy. Cheap option (${cheapLowQ[0].id} ₹${cheapLowQ[0].accepted}, quality ${Math.round(cheapLowQ[0].q*100)}%) vs premium option (${expHighQ[0].id} ₹${expHighQ[0].accepted}, quality ${Math.round(expHighQ[0].q*100)}%).
      </div>`;
    } else {document.getElementById('conflict-area').innerHTML='';}
  } else {document.getElementById('conflict-area').innerHTML='';}

  const ra=document.getElementById('rec-area');
  if(allDenied){
    ra.innerHTML=`<div class="recbox rb-fail"><div style="font-size:13px;font-weight:500;color:#712B13;margin-bottom:3px">No suppliers — all denied</div><div style="font-size:11px;color:#712B13">${G.task==='hard'?'Expected on Hard task. Agent correctly returns no-deal outcome — valid RL terminal state.':'Increase budget or try a lower difficulty.'}</div></div>`;
  } else if(allOver){
    const cl2=[...res].filter(v=>v.deal).sort((a,b)=>a.accepted-b.accepted)[0];
    ra.innerHTML=`<div class="recbox rb-warn"><div style="font-size:13px;font-weight:500;color:#633806;margin-bottom:3px">All deals exceed budget — best compromise</div><div style="font-size:11px;color:#633806">Agent recommends best-effort: <b>${cl2.id} (${cl2.name})</b> at ₹${cl2.accepted}/kg — ₹${cl2.accepted-G.bud} over. ${G.task==='hard'?'This is the expected Hard task outcome.':''}</div></div>`;
  } else if(best){
    const saving=(G.bud-best.accepted)*G.qty;
    ra.innerHTML=`<div class="recbox rb-ok">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div><div style="font-size:13px;font-weight:500;color:#085041;margin-bottom:3px">Agent recommends: ${best.id} — ${best.name}</div>
        <div style="font-size:11px;color:#0F6E56;margin-bottom:6px">Highest multi-factor score · archetype: ${best.arch}</div>
        <div>${['₹'+best.accepted+'/kg','Del. '+best.del+'d','Quality '+Math.round(best.q*100)+'%','Rel. '+Math.round(best.rel*100)+'%','Score '+best.sc.toFixed(3)].map(c=>`<span class="chip">${c}</span>`).join('')}</div></div>
        <div style="text-align:right"><div style="font-size:10px;color:#0F6E56;font-weight:500">Savings</div>
        <div style="font-size:20px;font-weight:500;color:#1D9E75">₹${saving.toLocaleString()}</div>
        <div style="font-size:10px;color:#0F6E56">${G.qty.toLocaleString()} kg</div></div>
      </div>
    </div>`;
  } else {ra.innerHTML='';}

  const el=G.results.filter(v=>v.deal&&v.ok);
  document.getElementById('ranked').innerHTML=res.map((v,i)=>{
    if(!v.deal)return`<div class="rrow" style="opacity:.4"><div class="rn">—</div><div style="font-size:11px;font-weight:500;flex:1">${v.id} — ${v.name}</div><span class="pill pd">denied</span></div>`;
    const ei=el.indexOf(v);
    const cls=ei===0?'rk1':ei===1?'rk2':ei===2?'rk3':'';
    return`<div class="rrow ${cls}">
      <div class="rn">#${i+1}</div>
      <div style="min-width:72px"><div style="font-weight:500;font-size:11px">${v.id}</div><div style="font-size:10px;color:var(--color-text-secondary)">${v.name} · ${v.arch}</div></div>
      <div style="flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:3px;font-size:11px">
        <div><div style="color:var(--color-text-secondary)">Price</div><div style="font-weight:500">₹${v.accepted}</div></div>
        <div><div style="color:var(--color-text-secondary)">Del.</div><div style="font-weight:500">${v.del}d</div></div>
        <div><div style="color:var(--color-text-secondary)">Quality</div><div style="font-weight:500">${Math.round(v.q*100)}%</div></div>
        <div><div style="color:var(--color-text-secondary)">Rel.</div><div style="font-weight:500">${Math.round(v.rel*100)}%</div></div>
      </div>
      <div style="text-align:right;min-width:50px">
        <div style="font-size:10px;color:var(--color-text-secondary)">Score</div>
        <div style="font-weight:500;font-size:12px">${v.sc.toFixed(3)}</div>
        <div class="sbar" style="margin-top:2px"><div class="sf" style="width:${Math.round(v.sc*100)}%"></div></div>
      </div>
      ${!v.ok?'<span class="pill pd" style="margin-left:4px;flex-shrink:0">over budget</span>':''}
    </div>`;
  }).join('');

  const effB=G.steps<=10?'+0.12':G.steps<=16?'+0.06':'none';
  document.getElementById('reward-body').innerHTML=`
    <div class="irow"><span>Task difficulty</span><span style="font-weight:500">${t.label}</span></div>
    <div class="irow"><span>Episode steps</span><span>${G.steps}</span></div>
    <div class="irow"><span>Deals / total vendors</span><span>${res.filter(v=>v.deal).length} / ${G.vendors.length}</span></div>
    <div class="irow"><span>Within-budget deals</span><span>${el.length}</span></div>
    <div class="irow"><span>Cumulative reward</span><span style="font-weight:500;color:${G.cumRew>=0?'#1D9E75':'#D85A30'}">${G.cumRew.toFixed(3)}</span></div>
    <div class="irow"><span>Efficiency bonus</span><span>${effB}</span></div>
    <div class="irow"><span>Agent reputation</span><span style="font-weight:500;color:#534AB7">${G.agent.r.toFixed(2)}</span></div>
    <div class="irow"><span>Final episode reward</span><span style="font-weight:500;color:${G.agent.reward>=0?'#1D9E75':'#D85A30'}">${G.agent.reward!==null?G.agent.reward.toFixed(3):'—'}</span></div>`;

  renderPickList();
}

function renderPickList(){
  const el=G.results.filter(v=>v.deal&&v.ok);
  if(!el.length){document.getElementById('pick-list').innerHTML='<p style="font-size:11px;color:var(--color-text-secondary)">No eligible vendors.</p>';return;}
  const best=el[0];
  document.getElementById('pick-list').innerHTML=el.map((v,i)=>{
    const isBest=i===0;
    const pen=isBest?0:parseFloat((0.04+i*0.03+(v.sc<best.sc-0.10?0.05:0)).toFixed(2));
    return`<div class="vprow ${isBest?'vbest':'vsub'}" onclick="pickV('${v.id}',${pen},${isBest})">
      <div><span style="font-weight:500;font-size:12px">${v.id} — ${v.name}</span><span style="font-size:10px;color:var(--color-text-secondary);margin-left:7px">₹${v.accepted} · ${v.del}d · ${v.arch} · ${v.sc.toFixed(3)}</span></div>
      <div>${isBest?'<span class="pill pk">agent pick</span>':`<span style="font-size:10px;color:#D85A30;font-weight:500">−${pen.toFixed(2)} rating</span>`}</div>
    </div>`;
  }).join('');
}

function toggleHuman(){
  const h=document.getElementById('human-loop');
  h.style.display=h.style.display==='none'?'block':'none';
}

function pickV(vid,pen,isBest){
  if(G.confirmed)return;
  G.confirmed=true;
  const v=G.results.find(x=>x.id===vid);
  if(!v)return;
  const total=v.accepted*G.qty;
  document.getElementById('conf-btn').disabled=true;
  document.getElementById('conf-btn').textContent='Order placed';
  document.getElementById('conf-area').innerHTML=`<div class="cbanner">
    <div style="font-weight:500;margin-bottom:3px">Order confirmed — ${v.id} (${v.name})</div>
    <div>₹${v.accepted}/kg × ${G.qty.toLocaleString()} kg = <strong>₹${total.toLocaleString()}</strong></div>
    <div style="font-size:10px;margin-top:3px">${isBest?'Optimal selection → agent +0.04':'Suboptimal override → agent −'+pen.toFixed(2)}</div>
  </div>`;
  if(isBest){bumpAgent(0.04);G.agent.deals++;}
  else{bumpAgent(-pen);G.agent.over++;G.agent.reward=parseFloat(cl((G.agent.reward||0)-pen,-1,1).toFixed(3));}
  const src=G.vendors.find(x=>x.id===vid);
  if(src)bumpVendor(src,true);
  renderVendors();updAgentPanel();updTopbar();
}

function confirmBest(){
  if(G.confirmed)return;
  const best=G.results.find(v=>v.ok&&v.deal);
  if(!best)return;
  pickV(best.id,0,true);
}

function gTab(id,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  const tabId=typeof id==='string'?'tab-'+id:null;
  if(tabId)document.getElementById(tabId).classList.add('active');
}

function fullReset(){
  G.steps=0;G.cumRew=0;G.vendors=[];G.results=[];G.trace=[];G.running=false;G.paused=false;G.confirmed=false;G.pauseRes=null;
  document.getElementById('vtbody').innerHTML='';
  document.getElementById('af').innerHTML='';
  document.getElementById('ptrace').innerHTML='<div style="color:var(--color-text-secondary);font-size:11px">Run the agent to see policy decisions.</div>';
  document.getElementById('res-main').style.display='none';
  document.getElementById('res-ph').style.display='block';
  document.getElementById('conf-area').innerHTML='';
  document.getElementById('human-loop').style.display='none';
  document.getElementById('score-banner').innerHTML='';
  document.getElementById('conflict-area').innerHTML='';
  document.getElementById('pause-btn').disabled=true;
  document.getElementById('tab-results-btn').classList.remove('notify');
  updMetrics();updSG();
}

setVendorMode(false);
selectTask('easy');renderScenarioBox();updAgentPanel();updMetrics();updSG();

