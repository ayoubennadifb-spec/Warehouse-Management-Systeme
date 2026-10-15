"""Standalone OpenCV window or headless worker for the native Claude app."""
import argparse
import csv
import io
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from capture import demo_frame, open_capture
from detection import DEFAULT, Tracker, annotate, detect, validate
from calibration import estimate


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic(path, data):
    path = Path(path)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temp.write_bytes(data if isinstance(data, bytes) else data.encode('utf-8'))
    try:
        for attempt in range(12):
            try:
                os.replace(temp, path)
                break
            except PermissionError:
                if attempt == 11:
                    raise
                time.sleep(0.02)
    finally:
        temp.unlink(missing_ok=True)


def write_json(path, value):
    atomic(path, json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2))


def jpeg(frame):
    ok, data = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise ValueError('Impossible d’encoder l’image.')
    return data.tobytes()


def export(output, token, observation, frame, mask, annotated, settings):
    folder = output / 'exports'
    folder.mkdir(exist_ok=True)
    token = str(uuid.UUID(token))
    files = []
    for suffix, image in [('original.png', frame), ('mask.png', mask), ('annotated.png', annotated)]:
        name = token + '-' + suffix
        ok, data = cv2.imencode('.png', image)
        if not ok:
            raise ValueError('Impossible d’enregistrer la capture.')
        atomic(folder / name, data.tobytes()); files.append(name)
    name = token + '-measures.json'
    write_json(folder / name, {**observation, 'settings': settings,
               'units': 'pixels', 'inventory_updated': False, 'identity': 'temporary observation IDs'})
    files.append(name)
    stream = io.StringIO(newline='')
    writer = csv.writer(stream)
    writer.writerow(['session_id', 'observed_at', 'source_kind', 'frame_index', 'observation_id',
                     'center_u_px', 'center_v_px', 'length_px', 'width_px', 'angle_deg', 'area_px2',
                     'rectangularity', 'samples', 'center_std_px', 'length_std_px', 'width_std_px', 'corners_px',
                     'sides_px', 'method', 'label', 'confidence', 'calibration_status', 'level', 'x_mm', 'y_mm', 'z_top_mm', 'area_mm2'])
    for d in observation['detections']:
        stability = d['stability']
        writer.writerow([observation['session_id'], observation['observed_at'], observation['source']['kind'],
                         observation['frame_index'], d['observation_id'], *d['center_px'], d['length_px'],
                         d['width_px'], d['angle_deg'], d['area_px2'], d['rectangularity'],
                         stability['samples'], stability['center_std_px'], stability['length_std_px'],
                         stability['width_std_px'], json.dumps(d['corners_px']), json.dumps(d.get('sides_px', [])),
                         d.get('method', 'color'), d.get('label', 'rectangle'), d.get('confidence'),
                         d.get('real', {}).get('status', 'uncalibrated'), *[d.get('real', {}).get(k) for k in ('level', 'x_mm', 'y_mm', 'z_top_mm', 'area_mm2')]])
    name = token + '-measures.csv'
    atomic(folder / name, '\ufeff' + stream.getvalue()); files.append(name)
    return dict(token=token, created_at=now(), files=files)


SLIDERS = [('H min', 'h_min', 179, 1), ('H max', 'h_max', 179, 1),
           ('S min', 's_min', 255, 1), ('S max', 's_max', 255, 1),
           ('V min', 'v_min', 255, 1), ('V max', 'v_max', 255, 1),
           ('Surface min', 'min_area', 100000, 1),
           ('Ratio min x100', 'min_ratio', 1000, 100), ('Ratio max x100', 'max_ratio', 1000, 100),
           ('Rectangle %', 'rectangularity', 100, 100)]


def gui_init(settings):
    cv2.namedWindow('Reglages', cv2.WINDOW_NORMAL)
    cv2.resizeWindow('Reglages', 620, 650)
    for label, key, maximum, scale in SLIDERS:
        cv2.createTrackbar(label, 'Reglages', round(settings[key]*scale), maximum, lambda _: None)
    for key in ('x', 'y', 'width', 'height'):
        cv2.createTrackbar('ROI ' + key + ' %', 'Reglages', round(settings['roi'][key]), 100, lambda _: None)
    cv2.namedWindow('Vision - original | masque | detections', cv2.WINDOW_NORMAL)


def gui_settings(settings):
    s = json.loads(json.dumps(settings))
    for label, key, _, scale in SLIDERS:
        value = cv2.getTrackbarPos(label, 'Reglages') / scale
        s[key] = int(value) if scale == 1 else value
    for key in ('x', 'y', 'width', 'height'):
        s['roi'][key] = cv2.getTrackbarPos('ROI '+key+' %', 'Reglages')
    return validate(s)


def run(args):
    output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    lock = (output / 'worker.lock').open('a+b')
    lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    settings_path = Path(args.settings).resolve()
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    if not settings_path.exists():
        write_json(settings_path, DEFAULT)
    settings = validate(json.loads(settings_path.read_text(encoding='utf-8')))
    session = str(uuid.uuid4())
    source = dict(kind=args.source, label='Exemple synthétique' if args.source == 'demo' else
                  f'Caméra locale {args.input}' if args.source == 'camera' else Path(args.input).name,
                  synthetic=args.source == 'demo', camera_index=int(args.input) if args.source == 'camera' and args.input.isdigit() else None)
    base = dict(session_id=session, source=source, units='pixels', inventory_updated=False,
                detector=args.detector,
                note='Faces visibles uniquement ; aucune calibration X/Y/Z ; IDs temporaires.')
    write_json(output/'status.json', dict(**base, status='starting', observed_at=None, detections=[]))
    cap = None; count = 0; tracker = Tracker(); latest_export = None
    try:
        model = None
        if args.detector == 'hybrid':
            from geometry import load_model
            model = load_model()
        image_frame = None
        if args.source == 'image':
            image_frame = cv2.imdecode(np.fromfile(args.input, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image_frame is None: raise ValueError('Image illisible ou format non pris en charge.')
        elif args.source != 'demo':
            cap = open_capture(args.source, args.input)
        if not args.headless:
            gui_init(settings)
        previous_settings = None; settings_mtime = None; request_seen = None
        started = time.monotonic()
        while not (args.stop_file and Path(args.stop_file).exists()):
            tick = time.monotonic()
            settings_error = None
            try:
                if args.headless:
                    mtime = settings_path.stat().st_mtime_ns
                    if mtime != settings_mtime:
                        settings = validate(json.loads(settings_path.read_text(encoding='utf-8')))
                        settings_mtime = mtime
                else:
                    settings = gui_settings(settings)
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                settings_error = str(exc)
            if settings != previous_settings:
                tracker = Tracker(); previous_settings = json.loads(json.dumps(settings))
            if args.source == 'demo':
                frame = demo_frame()
            elif args.source == 'image':
                frame = image_frame.copy()
            else:
                ok, frame = cap.read()
                if not ok or frame is None:
                    if count == 0 and args.source == 'video':
                        raise ValueError('Vidéo vide, illisible ou codec non pris en charge.')
                    if args.source == 'video' and args.loop:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0); ok, frame = cap.read(); tracker = Tracker()
                    if not ok or frame is None:
                        if args.source == 'video':
                            write_json(output/'status.json', {**observation, 'status': 'ended', 'latest_export': latest_export})
                            break
                        raise ValueError('Image caméra perdue. Vérifiez DroidCam et relancez la capture.')
            count += 1
            height, width = frame.shape[:2]
            if args.detector == 'color':
                detections, mask, roi = detect(frame, settings)
            else:
                from geometry import detect_geometry
                detections, mask, roi = detect_geometry(frame, settings, model)
            detections = tracker.update(detections, width, height)
            try:
                calibration_path = output/'calibration.json'
                profile = json.loads(calibration_path.read_text(encoding='utf-8')) if calibration_path.exists() else None
                for d in detections:
                    d['real'] = estimate(d, profile, dict(width=width, height=height), source)
            except (OSError, ValueError, KeyError):
                for d in detections:
                    d['real'] = dict(status='uncertain', reason='Calibration illisible')
            annotated = annotate(frame, detections, roi)
            observation = dict(**base, status='running', observed_at=now(), frame_index=count,
                               resolution=dict(width=width, height=height), roi_px=roi,
                               detections=detections, settings_error=settings_error,
                               fps=round(count/max(0.01, time.monotonic()-started), 1),
                               video_position_ms=round(cap.get(cv2.CAP_PROP_POS_MSEC), 2) if cap and args.source == 'video' else None)
            request_path = output/'export-request.json'
            try:
                request = json.loads(request_path.read_text(encoding='utf-8')) if request_path.exists() else None
                if request and request['token'] != request_seen:
                    request_seen = request['token']
                    latest_export = export(output, request_seen, observation, frame, mask, annotated, settings)
            except (ValueError, OSError, KeyError):
                pass
            if not args.headless:
                previews = [cv2.resize(image, (480, round(height*480/width))) for image in
                            [frame, cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR), annotated]]
                cv2.imshow('Vision - original | masque | detections', np.hstack(previews))
                key = cv2.waitKey(1) & 255
                if key in (27, ord('q')):
                    break
                if key == ord('p'):
                    write_json(settings_path, settings); print('Réglages sauvegardés.', flush=True)
                if key == ord('s'):
                    latest_export = export(output, str(uuid.uuid4()), observation, frame, mask, annotated, settings)
                    print('Capture exportée : '+latest_export['token'], flush=True)
            # Publish images before the observation referring to this frame.
            try:
                for kind, image in [('original', frame), ('mask', mask), ('annotated', annotated)]:
                    atomic(output/(kind+'.jpg'), jpeg(image))
            except PermissionError:
                # A reader can briefly hold a Windows image handle. Retry on
                # the next frame instead of stopping the camera and detector.
                continue
            write_json(output/'status.json', dict(**observation, latest_export=latest_export))
            time.sleep(max(0, 1/args.fps-(time.monotonic()-tick)))
    except Exception as exc:
        write_json(output/'status.json', dict(**base, status='error', observed_at=now(), detections=[], error=str(exc)))
        print(str(exc), file=sys.stderr, flush=True)
        return 1
    finally:
        if cap:
            cap.release()
        if not args.headless:
            cv2.destroyAllWindows()
        lock.close()
    status = json.loads((output/'status.json').read_text(encoding='utf-8'))
    if status['status'] != 'ended':
        status['status'] = 'stopped'; write_json(output/'status.json', status)
    return 0


def main():
    parser = argparse.ArgumentParser(description='Détection de faces rectangulaires en pixels (sans modification de l’inventaire).')
    parser.add_argument('--source', choices=['demo', 'video', 'image', 'camera'], default='demo')
    parser.add_argument('--detector', choices=['color', 'geometry', 'hybrid'], default='color')
    parser.add_argument('--input', default='0', help='Indice caméra ou chemin vidéo')
    parser.add_argument('--settings', default=str(Path(__file__).parent.parent/'.local/vision-standalone/settings.json'))
    parser.add_argument('--output', default=str(Path(__file__).parent.parent/'.local/vision-standalone'))
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--loop', action='store_true')
    parser.add_argument('--fps', type=int, choices=range(1, 31), default=15)
    parser.add_argument('--stop-file')
    parser.add_argument('--list-cameras', action='store_true')
    args = parser.parse_args()
    if args.list_cameras:
        from cv2_enumerate_cameras import enumerate_cameras
        backend = cv2.CAP_DSHOW if os.name == 'nt' else cv2.CAP_V4L2
        print(json.dumps([dict(index=c.index, name=c.name) for c in enumerate_cameras(backend)], ensure_ascii=False))
        return 0
    return run(args)


if __name__ == '__main__':
    sys.exit(main())
