# Entraîner dans Google Colab

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
