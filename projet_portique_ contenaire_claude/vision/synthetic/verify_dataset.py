"""Validate and preview a synthetic YOLO pose dataset; no model training."""
import argparse,json,math
from pathlib import Path
import cv2
import numpy as np
parser=argparse.ArgumentParser();parser.add_argument('dataset');parser.add_argument('--normalize',action='store_true');args=parser.parse_args()
root=Path(args.dataset).resolve();manifest=json.loads((root/'manifest.json').read_text())
thumbs=[];objects=0;visible=0
for index,entry in enumerate(manifest['images']):
    image_path=root/entry['image'];split=entry['split'];name=image_path.stem
    meta_path=root/'metadata'/split/(name+'.json');labels_path=root/'labels'/split/(name+'.txt')
    meta=json.loads(meta_path.read_text());image=cv2.imread(str(image_path))
    assert image is not None and image.shape[:2]==(480,640)
    if args.normalize:
        # Canonical image order: topmost corner, then clockwise (image y down).
        lines=[]
        for obj in meta['objects']:
            pts=obj['top_corners'];cx=sum(p['pixel'][0] for p in pts)/4;cy=sum(p['pixel'][1] for p in pts)/4
            pts.sort(key=lambda p:math.atan2(p['pixel'][1]-cy,p['pixel'][0]-cx))
            first=min(range(4),key=lambda i:(pts[i]['pixel'][1],pts[i]['pixel'][0]));pts=pts[first:]+pts[:first];obj['top_corners']=pts
            values=[0,*obj['bbox_normalized']]
            for p in pts:values.extend([p['pixel'][0]/640,p['pixel'][1]/480,2] if p['visible'] else [0,0,0])
            lines.append(' '.join(str(round(v,7)) for v in values))
        labels_path.write_text('\n'.join(lines)+('\n' if lines else ''),encoding='utf-8');meta_path.write_text(json.dumps(meta,indent=2),encoding='utf-8')
        target_split='val' if index%4==0 else 'train'
        if target_split!=split:
            for folder,suffix in [('images','.png'),('labels','.txt'),('metadata','.json')]:
                src=root/folder/split/(name+suffix);dest=root/folder/target_split/(name+suffix)
                src.resolve().relative_to(root);dest.resolve().relative_to(root)
                dest.parent.mkdir(parents=True,exist_ok=True);src.replace(dest)
            entry['split']=target_split;entry['image']=str(Path('images')/target_split/(name+'.png'))
            labels_path=root/'labels'/target_split/(name+'.txt')
    lines=labels_path.read_text().splitlines();assert len(lines)==len(meta['objects'])
    for line,obj in zip(lines,meta['objects']):
        values=list(map(float,line.split()));assert len(values)==17 and values[0]==0 and all(math.isfinite(v) for v in values)
        assert all(0<=v<=1 for v in values[1:5])
        for j in range(5,17,3):assert 0<=values[j]<=1 and 0<=values[j+1]<=1 and values[j+2] in (0,2)
        cx,cy,w,h=obj['bbox_normalized'];cv2.rectangle(image,(round((cx-w/2)*640),round((cy-h/2)*480)),(round((cx+w/2)*640),round((cy+h/2)*480)),(0,150,255),1)
        for corner in obj['top_corners']:
            if corner['visible']:cv2.circle(image,tuple(round(v) for v in corner['pixel']),4,(0,255,0),-1);visible+=1
        objects+=1
    tile=cv2.resize(image,(320,240));cv2.putText(tile,name+' '+entry['split'],(8,20),cv2.FONT_HERSHEY_SIMPLEX,.45,(0,0,0),2);thumbs.append(tile)
(root/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
while len(thumbs)%4:thumbs.append(np.full((240,320,3),255,np.uint8))
sheet=np.vstack([np.hstack(thumbs[i:i+4]) for i in range(0,len(thumbs),4)])
cv2.imwrite(str(root/'apercu_annotations.jpg'),sheet)
summary=dict(images=len(manifest['images']),objects=objects,visible_top_corners=visible,train=sum(e['split']=='train' for e in manifest['images']),val=sum(e['split']=='val' for e in manifest['images']),synthetic=True)
(root/'verification.json').write_text(json.dumps(summary,indent=2),encoding='utf-8');print(json.dumps(summary))
