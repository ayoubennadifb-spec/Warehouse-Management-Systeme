"""Experimental plane calibration for three known top-face heights."""
import json,sys,math
from pathlib import Path
import cv2
import numpy as np


def fit(profile):
    dims=profile['container_mm']
    if any(not math.isfinite(dims[k]) or dims[k]<=0 for k in ('length','width','height')):raise ValueError('Dimensions positives requises.')
    fitted=[]
    for level in profile['levels']:
        points=level['points']
        if len(points)<4:raise ValueError('Au moins quatre repères par hauteur.')
        uv=np.array([p['pixel'] for p in points],np.float64)
        xy=np.array([p['world'] for p in points],np.float64)
        if not np.isfinite(uv).all() or not np.isfinite(xy).all():raise ValueError('Repères invalides.')
        if cv2.contourArea(cv2.convexHull(uv.astype(np.float32)))<100 or cv2.contourArea(cv2.convexHull(xy.astype(np.float32)))<1:raise ValueError('Repères trop proches ou alignés.')
        matrix,_=cv2.findHomography(uv,xy,0)
        if matrix is None or not np.isfinite(matrix).all() or abs(np.linalg.det(matrix))<1e-12:raise ValueError('Calibration dégénérée.')
        mapped=cv2.perspectiveTransform(uv.astype(np.float64).reshape(-1,1,2),matrix).reshape(-1,2)
        rms=float(np.sqrt(np.mean(np.sum((mapped-xy)**2,axis=1))))
        fitted.append(dict(**level,matrix=matrix.tolist(),fit_error_mm=round(rms,3),coverage_px=cv2.convexHull(uv.astype(np.float32)).reshape(-1,2).tolist()))
    if sorted(l['level'] for l in fitted)!=[1,2,3]:raise ValueError('Les trois niveaux 1, 2 et 3 sont requis.')
    return dict(**{k:v for k,v in profile.items() if k!='levels'},levels=fitted,experimental=True)


def estimate(d,profile,resolution,source):
    if not profile:return dict(status='uncalibrated',reason='Calibration absente')
    if d.get('method')=='yolo-seg' and len(d.get('corners_px',[]))!=4:
        return dict(status='uncertain',reason='La segmentation mesure la surface visible ; quatre coins sont requis pour la calibration.')
    if resolution!=profile['resolution'] or source.get('kind')!=profile['source'].get('kind') or source.get('camera_index')!=profile['source'].get('camera_index'):
        return dict(status='uncertain',reason='Source ou résolution différente de la calibration')
    if d.get('method')=='yolo-box':return dict(status='uncertain',reason='Contour réel non confirmé')
    pts=np.array(d['corners_px'],np.float64)
    center=np.mean(pts,axis=0); candidates=[]
    target=sorted([profile['container_mm']['length'],profile['container_mm']['width']])
    for level in profile['levels']:
        coverage=np.array(level['coverage_px'],np.float32)
        if any(cv2.pointPolygonTest(coverage,tuple(map(float,p)),False)<0 for p in pts):continue
        H=np.array(level['matrix'],np.float64)
        mapped=cv2.perspectiveTransform(pts.reshape(-1,1,2),H).reshape(-1,2)
        if not np.isfinite(mapped).all():continue
        sides=np.linalg.norm(np.roll(mapped,-1,axis=0)-mapped,axis=1)
        size=sorted([(sides[0]+sides[2])/2,(sides[1]+sides[3])/2])
        error=math.sqrt(sum(((v-t)/t)**2 for v,t in zip(size,target))/2)
        location=mapped.mean(axis=0)
        candidates.append(dict(level=level['level'],x_mm=round(float(location[0]),2),y_mm=round(float(location[1]),2),
            z_top_mm=round(level['level']*profile['container_mm']['height'],2),z_base_mm=round((level['level']-1)*profile['container_mm']['height'],2),
            length_mm=round(float(size[1]),2),width_mm=round(float(size[0]),2),area_mm2=round(abs(cv2.contourArea(mapped.astype(np.float32))),2),
            error=error,corners_mm=[[round(float(v),2) for v in p] for p in mapped]))
    candidates.sort(key=lambda c:c['error'])
    if len(candidates)<3:return dict(status='uncertain',reason='Forme hors de la zone couverte aux trois hauteurs')
    best=candidates[0];gap=candidates[1]['error']-best['error']
    if best['error']>profile.get('max_error',.12) or gap<profile.get('min_gap',.03):
        return dict(status='uncertain',reason='Dimensions incompatibles ou niveaux trop proches',best_level=best['level'],relative_error=round(best['error'],4),separation=round(gap,4))
    return dict(**best,status='estimated',relative_error=round(best['error'],4),separation=round(gap,4),experimental=True)


if __name__=='__main__':
    try:print(json.dumps(fit(json.load(sys.stdin)),allow_nan=False))
    except Exception as exc:print(str(exc),file=sys.stderr);sys.exit(1)
