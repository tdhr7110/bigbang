(() => {
"use strict";

/* ===================== CONSTANTS ===================== */
const ROWS = 8, COLS = 8;
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
// At harder stages (once WALL is unlocked), partially box in the key explosive-family
// cells with WALL on 2-3 of their 4 orthogonal sides, leaving 1-2 sides open. Since
// blast line-of-sight is blocked by WALL cells lying on the straight line to a target,
// this sharply narrows which bomb positions can actually reach the cell that starts
// the chain - without it, a fixed blast radius makes almost every placement "good enough".
function narrowLineOfSight(board, stage, rng, cfg){
  const parts = stagePartsFor(stage);
  if (!parts.includes('WALL')) return;
  const t = Math.max(0, Math.min(1, (stage-1)/(TOTAL_STAGES-1)));
  // A bigger-than-base blast radius acts like a much harder stage for this pass: it needs
  // boxing sooner and more aggressively, since raw distance stops mattering once the blast
  // already reaches most of the board - only line-of-sight (which WALL blocks regardless
  // of distance) can still narrow down which placement actually works.
  const extraR = cfg ? Math.max(0, cfg.radius-2) : 0;
  const effectiveT = Math.min(1, t + extraR*0.3);
  if (effectiveT < 0.35) return;
  const keyCells = [];
  forEachCell(board, (c,x,y) => { if (c && isExplosiveFamily(c.type)) keyCells.push({x,y}); });
  const boxProb = Math.min(0.95, 0.3 + effectiveT*0.85);
  const protectedTypes = new Set(['FUEL','EXPLOSIVE','GAS','BATTERY','METAL']);
  for (const k of keyCells){
    if (rng() > boxProb) continue;
    const dirs = [{dx:-1,dy:0},{dx:1,dy:0},{dx:0,dy:-1},{dx:0,dy:1}];
    for (let i=dirs.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [dirs[i],dirs[j]]=[dirs[j],dirs[i]]; }
    const openSides = rng() < (0.65-0.25*effectiveT) ? 1 : 2;
    for (let i=openSides; i<dirs.length; i++){
      const nx = k.x+dirs[i].dx, ny = k.y+dirs[i].dy;
      if (nx<0||ny<0||nx>=COLS||ny>=ROWS) continue;
      const cur = board[ny][nx];
      if (cur && protectedTypes.has(cur.type)) continue;
      board[ny][nx] = makeCell('WALL');
    }
  }
}
function generateBoardRaw(stageIndex, rng, cfg){
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
  narrowLineOfSight(board, stageIndex, rng, cfg);
  return board;
}
function countDestructible(board){
  let n=0;
  forEachCell(board,(c)=>{ if (c && c.type!=='WALL') n++; });
  return n;
}
function cloneBoard(board){ return board.map(row=>row.map(c=>c?{...c}:null)); }

/* ===================== SIMULATION ENGINE ===================== */
// The bomb's power is fixed for the whole game - no upgrades. A small direct-hit
// footprint (3x3 = 9 cells) is the whole point: which cell you pick has to matter a lot,
// so the same explosion always plays out identically for a given board+placement.
const BOMB_RADIUS = 1;           // 3x3 = 9 cells direct hit
const FUEL_GAS_RADIUS = 1;       // secondary FUEL/GAS explosions stay just as small
const EXPLOSIVE_RADIUS = 2;      // EXPLOSIVE is the one deliberately bigger payoff (5x5)
const ELECTRIC_REACH = 1;        // battery->metal->explosive discharge reach
function deriveConfig(){
  return { radius: BOMB_RADIUS, fuelRadius: FUEL_GAS_RADIUS };
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
function igniteAround(fireMap, x, y){
  const cells = [{x,y}, ...orthNeighbors(x,y)];
  for (const c of cells){
    if (c.x<0||c.y<0||c.x>=COLS||c.y>=ROWS) continue;
    fireMap.set(c.x+','+c.y, 1);
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
function processElectric(board, seeds){
  const discharges = [], triggeredExplosions = [], consumed = [];
  const reach = ELECTRIC_REACH;
  for (const seed of seeds){
    const startMetals = orthNeighbors(seed.x,seed.y).filter(p=>inBounds(p) && board[p.y][p.x] && board[p.y][p.x].type==='METAL');
    if (board[seed.y] && board[seed.y][seed.x] && board[seed.y][seed.x].type==='BATTERY'){
      board[seed.y][seed.x]=null;
      consumed.push({x:seed.x, y:seed.y, type:'BATTERY'});
    }
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
      consumed.push({x:t.x, y:t.y, type:t.type});
      triggeredExplosions.push({x:t.x, y:t.y, radius: t.type==='EXPLOSIVE' ? EXPLOSIVE_RADIUS : FUEL_GAS_RADIUS});
    }
  }
  return {discharges, triggeredExplosions, consumed};
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
        const r = cell.type==='EXPLOSIVE' ? EXPLOSIVE_RADIUS : cfg.fuelRadius;
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
      const strongMap = new Map();
      for (const src of sources){
        const {strong} = computeBlastCells(board, src.x, src.y, src.radius, 0);
        for (const c of strong) strongMap.set(c.x+','+c.y, c);
      }
      let destroyedThisWave = 0;
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
            igniteAround(fireMap, c.x, c.y);
          } else if (cell.type==='EXPLOSIVE'){
            queue.push({x:c.x,y:c.y,radius:EXPLOSIVE_RADIUS});
          } else if (cell.type==='GAS'){
            const dwave = wave+2;
            delayed[dwave] = delayed[dwave] || [];
            delayed[dwave].push({x:c.x,y:c.y,radius:cfg.fuelRadius});
          } else if (cell.type==='BATTERY'){
            battDirectSeeds.push({x:c.x,y:c.y});
          }
        }
        if (!fast) hitCells.push({x:c.x,y:c.y,type:cell.type,destroyed:cell.hp<=0,hpLeft:Math.max(cell.hp,0)});
      }
      maxSimultaneous = Math.max(maxSimultaneous, destroyedThisWave);
      if (!fast) steps.push({kind:'explosion', sources, hits:hitCells, destroyed:destroyedList, chainStart, board:cloneBoard(board)});

      if (battDirectSeeds.length){
        const er = processElectric(board, battDirectSeeds);
        for (const c of er.consumed){
          totalDestroyed++; destroyedTypes.add(c.type);
          destroyedList.push({x:c.x, y:c.y, type:c.type, order:++destroyOrder});
        }
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
        const er = processElectric(board, seeds);
        for (const c of er.consumed){
          totalDestroyed++; destroyedTypes.add(c.type); destroyOrder++;
        }
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
function pickMission(stage, search, rng){
  const tier = missionTierForStage(stage);
  const best = search.best.stats;
  // Sample within the tier's ratio band instead of always taking its midpoint: since the
  // best candidate is now (thanks to the full-clear guarantee) reliably ~100% destroy rate
  // on almost every board, a fixed midpoint ratio would derive the exact same rounded
  // threshold stage after stage, making otherwise-different boards feel copy-pasted.
  const ratio = rng ? tier.ratio[0] + rng()*(tier.ratio[1]-tier.ratio[0]) : avg(tier.ratio);
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
function buildFallbackBoard(stage, rng, cfg){
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
  // even the safety-net board should resist an oversized blast radius when it can
  narrowLineOfSight(board, stage, rng, cfg);
  return board;
}
// Every stage must have at least one placement that clears the WHOLE board (not just the
// search's own best-so-far) - otherwise "100%" on the result screen never means a literal
// full clear. At a 9-cell blast radius, pure random placement almost never happens to be
// fully connected (measured: <1% of random boards for mid/late stages), so rather than
// rejection-sampling for it, patch the gap directly: find the best candidate's actual
// blast coverage, then bridge the shortest path from that coverage to whatever object it
// missed with FUEL stepping stones (spaced within FUEL_GAS_RADIUS of each other so each
// one chain-triggers the next), and repeat until nothing is left out of reach.
// WALL cells split a column into independent gravity segments. An object that ends up
// "remaining" is reported at its post-simulation (post-gravity) resting position, but
// bridging a static stepping-stone to THAT coordinate can get silently undone: something
// higher up in the same segment falls into the very cell we just fixed, after the chain
// has already finished cascading, and is never revisited. Targeting the topmost object in
// that same wall-bounded segment instead means it gets hit before gravity ever moves it.
function topOfWallSegment(board, x, fromY){
  let top = 0;
  for (let y=fromY; y>=0; y--){
    if (board[y][x] && board[y][x].type==='WALL'){ top = y+1; break; }
  }
  for (let y=top; y<=fromY; y++){
    if (board[y][x] && board[y][x].type!=='WALL') return {x, y};
  }
  return {x, y:fromY};
}
function clearWallSegment(board, x, fromY){
  let top = 0;
  for (let y=fromY; y>=0; y--){
    if (board[y][x] && board[y][x].type==='WALL'){ top = y+1; break; }
  }
  let bottom = ROWS-1;
  for (let y=fromY; y<ROWS; y++){
    if (board[y][x] && board[y][x].type==='WALL'){ bottom = y-1; break; }
  }
  for (let y=top; y<=bottom; y++){
    if (board[y][x] && board[y][x].type!=='WALL') board[y][x] = null;
  }
}
// Repair the CANDIDATE closest to a full clear already (highest destroyCount), not
// exhaustiveSearch's own "best" (picked by score) - the two can differ, and bridging
// toward the wrong one wastes iterations while never actually satisfying the
// "some placement reaches exactly 100%" requirement the caller checks for.
function closestToFullClear(search){
  let target = search.results[0];
  for (const r of search.results) if (r.stats.destroyCount > target.stats.destroyCount) target = r;
  return target;
}
function ensureFullClearReachable(board, cfg){
  const BRIDGE_BUDGET = 40;
  const TOTAL_BUDGET = 80;
  let guard = TOTAL_BUDGET;
  while (guard-- > 0){
    const search = exhaustiveSearch(board, cfg);
    if (!search.best) return;
    if (search.results.some(r => r.stats.fullClear)) return;
    const target = closestToFullClear(search);
    const pos = {x:target.x, y:target.y};
    // exhaustiveSearch runs in fast mode, which never populates remainingObjects/steps -
    // get an accurate remaining-object list by re-simulating this candidate in full.
    // WALL is intentionally indestructible and already excluded from fullClear's own
    // totalDestructible count, so exclude it here too - otherwise the "closest orphan"
    // search can spend every iteration chasing decorative walls instead of the actual
    // stragglers blocking full clear.
    const full = simulate(board, pos, cfg, {fast:false});
    const remaining = (full.stats.remainingObjects||[]).filter(o => o.type !== 'WALL');
    if (!remaining.length) return; // shouldn't happen given fullClear was false, but be safe
    if (guard >= TOTAL_BUDGET-BRIDGE_BUDGET){
      let orphan = remaining[0], bestDist = Infinity;
      for (const o of remaining){
        const d = Math.max(Math.abs(o.x-pos.x), Math.abs(o.y-pos.y));
        if (d < bestDist){ bestDist = d; orphan = o; }
      }
      const bridgeTo = topOfWallSegment(board, orphan.x, orphan.y);
      const dx = bridgeTo.x-pos.x, dy = bridgeTo.y-pos.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const hops = Math.max(1, Math.ceil(dist/FUEL_GAS_RADIUS));
      for (let i=1; i<=hops; i++){
        const t = i/hops;
        const x = Math.round(pos.x+dx*t), y = Math.round(pos.y+dy*t);
        if (x<0||y<0||x>=COLS||y>=ROWS) continue;
        board[y][x] = makeCell('FUEL');
      }
    } else {
      // Bridging budget spent: some WALL/gravity configurations can keep producing new
      // stragglers faster than they get bridged. Guarantee forward progress instead by
      // deleting every remaining object outright - this strictly shrinks the board each
      // pass, so it always terminates. `remaining` reports each object's post-simulation
      // (post-gravity) resting position, which the STATIC board may not even have
      // anything at (it fell there from higher up) - deleting there would be a no-op, so
      // delete the topmost object in that same wall-bounded column segment instead, same
      // as the bridge phase does. The promise that some placement reaches exactly 100%
      // must never fail, even at the cost of a few decorative objects on a rare board.
      for (const o of remaining) clearWallSegment(board, o.x, o.y);
    }
  }
}
const MAX_GENERATION_ATTEMPTS = 50;
function generateStage(stage, cfg, runSeed){
  const attempts = [];
  let chosen = null;
  for (let i=0; i<MAX_GENERATION_ATTEMPTS; i++){
    const seed = hashSeed(runSeed+'|stage'+stage+'|attempt'+i);
    const rng = mulberry32(seed);
    const board = generateBoardRaw(stage, rng, cfg);
    ensureFullClearReachable(board, cfg);
    const search = exhaustiveSearch(board, cfg);
    if (!search.best){ attempts.push({seed, ok:false, reason:'空きマスなし'}); continue; }
    const mission = pickMission(stage, search, rng);
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
    const board = buildFallbackBoard(stage, rng, cfg);
    ensureFullClearReachable(board, cfg);
    const search = exhaustiveSearch(board, cfg);
    const mission = pickMission(stage, search, rng);
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

let DEBUG_MODE = false;

const run = {
  board: null, bombPos: null,
  mission: null, search: null, genDebug: null,
  stageFailCount: 0, lastAttempt: null, tipsHintArea: null,
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
  const cfg = deriveConfig();
  ctx.save();
  ctx.strokeStyle = COLOR.text2;
  ctx.lineWidth = 1;
  ctx.setLineDash([4,4]);
  ctx.globalAlpha = 0.4;
  const r = cfg.radius;
  ctx.strokeRect((x-r)*cellPx+0.5, (y-r)*cellPx+0.5, (2*r+1)*cellPx, (2*r+1)*cellPx);
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
  const cfg = deriveConfig();
  const result = simulate(run.board, run.bombPos, cfg);
  await playSteps(result.steps);
  currentBoard = result.finalBoard;
  camScaleTarget = 1;
  await new Promise(r => setTimeout(r, 260));
  resetPlaybackState();
  showResult(result.stats, result.eventLog);
}

/* ===================== SAVE / CAMPAIGN STATE ===================== */
// v2: dropped the whole bomb-upgrade/XP/level system - the bomb's power is fixed for
// every stage, so old saves (which carried playerLevel/experience/bombConfig.levels)
// are treated as incompatible and the player starts a fresh campaign.
const SAVE_VERSION = 2;
const SAVE_KEY = 'oneexplosion_save_v1';
const CHAPTER_SIZE = 10;
const CHAPTER_COUNT = TOTAL_STAGES / CHAPTER_SIZE;
function freshGameState(){
  return {
    saveVersion: SAVE_VERSION,
    currentStage: 1,
    unlockedStage: 1,
    stageProgress: {},
    discoveredObjects: ['BLOCK'],
    seenTutorials: [],
    totalScore: 0,
    bestChain: 0,
    settings: {},
    runSeed: Date.now() ^ Math.floor(Math.random()*0xffffffff),
  };
}
function hasSaveData(){
  try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
}
function saveGame(){
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(game)); } catch (e) {}
}
function loadGame(){
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || data.saveVersion !== SAVE_VERSION) return null;
    return {
      saveVersion: SAVE_VERSION,
      currentStage: data.currentStage || 1,
      unlockedStage: data.unlockedStage || 1,
      stageProgress: (data.stageProgress && typeof data.stageProgress==='object') ? data.stageProgress : {},
      discoveredObjects: Array.isArray(data.discoveredObjects) ? data.discoveredObjects : ['BLOCK'],
      seenTutorials: Array.isArray(data.seenTutorials) ? data.seenTutorials : [],
      totalScore: data.totalScore || 0,
      bestChain: data.bestChain || 0,
      settings: data.settings || {},
      runSeed: data.runSeed || (Date.now() ^ Math.floor(Math.random()*0xffffffff)),
    };
  } catch (e) {
    try { localStorage.removeItem(SAVE_KEY); } catch (e2) {}
    return null;
  }
}
let game = freshGameState();

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
function flattenBoardTypes(board){
  const set = new Set();
  for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++){ if (board[y][x]) set.add(board[y][x].type); }
  return Array.from(set);
}
function refreshLegendDiscovery(){
  document.querySelectorAll('.legend-item').forEach(item => {
    const type = item.dataset.part;
    const known = type==='BLOCK' || game.discoveredObjects.includes(type);
    item.classList.toggle('undiscovered', !known);
    const info = LEGEND_ITEMS.find(l=>l.type===type);
    item.querySelector('.legend-name').textContent = known ? (info ? info.label : type) : '???';
  });
}
function pad2(n){ return String(n).padStart(2,'0'); }
function refreshHUD(){
  document.getElementById('hud-stage').textContent = pad2(game.currentStage);
}
function updateMissionBanner(){
  document.getElementById('mission-text').textContent = run.mission ? run.mission.label : '';
}
function updateBombStatsPanel(){
  const cfg = deriveConfig();
  document.getElementById('bomb-stats').innerHTML = `<span class="chip">RANGE <b>${cfg.radius}</b></span>`;
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
  const reach = ELECTRIC_REACH;
  let bestDist = Infinity;
  let farBattery = null;
  for (const b of battery) for (const m of metal){
    const d = Math.abs(b.x-m.x)+Math.abs(b.y-m.y);
    if (d<bestDist){ bestDist = d; farBattery = b; }
  }
  if (bestDist === reach+1){
    return { text:'この電池は金属まであと1マス届きませんでした', area: farBattery };
  }
  const wasBlocked = (eventLog||[]).some(step => step.kind==='explosion' && step.hits.some(h=>h.type==='WALL'));
  if (wasBlocked){
    return { text:'爆風が壁に阻まれました', area:null };
  }
  const leftover = remainingObjects.filter(o=>isExplosiveFamily(o.type));
  if (leftover.length){
    // report the leftover object farthest from the board center - usually the "missed corner"
    let far = leftover[0], farD = -1;
    for (const o of leftover){ const d = Math.abs(o.x-3.5)+Math.abs(o.y-3.5); if (d>farD){ farD=d; far=o; } }
    return { text:'誘爆しなかった爆薬・燃料・ガスが残っています', area: far };
  }
  return { text:'連鎖がここで止まりました', area:null };
}

/* ---- mission-aware, star-based result screen ---- */
function showResult(stats, eventLog){
  resetPlaybackState();
  uiState = 'IDLE';
  showScreen('screen-result');

  const stage = game.currentStage;
  const key = String(stage);
  const progress = game.stageProgress[key];
  const cfg = deriveConfig();
  const maxDestroy = run.search ? run.search.maxDestroyCount : stats.destroyCount;
  const rate = explosionRateFor(stats.destroyCount, maxDestroy);
  const stars = starsForRate(rate);
  const missionEval = evaluateMission(stats, run.mission);

  progress.attempts = (progress.attempts||0) + 1;
  if (rate > (progress.bestExplosionRate||0)) progress.bestExplosionRate = rate;
  if (stars > (progress.stars||0)) progress.stars = stars;
  if (missionEval.ok) progress.missionCleared = true;
  if (stats.score > (progress.bestScore||0)) progress.bestScore = stats.score;
  if (stats.chainCount > (progress.bestChain||0)) progress.bestChain = stats.chainCount;

  game.totalScore += stats.score;
  if (stats.chainCount > game.bestChain) game.bestChain = stats.chainCount;
  if (stars >= 1 && stage < TOTAL_STAGES && game.unlockedStage < stage+1) game.unlockedStage = stage+1;

  const stopReason = stars < 1 ? analyzeStopReason(stats.remainingObjects||[], cfg, eventLog) : null;
  if (stars < 1){
    progress.failCount = (progress.failCount||0) + 1;
    run.stageFailCount = progress.failCount;
  }
  run.lastAttempt = {
    bombPos: run.bombPos, rate, chainCount: stats.chainCount,
    remainingObjects: stats.remainingObjects||[], missedArea: stopReason ? stopReason.area : null,
  };
  progress.lastAttempt = run.lastAttempt;

  saveGame();

  const statusEl = document.getElementById('result-status');
  const cleared = stars >= 1;
  statusEl.textContent = missionEval.ok ? 'MISSION COMPLETE' : (cleared ? 'STAGE CLEAR' : 'MISSION FAILED');
  statusEl.classList.toggle('ok', missionEval.ok || cleared);
  statusEl.classList.toggle('fail', !cleared);

  document.querySelectorAll('#result-stars .star').forEach((el,i)=>{ el.classList.toggle('lit', i < stars); });
  document.getElementById('res-rate').textContent = Math.round(rate*100)+'%';
  document.getElementById('res-destroy').textContent = stats.destroyCount;
  document.getElementById('res-chain').textContent = '×'+stats.chainCount;
  document.getElementById('res-electric').textContent = '×'+stats.electricCount;
  document.getElementById('res-burst').textContent = stats.maxSimultaneous;

  document.getElementById('result-mission-line').textContent =
    missionEval.parts.map(p => `${p.label} → ${p.actual}${p.type==='DESTROY'?'%':''}`).join('   ');
  const badge = document.getElementById('result-mission-badge');
  badge.textContent = missionEval.ok ? '達成' : '未達成';
  badge.classList.toggle('ok', missionEval.ok);

  const hintEl = document.getElementById('result-fail-hint');
  if (!cleared){
    hintEl.textContent = 'CHAIN STOP\n' + stopReason.text;
    hintEl.hidden = false;
  } else {
    hintEl.hidden = true;
  }

  document.getElementById('btn-result-next').disabled = !cleared;
  refreshHUD();
  refreshDebugPanel();
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
  if (!game.seenTutorials.includes(currentTutorialType)) game.seenTutorials.push(currentTutorialType);
  if (!game.discoveredObjects.includes(currentTutorialType)) game.discoveredObjects.push(currentTutorialType);
  saveGame();
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
  const newParts = stagePartsIntroducedAt(game.currentStage).filter(p => p !== 'BLOCK');
  const toShow = newParts.filter(p => boardHasType(run.board, p) && !game.seenTutorials.includes(p));
  if (!toShow.length) return;
  tutorialQueue = toShow.slice();
  nextTutorial();
}

/* ---- staged TIPS ---- */
let tipsStage = 0;
let tipsIdleTimer = null;
function armTipsIdleTimer(){
  clearTimeout(tipsIdleTimer);
  if (run.stageFailCount >= 2){ showTipsToast(); return; } // toast already earned via failures
  tipsIdleTimer = setTimeout(() => { showTipsToast(); }, 25000);
}
function showTipsToast(){
  if (uiState !== 'SELECT') return;
  document.getElementById('tips-toast').hidden = false;
}
function buildTipsText(level){
  const best = run.search && (run.search.bestSolving || run.search.best);
  if (level === 1){
    const family = ['FUEL','EXPLOSIVE','GAS'].find(t => boardHasType(run.board, t));
    return family ? `${PART_INFO[family].name}の近くから連鎖を始めてみよう` : '爆風が直接当たる部品の数を確認してから置いてみよう';
  }
  if (level === 2){
    const la = run.lastAttempt;
    if (la && la.missedArea){
      const area = la.missedArea.x < 4 ? '左' : '右';
      const vArea = la.missedArea.y < 4 ? '上' : '下';
      return `${vArea}${area}側のエリアまで爆風が届いていません`;
    }
    return '盤面の隅まで連鎖が伸びていないエリアがないか確認しよう';
  }
  // level 3: show a coarse quadrant with viable placements, without the exact cell
  if (best){
    const area = best.x < 4 ? '左' : '右';
    const vArea = best.y < 4 ? '上' : '下';
    return `${vArea}${area}側の範囲に有効な配置があります`;
  }
  return '盤面全体を見渡して、部品が密集している場所を探そう';
}
function openTips(){
  tipsStage = Math.min(3, tipsStage+1);
  document.getElementById('tips-toast').hidden = true;
  document.getElementById('tips-stage-label').textContent = 'TIPS '+tipsStage;
  document.getElementById('tips-text').textContent = buildTipsText(tipsStage);
  document.getElementById('tips-overlay').hidden = false;
  if (tipsStage >= 3 && run.search){
    const solveSet = run.search.results.filter(r => starsForRate(explosionRateFor(r.stats.destroyCount, run.search.maxDestroyCount)) >= 1);
    run.tipsHintArea = solveSet;
  }
}
function dismissTips(){
  document.getElementById('tips-overlay').hidden = true;
}

/* ---- repeated-failure hint ---- */
function glowKeyParts(){
  const best = run.search && (run.search.bestSolving || run.search.best);
  if (!best) return;
  const cfg = deriveConfig();
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
  lines.push(`STAGE ${game.currentStage}   seed=${gd.seed}`);
  lines.push(`fallback=${gd.fallback}   attempt=${gd.attemptIndex+1}/${MAX_GENERATION_ATTEMPTS}`);
  lines.push(`empties=${run.search.empties}   best=${run.search.best.stats.score}   median=${run.search.median}   maxDestroy=${run.search.maxDestroyCount}`);
  lines.push(`mission: ${run.mission.label}`);
  const solveCount = run.search.results.filter(r=>evaluateMission(r.stats, run.mission).ok).length;
  const star1Count = run.search.results.filter(r=>starsForRate(explosionRateFor(r.stats.destroyCount, run.search.maxDestroyCount))>=1).length;
  lines.push(`star1=${star1Count}/${run.search.empties}   missionSolve=${solveCount}/${run.search.empties}`);
  lines.push(`top-score cell=(${run.search.best.x},${run.search.best.y})`);
  if (run.search.bestSolving) lines.push(`best solving cell=(${run.search.bestSolving.x},${run.search.bestSolving.y}) score=${run.search.bestSolving.stats.score}`);
  lines.push(`stageFailCount=${run.stageFailCount}`);
  lines.push('');
  lines.push('-- attempts (last 12) --');
  gd.attempts.slice(-12).forEach((a,i)=>{
    lines.push(`#${i} ${a.ok?'OK':'reject'}  ${a.reason}  solve=${a.solveCount||0}`);
  });
  el.textContent = lines.join('\n');
}

/* ---- stage loading (generate once, cache forever) ---- */
function peekStage(stageNum){
  const key = String(stageNum);
  let progress = game.stageProgress[key];
  if (!progress){
    const cfg = deriveConfig();
    const chosen = generateStage(stageNum, cfg, game.runSeed);
    progress = {
      stageNumber: stageNum, seed: chosen.seed, boardData: chosen.board, mission: chosen.mission,
      maxDestroyCountAtGeneration: chosen.search.maxDestroyCount,
      bestExplosionRate: 0, stars: 0, missionCleared: false, bestScore: 0, bestChain: 0,
      attempts: 0, failCount: 0, unlocked: stageNum <= game.unlockedStage, lastAttempt: null,
    };
    game.stageProgress[key] = progress;
    saveGame();
  }
  return progress;
}
function loadStage(stageNum){
  const cfg = deriveConfig();
  const progress = peekStage(stageNum);
  run.board = progress.boardData;
  run.mission = progress.mission;
  run.search = exhaustiveSearch(run.board, cfg);
  run.search.bestSolving = run.search.results.filter(r=>evaluateMission(r.stats, run.mission).ok).sort((a,b)=>b.stats.score-a.stats.score)[0] || run.search.best;
  run.genDebug = { seed: progress.seed, attempts: [], fallback: false, attemptIndex: 0 };
  run.stageFailCount = progress.failCount || 0;
  run.bombPos = null;
  run.lastAttempt = progress.lastAttempt || null;
  run.tipsHintArea = null;
  tipsStage = 0;
  game.currentStage = stageNum;
  currentBoard = run.board;
  saveGame();
}
function enterStageScreen(){
  resetPlaybackState();
  uiState = 'SELECT';
  showScreen('screen-game');
  requestAnimationFrame(resizeCanvas);
  refreshHUD();
  updateMissionBanner();
  updateBombStatsPanel();
  document.getElementById('direct-hit').hidden = true;
  document.getElementById('retry-marker-label').hidden = true;
  document.getElementById('tips-toast').hidden = true;
  document.getElementById('btn-blow').disabled = true;
  refreshDebugPanel();
  armTipsIdleTimer();
  setTimeout(showTutorialIfNeeded, 200);
}
function goToStage(stageNum){
  loadStage(stageNum);
  enterStageScreen();
}
function retrySameStage(){
  resetPlaybackState();
  const progress = game.stageProgress[String(game.currentStage)];
  run.board = progress.boardData;
  run.bombPos = null;
  currentBoard = run.board;
  uiState = 'SELECT';
  showScreen('screen-game');
  requestAnimationFrame(resizeCanvas);
  refreshHUD();
  updateMissionBanner();
  updateBombStatsPanel();
  document.getElementById('direct-hit').hidden = true;
  document.getElementById('btn-blow').disabled = true;
  showRetryMarker();
  armTipsIdleTimer();
  if (run.stageFailCount >= 2) setTimeout(glowKeyParts, 500);
}
function showRetryMarker(){
  const el = document.getElementById('retry-marker-label');
  const la = run.lastAttempt;
  if (!la || !cellPx){ el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `前回 ${Math.round(la.rate*100)}% / CHAIN ×${la.chainCount}`;
  el.style.left = (la.bombPos.x*cellPx + cellPx/2) + 'px';
  el.style.top = (la.bombPos.y*cellPx) + 'px';
}
function showFinal(){
  showScreen('screen-final');
  document.getElementById('final-stages').textContent = game.currentStage+' / '+TOTAL_STAGES;
  document.getElementById('final-best-chain').textContent = game.bestChain;
  document.getElementById('final-score').textContent = '0';
  animateCount(document.getElementById('final-score'), game.totalScore, 900);
}
function startNewCampaign(){
  game = freshGameState();
  saveGame();
  goToStage(1);
}
function continueCampaign(){
  const loaded = loadGame();
  game = loaded || freshGameState();
  goToStage(game.currentStage);
}

/* ---- title / stage select ---- */
function refreshTitleButtons(){
  const has = hasSaveData();
  document.getElementById('btn-continue').hidden = !has;
  document.getElementById('btn-stage-select').hidden = !has;
}
let currentChapter = 1;
function showStageSelect(){
  const loaded = loadGame();
  if (loaded) game = loaded;
  showScreen('screen-stage-select');
  document.getElementById('stgsel-score').textContent = game.totalScore.toLocaleString();
  currentChapter = Math.min(CHAPTER_COUNT, Math.max(1, Math.ceil(game.currentStage/CHAPTER_SIZE)));
  renderChapterTabs();
  renderStageGrid();
}
function renderChapterTabs(){
  const wrap = document.getElementById('chapter-tabs');
  wrap.innerHTML = '';
  for (let c=1;c<=CHAPTER_COUNT;c++){
    const start = (c-1)*CHAPTER_SIZE+1;
    const btn = document.createElement('button');
    btn.className = 'chapter-tab' + (c===currentChapter?' active':'') + (start>game.unlockedStage?' locked':'');
    btn.textContent = 'CH'+c;
    btn.addEventListener('click', () => { currentChapter=c; renderChapterTabs(); renderStageGrid(); });
    wrap.appendChild(btn);
  }
}
function renderStageGrid(){
  const wrap = document.getElementById('stage-grid');
  wrap.innerHTML = '';
  const start = (currentChapter-1)*CHAPTER_SIZE+1;
  for (let i=0;i<CHAPTER_SIZE;i++){
    const stageNum = start+i;
    const progress = game.stageProgress[String(stageNum)];
    const unlocked = stageNum <= game.unlockedStage;
    const tile = document.createElement('div');
    tile.className = 'stage-tile' + (unlocked?'':' locked') + (stageNum===game.currentStage?' current':'');
    if (unlocked){
      const stars = progress ? progress.stars : 0;
      const starsHtml = [1,2,3].map(n=>`<span class="${n<=stars?'lit':''}">★</span>`).join('');
      const bestHtml = (progress && progress.bestExplosionRate > 0) ? `<span class="stage-best mono">${Math.round(progress.bestExplosionRate*100)}%</span>` : '';
      tile.innerHTML = `<span class="stage-num mono">${pad2(stageNum)}</span><span class="stage-stars">${starsHtml}</span><span class="stage-mission-dot ${progress&&progress.missionCleared?'ok':''}"></span>${bestHtml}`;
      tile.addEventListener('click', () => { goToStage(stageNum); });
    } else {
      tile.innerHTML = `<span class="stage-num mono">🔒</span>`;
    }
    wrap.appendChild(tile);
  }
}

/* ---- in-game help overlay ---- */
let helpReturnScreen = 'screen-title';
function showHelp(fromGame){
  helpReturnScreen = fromGame ? 'screen-game' : 'screen-title';
  showScreen('screen-help');
  document.querySelectorAll('.help-tab').forEach((t,i)=>t.classList.toggle('active', i===0));
  document.getElementById('help-panel-status').hidden = false;
  document.getElementById('help-panel-objects').hidden = true;
  document.getElementById('help-panel-tips').hidden = true;
  document.getElementById('help-mission').textContent = run.mission ? run.mission.label : '—';
  const cfg = deriveConfig();
  document.getElementById('help-bomb').textContent = `RANGE ${cfg.radius}`;
  const objWrap = document.getElementById('help-panel-objects');
  objWrap.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'help-objects-grid';
  for (const type of game.discoveredObjects){
    const info = PART_INFO[type];
    if (!info) continue;
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<canvas class="legend-icon" width="72" height="72"></canvas><span class="legend-name">${LEGEND_ITEMS.find(l=>l.type===type)?.label||type}</span>`;
    grid.appendChild(item);
    requestAnimationFrame(() => {
      const c = item.querySelector('canvas');
      drawIconAt(c.getContext('2d'), makeCell(type), 36, 36, 72);
    });
  }
  objWrap.appendChild(grid);
}
function hideHelp(){
  showScreen(helpReturnScreen);
  if (helpReturnScreen === 'screen-game') gameScreenActive = true;
}

/* ---- direct-hit preview (before BLOW; no chain/final result shown) ---- */
function updateDirectHitPreview(){
  const el = document.getElementById('direct-hit');
  if (!run.bombPos){ el.hidden = true; return; }
  const cfg = deriveConfig();
  const { strong } = computeBlastCells(run.board, run.bombPos.x, run.bombPos.y, cfg.radius, 0);
  const counts = {};
  for (const c of strong){
    const cell = run.board[c.y][c.x];
    if (cell && cell.type!=='WALL') counts[cell.type] = (counts[cell.type]||0)+1;
  }
  const rows = Object.entries(counts).map(([t,n]) => `<div class="dh-row"><span>${PART_INFO[t].name}</span><span class="mono">×${n}</span></div>`).join('');
  el.innerHTML = `<div class="dh-title">DIRECT HIT</div>${rows || '<div class="dh-row"><span>—</span></div>'}`;
  el.hidden = false;
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
  document.getElementById('retry-marker-label').hidden = true;
  updateDirectHitPreview();
}
function onBlowClick(){
  if (!run.bombPos || uiState!=='SELECT') return;
  document.getElementById('direct-hit').hidden = true;
  document.getElementById('tips-toast').hidden = true;
  clearTimeout(tipsIdleTimer);
  runBlow();
}
function onResultNext(){
  const stage = game.currentStage;
  if (stage >= TOTAL_STAGES) showFinal();
  else goToStage(stage+1);
}

/* ===================== INIT ===================== */
function initApp(){
  canvas = document.getElementById('board-canvas');
  ctx = canvas.getContext('2d');
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 60));

  /* -- title -- */
  document.getElementById('btn-continue').addEventListener('click', () => { AudioEngine.ensure(); continueCampaign(); });
  document.getElementById('btn-stage-select').addEventListener('click', () => { AudioEngine.ensure(); showStageSelect(); });
  document.getElementById('btn-newgame').addEventListener('click', () => {
    AudioEngine.ensure();
    if (hasSaveData()) showScreen('screen-newgame-confirm');
    else startNewCampaign();
  });
  document.getElementById('btn-newgame-confirm').addEventListener('click', () => startNewCampaign());
  document.getElementById('btn-newgame-cancel').addEventListener('click', () => showScreen('screen-title'));
  document.getElementById('btn-howto').addEventListener('click', () => { drawLegend(); showScreen('screen-howto'); });
  document.getElementById('btn-howto-back').addEventListener('click', () => { showScreen('screen-title'); });

  /* -- gameplay -- */
  document.getElementById('btn-blow').addEventListener('click', onBlowClick);
  document.getElementById('tutorial-dismiss').addEventListener('click', dismissTutorial);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  document.getElementById('btn-help').addEventListener('click', () => showHelp(true));
  document.getElementById('tips-toast').addEventListener('click', openTips);
  document.getElementById('tips-dismiss').addEventListener('click', dismissTips);

  /* -- result -- */
  document.getElementById('btn-result-next').addEventListener('click', onResultNext);
  document.getElementById('btn-result-retry').addEventListener('click', () => { AudioEngine.ensure(); retrySameStage(); });
  document.getElementById('btn-result-stgsel').addEventListener('click', () => { AudioEngine.ensure(); showStageSelect(); });


  /* -- stage select / help / final -- */
  document.getElementById('btn-stgsel-back').addEventListener('click', () => showScreen('screen-title'));
  document.getElementById('btn-help-back').addEventListener('click', hideHelp);
  document.querySelectorAll('.help-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.help-tab').forEach(t => t.classList.toggle('active', t===tab));
      const name = tab.dataset.tab;
      document.getElementById('help-panel-status').hidden = name!=='status';
      document.getElementById('help-panel-objects').hidden = name!=='objects';
      document.getElementById('help-panel-tips').hidden = name!=='tips';
    });
  });
  document.getElementById('btn-final-stgsel').addEventListener('click', () => { AudioEngine.ensure(); showStageSelect(); });

  DEBUG_MODE = /[?&]debug=1/.test(window.location.search);
  if (DEBUG_MODE){
    document.getElementById('debug-panel').style.display = 'block';
    window.__run = run;
    Object.defineProperty(window, '__game', { get: () => game, configurable: true });
    window.__debug = { getEffects: () => effects, getChainPopupText: () => document.getElementById('chain-popup').textContent };
  }

  const loaded = loadGame();
  if (loaded) game = loaded;
  refreshTitleButtons();
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
    BOMB_RADIUS, FUEL_GAS_RADIUS, EXPLOSIVE_RADIUS, ensureFullClearReachable,
  };
}

})();
