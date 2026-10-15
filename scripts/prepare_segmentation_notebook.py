"""Colab notebook for face segmentation using existing RGB and lightweight labels."""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
cells=[]
def md(text):cells.append(dict(cell_type='markdown',metadata={},source=text.splitlines(keepends=True)))
def code(text):
    compile(text,'<colab>','exec')
    cells.append(dict(cell_type='code',metadata={},execution_count=None,outputs=[],source=text.splitlines(keepends=True)))
md('''# Portique : segmentation des faces visibles
Le modèle distingue dessus, côté long et côté court. Une face cachée n’est pas observée.
Les surfaces sont des surfaces projetées visibles en pixels², pas des dimensions physiques.

Dans **Mon Drive/PortiqueVision**, conserver **portique_dataset.zip** et ajouter **face-labels.zip**.
Importer ce notebook, activer un GPU et exécuter les cellules dans l’ordre.
Les images sont réutilisées ; aucune nouvelle scène à télécharger sur le PC.
Les sauvegardes vont dans **PortiqueVision/runs/faces-seg-v1**.
Après coupure, réexécuter le notebook : il reprend le checkpoint GPU de ce dossier.
Les métriques synthétiques doivent être complétées par des essais réels avant adoption.
''')
code('''import subprocess, sys
subprocess.check_call([sys.executable,'-m','pip','install','-q','ultralytics==8.4.174'])
import torch
assert torch.cuda.is_available(), 'Active un GPU dans Exécution → Modifier le type d’exécution.'
print(torch.cuda.get_device_name(0))
''')
code('''from google.colab import drive
drive.mount('/content/drive')
from pathlib import Path
import zipfile,json,shutil,yaml,cv2,numpy as np
DRIVE=Path('/content/drive/MyDrive/PortiqueVision')
RGB=Path('/content/portique_original')
DATA=Path('/content/portique_faces')
RUN=DRIVE/'runs/faces-seg-v1'
for filename in ('portique_dataset.zip','face-labels.zip'):
    assert (DRIVE/filename).exists(), 'Fichier manquant dans Drive : '+filename
def extract_checked(archive,destination):
    destination.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(archive) as pack:
        for name in pack.namelist():(destination/name).resolve().relative_to(destination.resolve())
        pack.extractall(destination)
extract_checked(DRIVE/'portique_dataset.zip',RGB)
extract_checked(DRIVE/'face-labels.zip',DATA)
manifest=json.loads((DATA/'manifest.json').read_text())
for split in ('train','val'):
    folder=DATA/'images'/split;folder.mkdir(parents=True,exist_ok=True)
    # Explicit lists prevent stale files from entering later notebook executions.
    paths=[]
    for entry in manifest:
        if entry['split']!=split:continue
        original=RGB/'images'/split/entry['image']
        target=folder/entry['image']
        assert original.exists()
        if not target.exists():shutil.copyfile(original,target)
        assert cv2.imread(str(target)) is not None
        label=DATA/'labels'/split/(target.stem+'.txt')
        for line in label.read_text().splitlines():
            values=list(map(float,line.split()))
            assert int(values[0]) in (0,1,2) and len(values)>=7 and len(values)%2==1
            assert all(np.isfinite(v) and 0<=v<=1 for v in values[1:])
        paths.append(target.as_posix())
    assert paths, 'Aucune image valide dans '+split
    (DATA/(split+'.txt')).write_text('\\n'.join(paths)+'\\n')
    print(split,len(paths),'images')
CONFIG=DATA/'faces.yaml'
CONFIG.write_text(yaml.safe_dump(dict(path=str(DATA),train='train.txt',val='val.txt',names={0:'top',1:'long_side',2:'short_side'})))
''')
code('''from ultralytics import YOLO
RUN.mkdir(parents=True,exist_ok=True)
LAST=RUN/'weights/last.pt'
if LAST.exists():
    checkpoint=torch.load(LAST,map_location='cpu',weights_only=False)
    complete=checkpoint.get('epoch',-1)<0
    del checkpoint
    if complete:
        print('Entraînement déjà terminé. Passer à la validation.')
    else:
        model=YOLO(str(LAST))
        model.train(resume=True,data=str(CONFIG),device=0,batch=4,workers=2,
                    cache=False,plots=False,save_dir=str(RUN))
else:
    model=YOLO('yolo11s-seg.pt')
    model.train(data=str(CONFIG),epochs=100,patience=20,imgsz=640,device=0,
                batch=4,workers=2,amp=False,optimizer='AdamW',lr0=.001,
                mask_ratio=1,overlap_mask=False,mosaic=0.0,degrees=15,
                translate=.05,scale=.2,hsv_h=.015,hsv_s=.4,hsv_v=.4,
                fliplr=.5,cache=False,plots=False,seed=42,save_period=-1,
                project=str(DRIVE/'runs'),name='faces-seg-v1',exist_ok=True)
''')
code('''BEST=RUN/'weights/best.pt'
assert BEST.exists(), 'Aucun modèle sauvegardé.'
model=YOLO(str(BEST))
assert model.task=='segment'
metrics=model.val(data=str(CONFIG),device=0,batch=4,plots=True,
                 project=str(DRIVE/'evaluation'),name='faces-seg-v1')
summary={k:float(v) for k,v in metrics.results_dict.items()}
(RUN/'validation.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
print('Ces scores synthétiques ne prouvent pas la précision sur caméra réelle.')
''')
code('''# Measure mask agreement and projected area error, separately for each face type.
stats={i:dict(expected=0,predicted=0,matched=0,iou=[],area_error_percent=[]) for i in range(3)}
for entry in manifest:
    if entry['split']!='val':continue
    image=DATA/'images/val'/entry['image']
    frame=cv2.imread(str(image));height,width=frame.shape[:2]
    truth=[]
    label=DATA/'labels/val'/(image.stem+'.txt')
    for line in label.read_text().splitlines():
        values=list(map(float,line.split()));kind=int(values[0])
        polygon=np.round(np.array(values[1:]).reshape(-1,2)*[width,height]).astype(np.int32)
        mask=np.zeros((height,width),np.uint8);cv2.fillPoly(mask,[polygon],1)
        truth.append((kind,mask>0));stats[kind]['expected']+=1
    result=model.predict(frame,device=0,conf=.25,imgsz=640,retina_masks=True,verbose=False)[0]
    predicted=[]
    if result.masks is not None:
        for kind,tensor in zip(result.boxes.cls.cpu().numpy(),result.masks.data):
            mask=tensor.cpu().numpy()
            if mask.shape!=(height,width):mask=cv2.resize(mask,(width,height),interpolation=cv2.INTER_NEAREST)
            predicted.append((int(kind),mask>.5));stats[int(kind)]['predicted']+=1
    pairs=[]
    for i,(kind,actual) in enumerate(truth):
        for j,(other,estimate) in enumerate(predicted):
            if kind!=other:continue
            overlap=np.logical_and(actual,estimate).sum()/max(1,np.logical_or(actual,estimate).sum())
            pairs.append((overlap,i,j))
    used_truth=set();used_prediction=set()
    for overlap,i,j in sorted(pairs,reverse=True):
        if overlap<.5:break
        if i in used_truth or j in used_prediction:continue
        used_truth.add(i);used_prediction.add(j)
        kind,actual=truth[i];estimate=predicted[j][1];stat=stats[kind]
        stat['matched']+=1;stat['iou'].append(float(overlap))
        stat['area_error_percent'].append(float(abs(int(actual.sum())-int(estimate.sum()))/max(1,int(actual.sum()))*100))
report={}
for kind,stat in stats.items():
    errors=stat['area_error_percent']
    report[model.names[kind]]=dict(expected=stat['expected'],predicted=stat['predicted'],matched=stat['matched'],
        precision=stat['matched']/max(1,stat['predicted']),recall=stat['matched']/max(1,stat['expected']),
        median_iou=float(np.median(stat['iou'])) if stat['iou'] else None,
        median_area_error_percent=float(np.median(errors)) if errors else None,
        p95_area_error_percent=float(np.percentile(errors,95)) if errors else None)
(RUN/'face-quality.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
print('Les erreurs de surface concernent les faces appariées ; le rappel compte les faces manquées.')
''')
code('''from IPython.display import display,Image
examples=[e for e in manifest if e['split']=='val' and e['faces']>=3][:5]
for entry in examples:
    image=DATA/'images/val'/entry['image']
    result=model.predict(str(image),device=0,conf=.25,imgsz=640,retina_masks=True,verbose=False)[0]
    preview=result.plot()
    ok,encoded=cv2.imencode('.jpg',preview)
    if ok:display(Image(data=encoded.tobytes()))
''')
code('''from google.colab import files
files.download(str(BEST))
''')
notebook=dict(cells=cells,metadata=dict(colab=dict(name='Portique_Faces_Segmentation.ipynb'),accelerator='GPU',kernelspec=dict(display_name='Python 3',language='python',name='python3')),nbformat=4,nbformat_minor=5)
out=root/'colab_vision/Portique_Faces_Segmentation.ipynb'
out.write_text(json.dumps(notebook,ensure_ascii=False,indent=2),encoding='utf-8')
print(out)
