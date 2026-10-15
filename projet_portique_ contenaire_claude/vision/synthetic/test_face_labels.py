import unittest
import numpy as np
from face_labels import project,visible_faces,polygon_label

class FaceLabelsTests(unittest.TestCase):
    def metadata(self,levels):
        camera=np.eye(4);camera[2,3]=1
        meta=dict(resolution=[640,480],camera_lens=36,camera_matrix_world=camera.tolist(),dimensions_mm=[200,90,90],objects=[])
        for level in levels:
            top=np.array([[-100,-45,level*90],[100,-45,level*90],[100,45,level*90],[-100,45,level*90]])
            pixels,_=project(top,meta)
            meta['objects'].append(dict(name=str(level),center_mm=[0,0,(level-.5)*90],top_corners=[dict(world_mm=p.tolist(),pixel=q.tolist()) for p,q in zip(top,pixels)]))
        return meta

    def test_overhead_projection_and_top_visibility(self):
        ids,faces,error=visible_faces(self.metadata([1]))
        self.assertEqual(len(faces),1)
        self.assertEqual(faces[0]['kind'],0)
        self.assertEqual(error,0)
        self.assertGreater((ids>0).sum(),8000)

    def test_higher_container_occludes_lower_top(self):
        ids,faces,_=visible_faces(self.metadata([1,2]))
        lower=next(f['id'] for f in faces if f['object']=='1')
        upper=next(f['id'] for f in faces if f['object']=='2')
        self.assertEqual((ids==lower).sum(),0)
        self.assertGreater((ids==upper).sum(),0)

    def test_disconnected_major_parts_rejected(self):
        mask=np.zeros((100,100),np.uint8);mask[10:30,10:30]=1;mask[60:80,60:80]=1
        polygon,reason=polygon_label(mask)
        self.assertIsNone(polygon)
        self.assertIsNotNone(reason)

if __name__=='__main__':unittest.main()
