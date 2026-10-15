"""Train object boxes and four top-face keypoints from a labelled real dataset."""
import argparse
import json, math
import cv2
from pathlib import Path
from ultralytics import YOLO
import yaml

parser=argparse.ArgumentParser()
parser.add_argument('--dataset',required=True,help='Dataset root containing images/train, images/val, labels/train, labels/val')
parser.add_argument('--epochs',type=int,default=100)
parser.add_argument('--device',default='cpu')
parser.add_argument('--batch',type=int,default=1)
parser.add_argument('--resume',help='Checkpoint last.pt pour reprendre un entraînement interrompu')
args=parser.parse_args()
root=Path(args.dataset).resolve()
report={'accepted':{},'excluded':[]}
for split in ('train','val'):
    if not (root/'images'/split).is_dir() or not (root/'labels'/split).is_dir():parser.error('Images et annotations train/val requises.')
    if not any((root/'labels'/split).glob('*.txt')):parser.error('Dataset non annoté : entraînement impossible.')
    accepted=[]
    for image in sorted((root/'images'/split).glob('*.png')):
        try:
            decoded=cv2.imread(str(image))
            if decoded is None:raise ValueError('image illisible')
            label=root/'labels'/split/(image.stem+'.txt')
            for line in label.read_text().splitlines():
                v=list(map(float,line.split()))
                if len(v)!=17 or v[0]!=0 or not all(math.isfinite(x) for x in v):raise ValueError('annotation invalide')
                if not all(0<=x<=1 for x in v[1:5]) or v[3]<=0 or v[4]<=0:raise ValueError('boîte invalide')
                for j in range(5,17,3):
                    if not (0<=v[j]<=1 and 0<=v[j+1]<=1 and v[j+2] in (0,2)):raise ValueError('coin invalide')
            accepted.append(image.as_posix())
        except Exception as exc:report['excluded'].append({'image':str(image),'reason':str(exc)})
    if not accepted:parser.error('Aucune image valide pour '+split)
    (root/(split+'.txt')).write_text('\n'.join(accepted)+'\n',encoding='utf-8')
    report['accepted'][split]=len(accepted)
(root/'training-data-check.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report),flush=True)
config=root/'container-pose.yaml'
config.write_text(yaml.safe_dump(dict(path=str(root),train='train.txt',val='val.txt',names={0:'container'},kpt_shape=[4,3]),sort_keys=False),encoding='utf-8')
model=YOLO(args.resume or 'yolo11n-pose.pt')
model.train(data=str(config),epochs=args.epochs,imgsz=640,batch=args.batch,resume=bool(args.resume),device=args.device,workers=0,project=str(root/'runs'),name='container-pose',cache=False,plots=False,save_period=-1)
print('Validez le modèle sur des scènes indépendantes avant de copier best.pt vers vision/models/portique-pose.pt.')
