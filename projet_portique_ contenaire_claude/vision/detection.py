"""Known-color top-face contours, rotated rectangles and short-term tracking."""
import json
import math
from collections import deque
from pathlib import Path
import cv2
import numpy as np

DEFAULT = json.loads((Path(__file__).parent / 'settings.json').read_text(encoding='utf-8'))


def validate(settings):
    s = json.loads(json.dumps(settings))
    for key, high in [('h', 179), ('s', 255), ('v', 255)]:
        low, upper = s[key + '_min'], s[key + '_max']
        if not (isinstance(low, int) and isinstance(upper, int) and 0 <= low <= upper <= high):
            raise ValueError(f'Seuils {key.upper()} invalides : minimum ≤ maximum requis.')
    for key in ('min_area', 'max_area', 'min_ratio', 'max_ratio', 'rectangularity'):
        if not isinstance(s[key], (int, float)) or not math.isfinite(s[key]):
            raise ValueError(f'Valeur invalide : {key}.')
    if not 10 <= s['min_area'] <= s['max_area'] <= 10000000:
        raise ValueError('Surface : 10 ≤ minimum ≤ maximum ≤ 10 000 000 pixels².')
    if not 1 <= s['min_ratio'] <= s['max_ratio'] <= 20:
        raise ValueError('Proportions : 1 ≤ minimum ≤ maximum ≤ 20.')
    if not 0.5 <= s['rectangularity'] <= 1 or s['kernel'] not in (1, 3, 5, 7, 9):
        raise ValueError('Rectangularité ou nettoyage invalide.')
    r = s['roi']
    if not all(isinstance(r[k], (int, float)) and math.isfinite(r[k]) for k in ('x', 'y', 'width', 'height')):
        raise ValueError('Zone d’analyse invalide.')
    if not (0 <= r['x'] < 100 and 0 <= r['y'] < 100 and r['width'] > 0 and r['height'] > 0
            and r['x'] + r['width'] <= 100 and r['y'] + r['height'] <= 100):
        raise ValueError('La zone d’analyse doit rester dans l’image (pourcentages).')
    return s


def detect(frame, settings):
    s = validate(settings)
    height, width = frame.shape[:2]
    roi = s['roi']
    x = round(width * roi['x'] / 100)
    y = round(height * roi['y'] / 100)
    w = min(width - x, max(1, round(width * roi['width'] / 100)))
    h = min(height - y, max(1, round(height * roi['height'] / 100)))
    hsv = cv2.cvtColor(frame[y:y+h, x:x+w], cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([s['h_min'], s['s_min'], s['v_min']], dtype=np.uint8),
                       np.array([s['h_max'], s['s_max'], s['v_max']], dtype=np.uint8))
    kernel = np.ones((s['kernel'], s['kernel']), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    results = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if not s['min_area'] <= area <= s['max_area']:
            continue
        (cx, cy), (a, b), _ = cv2.minAreaRect(contour)
        if min(a, b) < 2:
            continue
        ratio = max(a, b) / min(a, b)
        fill = area / (a * b)
        poly = cv2.approxPolyDP(contour, 0.025 * cv2.arcLength(contour, True), True)
        if not (s['min_ratio'] <= ratio <= s['max_ratio'] and fill >= s['rectangularity']
                and len(poly) == 4 and cv2.isContourConvex(poly)):
            continue
        bx, by, bw, bh = cv2.boundingRect(contour)
        # A truncated face cannot provide reliable dimensions.
        if bx <= 0 or by <= 0 or bx + bw >= w or by + bh >= h:
            continue
        corners = cv2.boxPoints(cv2.minAreaRect(contour))
        corners += np.array([x, y], dtype=np.float32)
        edges = np.roll(corners, -1, axis=0) - corners
        edge = edges[int(np.argmax(np.linalg.norm(edges, axis=1)))]
        angle = math.degrees(math.atan2(float(edge[1]), float(edge[0]))) % 180
        first = int(np.lexsort((corners[:, 0], corners[:, 1]))[0])
        corners = np.roll(corners, -first, axis=0)
        results.append(dict(center_px=[round(cx+x, 2), round(cy+y, 2)],
                            corners_px=np.round(corners, 2).tolist(),
                            length_px=round(max(a, b), 2), width_px=round(min(a, b), 2),
                            angle_deg=round(angle, 2), area_px2=round(area, 2),
                            rectangularity=round(fill, 3)))
    results.sort(key=lambda d: (d['center_px'][1], d['center_px'][0]))
    full_mask = np.zeros((height, width), np.uint8)
    full_mask[y:y+h, x:x+w] = mask
    return results, full_mask, [x, y, w, h]


class Tracker:
    """Greedy gated association; IDs are session observations, not inventory IDs."""
    def __init__(self):
        self.tracks = {}
        self.next_id = 1
        self.frame = 0

    def update(self, detections, width, height):
        self.frame += 1
        gate = max(20, math.hypot(width, height) * 0.05)
        pairs = []
        for i, d in enumerate(detections):
            for tid, track in self.tracks.items():
                if self.frame - track['seen'] > 5:
                    continue
                old = track['samples'][-1]
                previous_class = track.get('face_class')
                if previous_class and d.get('face_class') and previous_class != d['face_class']:
                    continue
                distance = math.dist(d['center_px'], old[:2])
                if distance < gate and 0.7 < d['length_px'] / old[2] < 1.4:
                    pairs.append((distance, i, tid))
        used_d, used_t, match = set(), set(), {}
        for _, i, tid in sorted(pairs):
            if i not in used_d and tid not in used_t:
                match[i] = tid; used_d.add(i); used_t.add(tid)
        for i, d in enumerate(detections):
            tid = match.get(i)
            if tid is None:
                tid = self.next_id; self.next_id += 1
                self.tracks[tid] = dict(samples=deque(maxlen=30), seen=self.frame)
            track = self.tracks[tid]
            track['seen'] = self.frame
            if d.get('face_class'):
                track['face_class'] = d['face_class']
            track['samples'].append([*d['center_px'], d['length_px'], d['width_px']])
            samples = np.array(track['samples'])
            std = samples.std(axis=0)
            d.update(observation_id=tid, stability=dict(samples=len(samples),
                     center_std_px=round(float(np.linalg.norm(std[:2])), 3),
                     length_std_px=round(float(std[2]), 3), width_std_px=round(float(std[3]), 3)))
        self.tracks = {k: v for k, v in self.tracks.items() if self.frame-v['seen'] <= 5}
        return detections


def annotate(frame, detections, roi):
    image = frame.copy()
    x, y, w, h = roi
    cv2.rectangle(image, (x, y), (x+w-1, y+h-1), (0, 180, 255), 1)
    overlay = image.copy()
    for d in detections:
        polygon = d.get('polygon_px')
        if polygon:
            color = {'top': (0, 220, 0), 'long_side': (255, 190, 0),
                     'short_side': (0, 120, 255)}.get(d.get('face_class'), (0, 220, 0))
            cv2.fillPoly(overlay, [np.array(polygon, np.int32)], color)
    image = cv2.addWeighted(overlay, .18, image, .82, 0)
    for d in detections:
        if d.get('object_box_px') and d.get('method') != 'yolo-seg':
            x1,y1,x2,y2 = map(round,d['object_box_px'])
            cv2.rectangle(image,(x1,y1),(x2,y2),(0,180,255),1)
        pts = np.array(d['corners_px'], dtype=np.int32)
        color = (0, 180, 255) if d.get('method') == 'yolo-box' else {
            'top': (0, 240, 0), 'long_side': (255, 220, 0), 'short_side': (0, 150, 255)
        }.get(d.get('face_class'), (0, 240, 0))
        cv2.polylines(image, [pts], True, color, 2)
        silhouette = d.get('object_silhouette')
        if silhouette:
            cv2.polylines(image, [np.array(silhouette['outline_px'], np.int32)], True, (255, 220, 0), 2)
        moments = cv2.moments(pts)
        if moments['m00']:
            cx, cy = round(moments['m10']/moments['m00']), round(moments['m01']/moments['m00'])
        else:
            cx, cy = map(round, d['center_px'])
        text = f"#{d['observation_id']}"
        font, scale, thickness = cv2.FONT_HERSHEY_SIMPLEX, .36, 1
        (tw, th), baseline = cv2.getTextSize(text, font, scale, thickness)
        tx = int(np.clip(cx-tw//2, 2, max(2,image.shape[1]-tw-4)))
        ty = int(np.clip(cy+th//2, th+3, max(th+3,image.shape[0]-baseline-2)))
        rect = (tx-3,ty-th-3,tx+tw+3,ty+baseline+2)
        cv2.rectangle(image,(rect[0],rect[1]),(rect[2],rect[3]),(28,35,42),-1)
        cv2.putText(image, text, (tx,ty), font, scale, (245,250,255), thickness, cv2.LINE_AA)

    # Keep measurements in one compact legend on the image edge; face surfaces
    # only carry their small tracking number so the object remains visible.
    if detections:
        height, width = image.shape[:2]
        top_margin, bottom_margin = y, height-(y+h)
        edge = 'top' if top_margin >= bottom_margin else 'bottom'
        margin = max(top_margin, bottom_margin)
        scale, thickness = .34, 1
        line_height = 15
        columns = max(1, min(len(detections), width//112))
        rows = (len(detections)+columns-1)//columns
        if rows*line_height+8 > max(margin, 1):
            scale, line_height = .29, 13
            columns = max(columns, min(len(detections), width//92))
            rows = (len(detections)+columns-1)//columns
        band_height = rows*line_height+8
        band_y = 3 if edge == 'top' else max(3, height-band_height-3)
        cv2.rectangle(image,(3,band_y),(width-4,min(height-4,band_y+band_height)),(28,35,42),-1)
        column_width = max(1,(width-12)//columns)
        for index, d in enumerate(detections):
            row, col = divmod(index, columns)
            label = f"#{d['observation_id']}  {int(d['area_px2']):,} px2".replace(',', ' ')
            cv2.putText(image,label,(8+col*column_width,band_y+line_height*(row+1)-2),
                        cv2.FONT_HERSHEY_SIMPLEX,scale,(245,250,255),thickness,cv2.LINE_AA)
    return image
