(() => {
"use strict";

/* ===================== CONSTANTS ===================== */
const ROWS = 8, COLS = 8;
const BEST_KEY = 'oneexplosion_best_chain';
const HITSTOP_MS = 60, WAVE_MS = 230, GRAVITY_MS = 220, ELECTRIC_MS = 260, FIRE_MS = 180;
const BIG_CHAIN_THRESHOLD = 8;

const COLOR = {
  bg:'#0E0E0F', surface:'#19191B', surface2:'#212124',
  text:'#F1F1EF', text2:'#8E8E93', accent:'#FFB000', danger:'#FF4D4F', line:'#2A2A2D'
};

/* ===================== DATA ===================== */
const OBJ = {
  BLOCK:     { hp:1, name:'BLOCK' },
  GLASS:     { hp:1, name:'GLASS' },
  FUEL:      { hp:1, name:'FUEL TANK' },
  EXPLOSIVE: { hp:1, name:'EXPLOSIVE' },
  BATTERY:   { hp:1, name:'BATTERY' },
  GAS:       { hp:1, name:'GAS CANISTER' },
  METAL:     { hp:2, name:'METAL' },
  WALL:      { hp:Infinity, name:'WALL' },
};

const UPGRADES = [
  { id:'RANGE',      name:'RANGE UP',   desc:'爆発範囲 +1' },
  { id:'SHOCKWAVE',  name:'SHOCKWAVE',  desc:'衝撃波でガラスも破壊' },
  { id:'BURN',       name:'IGNITION',   desc:'爆発跡に炎が残る' },
  { id:'CONDUCTIVE', name:'CONDUCTIVE', desc:'バッテリーが常に放電' },
  { id:'DOUBLETAP',  name:'DOUBLE TAP', desc:'時間差でもう一度爆発' },
  { id:'FUELX2',     name:'OVERCHARGE', desc:'燃料系の爆発が拡大' },
];

const LEGEND_ITEMS = [
  { type:'BLOCK',     label:'ブロック' },
  { type:'GLASS',      label:'ガラス' },
  { type:'FUEL',       label:'燃料' },
  { type:'EXPLOSIVE',  label:'爆薬' },
  { type:'BATTERY',    label:'電池' },
  { type:'GAS',        label:'ガス' },
  { type:'METAL',      label:'金属' },
  { type:'WALL',       label:'壁' },
];

function isExplosiveFamily(t){ return t==='FUEL'||t==='EXPLOSIVE'||t==='GAS'; }

/* ===================== BOARD GENERATION ===================== */
function stageWeights(n){
  const t = (n-1)/7;
  const lerp = (a,b) => a+(b-a)*t;
  return {
    EMPTY: lerp(0.30,0.20), BLOCK: lerp(0.28,0.14), GLASS: lerp(0.10,0.09),
    FUEL: lerp(0.07,0.13), EXPLOSIVE: lerp(0.07,0.15), BATTERY: lerp(0.06,0.09),
    GAS: lerp(0.04,0.09), METAL: lerp(0.05,0.08), WALL: lerp(0.03,0.03),
  };
}
function weightedPick(weights){
  const entries = Object.entries(weights);
  const total = entries.reduce((s,[,w])=>s+w,0);
  let r = Math.random()*total;
  for (const [k,w] of entries){ if (r<w) return k; r-=w; }
  return entries[entries.length-1][0];
}
function makeCell(type){ return { type, hp: OBJ[type].hp }; }
function forEachCell(board, fn){ for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) fn(board[y][x],x,y); }
function randomConvertibleCell(board){
  const cand = [];
  forEachCell(board,(c,x,y)=>{ if (c && (c.type==='BLOCK'||c.type==='GLASS')) cand.push({x,y}); });
  if (!cand.length) return null;
  return cand[Math.floor(Math.random()*cand.length)];
}
function ensureMinEmpty(board, n){
  let count = 0;
  forEachCell(board,(c)=>{ if(!c) count++; });
  while (count < n){
    const p = randomConvertibleCell(board);
    if (!p) break;
    board[p.y][p.x] = null;
    count++;
  }
}
function ensureMinCount(board, types, n){
  let count = 0;
  forEachCell(board,(c)=>{ if (c && types.includes(c.type)) count++; });
  let guard = 200;
  while (count < n && guard-- > 0){
    const p = randomConvertibleCell(board);
    if (!p) break;
    const type = types[Math.floor(Math.random()*types.length)];
    board[p.y][p.x] = makeCell(type);
    count++;
  }
}
function ensureMetalBatteryPair(board){
  let hasMetal=false, hasBattery=false;
  forEachCell(board,(c)=>{ if(c){ if(c.type==='METAL')hasMetal=true; if(c.type==='BATTERY')hasBattery=true; } });
  if (!hasMetal){ const p=randomConvertibleCell(board); if(p) board[p.y][p.x]=makeCell('METAL'); }
  if (!hasBattery){ const p=randomConvertibleCell(board); if(p) board[p.y][p.x]=makeCell('BATTERY'); }
}
function generateBoard(stageIndex){
  const weights = stageWeights(stageIndex);
  const board = [];
  for (let y=0;y<ROWS;y++){
    const row = [];
    for (let x=0;x<COLS;x++){
      const type = weightedPick(weights);
      row.push(type==='EMPTY' ? null : makeCell(type));
    }
    board.push(row);
  }
  ensureMinEmpty(board, 6);
  ensureMinCount(board, ['FUEL','EXPLOSIVE','GAS'], 2+Math.floor(stageIndex/2));
  if (stageIndex >= 2) ensureMetalBatteryPair(board);
  return board;
}
function countDestructible(board){
  let n=0;
  forEachCell(board,(c)=>{ if (c && c.type!=='WALL') n++; });
  return n;
}
function cloneBoard(board){ return board.map(row=>row.map(c=>c?{...c}:null)); }

/* ===================== SIMULATION ENGINE ===================== */
function deriveConfig(levels){
  return {
    levels,
    radius: 2+levels.RANGE,
    shockwaveLevel: levels.SHOCKWAVE,
    burnLevel: levels.BURN,
    conductiveLevel: levels.CONDUCTIVE,
    doubleTapLevel: levels.DOUBLETAP,
    fuelRadius: levels.FUELX2>0 ? 2+levels.FUELX2*2 : 2,
  };
}
function orthNeighbors(x,y){ return [{x:x-1,y},{x:x+1,y},{x,y:y-1},{x,y:y+1}]; }
function inBounds(p){ return p.x>=0 && p.x<COLS && p.y>=0 && p.y<ROWS; }

function lineBlockedByWall(board, x0,y0,x1,y1){
  const steps = Math.max(Math.abs(x1-x0), Math.abs(y1-y0));
  if (steps===0) return false;
  for (let i=1;i<steps;i++){
    const t = i/steps;
    const xi = Math.round(x0+(x1-x0)*t);
    const yi = Math.round(y0+(y1-y0)*t);
    if (xi===x1 && yi===y1) continue;
    const c = board[yi] && board[yi][xi];
    if (c && c.type==='WALL') return true;
  }
  return false;
}
function computeBlastCells(board, cx, cy, radius, ringWidth){
  const strong=[], weak=[];
  const maxR = radius+ringWidth;
  for (let y=Math.max(0,cy-maxR); y<=Math.min(ROWS-1,cy+maxR); y++){
    for (let x=Math.max(0,cx-maxR); x<=Math.min(COLS-1,cx+maxR); x++){
      const dist = Math.max(Math.abs(x-cx), Math.abs(y-cy));
      if (dist>maxR) continue;
      if (dist>0 && lineBlockedByWall(board,cx,cy,x,y)) continue;
      if (dist<=radius) strong.push({x,y}); else weak.push({x,y});
    }
  }
  return {strong, weak};
}
function igniteAround(fireMap, x, y, level){
  const duration = 1+level;
  const cells = [{x,y}, ...orthNeighbors(x,y)];
  if (level>=2) cells.push({x:x-1,y:y-1},{x:x+1,y:y-1},{x:x-1,y:y+1},{x:x+1,y:y+1});
  for (const c of cells){
    if (c.x<0||c.y<0||c.x>=COLS||c.y>=ROWS) continue;
    fireMap.set(c.x+','+c.y, duration);
  }
}
function applyGravity(board){
  const moves = [];
  for (let x=0;x<COLS;x++){
    let writeY = ROWS-1;
    for (let y=ROWS-1;y>=0;y--){
      const cell = board[y][x];
      if (cell && cell.type==='WALL'){ writeY = y-1; continue; }
      if (!cell) continue;
      if (y!==writeY){
        board[writeY][x]=cell; board[y][x]=null;
        moves.push({fromX:x,fromY:y,toX:x,toY:writeY,type:cell.type});
      }
      writeY--;
    }
  }
  return moves;
}
function processElectric(board, seeds, conductiveLevel){
  const discharges = [], triggeredExplosions = [];
  const reach = conductiveLevel>=2 ? 2 : 1;
  for (const seed of seeds){
    const startMetals = orthNeighbors(seed.x,seed.y).filter(p=>inBounds(p) && board[p.y][p.x] && board[p.y][p.x].type==='METAL');
    if (board[seed.y] && board[seed.y][seed.x] && board[seed.y][seed.x].type==='BATTERY') board[seed.y][seed.x]=null;
    if (startMetals.length===0) continue;
    const metalNetwork = []; const seen = new Set(); const stack=[...startMetals];
    while (stack.length){
      const p = stack.pop(); const key=p.x+','+p.y;
      if (seen.has(key)) continue;
      seen.add(key); metalNetwork.push(p);
      for (const n of orthNeighbors(p.x,p.y)){
        if (inBounds(n) && board[n.y][n.x] && board[n.y][n.x].type==='METAL' && !seen.has(n.x+','+n.y)) stack.push(n);
      }
    }
    const targets = []; const targetSeen = new Set();
    for (const m of metalNetwork){
      for (let dy=-reach; dy<=reach; dy++){
        for (let dx=-reach; dx<=reach; dx++){
          if (Math.abs(dx)+Math.abs(dy) > reach || (dx===0&&dy===0)) continue;
          const nx=m.x+dx, ny=m.y+dy;
          if (nx<0||ny<0||nx>=COLS||ny>=ROWS) continue;
          const c = board[ny][nx];
          if (c && c.type==='METAL') continue;
          if (c && isExplosiveFamily(c.type)){
            const key=nx+','+ny;
            if (!targetSeen.has(key)){ targetSeen.add(key); targets.push({x:nx,y:ny,type:c.type}); }
          }
        }
      }
    }
    discharges.push({from:seed, metal:metalNetwork, targets});
    for (const t of targets){
      if (!board[t.y][t.x]) continue;
      board[t.y][t.x] = null;
      triggeredExplosions.push({x:t.x, y:t.y, radius: t.type==='EXPLOSIVE' ? 2 : 2});
    }
  }
  return {discharges, triggeredExplosions};
}
function computeScore({destroyRate, chainCount, electricCount, maxSimultaneous, fullClear}){
  let score = Math.round(destroyRate*6000);
  score += chainCount*180;
  score += electricCount*350;
  score += maxSimultaneous*60;
  if (fullClear) score += 4000;
  return Math.round(score);
}

function simulate(initialBoard, bombPos, cfg){
  const board = cloneBoard(initialBoard);
  const totalDestructible = countDestructible(board);
  const steps = [];
  let queue = [{x:bombPos.x, y:bombPos.y, radius:cfg.radius}];
  const delayed = {};
  for (let i=1;i<=cfg.doubleTapLevel;i++){
    const dwave = 4*i;
    delayed[dwave] = delayed[dwave] || [];
    delayed[dwave].push({x:bombPos.x, y:bombPos.y, radius:cfg.radius});
  }
  const fireMap = new Map();
  let wave = 0, explosionEventCount = 0, maxSimultaneous = 0, electricCount = 0, totalDestroyed = 0;
  const MAX_WAVES = 90;

  while (wave < MAX_WAVES){
    if (delayed[wave]){ queue.push(...delayed[wave]); delete delayed[wave]; }

    const fireIgnitions = [];
    for (const [key, turns] of Array.from(fireMap.entries())){
      const [fx, fy] = key.split(',').map(Number);
      const cell = board[fy] && board[fy][fx];
      if (cell && isExplosiveFamily(cell.type)){
        const r = cell.type==='EXPLOSIVE' ? 2 : cfg.fuelRadius;
        queue.push({x:fx, y:fy, radius:r});
        fireIgnitions.push({x:fx, y:fy, effect:'ignite'});
        fireMap.delete(key);
        continue;
      }
      if (cell && cell.type==='GLASS'){
        board[fy][fx] = null;
        totalDestroyed++;
        fireIgnitions.push({x:fx, y:fy, effect:'shatter'});
        fireMap.delete(key);
        continue;
      }
      const nt = turns-1;
      if (nt<=0) fireMap.delete(key); else fireMap.set(key, nt);
    }
    if (fireIgnitions.length) steps.push({kind:'fire', cells:fireIgnitions, board:cloneBoard(board)});

    if (queue.length > 0){
      const sources = queue; queue = [];
      explosionEventCount += sources.length;
      const hitCells = [], destroyedList = [], battDirectSeeds = [];
      const strongMap = new Map(), weakMap = new Map();
      for (const src of sources){
        const {strong, weak} = computeBlastCells(board, src.x, src.y, src.radius, cfg.shockwaveLevel);
        for (const c of strong) strongMap.set(c.x+','+c.y, c);
        if (cfg.shockwaveLevel>0) for (const c of weak) weakMap.set(c.x+','+c.y, c);
      }
      let destroyedThisWave = 0;
      for (const [key,c] of weakMap){
        if (strongMap.has(key)) continue;
        const cell = board[c.y][c.x];
        if (cell && cell.type==='GLASS'){
          board[c.y][c.x]=null;
          destroyedList.push({x:c.x,y:c.y,type:'GLASS'});
          destroyedThisWave++; totalDestroyed++;
        }
        hitCells.push({x:c.x,y:c.y,weak:true,type:cell?cell.type:'EMPTY',destroyed: !!(cell&&cell.type==='GLASS')});
      }
      for (const [key,c] of strongMap){
        const cell = board[c.y][c.x];
        if (!cell){ hitCells.push({x:c.x,y:c.y,type:'EMPTY',destroyed:false}); continue; }
        if (cell.type==='WALL'){ hitCells.push({x:c.x,y:c.y,type:'WALL',destroyed:false}); continue; }
        cell.hp -= 1;
        if (cell.hp<=0){
          board[c.y][c.x]=null;
          destroyedList.push({x:c.x,y:c.y,type:cell.type});
          destroyedThisWave++; totalDestroyed++;
          if (cell.type==='FUEL'){
            queue.push({x:c.x,y:c.y,radius:cfg.fuelRadius});
            if (cfg.burnLevel>0) igniteAround(fireMap, c.x, c.y, cfg.burnLevel);
          } else if (cell.type==='EXPLOSIVE'){
            queue.push({x:c.x,y:c.y,radius:2});
          } else if (cell.type==='GAS'){
            const dwave = wave+2;
            delayed[dwave] = delayed[dwave] || [];
            delayed[dwave].push({x:c.x,y:c.y,radius:cfg.fuelRadius});
          } else if (cell.type==='BATTERY' && cfg.conductiveLevel>0){
            battDirectSeeds.push({x:c.x,y:c.y});
          }
        }
        hitCells.push({x:c.x,y:c.y,type:cell.type,destroyed:cell.hp<=0,hpLeft:Math.max(cell.hp,0)});
      }
      maxSimultaneous = Math.max(maxSimultaneous, destroyedThisWave);
      steps.push({kind:'explosion', sources, hits:hitCells, destroyed:destroyedList, board:cloneBoard(board)});

      if (battDirectSeeds.length){
        const er = processElectric(board, battDirectSeeds, cfg.conductiveLevel);
        if (er.discharges.length){
          electricCount += er.discharges.length;
          steps.push({kind:'electric', discharges:er.discharges, board:cloneBoard(board)});
          queue.push(...er.triggeredExplosions);
        }
      }
      wave++;
      continue;
    }

    const moves = applyGravity(board);
    if (moves.length > 0){
      steps.push({kind:'gravity', moves, board:cloneBoard(board)});
      const seeds = moves.filter(m => board[m.toY][m.toX] && board[m.toY][m.toX].type==='BATTERY').map(m=>({x:m.toX,y:m.toY}));
      if (seeds.length){
        const er = processElectric(board, seeds, cfg.conductiveLevel);
        if (er.discharges.length){
          electricCount += er.discharges.length;
          steps.push({kind:'electric', discharges:er.discharges, board:cloneBoard(board)});
          queue.push(...er.triggeredExplosions);
        }
      }
      wave++;
      continue;
    }

    if (Object.keys(delayed).length===0 && fireMap.size===0) break;
    wave++;
  }

  const destroyRate = totalDestructible ? totalDestroyed/totalDestructible : 0;
  const fullClear = totalDestroyed >= totalDestructible;
  const stats = {
    totalDestroyed, totalDestructible, destroyRate,
    chainCount: explosionEventCount, electricCount, maxSimultaneous, fullClear,
    score: computeScore({destroyRate, chainCount:explosionEventCount, electricCount, maxSimultaneous, fullClear}),
  };
  return { steps, stats, finalBoard: cloneBoard(board) };
}

/* ===================== AUDIO ===================== */
const AudioEngine = (() => {
  let actx;
  function ensure(){
    if (!actx) actx = new (window.AudioContext||window.webkitAudioContext)();
    if (actx.state==='suspended') actx.resume();
    return actx;
  }
  function boom(power=1){
    const c = ensure(); const now = c.currentTime;
    const dur = 0.32 + Math.min(power,6)*0.03;
    const osc = c.createOscillator(); const gain = c.createGain();
    osc.type='sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(36, now+dur);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.55, now+0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now+dur);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(now); osc.stop(now+dur+0.02);

    const bufSize = Math.floor(c.sampleRate*0.12);
    const buf = c.createBuffer(1,bufSize,c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i=0;i<bufSize;i++) data[i] = (Math.random()*2-1)*(1-i/bufSize);
    const noise = c.createBufferSource(); noise.buffer=buf;
    const ngain = c.createGain();
    ngain.gain.setValueAtTime(0.45, now);
    ngain.gain.exponentialRampToValueAtTime(0.001, now+0.12);
    const filt = c.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=1200;
    noise.connect(filt); filt.connect(ngain); ngain.connect(c.destination);
    noise.start(now);
  }
  function zap(){
    const c = ensure(); const now = c.currentTime;
    const osc = c.createOscillator(); osc.type='sawtooth';
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(140, now+0.12);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now+0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now+0.14);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(now); osc.stop(now+0.16);
  }
  function tick(){
    const c = ensure(); const now = c.currentTime;
    const osc = c.createOscillator(); osc.type='square'; osc.frequency.value=520;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now+0.05);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(now); osc.stop(now+0.06);
  }
  return { ensure, boom, zap, tick };
})();

/* ===================== RENDER STATE ===================== */
let canvas, ctx;
let cssSize = 0, cellPx = 0;
let currentBoard = null;
let uiState = 'IDLE'; // IDLE | SELECT | PLAYBACK
let gameScreenActive = false;
let effects = [];
let fallAnim = null;
let shake = { mag:0, total:0, until:0 };
let camScale = 1, camScaleTarget = 1;

const run = {
  stage: 1, totalStages: 8, score: 0, bestChain: 0,
  bombConfig: { levels: {RANGE:0,SHOCKWAVE:0,BURN:0,CONDUCTIVE:0,DOUBLETAP:0,FUELX2:0} },
  board: null, bombPos: null,
};

function resizeCanvas(){
  const wrap = document.querySelector('.board-wrap');
  if (!wrap) return;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const size = Math.max(120, Math.floor(Math.min(w,h)));
  cssSize = size;
  const dpr = Math.min(window.devicePixelRatio||1, 2);
  canvas.style.width = size+'px';
  canvas.style.height = size+'px';
  canvas.width = Math.round(size*dpr);
  canvas.height = Math.round(size*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  cellPx = size/COLS;
}

function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}
function hexPath(ctx, R){
  ctx.beginPath();
  for (let i=0;i<6;i++){
    const a = Math.PI/6 + i*Math.PI/3;
    const px = Math.cos(a)*R, py = Math.sin(a)*R;
    if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
  }
  ctx.closePath();
}
function drawBadge(ctx, letter, bw){
  ctx.font = `700 ${Math.round(bw*0.26)}px Inter, sans-serif`;
  ctx.fillStyle = COLOR.text2;
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText(letter, bw*0.46, bw*0.46);
}
function drawCellContent(ctx, cell, gx, gy){
  if (!cell) return;
  drawIconAt(ctx, cell, gx*cellPx + cellPx/2, gy*cellPx + cellPx/2, cellPx);
}
function drawIconAt(ctx, cell, cx, cy, size){
  if (!cell) return;
  const pad = size*0.16;
  const bw = size - pad*2;
  ctx.save();
  ctx.translate(cx, cy);
  switch (cell.type){
    case 'BLOCK': {
      ctx.fillStyle = COLOR.surface2; ctx.strokeStyle = COLOR.line; ctx.lineWidth = 1;
      roundRect(ctx, -bw/2,-bw/2, bw, bw, 4); ctx.fill(); ctx.stroke();
      break;
    }
    case 'GLASS': {
      ctx.strokeStyle = COLOR.text2; ctx.lineWidth = 1.4; ctx.setLineDash([3,3]);
      ctx.beginPath();
      ctx.moveTo(0,-bw/2); ctx.lineTo(bw/2,0); ctx.lineTo(0,bw/2); ctx.lineTo(-bw/2,0); ctx.closePath();
      ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(-bw/4,-bw/4); ctx.lineTo(bw/4,bw/4);
      ctx.moveTo(bw/4,-bw/4); ctx.lineTo(-bw/4,bw/4);
      ctx.lineWidth = 1; ctx.stroke();
      ctx.globalAlpha = 1;
      break;
    }
    case 'FUEL': {
      ctx.strokeStyle = COLOR.text; ctx.fillStyle = COLOR.surface2; ctx.lineWidth = 1.6;
      const w=bw*0.62, h=bw*0.8;
      roundRect(ctx, -w/2, -h/2+bw*0.06, w, h, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = COLOR.text;
      ctx.fillRect(-w*0.2, -h/2-bw*0.06, w*0.4, bw*0.14);
      drawBadge(ctx,'F',bw);
      break;
    }
    case 'EXPLOSIVE': {
      ctx.strokeStyle = COLOR.text; ctx.fillStyle = COLOR.surface2; ctx.lineWidth = 1.6;
      for (let i=-1;i<=1;i++){
        roundRect(ctx, i*bw*0.24-bw*0.09, -bw*0.32, bw*0.18, bw*0.64, 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.strokeStyle = COLOR.text2; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(0,-bw*0.32); ctx.lineTo(bw*0.16,-bw*0.5); ctx.stroke();
      drawBadge(ctx,'E',bw);
      break;
    }
    case 'BATTERY': {
      ctx.strokeStyle = COLOR.text; ctx.fillStyle = COLOR.surface2; ctx.lineWidth = 1.6;
      const w=bw*0.82, h=bw*0.46;
      roundRect(ctx, -w/2,-h/2, w, h, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = COLOR.text;
      ctx.fillRect(w/2, -h*0.18, bw*0.06, h*0.36);
      ctx.font = `600 ${Math.round(bw*0.32)}px Inter, sans-serif`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('+', -w*0.22, 0);
      drawBadge(ctx,'B',bw);
      break;
    }
    case 'GAS': {
      ctx.strokeStyle = COLOR.text; ctx.fillStyle = COLOR.surface2; ctx.lineWidth = 1.6;
      const w=bw*0.5, h=bw*0.86;
      roundRect(ctx, -w/2,-h/2, w, h, w/2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0,-h/2-bw*0.04, bw*0.06, 0, Math.PI*2);
      ctx.fillStyle = COLOR.text; ctx.fill();
      ctx.save();
      roundRect(ctx, -w/2,-h/2, w, h, w/2); ctx.clip();
      ctx.strokeStyle = COLOR.text2; ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
      for (let i=-2;i<=2;i++){ ctx.beginPath(); ctx.moveTo(-w, i*bw*0.16); ctx.lineTo(w, i*bw*0.16-w); ctx.stroke(); }
      ctx.restore();
      drawBadge(ctx,'G',bw);
      break;
    }
    case 'METAL': {
      ctx.strokeStyle = COLOR.text; ctx.fillStyle = COLOR.surface2; ctx.lineWidth = 1.8;
      hexPath(ctx, bw*0.52); ctx.fill(); ctx.stroke();
      if (cell.hp < OBJ.METAL.hp){
        ctx.strokeStyle = COLOR.text2; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-bw*0.12,-bw*0.2); ctx.lineTo(bw*0.05,bw*0.05); ctx.lineTo(-bw*0.02,bw*0.22); ctx.stroke();
      }
      break;
    }
    case 'WALL': {
      ctx.fillStyle = COLOR.surface;
      ctx.fillRect(-bw/2,-bw/2,bw,bw);
      ctx.save();
      ctx.beginPath(); ctx.rect(-bw/2,-bw/2,bw,bw); ctx.clip();
      ctx.strokeStyle = COLOR.text2; ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
      for (let i=-4;i<=4;i++){ ctx.beginPath(); ctx.moveTo(-bw/2+i*bw*0.25,-bw/2); ctx.lineTo(-bw/2+i*bw*0.25+bw,bw/2); ctx.stroke(); }
      ctx.restore();
      ctx.strokeStyle = COLOR.text; ctx.lineWidth = 1.6;
      ctx.strokeRect(-bw/2,-bw/2,bw,bw);
      break;
    }
  }
  ctx.restore();
}
function drawBombMarker(ctx, x, y, now){
  const cx = x*cellPx+cellPx/2, cy = y*cellPx+cellPx/2;
  const pulse = 0.5+0.5*Math.sin(now/260);
  const r = cellPx*0.22 + pulse*cellPx*0.03;
  ctx.save();
  ctx.strokeStyle = COLOR.accent; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle = COLOR.accent;
  ctx.beginPath(); ctx.arc(cx,cy,cellPx*0.05,0,Math.PI*2); ctx.fill();
  ctx.restore();
}
function drawBlastPreview(ctx, x, y){
  const cfg = deriveConfig(run.bombConfig.levels);
  ctx.save();
  ctx.strokeStyle = COLOR.text2;
  ctx.lineWidth = 1;
  ctx.setLineDash([4,4]);
  ctx.globalAlpha = 0.4;
  const r = cfg.radius;
  ctx.strokeRect((x-r)*cellPx+0.5, (y-r)*cellPx+0.5, (2*r+1)*cellPx, (2*r+1)*cellPx);
  if (cfg.shockwaveLevel > 0){
    const r2 = r + cfg.shockwaveLevel;
    ctx.globalAlpha = 0.2;
    ctx.strokeRect((x-r2)*cellPx+0.5, (y-r2)*cellPx+0.5, (2*r2+1)*cellPx, (2*r2+1)*cellPx);
  }
  ctx.setLineDash([]);
  ctx.restore();
}
function drawGrid(){
  ctx.strokeStyle = COLOR.line; ctx.lineWidth = 1;
  for (let i=0;i<=COLS;i++){
    const p = Math.round(i*cellPx)+0.5;
    ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,cssSize); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(cssSize,p); ctx.stroke();
  }
}
function drawCells(now){
  const anim = fallAnim;
  const hideSet = anim ? new Set(anim.moves.map(m=>m.fromX+','+m.fromY)) : null;
  const board = anim ? anim.boardBefore : currentBoard;
  if (!board) return;
  for (let y=0;y<ROWS;y++){
    for (let x=0;x<COLS;x++){
      if (hideSet && hideSet.has(x+','+y)) continue;
      const cell = board[y][x];
      if (!cell && uiState==='SELECT'){
        ctx.fillStyle = COLOR.text2; ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(x*cellPx+cellPx/2, y*cellPx+cellPx/2, 2, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      drawCellContent(ctx, cell, x, y);
    }
  }
  if (anim){
    const t = Math.max(0, Math.min(1, (now-anim.start)/anim.dur));
    const et = t*t;
    for (const m of anim.moves){
      const cell = anim.boardBefore[m.fromY][m.fromX];
      const yy = m.fromY + (m.toY-m.fromY)*et;
      drawCellContent(ctx, cell, m.fromX, yy);
    }
  }
  if (uiState==='SELECT' && run.bombPos){
    drawBlastPreview(ctx, run.bombPos.x, run.bombPos.y);
    drawBombMarker(ctx, run.bombPos.x, run.bombPos.y, now);
  }
}
function drawEffects(now){
  effects = effects.filter(e => now-e.start < e.dur);
  for (const e of effects){
    const t = Math.max(0, Math.min(1, (now-e.start)/e.dur));
    ctx.save();
    if (e.type==='flash'){
      ctx.globalAlpha = (1-t)*(e.strong?0.55:0.28);
      ctx.fillStyle = e.strong ? COLOR.danger : COLOR.accent;
      ctx.fillRect(e.x-e.size/2, e.y-e.size/2, e.size, e.size);
    } else if (e.type==='burst'){
      ctx.globalAlpha = 1-t;
      ctx.strokeStyle = COLOR.accent;
      ctx.lineWidth = 2*(1-t)+0.5;
      for (const p of e.parts){
        const d = p.speed*t;
        ctx.beginPath();
        ctx.moveTo(e.x+Math.cos(p.a)*d*0.4, e.y+Math.sin(p.a)*d*0.4);
        ctx.lineTo(e.x+Math.cos(p.a)*d, e.y+Math.sin(p.a)*d);
        ctx.stroke();
      }
    } else if (e.type==='ring'){
      ctx.globalAlpha = 0.5*(1-t);
      ctx.strokeStyle = COLOR.danger;
      ctx.lineWidth = 3*(1-t)+0.5;
      ctx.beginPath(); ctx.arc(e.x,e.y, e.maxR*t, 0, Math.PI*2); ctx.stroke();
    } else if (e.type==='spark'){
      ctx.globalAlpha = 1-t;
      ctx.strokeStyle = COLOR.accent; ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i=0;i<e.points.length-1;i++){
        const a=e.points[i], b=e.points[i+1];
        ctx.moveTo(a.x,a.y);
        const mx=(a.x+b.x)/2+(Math.random()*10-5), my=(a.y+b.y)/2+(Math.random()*10-5);
        ctx.lineTo(mx,my); ctx.lineTo(b.x,b.y);
      }
      ctx.stroke();
    } else if (e.type==='ember'){
      ctx.globalAlpha = 1-t;
      ctx.fillStyle = e.ignite ? COLOR.danger : COLOR.accent;
      ctx.beginPath(); ctx.arc(e.x,e.y, 3+3*(1-t), 0, Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }
}
function draw(now){
  requestAnimationFrame(draw);
  if (!gameScreenActive || !cssSize) return;
  ctx.clearRect(0,0,cssSize,cssSize);
  ctx.save();
  let sx=0, sy=0;
  if (shake.mag>0){
    const remain = shake.until-now;
    if (remain>0){ const p=remain/shake.total; sx=(Math.random()*2-1)*shake.mag*p; sy=(Math.random()*2-1)*shake.mag*p; }
    else shake.mag=0;
  }
  camScale += (camScaleTarget-camScale)*0.08;
  const cx = cssSize/2, cy = cssSize/2;
  ctx.translate(cx+sx, cy+sy);
  ctx.scale(camScale, camScale);
  ctx.translate(-cx, -cy);
  drawGrid();
  drawCells(now);
  drawEffects(now);
  ctx.restore();
}

/* ===================== EFFECT SPAWNERS ===================== */
function triggerShake(mag, dur){ shake.mag=mag; shake.total=dur; shake.until=performance.now()+dur; }
function spawnExplosionEffects(step){
  for (const h of step.hits){
    const cx = h.x*cellPx+cellPx/2, cy = h.y*cellPx+cellPx/2;
    effects.push({type:'flash', x:cx, y:cy, start:performance.now(), dur: h.destroyed?260:160, strong:h.destroyed, size:cellPx});
  }
  for (const d of step.destroyed){
    const cx = d.x*cellPx+cellPx/2, cy = d.y*cellPx+cellPx/2;
    const n = 6+Math.floor(Math.random()*5);
    const parts = [];
    for (let i=0;i<n;i++) parts.push({a:Math.random()*Math.PI*2, speed: cellPx*(0.6+Math.random()*0.9), size:1.5+Math.random()*2});
    effects.push({type:'burst', x:cx, y:cy, start:performance.now(), dur:380, parts});
  }
  for (const s of step.sources){
    const cx = s.x*cellPx+cellPx/2, cy = s.y*cellPx+cellPx/2;
    effects.push({type:'ring', x:cx, y:cy, start:performance.now(), dur:340, maxR:(s.radius+0.5)*cellPx});
  }
}
function spawnElectricArcs(step){
  for (const d of step.discharges){
    const pts = [d.from, ...d.metal, ...d.targets].map(p=>({x:p.x*cellPx+cellPx/2, y:p.y*cellPx+cellPx/2}));
    effects.push({type:'spark', points:pts, start:performance.now(), dur:280});
  }
}
function spawnEmbers(cells){
  for (const c of cells) effects.push({type:'ember', x:c.x*cellPx+cellPx/2, y:c.y*cellPx+cellPx/2, start:performance.now(), dur:220, ignite:c.effect==='ignite'});
}
function animateFalls(moves, boardAfter){
  return new Promise(resolve => {
    const start = performance.now();
    const dur = 220;
    fallAnim = { moves, start, dur, boardBefore: currentBoard };
    setTimeout(() => { fallAnim=null; currentBoard=boardAfter; resolve(); }, dur);
  });
}

/* ===================== PLAYBACK ===================== */
let runningChainTotal = 0;
function popChain(text){
  const el = document.getElementById('chain-popup');
  el.textContent = text;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}
function playStep(step){
  return new Promise(resolve => {
    if (step.kind==='explosion'){
      runningChainTotal += step.sources.length;
      spawnExplosionEffects(step);
      triggerShake(Math.min(4+step.sources.length*1.5, 18), 220);
      AudioEngine.boom(step.sources.length);
      popChain('×'+runningChainTotal);
      if (runningChainTotal >= BIG_CHAIN_THRESHOLD) camScaleTarget = 0.86;
      setTimeout(() => {
        currentBoard = step.board;
        setTimeout(resolve, WAVE_MS);
      }, HITSTOP_MS);
    } else if (step.kind==='gravity'){
      animateFalls(step.moves, step.board).then(resolve);
    } else if (step.kind==='electric'){
      spawnElectricArcs(step);
      AudioEngine.zap();
      popChain('ELECTRIC');
      currentBoard = step.board;
      setTimeout(resolve, ELECTRIC_MS);
    } else if (step.kind==='fire'){
      spawnEmbers(step.cells);
      currentBoard = step.board;
      setTimeout(resolve, FIRE_MS);
    } else {
      currentBoard = step.board;
      resolve();
    }
  });
}
async function playSteps(steps){ for (const s of steps) await playStep(s); }

async function runBlow(){
  uiState = 'PLAYBACK';
  document.getElementById('btn-blow').disabled = true;
  AudioEngine.ensure();
  const cfg = deriveConfig(run.bombConfig.levels);
  const result = simulate(run.board, run.bombPos, cfg);
  runningChainTotal = 0;
  camScaleTarget = 1;
  await playSteps(result.steps);
  currentBoard = result.finalBoard;
  camScaleTarget = 1;
  await new Promise(r => setTimeout(r, 260));
  showResult(result.stats);
}

/* ===================== UI / SCREEN FLOW ===================== */
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  gameScreenActive = (id==='screen-game');
}
let legendDrawn = false;
function drawLegend(){
  if (legendDrawn) return;
  const nodes = document.querySelectorAll('.legend-icon');
  nodes.forEach(node => {
    const type = node.dataset.type;
    const lctx = node.getContext('2d');
    const size = 72;
    lctx.clearRect(0,0,size,size);
    drawIconAt(lctx, makeCell(type), size/2, size/2, size);
  });
  legendDrawn = true;
}
function pad2(n){ return String(n).padStart(2,'0'); }
function refreshHUD(){
  document.getElementById('hud-stage').textContent = pad2(run.stage);
  document.getElementById('hud-score').textContent = run.score.toLocaleString();
  document.getElementById('hud-best').textContent = run.bestChain;
}
function updateBombStatsPanel(){
  const cfg = deriveConfig(run.bombConfig.levels);
  let html = `<span class="chip">RANGE <b>${cfg.radius}</b></span>`;
  if (cfg.shockwaveLevel) html += `<span class="chip">SHOCK <b>${cfg.shockwaveLevel}</b></span>`;
  if (cfg.burnLevel) html += `<span class="chip">BURN <b>${cfg.burnLevel}</b></span>`;
  if (cfg.conductiveLevel) html += `<span class="chip">ELEC <b>${cfg.conductiveLevel}</b></span>`;
  if (cfg.doubleTapLevel) html += `<span class="chip">TAP <b>${cfg.doubleTapLevel+1}×</b></span>`;
  if (run.bombConfig.levels.FUELX2) html += `<span class="chip">FUEL <b>${run.bombConfig.levels.FUELX2}</b></span>`;
  document.getElementById('bomb-stats').innerHTML = html;
}
function animateCount(el, target, dur){
  const start = performance.now();
  function step(now){
    const t = Math.max(0, Math.min(1, (now-start)/dur));
    const v = Math.round(target*(1-Math.pow(1-t,3)));
    el.textContent = v.toLocaleString();
    if (t<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function showResult(stats){
  uiState = 'IDLE';
  showScreen('screen-result');
  document.getElementById('res-destroy').textContent = Math.round(stats.destroyRate*100)+'%';
  document.getElementById('res-chain').textContent = '×'+stats.chainCount;
  document.getElementById('res-electric').textContent = '×'+stats.electricCount;
  document.getElementById('res-burst').textContent = stats.maxSimultaneous;
  document.getElementById('res-fullclear').textContent = stats.fullClear ? 'YES' : '—';
  run.score += stats.score;
  if (stats.chainCount > run.bestChain){
    run.bestChain = stats.chainCount;
    try { localStorage.setItem(BEST_KEY, String(run.bestChain)); } catch (e) {}
  }
  document.getElementById('res-total').textContent = '0';
  animateCount(document.getElementById('res-total'), stats.score, 700);
}
function shuffle(arr){
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function showUpgrade(){
  showScreen('screen-upgrade');
  const pool = shuffle(UPGRADES).slice(0,3);
  const wrap = document.getElementById('upgrade-cards');
  wrap.innerHTML = '';
  for (const u of pool){
    const lvl = run.bombConfig.levels[u.id];
    const card = document.createElement('div');
    card.className = 'upgrade-card';
    card.innerHTML = `<div class="u-name">${u.name}</div><div class="u-desc">${u.desc}</div>${lvl>0?`<div class="u-lv">LV.${lvl+1}</div>`:''}`;
    card.addEventListener('click', () => {
      if (card.dataset.picked) return;
      card.dataset.picked = '1';
      card.classList.add('selected');
      run.bombConfig.levels[u.id]++;
      AudioEngine.tick();
      setTimeout(proceedToNextStage, 220);
    });
    wrap.appendChild(card);
  }
}
function proceedToNextStage(){
  run.stage++;
  run.board = generateBoard(run.stage);
  run.bombPos = null;
  currentBoard = run.board;
  uiState = 'SELECT';
  showScreen('screen-game');
  requestAnimationFrame(resizeCanvas);
  refreshHUD();
  updateBombStatsPanel();
  document.getElementById('btn-blow').disabled = true;
}
function showFinal(){
  showScreen('screen-final');
  document.getElementById('final-stages').textContent = run.stage+' / '+run.totalStages;
  document.getElementById('final-best-chain').textContent = run.bestChain;
  document.getElementById('final-score').textContent = '0';
  animateCount(document.getElementById('final-score'), run.score, 900);
}
function startNewRun(){
  run.stage = 1; run.score = 0;
  run.bombConfig = { levels: {RANGE:0,SHOCKWAVE:0,BURN:0,CONDUCTIVE:0,DOUBLETAP:0,FUELX2:0} };
  run.board = generateBoard(1);
  run.bombPos = null;
  currentBoard = run.board;
  uiState = 'SELECT';
  showScreen('screen-game');
  requestAnimationFrame(resizeCanvas);
  refreshHUD();
  updateBombStatsPanel();
  document.getElementById('btn-blow').disabled = true;
}
function onCanvasPointerDown(e){
  if (uiState!=='SELECT' || !cellPx) return;
  const rect = canvas.getBoundingClientRect();
  const scale = cssSize/rect.width;
  const px = (e.clientX-rect.left)*scale;
  const py = (e.clientY-rect.top)*scale;
  const gx = Math.floor(px/cellPx), gy = Math.floor(py/cellPx);
  if (gx<0||gy<0||gx>=COLS||gy>=ROWS) return;
  if (currentBoard[gy][gx]) return;
  run.bombPos = {x:gx,y:gy};
  AudioEngine.tick();
  document.getElementById('btn-blow').disabled = false;
}
function onBlowClick(){
  if (!run.bombPos || uiState!=='SELECT') return;
  runBlow();
}
function onResultNext(){
  if (run.stage >= run.totalStages) showFinal(); else showUpgrade();
}

/* ===================== INIT ===================== */
document.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('board-canvas');
  ctx = canvas.getContext('2d');
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 60));
  document.getElementById('btn-start').addEventListener('click', () => { AudioEngine.ensure(); startNewRun(); });
  document.getElementById('btn-blow').addEventListener('click', onBlowClick);
  document.getElementById('btn-result-next').addEventListener('click', onResultNext);
  document.getElementById('btn-retry').addEventListener('click', () => { AudioEngine.ensure(); startNewRun(); });
  document.getElementById('btn-howto').addEventListener('click', () => { drawLegend(); showScreen('screen-howto'); });
  document.getElementById('btn-howto-back').addEventListener('click', () => { showScreen('screen-title'); });
  canvas.addEventListener('pointerdown', onCanvasPointerDown);

  let best = 0;
  try { best = parseInt(localStorage.getItem(BEST_KEY)||'0', 10) || 0; } catch (e) {}
  run.bestChain = best;
  document.getElementById('title-best-chain').textContent = best;

  showScreen('screen-title');
  requestAnimationFrame(draw);
});

})();
