import unittest
from calibration import fit, estimate
from geometry import measure

class CalibrationTests(unittest.TestCase):
    def profile(self):
        uv=[[0,0],[600,0],[600,400],[0,400]]
        return fit(dict(container_mm=dict(length=100,width=50,height=30),resolution=dict(width=640,height=480),source=dict(kind='camera',camera_index=2),levels=[dict(level=i+1,points=[dict(pixel=p,world=[p[0]*scale,p[1]*scale]) for p in uv]) for i,scale in enumerate([1,.8,.6])]))
    def test_three_planes_and_physical_dimensions(self):
        p=self.profile();d=measure([[200,150],[325,150],[325,212.5],[200,212.5]])
        r=estimate(d,p,p['resolution'],p['source'])
        self.assertEqual(r['status'],'estimated');self.assertEqual(r['level'],2)
        self.assertAlmostEqual(r['area_mm2'],5000,places=2)
        self.assertEqual(r['length_mm'],100);self.assertEqual(r['z_top_mm'],60)
        self.assertEqual(r['x_mm'],210);self.assertEqual(r['y_mm'],145)
    def test_ambiguity_source_change_and_yolo_box_are_uncertain(self):
        p=self.profile();d=measure([[200,150],[300,150],[300,200],[200,200]])
        for level in p['levels']:level['matrix']=p['levels'][0]['matrix']
        self.assertEqual(estimate(d,p,p['resolution'],p['source'])['status'],'uncertain')
        self.assertEqual(estimate(d,p,dict(width=1280,height=720),p['source'])['status'],'uncertain')
        d['method']='yolo-box';self.assertEqual(estimate(d,p,p['resolution'],p['source'])['status'],'uncertain')
    def test_outside_coverage_and_degenerate_points(self):
        p=self.profile();d=measure([[610,100],[635,100],[635,200],[610,200]])
        self.assertEqual(estimate(d,p,p['resolution'],p['source'])['status'],'uncertain')
        for level in p['levels']:level['points']=[dict(pixel=[i*10,10],world=[i*10,0]) for i in range(4)]
        with self.assertRaises(ValueError):fit(p)
if __name__=='__main__':unittest.main()
