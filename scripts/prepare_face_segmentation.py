"""Audit existing annotations and export lightweight YOLO face segmentation labels."""
import json,sys,zipfile
from pathlib import Path
import cv2
import numpy as np

workspace=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(workspace/'projet_portique_ contenaire_claude/vision/synthetic'))
from face_labels import visible_faces,polygon_label,CLASSES
source=workspace/'.local/synthetic-containers-20261008-221130'
output=workspace/'colab_vision/face_segmentation'
output.mkdir(parents=True,exist_ok=True)
report=dict(images=0,objects=0,fully_visible_top=0,partly_visible_top=0,hidden_top=0,
            faces={v:0 for v in CLASSES.values()},excluded_images=[],projection_max_error_px=0,kept={'train':0,'val':0})
previews=[]; records=[]
for split in ('train','val'):
    (output/'labels'/split).mkdir(parents=True,exist_ok=True)
    for image in sorted((source/'images'/split).glob('*.png')):
        metadata_path=source/'metadata'/split/(image.stem+'.json')
        if not metadata_path.exists():continue
        meta=json.loads(metadata_path.read_text())
        report['images']+=1
        for obj in meta['objects']:
            report['objects']+=1
            visible=sum(c['visible'] for c in obj['top_corners'])
            report['fully_visible_top' if visible==4 else 'hidden_top' if visible==0 else 'partly_visible_top']+=1
        ids,faces,error=visible_faces(meta)
        report['projection_max_error_px']=max(report['projection_max_error_px'],error)
        lines=[]; rejected=[]; kept=[]
        for face in faces:
            mask=ids==face['id'];area=int(mask.sum())
            if area<16:continue # Tiny grazing faces are below useful measurement resolution.
            polygon,reason=polygon_label(mask)
            if reason:rejected.append(reason);continue
            width,height=meta['resolution']
            values=(polygon/[width,height]).reshape(-1)
            lines.append(str(face['kind'])+' '+' '.join(f'{v:.7f}' for v in values))
            kept.append((face,polygon,area))
        if rejected:
            report['excluded_images'].append(dict(image=image.name,split=split,reasons=rejected))
            continue # Never treat a visible, unlabelled face as a negative.
        (output/'labels'/split/(image.stem+'.txt')).write_text('\n'.join(lines)+('\n' if lines else ''))
        report['kept'][split]+=1
        for face,_,_ in kept:report['faces'][CLASSES[face['kind']]]+=1
        records.append(dict(image=image.name,split=split,faces=len(lines)))
        # A few overlay examples only, no copied training images.
        if len(meta['objects'])>=3 and len(previews)<6:
            frame=cv2.imread(str(image))
            for face,polygon,area in kept:
                color=[(0,255,0),(255,170,0),(0,170,255)][face['kind']]
                cv2.polylines(frame,[polygon.astype(np.int32)],True,color,1)
            cv2.putText(frame,image.stem+' | annotated faces '+str(len(lines)),(8,20),cv2.FONT_HERSHEY_SIMPLEX,.45,(255,255,255),1)
            previews.append(cv2.resize(frame,(320,240)))
report['face_names']=CLASSES
(output/'audit.json').write_text(json.dumps(report,indent=2))
(output/'manifest.json').write_text(json.dumps(records,indent=2))
if previews:
    while len(previews)%3:previews.append(np.zeros((240,320,3),np.uint8))
    cv2.imwrite(str(output/'annotation-preview.jpg'),np.vstack([np.hstack(previews[i:i+3]) for i in range(0,len(previews),3)]))
with zipfile.ZipFile(output/'face-labels.zip','w',zipfile.ZIP_DEFLATED) as archive:
    for record in records:
        p=output/'labels'/record['split']/(Path(record['image']).stem+'.txt')
        archive.write(p,p.relative_to(output).as_posix())
    archive.write(output/'manifest.json','manifest.json')
print(json.dumps({k:v for k,v in report.items() if k!='excluded_images'},indent=2))
print('Excluded images:',len(report['excluded_images']))
