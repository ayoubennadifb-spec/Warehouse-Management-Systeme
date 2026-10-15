"""Rectilinear planning for the simulator, with a finite container footprint.

This model knows stored piles and parked trucks only. Its height limit and
clearances are simulation assumptions, not calibrated crane travel limits.
"""
import heapq
import math

EPS = 1e-7
CABIN_TOP_MM = 31  # Matches the illustrative cabin drawn at z=1 with height=30.


def _inside(point, rectangle):
    return (rectangle[0] + EPS < point['x'] < rectangle[2] - EPS
            and rectangle[1] + EPS < point['y'] < rectangle[3] - EPS)


def _clear(a, b, rectangles):
    """An axis-aligned segment must not enter a forbidden open rectangle."""
    for left, bottom, right, top in rectangles:
        if abs(a['x'] - b['x']) < EPS:
            if (left + EPS < a['x'] < right - EPS
                    and min(a['y'], b['y']) < top - EPS
                    and max(a['y'], b['y']) > bottom + EPS):
                return False
        elif (bottom + EPS < a['y'] < top - EPS
              and min(a['x'], b['x']) < right - EPS
              and max(a['x'], b['x']) > left + EPS):
            return False
    return True


def _distance(a, b):
    return sum(abs(a[axis] - b[axis]) for axis in ('x', 'y', 'z'))


def _simplify(points):
    result = []
    for point in points:
        if result and _distance(result[-1], point) < EPS:
            continue
        if len(result) >= 2:
            a, b = result[-2:]
            if any(all(abs(a[k] - b[k]) < EPS and abs(b[k] - point[k]) < EPS
                       for k in ('x', 'y', 'z') if k != axis)
                   for axis in ('x', 'y', 'z')):
                result.pop()
        result.append(dict(point))
    return result


def _horizontal_path(start, end, rectangles, max_x, max_y):
    if any(_inside(start, rect) or _inside(end, rect) for rect in rectangles):
        return None
    # An unobstructed L already attains the Manhattan lower bound.
    for corner in (dict(x=end['x'], y=start['y']), dict(x=start['x'], y=end['y'])):
        if _clear(start, corner, rectangles) and _clear(corner, end, rectangles):
            return [start, corner, end]
    xs = sorted({0.0, max_x, start['x'], end['x']} |
                {x for r in rectangles for x in (r[0], r[2]) if 0 <= x <= max_x})
    ys = sorted({0.0, max_y, start['y'], end['y']} |
                {y for r in rectangles for y in (r[1], r[3]) if 0 <= y <= max_y})
    ny = len(ys)
    source = xs.index(start['x']) * ny + ys.index(start['y'])
    target = xs.index(end['x']) * ny + ys.index(end['y'])

    def point(node):
        return dict(x=xs[node // ny], y=ys[node % ny])

    def heuristic(p):
        return abs(p['x'] - end['x']) + abs(p['y'] - end['y'])

    costs, parents = {source: 0.0}, {}
    pending = [(heuristic(start), 0, source)]
    order = 0
    closed = set()
    while pending:
        _, _, current = heapq.heappop(pending)
        if current in closed:
            continue
        if current == target:
            path = [point(current)]
            while current in parents:
                current = parents[current]
                path.append(point(current))
            return list(reversed(path))
        closed.add(current)
        ix, iy = divmod(current, ny)
        a = point(current)
        for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
            xx, yy = ix + dx, iy + dy
            if not (0 <= xx < len(xs) and 0 <= yy < ny):
                continue
            neighbor = xx * ny + yy
            b = point(neighbor)
            if neighbor in closed or not _clear(a, b, rectangles):
                continue
            cost = costs[current] + abs(a['x'] - b['x']) + abs(a['y'] - b['y'])
            if cost < costs.get(neighbor, math.inf) - EPS:
                costs[neighbor], parents[neighbor] = cost, current
                order += 1
                heapq.heappush(pending, (cost + heuristic(b), order, neighbor))
    return None


def plan_trajectory(config, start, end, obstacles, options=None):
    """Choose shortest lift/constant-height XY/lower route on obstacle edges.

    Coordinates describe the container's lower corner. Obstacles are boxes with
    x/y/length/width/top. Clearance applies vertically; horizontal padding keeps
    the load away from other footprints at cruise height. Vertical pickup and
    placement allow contact with the supporting pile/bed.
    """
    options = options or {}
    height = config['containerHeight']
    clearance = options.get('clearanceMm', height * .2)
    padding = options.get('horizontalClearanceMm', min(5.0, config['containerWidth'] * .1))
    ceiling = options.get('maxHeightMm', config['levels'] * height + height * 1.2)
    for value in (clearance, padding, ceiling):
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
            raise ValueError('Marges et hauteur de trajectoire invalides.')
    max_x = config['length'] - config['containerLength']
    max_y = config['width'] - config['containerWidth']
    for p in (start, end):
        if (any(not isinstance(p.get(k), (float, int)) or not math.isfinite(p[k]) for k in ('x', 'y', 'z'))
                or not (0 <= p['x'] <= max_x and 0 <= p['y'] <= max_y and 0 <= p['z'] <= ceiling)):
            raise ValueError('Prise ou dépôt hors de l’espace de simulation.')
        for obstacle in obstacles:
            actual = (obstacle['x'] - config['containerLength'], obstacle['y'] - config['containerWidth'],
                      obstacle['x'] + obstacle['length'], obstacle['y'] + obstacle['width'])
            if _inside(p, actual) and p['z'] < obstacle['top'] - EPS:
                raise ValueError('Prise ou dépôt en collision avec un obstacle connu.')
    minimum = max(start['z'], end['z']) + clearance
    heights = sorted({minimum} | {o['top'] + clearance for o in obstacles if o['top'] + clearance >= minimum})
    best = None
    score = options.get('routeScore', lambda route: route['routeLengthMm'])
    direct = abs(start['x'] - end['x']) + abs(start['y'] - end['y'])
    for z in heights:
        if z > ceiling + EPS:
            continue
        if best and 'routeScore' not in options and direct + 2 * z - start['z'] - end['z'] >= best['routeLengthMm'] - EPS:
            break
        rectangles = [(o['x'] - config['containerLength'] - padding,
                       o['y'] - config['containerWidth'] - padding,
                       o['x'] + o['length'] + padding,
                       o['y'] + o['width'] + padding)
                      for o in obstacles if z < o['top'] + clearance - EPS]
        path = _horizontal_path(start, end, rectangles, max_x, max_y)
        if path is None:
            continue
        waypoints = _simplify([start] + [dict(x=p['x'], y=p['y'], z=z) for p in path] + [end])
        length = sum(_distance(a, b) for a, b in zip(waypoints, waypoints[1:]))
        candidate = dict(waypoints=waypoints, routeLengthMm=length, cruiseHeightMm=z,
                        clearanceMm=clearance, horizontalClearanceMm=padding,
                        maxHeightMm=ceiling, planner='rectilinear-a-star-v1')
        if best is None or score(candidate) < score(best) - EPS:
            best = candidate
    if best is None:
        raise ValueError('Aucune trajectoire libre dans la hauteur de simulation autorisée.')
    return best
