"""Independent synthetic holdout: object matching and visible top-face measurements."""
import argparse, hashlib, json, sys
from pathlib import Path
import cv2
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument('dataset')
args=parser.parse_args()
workspace=Path(__file__).resolve().parents[1]
root=Path(args.dataset).resolve()
sys.path.insert(0,str(workspace/'projet_portique_ contenaire_claude/vision'))
from geometry import load_model, detect_geometry
from detection import DEFAULT
model=load_model()
training=workspace/'.local/synthetic-containers-20261008-221130'
known_seeds={json.loads(p.read_text())['seed'] for p in (training/'metadata').rglob('*.json')}
known_hashes={hashlib.sha256(p.read_bytes()).hexdigest() for p in (training/'images').rglob('*.png')}

def iou(a,b):
    intersection=np.maximum(0,np.minimum(a[2:],b[2:])-np.maximum(a[:2],b[:2])).prod()
    return float(intersection/max(1,(a[2:]-a[:2]).prod()+(b[2:]-b[:2]).prod()-intersection))

rows=[]; tiles=[]; errors=[]; area_errors=[]; tp=fp=fn=0; eligible=usable=0
for image in sorted((root/'images').rglob('*.png')):
    meta=json.loads((root/'metadata'/image.parent.name/(image.stem+'.json')).read_text())
    assert meta['seed'] not in known_seeds, 'Seed overlaps training'
    assert hashlib.sha256(image.read_bytes()).hexdigest() not in known_hashes, 'Image overlaps training'
    frame=cv2.imread(str(image)); result=model.predict(frame,conf=.15,imgsz=640,device='cpu',verbose=False)[0]
    boxes=result.boxes.xyxy.cpu().numpy()
    truth=[]
    for obj in meta['objects']:
        cx,cy,w,h=obj['bbox_normalized']
        truth.append(np.array([(cx-w/2)*640,(cy-h/2)*480,(cx+w/2)*640,(cy+h/2)*480]))
    possibilities=sorted([(iou(a,b),i,j) for i,a in enumerate(truth) for j,b in enumerate(boxes)],reverse=True)
    matches=[]; gt_used=set(); pred_used=set()
    for score,i,j in possibilities:
        if score<.5:break
        if i not in gt_used and j not in pred_used:
            matches.append((i,j));gt_used.add(i);pred_used.add(j)
    tp+=len(matches);fp+=len(boxes)-len(matches);fn+=len(truth)-len(matches)
    tops=0
    for obj in meta['objects']:
        if all(c['visible'] for c in obj['top_corners']):eligible+=1
    for i,j in matches:
        obj=meta['objects'][i]
        if not all(c['visible'] for c in obj['top_corners']):continue
        if result.keypoints is None or result.keypoints.conf is None:continue
        if not bool((result.keypoints.conf[j]>=.5).all()):continue
        pred=result.keypoints.xy[j].cpu().numpy().astype(np.float32)
        if not cv2.isContourConvex(pred.astype(np.float32)):continue
        actual=np.array([c['pixel'] for c in obj['top_corners']],np.float32)
        # Corner identities are symmetric; compare geometric corners modulo cyclic order.
        variants=[np.roll(pred,k,axis=0) for k in range(4)]+[np.roll(pred[::-1],k,axis=0) for k in range(4)]
        best=min(variants,key=lambda p:np.linalg.norm(p-actual,axis=1).sum())
        errors.extend(np.linalg.norm(best-actual,axis=1).tolist())
        area_errors.append(abs(cv2.contourArea(pred)-cv2.contourArea(actual))/max(1,cv2.contourArea(actual))*100)
        usable+=1;tops+=1
        cv2.polylines(frame,[actual.astype(np.int32)],True,(255,140,0),2)
        cv2.polylines(frame,[pred.astype(np.int32)],True,(0,255,0),2)
    for a in truth:cv2.rectangle(frame,tuple(a[:2].astype(int)),tuple(a[2:].astype(int)),(255,140,0),1)
    for a in boxes:cv2.rectangle(frame,tuple(a[:2].astype(int)),tuple(a[2:].astype(int)),(0,255,0),1)
    app_detections,_,_=detect_geometry(cv2.imread(str(image)),DEFAULT,model)
    row=dict(image=image.relative_to(root).as_posix(),seed=meta['seed'],expected=len(truth),predicted=len(boxes),matched=len(matches),false_positive=len(boxes)-len(matches),missed=len(truth)-len(matches),usable_top_faces=tops,app_detections=len(app_detections))
    rows.append(row)
    cv2.putText(frame,f'{image.stem}: GT {len(truth)} / YOLO {len(boxes)} / OK {len(matches)}',(8,22),cv2.FONT_HERSHEY_SIMPLEX,.48,(255,255,255),2)
    (root/'predictions').mkdir(exist_ok=True)
    cv2.imwrite(str(root/'predictions'/(image.stem+'.jpg')),frame)
    tiles.append(cv2.resize(frame,(320,240)))

summary=dict(images=len(rows),expected_objects=tp+fn,predicted_objects=tp+fp,matched=tp,false_positives=fp,missed=fn,
    precision=tp/max(1,tp+fp),recall=tp/max(1,tp+fn),confidence_threshold=.15,iou_threshold=.5,
    fully_visible_top_faces=eligible,measurable_top_faces=usable,
    corner_error_median_px=float(np.median(errors)) if errors else None,
    corner_error_p90_px=float(np.percentile(errors,90)) if errors else None,
    area_error_median_percent=float(np.median(area_errors)) if area_errors else None,
    independent_seeds_and_images=True,synthetic=True,rows=rows)
(root/'evaluation.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
while len(tiles)%3:tiles.append(np.zeros((240,320,3),np.uint8))
cv2.imwrite(str(root/'predictions-overview.jpg'),np.vstack([np.hstack(tiles[i:i+3]) for i in range(0,len(tiles),3)]))
print(json.dumps({k:v for k,v in summary.items() if k!='rows'},indent=2))
