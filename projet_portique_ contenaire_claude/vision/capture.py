"""Video files and local webcam indices (including DroidCam)."""
import os
import cv2
import numpy as np


def open_capture(kind, source):
    if kind == 'camera':
        index = int(source)
        if not 0 <= index <= 20:
            raise ValueError('Indice caméra : entier de 0 à 20.')
        cap = cv2.VideoCapture(index, cv2.CAP_DSHOW) if os.name == 'nt' else cv2.VideoCapture(index)
        if not cap.isOpened() and os.name == 'nt':
            cap.release(); cap = cv2.VideoCapture(index)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    else:
        cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        cap.release()
        raise ValueError('Source inaccessible. Vérifiez le fichier ou la caméra et fermez les applications qui l’occupent.')
    return cap


def demo_frame():
    frame = np.full((540, 960, 3), 242, np.uint8)
    for cx, cy, angle in [(210, 160, 0), (650, 180, 28), (420, 390, 75)]:
        box = cv2.boxPoints(((cx, cy), (160, 80), angle)).astype(np.int32)
        cv2.fillConvexPoly(frame, box, (210, 100, 35))
    cv2.putText(frame, 'EXEMPLE SYNTHETIQUE - aucune camera', (15, 30), cv2.FONT_HERSHEY_SIMPLEX,
                0.65, (60, 60, 60), 1, cv2.LINE_AA)
    return frame
