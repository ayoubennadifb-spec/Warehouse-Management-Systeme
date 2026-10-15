"""Geometry, rejection, tracking and export checks independent of PostgreSQL."""
import json
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path
import cv2
import numpy as np
from capture import demo_frame
from detection import DEFAULT, Tracker, annotate, detect, validate
from worker import export, atomic
from geometry import measure, detect_geometry, object_silhouette
from unittest.mock import patch
import os


class VisionTests(unittest.TestCase):
    def test_volume_silhouette_and_face_are_separate(self):
        frame=np.full((300,400,3),230,np.uint8)
        cv2.fillConvexPoly(frame,np.array([[80,80],[240,80],[260,150],[100,150]]),(130,130,130))
        cv2.fillConvexPoly(frame,np.array([[100,150],[260,150],[260,180],[100,180]]),(30,30,30))
        silhouette=object_silhouette(frame,[78,78,262,182])
        self.assertIsNotNone(silhouette)
        self.assertGreater(len(silhouette['outline_px']),4)
        self.assertTrue(silhouette['face_candidates'])
        top=max(silhouette['face_candidates'],key=lambda d:d['area_px2'])
        self.assertLess(top['area_px2'],silhouette['projected_area_px2'])
        self.assertAlmostEqual(top['area_px2'],11200,delta=800)
        self.assertEqual(top['face_role'],'candidate')

    def test_perspective_surface_is_polygon_area_not_bounding_box(self):
        d = measure([[100, 100], [300, 100], [260, 200], [140, 200]])
        self.assertEqual(d['area_px2'], 16000)
        self.assertEqual(len(d['sides_px']), 4)
        self.assertEqual(d['center_px'], [200, 150])

    def test_quadrilateral_detected_without_color_or_yolo(self):
        frame = np.full((400, 600, 3), 240, np.uint8)
        cv2.fillConvexPoly(frame, np.array([[100, 100], [300, 110], [270, 230], [130, 230]]), (40, 40, 40))
        settings = json.loads(json.dumps(DEFAULT))
        ds, _, _ = detect_geometry(frame, settings)
        self.assertEqual(len(ds), 1)
        self.assertAlmostEqual(ds[0]['area_px2'], 21050, delta=600)
        tracker = Tracker()
        first = tracker.update(ds, 600, 400)[0]['observation_id']
        shifted = measure(np.array(ds[0]['corners_px']) + [3, 2])
        self.assertEqual(tracker.update([shifted], 600, 400)[0]['observation_id'], first)

    def test_image_publication_retries_windows_reader_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)/'original.jpg'
            replace = os.replace
            with patch('worker.os.replace', side_effect=[PermissionError('busy'), PermissionError('busy'), None]) as mocked:
                atomic(target, b'image')
                self.assertEqual(mocked.call_count, 3)
            self.assertEqual(list(Path(folder).glob('*.tmp')), [])
            with patch('worker.os.replace', side_effect=PermissionError('busy')), patch('worker.time.sleep'):
                with self.assertRaises(PermissionError):
                    atomic(target, b'image')
            self.assertEqual(list(Path(folder).glob('*.tmp')), [])
            atomic(target, b'image')
            self.assertEqual(target.read_bytes(), b'image')

    def setUp(self):
        self.settings = json.loads(json.dumps(DEFAULT))

    def test_rotated_top_faces_and_global_pixel_coordinates(self):
        ds, mask, roi = detect(demo_frame(), self.settings)
        self.assertEqual(len(ds), 3)
        self.assertEqual(mask.shape, (540, 960))
        for d, expected in zip(ds, [(210, 160), (650, 180), (420, 390)]):
            self.assertLess(np.linalg.norm(np.array(d['center_px'])-expected), 2)
            self.assertAlmostEqual(d['length_px'], 160, delta=3)
            self.assertAlmostEqual(d['width_px'], 80, delta=3)
            self.assertEqual(len(d['corners_px']), 4)
        self.assertAlmostEqual(ds[1]['angle_deg'], 28, delta=2)
        self.settings['roi'] = dict(x=50, y=10, width=45, height=50)
        selected, _, _ = detect(demo_frame(), self.settings)
        self.assertEqual(len(selected), 1)
        self.assertAlmostEqual(selected[0]['center_px'][0], 650, delta=2)

    def test_non_rectangle_wrong_color_and_truncated_face_rejected(self):
        image = np.full((400, 600, 3), 240, np.uint8)
        cv2.fillConvexPoly(image, np.array([[100, 100], [280, 100], [100, 180]]), (210, 100, 35))
        cv2.rectangle(image, (310, 100), (470, 180), (20, 200, 20), -1)
        cv2.rectangle(image, (0, 250), (160, 330), (210, 100, 35), -1)
        self.assertEqual(detect(image, self.settings)[0], [])

    def test_invalid_roi_and_inverted_thresholds(self):
        self.settings['roi']['width'] = 101
        with self.assertRaises(ValueError): validate(self.settings)
        self.settings = json.loads(json.dumps(DEFAULT)); self.settings['h_min'] = 160
        with self.assertRaises(ValueError): validate(self.settings)

    def test_tracking_preserves_ids_and_measures_dispersion(self):
        tracker = Tracker()
        ids = None
        for _ in range(5):
            ds, _, _ = detect(demo_frame(), self.settings)
            tracked = tracker.update(ds, 960, 540)
            current = [d['observation_id'] for d in tracked]
            if ids is not None: self.assertEqual(current, ids)
            ids = current
        self.assertEqual(tracked[0]['stability']['samples'], 5)
        self.assertEqual(tracked[0]['stability']['center_std_px'], 0)
        for _ in range(6): tracker.update([], 960, 540)
        self.assertFalse(tracker.tracks)

    def test_export_matches_one_frame_and_keeps_inventory_unmodified(self):
        image = demo_frame(); ds, mask, roi = detect(image, self.settings)
        ds = Tracker().update(ds, 960, 540)
        observation = dict(session_id='test', observed_at='2026-10-08T12:00:00Z', source={'kind': 'demo'}, frame_index=1, detections=ds, units='pixels', inventory_updated=False)
        with tempfile.TemporaryDirectory() as directory:
            result = export(Path(directory), '12345678-1234-4234-8234-123456789012', observation, image, mask, annotate(image, ds, roi), self.settings)
            self.assertEqual(len(result['files']), 5)
            folder = Path(directory)/'exports'
            data = json.loads((folder/result['files'][3]).read_text(encoding='utf-8'))
            self.assertFalse(data['inventory_updated'])
            self.assertEqual(data['detections'][0]['center_px'], ds[0]['center_px'])
            self.assertEqual(cv2.imread(str(folder/result['files'][0])).shape, image.shape)
            self.assertEqual(len((folder/result['files'][4]).read_text(encoding='utf-8-sig').splitlines()), 4)

    def test_recorded_video_finishes_and_preserves_last_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); video = root/'test.avi'
            writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*'MJPG'), 15, (960, 540))
            self.assertTrue(writer.isOpened())
            for _ in range(3): writer.write(demo_frame())
            writer.release()
            result = subprocess.run([sys.executable, str(Path(__file__).parent/'worker.py'),
                                     '--headless', '--source', 'video', '--input', str(video),
                                     '--output', str(root/'output'), '--settings', str(root/'settings.json')],
                                    capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            status = json.loads((root/'output/status.json').read_text(encoding='utf-8'))
            self.assertEqual(status['status'], 'ended')
            self.assertEqual(status['frame_index'], 3)
            self.assertEqual(len(status['detections']), 3)


if __name__ == '__main__':
    unittest.main()
