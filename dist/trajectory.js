// Simulation geometry only: no measured obstacles or calibrated travel limits.
// Keep this planner equivalent to backend/trajectory.py.
const EPS = 1e-7;
export const CABIN_TOP_MM = 31; // The rendered cabin starts at z=1, height=30.

function inside(p, r) {
  return r[0] + EPS < p.x && p.x < r[2] - EPS && r[1] + EPS < p.y && p.y < r[3] - EPS;
}
function clear(a, b, rectangles) {
  for (const [left, bottom, right, top] of rectangles) {
    if (Math.abs(a.x - b.x) < EPS) {
      if (left + EPS < a.x && a.x < right - EPS && Math.min(a.y, b.y) < top - EPS && Math.max(a.y, b.y) > bottom + EPS) return false;
    } else if (bottom + EPS < a.y && a.y < top - EPS && Math.min(a.x, b.x) < right - EPS && Math.max(a.x, b.x) > left + EPS) return false;
  }
  return true;
}
function distance(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z); }
function simplify(points) {
  const result = [];
  for (const p of points) {
    if (result.length && distance(result.at(-1), p) < EPS) continue;
    if (result.length >= 2) {
      const a = result.at(-2), b = result.at(-1);
      if (['x', 'y', 'z'].some(axis => ['x', 'y', 'z'].filter(k => k !== axis).every(k => Math.abs(a[k] - b[k]) < EPS && Math.abs(b[k] - p[k]) < EPS))) result.pop();
    }
    result.push({...p});
  }
  return result;
}

// Stable priority queue makes equal-cost routes deterministic in both runtimes.
class Queue {
  items = [];
  less(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }
  push(item) {
    let i = this.items.length;
    this.items.push(item);
    while (i) {
      const parent = (i - 1) >> 1;
      if (!this.less(item, this.items[parent])) break;
      this.items[i] = this.items[parent]; i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0], last = this.items.pop();
    if (!this.items.length) return first;
    let i = 0;
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.items.length && this.less(this.items[child + 1], this.items[child])) child++;
      if (!this.less(this.items[child], last)) break;
      this.items[i] = this.items[child]; i = child;
    }
    this.items[i] = last;
    return first;
  }
}

function horizontalPath(start, end, rectangles, maxX, maxY) {
  if (rectangles.some(r => inside(start, r) || inside(end, r))) return null;
  for (const corner of [{x:end.x, y:start.y}, {x:start.x, y:end.y}]) {
    if (clear(start, corner, rectangles) && clear(corner, end, rectangles)) return [start, corner, end];
  }
  const xs = [...new Set([0, maxX, start.x, end.x, ...rectangles.flatMap(r => [r[0], r[2]]).filter(x => x >= 0 && x <= maxX)])].sort((a,b) => a-b);
  const ys = [...new Set([0, maxY, start.y, end.y, ...rectangles.flatMap(r => [r[1], r[3]]).filter(y => y >= 0 && y <= maxY)])].sort((a,b) => a-b);
  const ny = ys.length, source = xs.indexOf(start.x) * ny + ys.indexOf(start.y), target = xs.indexOf(end.x) * ny + ys.indexOf(end.y);
  const point = n => ({x:xs[Math.floor(n / ny)], y:ys[n % ny]});
  const heuristic = p => Math.abs(p.x - end.x) + Math.abs(p.y - end.y);
  const costs = new Map([[source, 0]]), parents = new Map(), closed = new Set(), pending = new Queue();
  let order = 0;
  pending.push([heuristic(start), order, source]);
  while (pending.items.length) {
    let current = pending.pop()[2];
    if (closed.has(current)) continue;
    if (current === target) {
      const path = [point(current)];
      while (parents.has(current)) { current = parents.get(current); path.push(point(current)); }
      return path.reverse();
    }
    closed.add(current);
    const ix = Math.floor(current / ny), iy = current % ny, a = point(current);
    for (const [dx, dy] of [[1,0], [0,1], [-1,0], [0,-1]]) {
      const xx = ix + dx, yy = iy + dy;
      if (xx < 0 || xx >= xs.length || yy < 0 || yy >= ny) continue;
      const neighbor = xx * ny + yy, b = point(neighbor);
      if (closed.has(neighbor) || !clear(a, b, rectangles)) continue;
      const cost = costs.get(current) + Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (cost < (costs.get(neighbor) ?? Infinity) - EPS) {
        costs.set(neighbor, cost); parents.set(neighbor, current);
        pending.push([cost + heuristic(b), ++order, neighbor]);
      }
    }
  }
  return null;
}

export function planTrajectory(config, start, end, obstacles, options = {}) {
  // Margin at cruise height; pickup/drop may touch the supporting pile or bed.
  const height = config.containerHeight;
  const clearance = options.clearanceMm ?? height * .2;
  const padding = options.horizontalClearanceMm ?? Math.min(5, config.containerWidth * .1);
  const ceiling = options.maxHeightMm ?? config.levels * height + height * 1.2;
  if ([clearance, padding, ceiling].some(v => !Number.isFinite(v) || v < 0)) throw Error('Marges et hauteur de trajectoire invalides.');
  const maxX = config.length - config.containerLength, maxY = config.width - config.containerWidth;
  for (const p of [start, end]) {
    if (['x','y','z'].some(k => !Number.isFinite(p[k])) || p.x < 0 || p.x > maxX || p.y < 0 || p.y > maxY || p.z < 0 || p.z > ceiling) throw Error('Prise ou dépôt hors de l’espace de simulation.');
    for (const o of obstacles) {
      if (inside(p, [o.x-config.containerLength, o.y-config.containerWidth, o.x+o.length, o.y+o.width]) && p.z < o.top-EPS) throw Error('Prise ou dépôt en collision avec un obstacle connu.');
    }
  }
  const minimum = Math.max(start.z, end.z) + clearance;
  const heights = [...new Set([minimum, ...obstacles.map(o => o.top + clearance).filter(z => z >= minimum)])].sort((a,b) => a-b);
  const direct = Math.abs(start.x-end.x) + Math.abs(start.y-end.y);
  let best = null;
  for (const z of heights) {
    if (z > ceiling + EPS) continue;
    if (best && direct + 2*z-start.z-end.z >= best.routeLengthMm-EPS) break;
    const rectangles = obstacles.filter(o => z < o.top+clearance-EPS).map(o => [o.x-config.containerLength-padding, o.y-config.containerWidth-padding, o.x+o.length+padding, o.y+o.width+padding]);
    const path = horizontalPath(start, end, rectangles, maxX, maxY);
    if (!path) continue;
    const waypoints = simplify([start, ...path.map(p => ({x:p.x,y:p.y,z})), end]);
    const length = waypoints.slice(1).reduce((total,p,i) => total + distance(waypoints[i],p), 0);
    if (!best || length < best.routeLengthMm-EPS) best = {waypoints, routeLengthMm:length, cruiseHeightMm:z, clearanceMm:clearance, horizontalClearanceMm:padding, maxHeightMm:ceiling, planner:'rectilinear-a-star-v1'};
  }
  if (!best) throw Error('Aucune trajectoire libre dans la hauteur de simulation autorisée.');
  return best;
}

export function positionAlongRoute(waypoints, progress) {
  const lengths = waypoints.slice(1).map((p,i) => distance(waypoints[i],p));
  let remaining = lengths.reduce((a,b) => a+b, 0) * Math.max(0, Math.min(1, progress));
  for (let i=0; i<lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i] > EPS) {
      const t = remaining/lengths[i], a = waypoints[i], b = waypoints[i+1];
      return {x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t, z:a.z+(b.z-a.z)*t};
    }
    remaining -= lengths[i];
  }
  return {...waypoints.at(-1)};
}
