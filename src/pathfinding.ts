/**
 * Karahanlı RTS — İzometrik Izgara Yol Bulma ve Engel Kaçınma Sistemi (Pathfinding)
 *
 * 16x16 harita sınırları içinde, ağaç/kaynak karolarının içinden veya köşelerinden
 * geçmeden hedefe ulaşan 8 yönlü A* yol bulma ve görüş hattı (line-of-sight)
 * rota yumuşatma algoritmasını içerir.
 */

export interface GridCoord {
  col: number;
  row: number;
}

export interface GridObstacleQuery {
  cols: number;
  rows: number;
  isTileBlocked: (col: number, row: number) => boolean;
}

/** Ağaç gövdesi merkezinden korunacak minimum ızgara yarıçapı (köşe kesmeyi önler: 0.707 < 0.74 < 1.0) */
const OBSTACLE_CLEARANCE_RADIUS = 0.74;

/** Harita dış kenarından korunacak güvenli iç pay (karo birimi) */
const MAP_BORDER_MARGIN = 0.28;

interface AStarNode {
  col: number;
  row: number;
  g: number;
  f: number;
  parent: AStarNode | null;
}

const NEIGHBOR_DIRS: ReadonlyArray<{ dc: number; dr: number; cost: number }> = [
  { dc: 1, dr: 0, cost: 1 },
  { dc: -1, dr: 0, cost: 1 },
  { dc: 0, dr: 1, cost: 1 },
  { dc: 0, dr: -1, cost: 1 },
  { dc: 1, dr: 1, cost: Math.SQRT2 },
  { dc: 1, dr: -1, cost: Math.SQRT2 },
  { dc: -1, dr: 1, cost: Math.SQRT2 },
  { dc: -1, dr: -1, cost: Math.SQRT2 },
];

/**
 * Başlangıç (start) ve hedef (rawTarget) sürekli ızgara koordinatları arasında
 * engellere çarpmayan ve harita dışına çıkmayan akıcı bir yürüyüş rotası üretir.
 */
export function findSmoothGridPath(
  start: GridCoord,
  rawTarget: GridCoord,
  grid: GridObstacleQuery
): GridCoord[] {
  const clampedTarget = clampToSafeMapBounds(rawTarget, grid.cols, grid.rows);
  const startCell = findNearestWalkableCell(
    Math.round(start.col),
    Math.round(start.row),
    start,
    grid
  );
  if (!startCell) {
    return [];
  }

  const targetTileCol = Math.round(clampedTarget.col);
  const targetTileRow = Math.round(clampedTarget.row);

  let finalGoal: GridCoord;
  let goalCell: GridCoord | null;

  if (!isOutOfGrid(targetTileCol, targetTileRow, grid) && !grid.isTileBlocked(targetTileCol, targetTileRow)) {
    goalCell = { col: targetTileCol, row: targetTileRow };
    finalGoal = pushAwayFromAdjacentObstacles(clampedTarget, grid);
  } else {
    goalCell = findNearestWalkableCell(targetTileCol, targetTileRow, start, grid);
    if (!goalCell) {
      return [];
    }
    finalGoal = { col: goalCell.col, row: goalCell.row };
  }

  // Doğrudan engelsiz görüş hattı varsa tek düz çizgide yürü (açık bozkırda doğal hareket)
  if (hasClearLineOfSight(start, finalGoal, grid)) {
    if (Math.hypot(finalGoal.col - start.col, finalGoal.row - start.row) < 0.03) {
      return [];
    }
    return [finalGoal];
  }

  const cellPath = runAStar(startCell, goalCell, grid);
  if (cellPath.length === 0) {
    return [];
  }

  const rawWaypoints: GridCoord[] = [start];
  for (let i = 1; i < cellPath.length - 1; i++) {
    rawWaypoints.push(cellPath[i]);
  }
  if (
    cellPath.length > 1 &&
    (Math.abs(finalGoal.col - goalCell.col) > 0.02 ||
      Math.abs(finalGoal.row - goalCell.row) > 0.02)
  ) {
    rawWaypoints.push(goalCell);
  }
  rawWaypoints.push(finalGoal);

  return smoothWaypoints(rawWaypoints, grid);
}

function runAStar(
  start: GridCoord,
  goal: GridCoord,
  grid: GridObstacleQuery
): GridCoord[] {
  if (start.col === goal.col && start.row === goal.row) {
    return [goal];
  }

  const open: AStarNode[] = [];
  const bestG = new Map<number, number>();
  const closed = new Set<number>();

  const toKey = (c: number, r: number): number => r * grid.cols + c;
  const heuristic = (c: number, r: number): number => {
    const dx = Math.abs(c - goal.col);
    const dy = Math.abs(r - goal.row);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };

  const startNode: AStarNode = {
    col: start.col,
    row: start.row,
    g: 0,
    f: heuristic(start.col, start.row),
    parent: null,
  };

  open.push(startNode);
  bestG.set(toKey(start.col, start.row), 0);

  while (open.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) {
        bestIdx = i;
      }
    }

    const current = open.splice(bestIdx, 1)[0];
    const currentKey = toKey(current.col, current.row);
    if (closed.has(currentKey)) {
      continue;
    }

    if (current.col === goal.col && current.row === goal.row) {
      const result: GridCoord[] = [];
      let cur: AStarNode | null = current;
      while (cur) {
        result.push({ col: cur.col, row: cur.row });
        cur = cur.parent;
      }
      result.reverse();
      return result;
    }

    closed.add(currentKey);

    for (const dir of NEIGHBOR_DIRS) {
      const nc = current.col + dir.dc;
      const nr = current.row + dir.dr;
      if (isOutOfGrid(nc, nr, grid) || grid.isTileBlocked(nc, nr)) {
        continue;
      }

      // Çapraz geçişte her iki komşu kenar karosu da açık olmalı (ağaç köşesinden geçmeyi engeller)
      if (dir.dc !== 0 && dir.dr !== 0) {
        if (
          grid.isTileBlocked(current.col + dir.dc, current.row) ||
          grid.isTileBlocked(current.col, current.row + dir.dr)
        ) {
          continue;
        }
      }

      const nKey = toKey(nc, nr);
      if (closed.has(nKey)) {
        continue;
      }

      const tentativeG = current.g + dir.cost;
      const prevBest = bestG.get(nKey);
      if (prevBest !== undefined && tentativeG >= prevBest) {
        continue;
      }

      bestG.set(nKey, tentativeG);
      open.push({
        col: nc,
        row: nr,
        g: tentativeG,
        f: tentativeG + heuristic(nc, nr),
        parent: current,
      });
    }
  }

  return [];
}

/**
 * Gereksiz ızgara zikzaklarını temizleyerek engellere değmeyen en kısa kırık çizgiyi üretir.
 */
function smoothWaypoints(
  points: GridCoord[],
  grid: GridObstacleQuery
): GridCoord[] {
  if (points.length <= 2) {
    return points.slice(1);
  }

  const smoothed: GridCoord[] = [];
  let anchorIdx = 0;

  while (anchorIdx < points.length - 1) {
    let furthestIdx = anchorIdx + 1;
    for (let probe = points.length - 1; probe > anchorIdx + 1; probe--) {
      if (hasClearLineOfSight(points[anchorIdx], points[probe], grid)) {
        furthestIdx = probe;
        break;
      }
    }
    smoothed.push(points[furthestIdx]);
    anchorIdx = furthestIdx;
  }

  return smoothed;
}

function hasClearLineOfSight(
  a: GridCoord,
  b: GridCoord,
  grid: GridObstacleQuery
): boolean {
  const dist = Math.hypot(b.col - a.col, b.row - a.row);
  const steps = Math.max(2, Math.ceil(dist / 0.12));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const c = a.col + (b.col - a.col) * t;
    const r = a.row + (b.row - a.row) * t;

    if (
      c < -0.5 + MAP_BORDER_MARGIN - 0.02 ||
      c > grid.cols - 0.5 - MAP_BORDER_MARGIN + 0.02 ||
      r < -0.5 + MAP_BORDER_MARGIN - 0.02 ||
      r > grid.rows - 0.5 - MAP_BORDER_MARGIN + 0.02
    ) {
      return false;
    }

    const baseC = Math.round(c);
    const baseR = Math.round(r);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const tc = baseC + dc;
        const tr = baseR + dr;
        if (!isOutOfGrid(tc, tr, grid) && grid.isTileBlocked(tc, tr)) {
          if (Math.hypot(c - tc, r - tr) < OBSTACLE_CLEARANCE_RADIUS) {
            return false;
          }
        }
      }
    }
  }

  return true;
}

function pushAwayFromAdjacentObstacles(
  pt: GridCoord,
  grid: GridObstacleQuery
): GridCoord {
  let col = pt.col;
  let row = pt.row;
  const baseC = Math.round(col);
  const baseR = Math.round(row);

  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const tc = baseC + dc;
      const tr = baseR + dr;
      if (!isOutOfGrid(tc, tr, grid) && grid.isTileBlocked(tc, tr)) {
        const vx = col - tc;
        const vy = row - tr;
        const d = Math.hypot(vx, vy);
        const minSafe = OBSTACLE_CLEARANCE_RADIUS + 0.04;
        if (d < minSafe && d > 0.0001) {
          col = tc + (vx / d) * minSafe;
          row = tr + (vy / d) * minSafe;
        }
      }
    }
  }

  return clampToSafeMapBounds({ col, row }, grid.cols, grid.rows);
}

function findNearestWalkableCell(
  centerCol: number,
  centerRow: number,
  referenceFrom: GridCoord,
  grid: GridObstacleQuery
): GridCoord | null {
  const clampedC = Math.max(0, Math.min(grid.cols - 1, centerCol));
  const clampedR = Math.max(0, Math.min(grid.rows - 1, centerRow));

  if (!grid.isTileBlocked(clampedC, clampedR)) {
    return { col: clampedC, row: clampedR };
  }

  let best: GridCoord | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let radius = 1; radius <= 4; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) {
          continue;
        }
        const nc = clampedC + dc;
        const nr = clampedR + dr;
        if (isOutOfGrid(nc, nr, grid) || grid.isTileBlocked(nc, nr)) {
          continue;
        }
        const distGoal = Math.hypot(nc - centerCol, nr - centerRow);
        const distStart = Math.hypot(nc - referenceFrom.col, nr - referenceFrom.row);
        const score = distGoal * 10 + distStart * 0.25;
        if (score < bestScore) {
          bestScore = score;
          best = { col: nc, row: nr };
        }
      }
    }
    if (best) {
      return best;
    }
  }

  return null;
}

function clampToSafeMapBounds(
  pt: GridCoord,
  cols: number,
  rows: number
): GridCoord {
  const minC = -0.5 + MAP_BORDER_MARGIN;
  const maxC = cols - 0.5 - MAP_BORDER_MARGIN;
  const minR = -0.5 + MAP_BORDER_MARGIN;
  const maxR = rows - 0.5 - MAP_BORDER_MARGIN;
  return {
    col: Math.max(minC, Math.min(maxC, pt.col)),
    row: Math.max(minR, Math.min(maxR, pt.row)),
  };
}

function isOutOfGrid(
  col: number,
  row: number,
  grid: GridObstacleQuery
): boolean {
  return col < 0 || col >= grid.cols || row < 0 || row >= grid.rows;
}
