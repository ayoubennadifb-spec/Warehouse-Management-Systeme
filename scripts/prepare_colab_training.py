"""Package the verified dataset and create a Colab notebook without cloud credentials."""
import hashlib
import json
import zipfile
from pathlib import Path

workspace = Path(__file__).resolve().parents[1]
dataset = workspace / '.local/synthetic-containers-20261008-221130'
output = workspace / 'colab_vision'
output.mkdir(exist_ok=True)
report = json.loads((dataset / 'training-data-check.json').read_text())
archive = output / 'portique_dataset.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as pack:
    for split in ('train', 'val'):
        paths = (dataset / (split + '.txt')).read_text().splitlines()
        assert len(paths) == report['accepted'][split]
        for image_name in paths:
            image = Path(image_name)
            image.resolve().relative_to(dataset.resolve())
            pack.write(image, 'images/' + split + '/' + image.name)
            label = dataset / 'labels' / split / (image.stem + '.txt')
            pack.write(label, 'labels/' + split + '/' + label.name)
    pack.write(dataset / 'runs/container-pose/weights/last.pt', 'checkpoint/last.pt')
    pack.writestr('dataset-summary.json', json.dumps(report, indent=2))
with zipfile.ZipFile(archive) as pack:
    assert pack.testzip() is None
    assert len([n for n in pack.namelist() if n.endswith('.png')]) == 419

cells = []
def markdown(text):
    cells.append(dict(cell_type='markdown', metadata={}, source=text.splitlines(keepends=True)))
def code(text):
    compile(text, '<notebook>', 'exec')
    cells.append(dict(cell_type='code', metadata={}, execution_count=None, outputs=[], source=text.splitlines(keepends=True)))

markdown('''# Portique : entraînement YOLO Pose sur GPU
Ce notebook reprend les deux passages sauvegardés avec 314 images d’entraînement et 105 images de validation.
Il apprend une classe « container » et quatre coins de la face supérieure.

1. Dans Google Drive, créer le dossier **PortiqueVision** et y déposer **portique_dataset.zip**.
2. Dans Colab, choisir **Exécution → Modifier le type d’exécution → GPU**, puis **Exécution → Tout exécuter**.
3. Autoriser vous-même la connexion à Drive lorsqu’elle est demandée.

Les résultats sont sauvegardés dans **Mon Drive/PortiqueVision/runs/container-pose**.
Si la session est interrompue, relancer ce notebook : il reprend le dernier passage sauvegardé dans Drive.
Les scores mesurent des images synthétiques. Tester ensuite sur de nouvelles photos réelles avant utilisation dans le robot.
''')
code('''import subprocess, sys
subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'ultralytics==8.4.174'])
import torch
assert torch.cuda.is_available(), 'Active le GPU dans Exécution → Modifier le type d’exécution.'
print('GPU :', torch.cuda.get_device_name(0))
''')
code('''from google.colab import drive
drive.mount('/content/drive')
from pathlib import Path
DRIVE = Path('/content/drive/MyDrive/PortiqueVision')
ARCHIVE = DRIVE / 'portique_dataset.zip'
assert ARCHIVE.exists(), 'Dépose portique_dataset.zip dans Mon Drive/PortiqueVision.'
DATA = Path('/content/portique_dataset')
RUN = DRIVE / 'runs/container-pose'
RUN.mkdir(parents=True, exist_ok=True)
''')
code('''import zipfile, math, json, yaml, cv2
DATA.mkdir(exist_ok=True)
with zipfile.ZipFile(ARCHIVE) as pack:
    for name in pack.namelist():
        (DATA / name).resolve().relative_to(DATA.resolve())
    pack.extractall(DATA)
for split, expected in [('train',314), ('val',105)]:
    images = sorted((DATA / 'images' / split).glob('*.png'))
    assert len(images) == expected
    for image in images:
        assert cv2.imread(str(image)) is not None, str(image)
        for line in (DATA / 'labels' / split / (image.stem + '.txt')).read_text().splitlines():
            values = list(map(float, line.split()))
            assert len(values) == 17 and values[0] == 0 and all(math.isfinite(v) for v in values)
            assert all(0 <= v <= 1 for v in values[1:5])
            for j in range(5,17,3):
                assert 0 <= values[j] <= 1 and 0 <= values[j+1] <= 1 and values[j+2] in (0,2)
    print(split, len(images), 'images vérifiées')
CONFIG = DATA / 'container-pose.yaml'
CONFIG.write_text(yaml.safe_dump(dict(path=str(DATA),train='images/train',val='images/val',names={0:'container'},kpt_shape=[4,3])))
''')
code('''from ultralytics import YOLO
import torch

assert torch.cuda.is_available(), "Active le GPU dans Colab."
checkpoint = DRIVE / "runs/container-pose/weights/last.pt"
if not checkpoint.exists():
    checkpoint = DATA / "checkpoint/last.pt"

# Conserver les poids appris ; reconstruire un optimiseur neuf sur Colab.
model = YOLO(str(checkpoint))
model.reset_callbacks()
results = model.train(
    resume=False,
    data=str(CONFIG),
    epochs=100,
    device=0,
    batch=4,
    workers=2,
    amp=False,
    optimizer="AdamW",
    cache=False,
    plots=False,
    save_period=-1,
    project=str(DRIVE / "runs"),
    name="container-pose-gpu",
)
RUN = Path(model.trainer.save_dir)
print("Résultats sauvegardés dans :", RUN)
''')
code('''BEST = RUN / 'weights/best.pt'
assert BEST.exists(), 'Le meilleur modèle n’est pas encore sauvegardé.'
evaluation = YOLO(str(BEST)).val(data=str(CONFIG), device=0, batch=4,
                               plots=False, project=str(DRIVE / 'evaluation'), name='synthetic')
summary = {key: float(value) for key, value in evaluation.results_dict.items()}
(DRIVE / 'validation-synthetic.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
print('Modèle à récupérer :', BEST)
''')
code('''from google.colab import files
files.download(str(BEST))
''')
notebook = dict(cells=cells, metadata=dict(colab=dict(name='Portique_YOLO_Pose.ipynb'),
    kernelspec=dict(display_name='Python 3',language='python',name='python3'),
    accelerator='GPU', language_info=dict(name='python')), nbformat=4, nbformat_minor=5)
(output / 'Portique_YOLO_Pose.ipynb').write_text(json.dumps(notebook,ensure_ascii=False,indent=2),encoding='utf-8')
(output / 'README.md').write_text('''# Entraîner dans Google Colab

1. Créer dans Google Drive un dossier `PortiqueVision`.
2. Y transférer `portique_dataset.zip` (419 images, annotations et sauvegarde).
3. Ouvrir https://colab.research.google.com/ puis Fichier → Importer un notebook.
4. Importer `Portique_YOLO_Pose.ipynb`.
5. Exécution → Modifier le type d’exécution → GPU.
6. Exécution → Tout exécuter, puis autoriser personnellement la connexion à Drive.
7. À la fin, récupérer `best.pt`. Le notebook le propose en téléchargement.

L’entraînement reprend les deux premiers passages. Les sauvegardes vont dans
`Mon Drive/PortiqueVision/runs/container-pose/weights` à chaque passage terminé.
Après une interruption, relancer le même notebook pour reprendre.
Lancer une seule session d’entraînement à la fois sur ce dossier.
Les 105 images de validation sont synthétiques : les scores ne prouvent pas la précision sur caméra réelle.
Conserver une copie du modèle actuel avant d’intégrer le nouveau modèle après vérification.
''',encoding='utf-8')
print(json.dumps(dict(archive=str(archive),bytes=archive.stat().st_size,images=419,
    notebook=str(output/'Portique_YOLO_Pose.ipynb')),ensure_ascii=False))
