"""One-time official weights and text embeddings download; runtime is offline."""
from pathlib import Path
from ultralytics import YOLOWorld
folder=Path(__file__).parent/'models'
folder.mkdir(exist_ok=True)
model=YOLOWorld(str(folder/'yolov8s-worldv2.pt'))
model.set_classes(['shipping container','box','rectangular card','rectangular object'])
model.save(str(folder/'portique-world.pt'))
print('Modèle YOLO-World préparé pour une utilisation locale.')
