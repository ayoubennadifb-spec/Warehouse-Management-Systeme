"""Perspective quadrilaterals, with optional YOLO-World semantic confirmation."""
import math
from pathlib import Path
import cv2
import numpy as np


def measure(points):
    pts=np.array(points,dtype=np.float32).reshape(4,2)
    center=pts.mean(axis=0)
    pts=pts[np.argsort(np.arctan2(pts[:,1]-center[1],pts[:,0]-center[0]))]
    pts=np.roll(pts,-int(np.argmin(pts[:,1])),axis=0)
    edges=np.roll(pts,-1,axis=0)-pts
    sides=np.linalg.norm(edges,axis=1)
    pair=[float((sides[0]+sides[2])/2),float((sides[1]+sides[3])/2)]
    edge=edges[int(np.argmax(sides))]
    return dict(center_px=[round(float(v),2) for v in center],corners_px=[[round(float(v),2) for v in p] for p in pts],
                sides_px=[round(float(v),2) for v in sides],length_px=round(max(pair),2),width_px=round(min(pair),2),
                angle_deg=round(math.degrees(math.atan2(float(edge[1]),float(edge[0])))%180,2),
                area_px2=round(abs(cv2.contourArea(pts)),2),rectangularity=round(abs(cv2.contourArea(pts))/cv2.contourArea(cv2.boxPoints(cv2.minAreaRect(pts))),3),
                method='geometry',label='Quadrilatère',confidence=None)


def overlap(a,b):
    pa=np.array(a['corners_px'],np.float32);pb=np.array(b['corners_px'],np.float32)
    intersection=cv2.intersectConvexConvex(pa,pb)[0]
    return intersection/max(1,min(a['area_px2'],b['area_px2']))


def object_silhouette(frame, bounds):
    """Estimate the visible 2D silhouette inside an object box, not a 3D mesh."""
    height,width=frame.shape[:2]
    x1,y1,x2,y2=map(int,bounds)
    pad=max(8,round(max(x2-x1,y2-y1)*.12))
    left=max(0,x1-pad);top=max(0,y1-pad);right=min(width,x2+pad);bottom=min(height,y2+pad)
    crop=frame[top:bottom,left:right]
    rect=(max(1,x1-left),max(1,y1-top),min(x2-x1,crop.shape[1]-2),min(y2-y1,crop.shape[0]-2))
    if min(rect[2:])<10:return None
    mask=np.zeros(crop.shape[:2],np.uint8)
    try:cv2.grabCut(crop,mask,rect,np.zeros((1,65),np.float64),np.zeros((1,65),np.float64),2,cv2.GC_INIT_WITH_RECT)
    except cv2.error:return None
    foreground=np.uint8((mask==cv2.GC_FGD)|(mask==cv2.GC_PR_FGD))*255
    contours=cv2.findContours(foreground,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]
    if not contours:return None
    contour=max(contours,key=cv2.contourArea);area=cv2.contourArea(contour)
    if area<.25*(x2-x1)*(y2-y1):return None
    poly=cv2.approxPolyDP(contour,.008*cv2.arcLength(contour,True),True).reshape(-1,2)+[left,top]
    faces=[]
    gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
    pixels=gray[foreground>0]
    if pixels.size:
        threshold=cv2.threshold(pixels.reshape(-1,1),0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)[0]
        for bright in (False,True):
            selected=np.uint8(((gray>threshold) if bright else (gray<=threshold)) & (foreground>0))*255
            selected=cv2.morphologyEx(selected,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
            for c in cv2.findContours(selected,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0]:
                if cv2.contourArea(c)<.25*area:continue
                quad=cv2.approxPolyDP(c,.035*cv2.arcLength(c,True),True)
                if len(quad)!=4 or not cv2.isContourConvex(quad):continue
                face=measure(quad.reshape(4,2)+[left,top])
                face.update(face_role='candidate',face_validation='Segmentation expérimentale ; face supérieure à vérifier')
                faces.append(face)
    return dict(outline_px=poly.tolist(),projected_area_px2=round(area,2),approximate=True,face_candidates=faces)


def detect_segmented(frame, settings, model):
    """Return the model's visible face masks with their measured pixel area."""
    height, width = frame.shape[:2]
    r = settings['roi']
    x = round(width*r['x']/100); y = round(height*r['y']/100)
    w = min(width-x, round(width*r['width']/100)); h = min(height-y, round(height*r['height']/100))
    crop = frame[y:y+h, x:x+w]
    # Brighten only genuinely dark frames. CLAHE on luminance preserves the
    # original color/coordinates while making low-contrast edges easier to see.
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    low_light = float(gray.mean()) < 90
    inference_crop = crop
    if low_light:
        gamma = 1.45
        lut = np.array([round(((i / 255) ** (1 / gamma)) * 255) for i in range(256)], np.uint8)
        inference_crop = cv2.LUT(crop, lut)
        lab = cv2.cvtColor(inference_crop, cv2.COLOR_BGR2LAB)
        luminance, a, b = cv2.split(lab)
        luminance = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(luminance)
        inference_crop = cv2.cvtColor(cv2.merge((luminance, a, b)), cv2.COLOR_LAB2BGR)
    result = model.predict(inference_crop, conf=.45, imgsz=640, device='cpu', retina_masks=True, verbose=False)[0]
    detections = []
    class_mask = np.zeros((height, width), np.uint8)
    if result.masks is not None and result.boxes is not None:
        masks = result.masks.data.cpu().numpy()
        boxes = result.boxes
        for i, raw_mask in enumerate(masks):
            binary = np.uint8(raw_mask > .5)*255
            if binary.shape != crop.shape[:2]:
                binary = cv2.resize(binary, (w,h), interpolation=cv2.INTER_NEAREST)
            area = int(cv2.countNonZero(binary))
            cls = int(boxes.cls[i].item())
            name = result.names[cls]
            minimum_area = settings.get('min_side_area', 500) if name in ('long_side', 'short_side') else settings['min_area']
            if not minimum_area <= area <= settings['max_area']:
                continue
            contours = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
            if not contours:
                continue
            contour = max(contours, key=cv2.contourArea)
            if cv2.contourArea(contour) < 8:
                continue
            perimeter = cv2.arcLength(contour, True)
            simple = cv2.approxPolyDP(contour, max(.75, .02*perimeter), True)
            hull = cv2.convexHull(contour)
            solidity = cv2.contourArea(contour) / max(1.0, cv2.contourArea(hull))
            (cx,cy),(a,b),angle = cv2.minAreaRect(contour)
            fill = area / max(1.0, a*b)
            # A visible cuboid face should be a compact convex polygon. This
            # rejects fragmented UI text and background patches in screenshots.
            if not (4 <= len(simple) <= 8 and cv2.isContourConvex(simple)
                    and solidity >= .78 and fill >= .55):
                continue
            polygon = simple.reshape(-1,2)
            polygon = polygon + np.array([x,y], dtype=np.int32)
            if min(a,b) < 1:
                continue
            box = boxes.xyxy[i].cpu().numpy()+np.array([x,y,x,y])
            confidence = float(boxes.conf[i].item())
            detections.append(dict(
                center_px=[round(float(cx+x),2),round(float(cy+y),2)],
                corners_px=polygon.tolist(), polygon_px=polygon.tolist(),
                oriented_box_px=(cv2.boxPoints(((cx+x,cy+y),(a,b),angle))).round(2).tolist(),
                length_px=round(float(max(a,b)),2), width_px=round(float(min(a,b)),2),
                angle_deg=round(float(angle),2), area_px2=area,
                rectangularity=round(float(fill),3), solidity=round(float(solidity),3),
                face_class=name, method='yolo-seg', label=name,
                confidence=round(confidence,3),
                low_light_enhanced=low_light,
                object_box_px=[round(float(v),2) for v in box]))
            # Distinct intensity per face class for the mask preview.
            class_mask[y:y+h,x:x+w][binary > 0] = {0:90,1:170,2:250}.get(cls,220)
    detections.sort(key=lambda d:(d['center_px'][1],d['center_px'][0]))
    return detections, class_mask, [x,y,w,h]


def detect_geometry(frame,settings,model=None):
    if model is not None and getattr(model, 'task', None) == 'segment':
        return detect_segmented(frame, settings, model)
    height,width=frame.shape[:2];r=settings['roi']
    x=round(width*r['x']/100);y=round(height*r['y']/100)
    w=min(width-x,round(width*r['width']/100));h=min(height-y,round(height*r['height']/100))
    crop=frame[y:y+h,x:x+w];gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
    gray=cv2.GaussianBlur(gray,(5,5),0)
    edges=cv2.Canny(gray,40,120)
    edges=cv2.morphologyEx(edges,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    masks=[edges,cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)[1]]
    candidates=[]
    for mask in masks:
        for c in cv2.findContours(mask,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)[0]:
            area=cv2.contourArea(c)
            if not settings['min_area']<=area<=settings['max_area']:continue
            poly=cv2.approxPolyDP(c,.025*cv2.arcLength(c,True),True)
            if len(poly)!=4 or not cv2.isContourConvex(poly):continue
            bx,by,bw,bh=cv2.boundingRect(poly)
            if bx<=2 or by<=2 or bx+bw>=w-2 or by+bh>=h-2:continue
            d=measure(poly.reshape(4,2)+np.array([x,y]))
            if d['width_px']<8 or d['length_px']/d['width_px']>settings['max_ratio']:continue
            candidates.append(d)
    candidates.sort(key=lambda d:d['area_px2'],reverse=True)
    ds=[]
    for d in candidates:
        if not any(overlap(d,old)>.8 for old in ds):ds.append(d)
    if model is not None:
        confirmed = []
        result=model.predict(crop,conf=.15,imgsz=640,device='cpu',verbose=False)[0]
        for object_index,box in enumerate(result.boxes):
            x1,y1,x2,y2=box.xyxy[0].cpu().numpy()+np.array([x,y,x,y])
            best=None;score=0
            for d in ds:
                pts=np.array(d['corners_px']);lo=pts.min(axis=0);hi=pts.max(axis=0)
                inter=np.maximum(0,np.minimum(hi,[x2,y2])-np.maximum(lo,[x1,y1])).prod()
                union=(hi-lo).prod()+(x2-x1)*(y2-y1)-inter
                iou=inter/max(1,union)
                if iou>score:best=d;score=iou
            if result.keypoints is not None and result.keypoints.xy.shape[1] == 4:
                keypoints=result.keypoints.xy[object_index].cpu().numpy()+[x,y]
                confidence=result.keypoints.conf
                valid=confidence is not None and bool((confidence[object_index]>=.5).all())
                if valid and cv2.isContourConvex(keypoints.astype(np.float32)):
                    best=measure(keypoints);best['face_role']='top-keypoints';score=1;ds.append(best)
            silhouette=object_silhouette(frame,[x1,y1,x2,y2])
            if silhouette and (best is None or score<=.35):
                faces=silhouette.get('face_candidates',[])
                if faces:
                    best=max(faces,key=lambda f:f['area_px2']);score=.36;ds.append(best)
            if best is not None and score>.35:
                best['object_box_px']=[round(float(v),2) for v in [x1,y1,x2,y2]]
                best['object_silhouette']=silhouette
                if best.get('face_role') != 'top-keypoints':best['face_role']='candidate'
                best.update(method='yolo+geometry',label=result.names[int(box.cls[0])],confidence=round(float(box.conf[0]),3))
                confirmed.append(best.copy())
            elif x1>x+2 and y1>y+2 and x2<x+w-2 and y2<y+h-2:
                d=measure([[x1,y1],[x2,y1],[x2,y2],[x1,y2]])
                d.update(method='yolo-box',label=result.names[int(box.cls[0])],confidence=round(float(box.conf[0]),3))
                d['object_box_px']=[round(float(v),2) for v in [x1,y1,x2,y2]]
                d['object_silhouette']=silhouette
                ds.append(d)
                confirmed.append(d)
        ds = confirmed
    mask=np.zeros((height,width),np.uint8);mask[y:y+h,x:x+w]=edges
    return ds,mask,[x,y,w,h]


def load_model():
    from ultralytics import YOLO
    custom=Path(__file__).parent/'models/portique-faces-seg.pt'
    if not custom.exists():raise ValueError('Modèle de segmentation entraîné absent : vision/models/portique-faces-seg.pt requis.')
    model=YOLO(str(custom))
    if model.task!='segment' or set(model.names.values())!={'top','long_side','short_side'}:
        raise ValueError('Le modèle doit segmenter les classes top, long_side et short_side.')
    return model
