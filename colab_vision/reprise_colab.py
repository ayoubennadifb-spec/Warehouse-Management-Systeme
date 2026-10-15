from ultralytics import YOLO
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
