import json
from pathlib import Path
import shutil
import subprocess
import unittest
from backend.domain import DEFAULT
from backend.trajectory import plan_trajectory

ROOT=Path(__file__).resolve().parents[1]
CASES=json.loads((ROOT/'tests/trajectory_cases.json').read_text(encoding='utf-8'))


class TrajectoryTests(unittest.TestCase):
    def test_expected_routes_and_collision_free_swept_volume(self):
        for case in CASES:
            with self.subTest(case=case['name']):
                args=(DEFAULT,case['start'],case['end'],case['obstacles'])
                if case.get('error'):
                    with self.assertRaises(ValueError):plan_trajectory(*args)
                    continue
                route=plan_trajectory(*args)
                self.assertAlmostEqual(route['routeLengthMm'],case['length'])
                self.assertAlmostEqual(route['cruiseHeightMm'],case['height'])
                self.assertEqual(route['waypoints'][0],case['start'])
                self.assertEqual(route['waypoints'][-1],case['end'])
                for a,b in zip(route['waypoints'],route['waypoints'][1:]):
                    self.assertEqual(sum(abs(a[k]-b[k])>1e-7 for k in ('x','y','z')),1)
                    for i in range(101):
                        p={k:a[k]+(b[k]-a[k])*i/100 for k in ('x','y','z')}
                        for obstacle in case['obstacles']:
                            overlap=(p['x']<obstacle['x']+obstacle['length']-1e-7 and
                                     p['x']+DEFAULT['containerLength']>obstacle['x']+1e-7 and
                                     p['y']<obstacle['y']+obstacle['width']-1e-7 and
                                     p['y']+DEFAULT['containerWidth']>obstacle['y']+1e-7)
                            self.assertFalse(overlap and p['z']<obstacle['top']-1e-7)

    def test_rejects_invalid_parameters_and_out_of_bounds(self):
        a,b=dict(x=100,y=100,z=0),dict(x=700,y=100,z=0)
        for options in ({'clearanceMm':-1},{'maxHeightMm':float('nan')},{'horizontalClearanceMm':True}):
            with self.assertRaises(ValueError):plan_trajectory(DEFAULT,a,b,[],options)
        with self.assertRaises(ValueError):plan_trajectory(DEFAULT,a,dict(x=950,y=100,z=0),[])

    @unittest.skipUnless(shutil.which('node'),'Node nécessaire pour comparaison Python/JavaScript')
    def test_browser_and_server_return_identical_routes(self):
        code="""import fs from 'node:fs'; import {DEFAULT_CONFIG} from './dist/core.js'; import {planTrajectory} from './dist/trajectory.js'; const cases=JSON.parse(fs.readFileSync('tests/trajectory_cases.json','utf8')); console.log(JSON.stringify(cases.filter(c=>!c.error).map(c=>planTrajectory(DEFAULT_CONFIG,c.start,c.end,c.obstacles))));"""
        actual=json.loads(subprocess.check_output(['node','--input-type=module','-e',code],cwd=ROOT,text=True))
        expected=[plan_trajectory(DEFAULT,c['start'],c['end'],c['obstacles']) for c in CASES if not c.get('error')]
        self.assertEqual(actual,expected)
