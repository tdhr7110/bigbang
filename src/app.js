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

const PART_INFO = {
  BLOCK:     { name:'BLOCK',        desc:'爆風で壊れる、ただのがれき' },
  FUEL:      { name:'FUEL TANK',    desc:'壊れると爆発し、周囲を巻き込む' },
  EXPLOSIVE: { name:'EXPLOSIVE',    desc:'壊れると爆発し、連鎖の起点になる' },
  GAS:       { name:'GAS CANISTER',desc:'少し遅れて爆発し、離れた場所へ連鎖を伸ばす' },
  GLASS:     { name:'GLASS',        desc:'脆く、弱い衝撃波でも割れる' },
  WALL:      { name:'WALL',         desc:'壊れず、爆風を完全に遮断する' },
  BATTERY:   { name:'BATTERY',      desc:'落下して金属に触れると周囲へ電撃が連鎖する' },
  METAL:     { name:'METAL',        desc:'頑丈で電気を通す。電池と組み合わせると危険' },
};

const TOTAL_STAGES = 50;
// Part unlock tiers: [firstStage, parts]. Stays at the last tier for all later stages.
const PART_TIERS = [
  [1,  ['BLOCK','FUEL','EXPLOSIVE']],
  [6,  ['BLOCK','FUEL','EXPLOSIVE','GAS']],
  [11, ['BLOCK','FUEL','EXPLOSIVE','GAS','GLASS']],
  [16, ['BLOCK','FUEL','EXPLOSIVE','GAS','GLASS','WALL']],
  [21, ['BLOCK','FUEL','EXPLOSIVE','GAS','GLASS','WALL','BATTERY','METAL']],
];
function stagePartsFor(stage){
  let parts = PART_TIERS[0][1];
  for (const [first, list] of PART_TIERS){ if (stage >= first) parts = list; }
  return parts;
}
function isNewPartStage(stage){ return PART_TIERS.some(([first])=>first===stage); }
function stagePartsIntroducedAt(stage){
  const prev = stagePartsFor(stage-1<1 ? 0 : stage-1);
  return stagePartsFor(stage).filter(p => !prev.includes(p));
}

// Fraction of empty cells that should be able to reach >=star1 (50% explosion rate).
// Interpolated across the 50-stage curve, then eased on stages that just unlocked a
// new part (per spec: ease up right when a new mechanic appears).
function stageDifficultyBand(stage){
  const t = Math.max(0, Math.min(1, (stage-1)/(TOTAL_STAGES-1)));
  const lerp = (a,b) => a+(b-a)*t;
  let min = lerp(0.40, 0.01);
  let max = lerp(0.65, 0.06);
  if (isNewPartStage(stage)){ min *= 1.7; max *= 1.8; }
  if (stage <= 3){ min = Math.max(min, 0.40); max = Math.max(max, 0.65); }
  return { min, max };
}
// Which mission metric(s) to offer at this stage, and how ambitious (fraction of the
// best achievable result) the threshold should be. Complexity ramps: single simple
// condition -> single harder condition -> two conditions -> tight two/three conditions.
function missionTierForStage(stage){
  if (stage <= 5)  return { metrics:['DESTROY'],           ratio:[0.45,0.60] };
  if (stage <= 10) return { metrics:['DESTROY','CHAIN'],   ratio:[0.55,0.65] };
  if (stage <= 20) return { metrics:['CHAIN'],              ratio:[0.60,0.72] };
  if (stage === 21) return { metrics:['ELECTRIC_ANY'],      ratio:[1,1] };
  if (stage <= 30) return { metrics:['CHAIN','ELECTRIC'],   ratio:[0.68,0.80] };
  if (stage <= 40) return { metrics:['COMPOUND2'],          ratio:[0.75,0.85] };
  if (stage <= 49) return { metrics:['COMPOUND2'],          ratio:[0.85,0.92] };
  return              { metrics:['COMPOUND3'],              ratio:[0.88,0.95] };
}

function isExplosiveFamily(t){ return t==='FUEL'||t==='EXPLOSIVE'||t==='GAS'; }

/* ===================== SEEDED RNG ===================== */
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str){
  let h = 1779033703 ^ str.length;
  for (let i=0;i<str.length;i++){
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0);
}

/* ===================== BOARD GENERATION ===================== */
function stageWeights(n){
  const parts = stagePartsFor(n);
  const has = (t) => parts.includes(t);
  // Later stages get SPARSER, not denser: with a fixed blast radius, a dense board
  // makes almost every placement hit something good (too easy, high star1 ratio).
  // A sparse board makes most placements hit little, so only a few well-read cells
  // reach the chain-enabling objects - that's what produces a narrow solution set.
  const t = Math.max(0, Math.min(1, (n-1)/(TOTAL_STAGES-1)));
  const lerp = (a,b) => a+(b-a)*t;
  const w = { EMPTY: lerp(0.28,0.58), BLOCK: lerp(0.34,0.16) };
  if (has('GLASS'))     w.GLASS = lerp(0.09,0.05);
  if (has('FUEL'))      w.FUEL = lerp(0.08,0.06);
  if (has('EXPLOSIVE')) w.EXPLOSIVE = lerp(0.08,0.06);
  if (has('BATTERY'))   w.BATTERY = lerp(0.05,0.04);
  if (has('GAS'))       w.GAS = lerp(0.04,0.03);
  if (has('METAL'))     w.METAL = lerp(0.04,0.04);
  if (has('WALL'))      w.WALL = lerp(0.02,0.03);
  return w;
}
function weightedPick(weights, rng){
  const entries = Object.entries(weights);
  const total = entries.reduce((s,[,w])=>s+w,0);
  let r = rng()*total;
  for (const [k,w] of entries){ if (r<w) return k; r-=w; }
  return entries[entries.length-1][0];
}
function makeCell(type){ return { type, hp: OBJ[type].hp }; }
function forEachCell(board, fn){ for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) fn(board[y][x],x,y); }
function randomConvertibleCell(board, rng){
  const cand = [];
  forEachCell(board,(c,x,y)=>{ if (c && (c.type==='BLOCK'||c.type==='GLASS')) cand.push({x,y}); });
  if (!cand.length) return null;
  return cand[Math.floor(rng()*cand.length)];
}
function ensureMinEmpty(board, n, rng){
  let count = 0;
  forEachCell(board,(c)=>{ if(!c) count++; });
  while (count < n){
    const p = randomConvertibleCell(board, rng);
    if (!p) break;
    board[p.y][p.x] = null;
    count++;
  }
}
function ensureMinCount(board, types, n, rng){
  let count = 0;
  forEachCell(board,(c)=>{ if (c && types.includes(c.type)) count++; });
  let guard = 200;
  while (count < n && guard-- > 0){
    const p = randomConvertibleCell(board, rng);
    if (!p) break;
    const type = types[Math.floor(rng()*types.length)];
    board[p.y][p.x] = makeCell(type);
    count++;
  }
}
function ensureMetalBatteryPair(board, rng){
  let hasMetal=false, hasBattery=false;
  forEachCell(board,(c)=>{ if(c){ if(c.type==='METAL')hasMetal=true; if(c.type==='BATTERY')hasBattery=true; } });
  if (!hasMetal){ const p=randomConvertibleCell(board, rng); if(p) board[p.y][p.x]=makeCell('METAL'); }
  if (!hasBattery){ const p=randomConvertibleCell(board, rng); if(p) board[p.y][p.x]=makeCell('BATTERY'); }
}
function generateBoardRaw(stageIndex, rng){
  const weights = stageWeights(stageIndex);
  const board = [];
  for (let y=0;y<ROWS;y++){
    const row = [];
    for (let x=0;x<COLS;x++){
      const type = weightedPick(weights, rng);
      row.push(type==='EMPTY' ? null : makeCell(type));
    }
    board.push(row);
  }
  ensureMinEmpty(board, 6, rng);
  const parts = stagePartsFor(stageIndex);
  const explosiveFamily = ['FUEL','EXPLOSIVE'].filter(t=>parts.includes(t));
  if (parts.includes('GAS')) explosiveFamily.push('GAS');
  ensureMinCount(board, explosiveFamily, 2, rng);
  if (parts.includes('BATTERY') && parts.includes('METAL')) ensureMetalBatteryPair(board, rng);
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

function simulate(initialBoard, bombPos, cfg, opts){
  const fast = !!(opts && opts.fast);
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
  let wave = 0, explosionEventCount = 0, maxSimultaneous = 0, electricCount = 0, totalDestroyed = 0, destroyOrder = 0;
  const destroyedTypes = new Set();
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
        totalDestroyed++; destroyedTypes.add('GLASS');
        fireIgnitions.push({x:fx, y:fy, effect:'shatter'});
        fireMap.delete(key);
        continue;
      }
      const nt = turns-1;
      if (nt<=0) fireMap.delete(key); else fireMap.set(key, nt);
    }
    if (!fast && fireIgnitions.length) steps.push({kind:'fire', cells:fireIgnitions, board:cloneBoard(board)});

    if (queue.length > 0){
      const sources = queue; queue = [];
      const chainStart = explosionEventCount + 1;
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
          destroyedList.push({x:c.x,y:c.y,type:'GLASS',order:++destroyOrder});
          destroyedThisWave++; totalDestroyed++; destroyedTypes.add('GLASS');
        }
        if (!fast) hitCells.push({x:c.x,y:c.y,weak:true,type:cell?cell.type:'EMPTY',destroyed: !!(cell&&cell.type==='GLASS')});
      }
      for (const [key,c] of strongMap){
        const cell = board[c.y][c.x];
        if (!cell){ if (!fast) hitCells.push({x:c.x,y:c.y,type:'EMPTY',destroyed:false}); continue; }
        if (cell.type==='WALL'){ if (!fast) hitCells.push({x:c.x,y:c.y,type:'WALL',destroyed:false}); continue; }
        cell.hp -= 1;
        if (cell.hp<=0){
          board[c.y][c.x]=null;
          destroyedList.push({x:c.x,y:c.y,type:cell.type,order:++destroyOrder});
          destroyedThisWave++; totalDestroyed++; destroyedTypes.add(cell.type);
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
        if (!fast) hitCells.push({x:c.x,y:c.y,type:cell.type,destroyed:cell.hp<=0,hpLeft:Math.max(cell.hp,0)});
      }
      maxSimultaneous = Math.max(maxSimultaneous, destroyedThisWave);
      if (!fast) steps.push({kind:'explosion', sources, hits:hitCells, destroyed:destroyedList, chainStart, board:cloneBoard(board)});

      if (battDirectSeeds.length){
        const er = processElectric(board, battDirectSeeds, cfg.conductiveLevel);
        if (er.discharges.length){
          electricCount += er.discharges.length;
          if (!fast) steps.push({kind:'electric', discharges:er.discharges, board:cloneBoard(board)});
          queue.push(...er.triggeredExplosions);
        }
      }
      wave++;
      continue;
    }

    const moves = applyGravity(board);
    if (moves.length > 0){
      if (!fast) steps.push({kind:'gravity', moves, board:cloneBoard(board)});
      const seeds = moves.filter(m => board[m.toY][m.toX] && board[m.toY][m.toX].type==='BATTERY').map(m=>({x:m.toX,y:m.toY}));
      if (seeds.length){
        const er = processElectric(board, seeds, cfg.conductiveLevel);
        if (er.discharges.length){
          electricCount += er.discharges.length;
          if (!fast) steps.push({kind:'electric', discharges:er.discharges, board:cloneBoard(board)});
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
  const score = computeScore({destroyRate, chainCount:explosionEventCount, electricCount, maxSimultaneous, fullClear});
  const remainingObjects = [];
  if (!fast) forEachCell(board, (c,x,y)=>{ if (c) remainingObjects.push({x,y,type:c.type}); });
  const stats = {
    // legacy field names (kept for existing UI code)
    totalDestroyed, totalDestructible, destroyRate,
    chainCount: explosionEventCount, electricCount, maxSimultaneous, fullClear, score,
    // spec-required field names
    destroyCount: totalDestroyed, maxBurst: maxSimultaneous, totalScore: score,
    remainingObjects, destroyedTypes,
  };
  return { steps, stats, finalBoard: fast ? null : cloneBoard(board), eventLog: steps };
}

/* ===================== EXHAUSTIVE SEARCH ===================== */
function findEmptyCells(board){
  const cells = [];
  for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++) if (!board[y][x]) cells.push({x,y});
  return cells;
}
function exhaustiveSearch(board, cfg){
  const empties = findEmptyCells(board);
  const results = empties.map(p => {
    const r = simulate(board, p, cfg, {fast:true});
    return { x:p.x, y:p.y, stats:r.stats };
  });
  const byScore = results.slice().sort((a,b)=>b.stats.score-a.stats.score);
  const best = byScore[0] || null;
  const scoresAsc = results.map(r=>r.stats.score).sort((a,b)=>a-b);
  const median = scoresAsc.length ? scoresAsc[Math.floor((scoresAsc.length-1)/2)] : 0;
  const maxDestroyCount = results.reduce((m,r)=>Math.max(m,r.stats.destroyCount),0);
  let centerBaseline = null;
  if (results.length){
    let bestD = Infinity;
    for (const r of results){
      const d = Math.abs(r.x-3.5)+Math.abs(r.y-3.5);
      if (d<bestD){ bestD=d; centerBaseline=r; }
    }
  }
  return { empties: empties.length, results, best, median, centerBaseline, maxDestroyCount };
}
function explosionRateFor(destroyCount, maxDestroyCount){
  if (maxDestroyCount <= 0) return destroyCount > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, destroyCount / maxDestroyCount));
}
function starsForRate(rate){
  const pct = rate * 100;
  if (pct >= 95) return 3;
  if (pct >= 75) return 2;
  if (pct >= 50) return 1;
  return 0;
}

/* ===================== MISSION SYSTEM ===================== */
function missionPartLabel(m){
  switch(m.type){
    case 'DESTROY': return `破壊率${m.threshold}%以上`;
    case 'CHAIN': return `CHAIN ${m.threshold}以上`;
    case 'ELECTRIC': return `ELECTRIC ${m.threshold}回以上`;
    case 'BURST': return `MAX BURST ${m.threshold}以上`;
    case 'FULLCLEAR': return 'FULL CLEAR';
  }
  return '';
}
function evaluateMissionPart(stats, m){
  switch(m.type){
    case 'DESTROY': { const actual = Math.round(stats.destroyRate*100); return { type:m.type, ok: actual>=m.threshold, actual, target:m.threshold, label:missionPartLabel(m) }; }
    case 'CHAIN': { const actual = stats.chainCount; return { type:m.type, ok: actual>=m.threshold, actual, target:m.threshold, label:missionPartLabel(m) }; }
    case 'ELECTRIC': { const actual = stats.electricCount; return { type:m.type, ok: actual>=m.threshold, actual, target:m.threshold, label:missionPartLabel(m) }; }
    case 'BURST': { const actual = stats.maxSimultaneous; return { type:m.type, ok: actual>=m.threshold, actual, target:m.threshold, label:missionPartLabel(m) }; }
    case 'FULLCLEAR': { return { type:m.type, ok: stats.fullClear, actual: stats.fullClear?1:0, target:1, label:missionPartLabel(m) }; }
  }
  return { type:m.type, ok:false, actual:0, target:0, label:'' };
}
function evaluateMission(stats, mission){
  const parts = mission.parts.map(p => evaluateMissionPart(stats, p));
  return { ok: parts.every(p=>p.ok), parts };
}
function avg(range){ return (range[0]+range[1])/2; }
// Every threshold below is clamped so it never exceeds what `best` (the top-score
// candidate) actually achieved - otherwise a weak/sparse board could derive a
// mission that not even the best possible placement can satisfy.
function clampDestroyTarget(best, ratio){
  const bestPct = best.destroyRate*100;
  const raw = Math.round(bestPct*ratio/5)*5;
  return Math.max(5, Math.min(raw, Math.floor(bestPct)));
}
function clampCountTarget(bestValue, ratio, floor){
  if (bestValue <= 0) return 0;
  return Math.max(Math.min(floor, bestValue), Math.min(Math.round(bestValue*ratio), bestValue));
}
function pickMission(stage, search){
  const tier = missionTierForStage(stage);
  const best = search.best.stats;
  const ratio = avg(tier.ratio);
  const metrics = tier.metrics;

  if (metrics[0] === 'ELECTRIC_ANY'){
    return { parts:[{type:'ELECTRIC', threshold:1}], label:'ELECTRICを1回発生させよ' };
  }
  if (metrics[0] === 'COMPOUND3'){
    const parts = [{type:'DESTROY', threshold: clampDestroyTarget(best, ratio)}];
    parts.push({type:'CHAIN', threshold: clampCountTarget(best.chainCount, ratio, 4)});
    parts.push(best.electricCount >= 1
      ? {type:'ELECTRIC', threshold: Math.max(1, Math.min(best.electricCount, 2))}
      : {type:'BURST', threshold: clampCountTarget(best.maxSimultaneous, ratio, 3)});
    return { parts, label: parts.map(missionPartLabel).join(' + ') };
  }
  if (metrics[0] === 'COMPOUND2'){
    const parts = [{type:'DESTROY', threshold: clampDestroyTarget(best, ratio)}];
    parts.push(best.electricCount >= 1
      ? {type:'ELECTRIC', threshold: Math.max(1, Math.min(best.electricCount, 2))}
      : {type:'CHAIN', threshold: clampCountTarget(best.chainCount, ratio, 4)});
    return { parts, label: parts.map(missionPartLabel).join(' + ') };
  }
  if (metrics.includes('ELECTRIC') && best.electricCount >= 1){
    const t = Math.max(1, Math.min(best.electricCount, 2));
    return { parts:[{type:'ELECTRIC', threshold:t}], label:missionPartLabel({type:'ELECTRIC',threshold:t}) };
  }
  if (metrics.includes('CHAIN')){
    const t = clampCountTarget(best.chainCount, ratio, 3);
    return { parts:[{type:'CHAIN', threshold:t}], label:`CHAIN ${t}以上を達成せよ` };
  }
  const t = clampDestroyTarget(best, ratio);
  return { parts:[{type:'DESTROY', threshold:t}], label:`破壊率${t}%以上を達成せよ` };
}

/* ===================== BOARD QUALITY GATE ===================== */
function evaluateBoardQuality(stage, search, mission){
  const empties = search.empties;
  if (empties < 5 || !search.best) return { ok:false, reason:'空きマスが少なすぎる' };

  const rateOf = (r) => explosionRateFor(r.stats.destroyCount, search.maxDestroyCount);
  const star1Results = search.results.filter(r => starsForRate(rateOf(r)) >= 1);
  const star2Results = search.results.filter(r => starsForRate(rateOf(r)) >= 2);
  const star1Count = star1Results.length;
  const star1Ratio = star1Count/empties;
  const star2Ratio = star2Results.length/empties;

  const solveResults = search.results.filter(r => evaluateMission(r.stats, mission).ok);
  const solveCount = solveResults.length;
  const bestSolving = solveResults.length ? solveResults.slice().sort((a,b)=>b.stats.score-a.stats.score)[0] : null;

  if (star1Count === 0) return { ok:false, reason:'星1を取得できる配置が存在しない', star1Count, star1Ratio, solveCount, bestSolving };
  if (solveCount === 0) return { ok:false, reason:'ミッションを達成できる配置が存在しない', star1Count, star1Ratio, solveCount, bestSolving };

  const band = stageDifficultyBand(stage);
  if (star1Ratio < band.min*0.5) return { ok:false, reason:'正解候補が少なすぎる', star1Count, star1Ratio, solveCount, bestSolving };
  if (star1Ratio > band.max + 0.30) return { ok:false, reason:'正解候補が多すぎる（簡単すぎる）', star1Count, star1Ratio, solveCount, bestSolving };
  if (stage > 3 && star2Ratio > 0.8 && empties > 6) return { ok:false, reason:'どこに置いても星2以上になる', star1Count, star1Ratio, solveCount, bestSolving };

  const best = search.best.stats.score;
  const median = search.median;
  if (stage > 3){
    if (best > 0 && (best-median) < best*0.10) return { ok:false, reason:'最適配置と適当な配置の差が小さい', star1Count, star1Ratio, solveCount, bestSolving };
    const centerScore = search.centerBaseline ? search.centerBaseline.stats.score : 0;
    if (best > 0 && centerScore >= best*0.97 && empties > 8) return { ok:false, reason:'中央付近がほぼ最適解と同等', star1Count, star1Ratio, solveCount, bestSolving };
  }

  const newParts = stagePartsIntroducedAt(stage);
  if (newParts.length){
    const usedNew = star1Results.some(r => newParts.some(p => r.stats.destroyedTypes.has(p)));
    if (!usedNew) return { ok:false, reason:'新部品が攻略に関係していない', star1Count, star1Ratio, solveCount, bestSolving };
  }
  if (search.best.stats.chainCount < 2 && stage >= 4) return { ok:false, reason:'最適解でも連鎖が起きない', star1Count, star1Ratio, solveCount, bestSolving };

  return { ok:true, star1Count, star1Ratio, solveCount, best, median, bestSolving };
}
function buildFallbackBoard(stage, rng){
  const parts = stagePartsFor(stage);
  const t = Math.max(0, Math.min(1, (stage-1)/(TOTAL_STAGES-1)));
  const board = [];
  for (let y=0;y<ROWS;y++){ const row=[]; for(let x=0;x<COLS;x++) row.push(null); board.push(row); }
  const glassW = parts.includes('GLASS') ? 0.06 : 0;
  const emptyW = 0.30 + 0.55*t;
  const fillerWeights = { EMPTY: emptyW, BLOCK: Math.max(0.1, 1-emptyW-glassW) };
  if (glassW) fillerWeights.GLASS = glassW;
  for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++){
    const type = weightedPick(fillerWeights, rng);
    board[y][x] = type==='EMPTY' ? null : makeCell(type);
  }
  // a single guaranteed trigger, kept minimal at higher stages so the fallback
  // board doesn't hand out an obvious multi-cell cluster of "also works" solutions
  const cx = 5, cy = 2;
  board[cy][cx] = makeCell('FUEL');
  board[cy][cx-1] = null;
  if (stage <= 10 && parts.includes('EXPLOSIVE')) board[cy][cx+1] = makeCell('EXPLOSIVE');
  if (stage >= 16 && parts.includes('WALL')) board[cy+1][cx] = makeCell('WALL');
  if (stage <= 15 && parts.includes('GAS')) board[cy][Math.min(cx+2,COLS-1)] = makeCell('GAS');
  if (parts.includes('BATTERY') && parts.includes('METAL')){
    board[cy+2][cx] = makeCell('METAL');
    board[cy+1][cx-1] = makeCell('BATTERY');
  }
  ensureMinEmpty(board, 6, rng);
  return board;
}
const MAX_GENERATION_ATTEMPTS = 50;
function generateStage(stage, cfg, runSeed){
  const attempts = [];
  let chosen = null;
  for (let i=0; i<MAX_GENERATION_ATTEMPTS; i++){
    const seed = hashSeed(runSeed+'|stage'+stage+'|attempt'+i);
    const rng = mulberry32(seed);
    const board = generateBoardRaw(stage, rng);
    const search = exhaustiveSearch(board, cfg);
    if (!search.best){ attempts.push({seed, ok:false, reason:'空きマスなし'}); continue; }
    const mission = pickMission(stage, search);
    const quality = evaluateBoardQuality(stage, search, mission);
    attempts.push({ seed, ok:quality.ok, reason:quality.reason||'OK', solveCount:quality.solveCount, solveRatio:quality.solveRatio, best:search.best.stats.score, median:search.median });
    if (quality.ok){
      chosen = { board, mission, search, seed, attemptIndex:i, fallback:false, bestSolving:quality.bestSolving };
      break;
    }
  }
  if (!chosen){
    const seed = hashSeed(runSeed+'|stage'+stage+'|fallback');
    const rng = mulberry32(seed);
    const board = buildFallbackBoard(stage, rng);
    const search = exhaustiveSearch(board, cfg);
    const mission = pickMission(stage, search);
    const quality = evaluateBoardQuality(stage, search, mission);
    chosen = { board, mission, search, seed, attemptIndex: MAX_GENERATION_ATTEMPTS, fallback:true, bestSolving: quality.bestSolving || search.best };
  }
  chosen.attempts = attempts;
  chosen.stage = stage;
  return chosen;
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

const DISCOVERED_KEY = 'oneexplosion_discovered';
let DEBUG_MODE = false;

const run = {
  stage: 1, totalStages: 8, score: 0, bestChain: 0,
  bombConfig: { levels: {RANGE:0,SHOCKWAVE:0,BURN:0,CONDUCTIVE:0,DOUBLETAP:0,FUELX2:0} },
  board: null, bombPos: null,
  runSeed: 1, mission: null, search: null, genDebug: null,
  stageFailCount: 0, discovered: new Set(), tutorialShownThisRun: new Set(),
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
    } else if (e.type==='wallflash'){
      ctx.globalAlpha = (1-t)*0.9;
      ctx.strokeStyle = COLOR.text;
      ctx.lineWidth = 3*(1-t)+1;
      ctx.strokeRect(e.x-e.size/2+2, e.y-e.size/2+2, e.size-4, e.size-4);
    } else if (e.type==='label'){
      ctx.globalAlpha = 1-t;
      ctx.fillStyle = COLOR.accent;
      ctx.font = `700 ${Math.round(cellPx*0.34)}px Inter, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(e.text, e.x, e.y - cellPx*0.22*t);
    } else if (e.type==='glow'){
      const pulse = 0.5+0.5*Math.sin((now-e.start)/110);
      ctx.globalAlpha = (1-t)*0.85;
      ctx.strokeStyle = COLOR.accent;
      ctx.lineWidth = 2+pulse*2;
      ctx.beginPath(); ctx.arc(e.x, e.y, cellPx*0.42+pulse*3, 0, Math.PI*2); ctx.stroke();
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
  drawDebugOverlay();
  ctx.restore();
}
function drawDebugOverlay(){
  if (!DEBUG_MODE || !run.search || uiState!=='SELECT' || !run.mission) return;
  const solveSet = new Set(run.search.results.filter(r=>evaluateMission(r.stats, run.mission).ok).map(r=>r.x+','+r.y));
  for (const r of run.search.results){
    const cx = r.x*cellPx+cellPx/2, cy = r.y*cellPx+cellPx/2;
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = solveSet.has(r.x+','+r.y) ? '#3ddc84' : '#55555a';
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }
  if (run.search.best){
    const cx = run.search.best.x*cellPx+cellPx/2, cy = run.search.best.y*cellPx+cellPx/2;
    ctx.save();
    ctx.strokeStyle = '#3ddc84'; ctx.lineWidth = 2; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(cx,cy,cellPx*0.35,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }
}

/* ===================== EFFECT SPAWNERS ===================== */
function triggerShake(mag, dur){ shake.mag=mag; shake.total=dur; shake.until=performance.now()+dur; }
function spawnExplosionEffects(step){
  for (const h of step.hits){
    const cx = h.x*cellPx+cellPx/2, cy = h.y*cellPx+cellPx/2;
    if (h.type==='WALL'){
      effects.push({type:'wallflash', x:cx, y:cy, start:performance.now(), dur:300, size:cellPx});
      continue;
    }
    effects.push({type:'flash', x:cx, y:cy, start:performance.now(), dur: h.destroyed?260:160, strong:h.destroyed, size:cellPx});
  }
  for (const d of step.destroyed){
    const cx = d.x*cellPx+cellPx/2, cy = d.y*cellPx+cellPx/2;
    const n = 6+Math.floor(Math.random()*5);
    const parts = [];
    for (let i=0;i<n;i++) parts.push({a:Math.random()*Math.PI*2, speed: cellPx*(0.6+Math.random()*0.9), size:1.5+Math.random()*2});
    effects.push({type:'burst', x:cx, y:cy, start:performance.now(), dur:380, parts});
    if (d.order) effects.push({type:'label', x:cx, y:cy, start:performance.now(), dur:520, text:String(d.order)});
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
    const fromPx = { x:d.from.x*cellPx+cellPx/2, y:d.from.y*cellPx+cellPx/2 };
    effects.push({type:'ring', x:fromPx.x, y:fromPx.y, start:performance.now(), dur:260, maxR:cellPx*0.9});
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
// Clears all transient playback/effect state. Internal stats (run.mission,
// run.search, stats.chainCount, etc.) are untouched - only display-layer
// leftovers from a previous BLOW are cleared here.
function resetPlaybackState(){
  effects = [];
  fallAnim = null;
  shake = { mag:0, total:0, until:0 };
  camScale = 1; camScaleTarget = 1;
  runningChainTotal = 0;
  const popupEl = document.getElementById('chain-popup');
  if (popupEl){
    popupEl.classList.remove('pop');
    popupEl.textContent = '';
  }
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
  resetPlaybackState();
  uiState = 'PLAYBACK';
  document.getElementById('btn-blow').disabled = true;
  AudioEngine.ensure();
  const cfg = deriveConfig(run.bombConfig.levels);
  const result = simulate(run.board, run.bombPos, cfg);
  await playSteps(result.steps);
  currentBoard = result.finalBoard;
  camScaleTarget = 1;
  await new Promise(r => setTimeout(r, 260));
  resetPlaybackState();
  showResult(result.stats, result.eventLog);
}

/* ===================== UI / SCREEN FLOW ===================== */
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  gameScreenActive = (id==='screen-game');
}
let legendDrawn = false;
function drawLegend(){
  if (!legendDrawn){
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
  refreshLegendDiscovery();
}
function boardHasType(board, type){
  for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++){ if (board[y][x] && board[y][x].type===type) return true; }
  return false;
}
function loadDiscovered(){
  try {
    const raw = localStorage.getItem(DISCOVERED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch (e) {}
  return new Set(['BLOCK']);
}
function saveDiscovered(){
  try { localStorage.setItem(DISCOVERED_KEY, JSON.stringify(Array.from(run.discovered))); } catch (e) {}
}
function refreshLegendDiscovery(){
  document.querySelectorAll('.legend-item').forEach(item => {
    const type = item.dataset.part;
    const known = type==='BLOCK' || run.discovered.has(type);
    item.classList.toggle('undiscovered', !known);
    const info = LEGEND_ITEMS.find(l=>l.type===type);
    item.querySelector('.legend-name').textContent = known ? (info ? info.label : type) : '???';
  });
}
function pad2(n){ return String(n).padStart(2,'0'); }
function refreshHUD(){
  document.getElementById('hud-stage').textContent = pad2(run.stage);
  document.getElementById('hud-score').textContent = run.score.toLocaleString();
  document.getElementById('hud-best').textContent = run.bestChain;
}
function updateMissionBanner(){
  document.getElementById('mission-text').textContent = run.mission ? run.mission.label : '';
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

/* ---- failure cause analysis ---- */
function analyzeStopReason(remainingObjects, cfg, eventLog){
  const battery = remainingObjects.filter(o=>o.type==='BATTERY');
  const metal = remainingObjects.filter(o=>o.type==='METAL');
  const reach = cfg.conductiveLevel>=2 ? 2 : 1;
  let bestDist = Infinity;
  for (const b of battery) for (const m of metal){
    const d = Math.abs(b.x-m.x)+Math.abs(b.y-m.y);
    if (d<bestDist) bestDist = d;
  }
  if (bestDist === reach+1){
    return 'この電池は金属まであと1マス届きませんでした';
  }
  const wasBlocked = (eventLog||[]).some(step => step.kind==='explosion' && step.hits.some(h=>h.type==='WALL'));
  if (wasBlocked){
    return '爆風が壁に阻まれました';
  }
  if (remainingObjects.some(o=>isExplosiveFamily(o.type))){
    return '誘爆しなかった爆薬・燃料・ガスが残っています';
  }
  return '連鎖がここで止まりました';
}

/* ---- mission-aware result screen ---- */
function showResult(stats, eventLog){
  resetPlaybackState();
  uiState = 'IDLE';
  showScreen('screen-result');
  const evalResult = evaluateMission(stats, run.mission);

  const statusEl = document.getElementById('result-status');
  statusEl.textContent = evalResult.ok ? 'MISSION COMPLETE' : 'MISSION FAILED';
  statusEl.classList.toggle('ok', evalResult.ok);
  statusEl.classList.toggle('fail', !evalResult.ok);

  document.getElementById('result-mission-line').textContent =
    evalResult.parts.map(p => `${p.label} → ${p.actual}${p.type==='DESTROY'?'%':''}`).join('   ');

  document.getElementById('res-destroy').textContent = Math.round(stats.destroyRate*100)+'%';
  document.getElementById('res-chain').textContent = '×'+stats.chainCount;
  document.getElementById('res-electric').textContent = '×'+stats.electricCount;
  document.getElementById('res-burst').textContent = stats.maxSimultaneous;
  document.getElementById('res-fullclear').textContent = stats.fullClear ? 'YES' : '—';
  document.getElementById('res-total').textContent = '0';
  animateCount(document.getElementById('res-total'), stats.score, 700);

  const hintEl = document.getElementById('result-fail-hint');
  if (evalResult.ok){
    hintEl.hidden = true;
    run.score += stats.score;
    if (stats.chainCount > run.bestChain){
      run.bestChain = stats.chainCount;
      try { localStorage.setItem(BEST_KEY, String(run.bestChain)); } catch (e) {}
    }
    run.stageFailCount = 0;
  } else {
    run.stageFailCount = (run.stageFailCount||0) + 1;
    const cfg = deriveConfig(run.bombConfig.levels);
    const reason = analyzeStopReason(stats.remainingObjects||[], cfg, eventLog);
    hintEl.textContent = 'CHAIN STOP\n' + reason;
    hintEl.hidden = false;
  }
  document.getElementById('btn-result-next').style.display = evalResult.ok ? '' : 'none';
  document.getElementById('btn-result-retry').hidden = evalResult.ok;
  refreshHUD();
  refreshDebugPanel();
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

/* ---- new-object tutorial ---- */
let tutorialQueue = [];
let currentTutorialType = null;
function glowCellAt(x, y){
  if (!cellPx) return;
  effects.push({type:'glow', x:x*cellPx+cellPx/2, y:y*cellPx+cellPx/2, start:performance.now(), dur:1500});
}
function glowPartOnBoard(type){
  for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++){
    if (run.board[y][x] && run.board[y][x].type===type){ glowCellAt(x,y); return; }
  }
}
function nextTutorial(){
  if (!tutorialQueue.length) return;
  currentTutorialType = tutorialQueue.shift();
  run.tutorialShownThisRun.add(currentTutorialType);
  if (!run.discovered.has(currentTutorialType)){
    run.discovered.add(currentTutorialType);
    saveDiscovered();
  }
  const info = PART_INFO[currentTutorialType];
  document.getElementById('tutorial-name').textContent = info.name;
  document.getElementById('tutorial-desc').textContent = info.desc;
  document.getElementById('tutorial-overlay').hidden = false;
}
function dismissTutorial(){
  document.getElementById('tutorial-overlay').hidden = true;
  if (currentTutorialType) glowPartOnBoard(currentTutorialType);
  currentTutorialType = null;
  if (tutorialQueue.length) setTimeout(nextTutorial, 900);
}
function showTutorialIfNeeded(){
  const newParts = stagePartsIntroducedAt(run.stage).filter(p => p !== 'BLOCK');
  const toShow = newParts.filter(p => boardHasType(run.board, p) && !run.tutorialShownThisRun.has(p));
  if (!toShow.length) return;
  tutorialQueue = toShow.slice();
  nextTutorial();
}

/* ---- repeated-failure hint ---- */
function glowKeyParts(){
  const best = run.search && (run.search.bestSolving || run.search.best);
  if (!best) return;
  const cfg = deriveConfig(run.bombConfig.levels);
  const full = simulate(run.board, {x:best.x, y:best.y}, cfg);
  const keyTypes = new Set(['FUEL','EXPLOSIVE','GAS','BATTERY','METAL']);
  for (const step of full.steps){
    if (step.kind !== 'explosion') continue;
    for (const item of step.destroyed){
      if (keyTypes.has(item.type)){ glowCellAt(item.x, item.y); return; }
    }
  }
}

/* ---- debug panel ---- */
function refreshDebugPanel(){
  if (!DEBUG_MODE) return;
  const gd = run.genDebug;
  const el = document.getElementById('debug-content');
  if (!gd || !run.search){ el.textContent = '(no generation data yet)'; return; }
  const lines = [];
  lines.push(`STAGE ${run.stage}   seed=${gd.seed}`);
  lines.push(`fallback=${gd.fallback}   attempt=${gd.attemptIndex+1}/${MAX_GENERATION_ATTEMPTS}`);
  lines.push(`empties=${run.search.empties}   best=${run.search.best.stats.score}   median=${run.search.median}`);
  lines.push(`mission: ${run.mission.label}`);
  const solveCount = run.search.results.filter(r=>evaluateMission(r.stats, run.mission).ok).length;
  const pct = run.search.empties ? (solveCount/run.search.empties*100).toFixed(0) : '0';
  lines.push(`solveCount=${solveCount}/${run.search.empties} (${pct}%)`);
  lines.push(`top-score cell=(${run.search.best.x},${run.search.best.y})`);
  if (run.search.bestSolving) lines.push(`best solving cell=(${run.search.bestSolving.x},${run.search.bestSolving.y}) score=${run.search.bestSolving.stats.score}`);
  lines.push(`upgrades: ${JSON.stringify(run.bombConfig.levels)}`);
  lines.push(`stageFailCount=${run.stageFailCount}`);
  lines.push('');
  lines.push('-- attempts (last 12) --');
  gd.attempts.slice(-12).forEach((a,i)=>{
    lines.push(`#${i} ${a.ok?'OK':'reject'}  ${a.reason}  solve=${a.solveCount||0}`);
  });
  el.textContent = lines.join('\n');
}

/* ---- stage loading ---- */
function loadStageBoard(stage){
  const cfg = deriveConfig(run.bombConfig.levels);
  const chosen = generateStage(stage, cfg, run.runSeed);
  run.board = chosen.board;
  run.mission = chosen.mission;
  run.search = chosen.search;
  run.search.bestSolving = chosen.bestSolving || chosen.search.best;
  run.genDebug = { seed:chosen.seed, attempts:chosen.attempts, fallback:chosen.fallback, attemptIndex:chosen.attemptIndex };
  run.stageFailCount = 0;
  run.bombPos = null;
  currentBoard = run.board;
}
function enterStageScreen(){
  resetPlaybackState();
  uiState = 'SELECT';
  showScreen('screen-game');
  requestAnimationFrame(resizeCanvas);
  refreshHUD();
  updateMissionBanner();
  updateBombStatsPanel();
  document.getElementById('btn-blow').disabled = true;
  refreshDebugPanel();
  setTimeout(showTutorialIfNeeded, 200);
}
function proceedToNextStage(){
  run.stage++;
  loadStageBoard(run.stage);
  enterStageScreen();
}
function retrySameStage(){
  resetPlaybackState();
  run.bombPos = null;
  currentBoard = run.board;
  uiState = 'SELECT';
  showScreen('screen-game');
  requestAnimationFrame(resizeCanvas);
  refreshHUD();
  updateMissionBanner();
  updateBombStatsPanel();
  document.getElementById('btn-blow').disabled = true;
  if (run.stageFailCount >= 2) setTimeout(glowKeyParts, 500);
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
  run.runSeed = Date.now() ^ Math.floor(Math.random()*0xffffffff);
  run.discovered = loadDiscovered();
  run.tutorialShownThisRun = new Set();
  loadStageBoard(1);
  enterStageScreen();
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
function initApp(){
  canvas = document.getElementById('board-canvas');
  ctx = canvas.getContext('2d');
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 60));
  document.getElementById('btn-start').addEventListener('click', () => { AudioEngine.ensure(); startNewRun(); });
  document.getElementById('btn-blow').addEventListener('click', onBlowClick);
  document.getElementById('btn-result-next').addEventListener('click', onResultNext);
  document.getElementById('btn-result-retry').addEventListener('click', () => { AudioEngine.ensure(); retrySameStage(); });
  document.getElementById('btn-retry').addEventListener('click', () => { AudioEngine.ensure(); startNewRun(); });
  document.getElementById('btn-howto').addEventListener('click', () => { drawLegend(); showScreen('screen-howto'); });
  document.getElementById('btn-howto-back').addEventListener('click', () => { showScreen('screen-title'); });
  document.getElementById('tutorial-dismiss').addEventListener('click', dismissTutorial);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);

  let best = 0;
  try { best = parseInt(localStorage.getItem(BEST_KEY)||'0', 10) || 0; } catch (e) {}
  run.bestChain = best;
  document.getElementById('title-best-chain').textContent = best;

  DEBUG_MODE = /[?&]debug=1/.test(window.location.search);
  if (DEBUG_MODE){
    document.getElementById('debug-panel').style.display = 'block';
    window.__run = run;
    window.__debug = { getEffects: () => effects, getChainPopupText: () => document.getElementById('chain-popup').textContent };
  }

  showScreen('screen-title');
  requestAnimationFrame(draw);
}
if (typeof document !== 'undefined'){
  document.addEventListener('DOMContentLoaded', initApp);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    simulate, exhaustiveSearch, generateStage, generateBoardRaw, deriveConfig,
    pickMission, evaluateMission, evaluateBoardQuality, hashSeed, mulberry32,
    stagePartsFor, stageDifficultyBand, missionTierForStage, stagePartsIntroducedAt,
    isNewPartStage, explosionRateFor, starsForRate, OBJ, TOTAL_STAGES,
    ROWS, COLS, MAX_GENERATION_ATTEMPTS, buildFallbackBoard, countDestructible,
  };
}

})();
