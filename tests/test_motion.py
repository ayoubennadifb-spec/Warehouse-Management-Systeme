from copy import deepcopy
import unittest
from backend import domain as d
from backend.motion import route_seconds,approach,top_position
from backend.retrieval import plan_retrieval
from test_retrieval import small_scene

class MotionTests(unittest.TestCase):
    def test_triangular_and_trapezoidal_acceleration(self):
        route=lambda x,z:dict(waypoints=[dict(x=0,y=0,z=0),dict(x=x,y=0,z=z)])
        self.assertAlmostEqual(route_seconds(route(50,0)),1)
        self.assertAlmostEqual(route_seconds(route(200,0)),2.5)
        self.assertAlmostEqual(route_seconds(route(0,100)),2.5)
    def test_empty_routes_and_costs_include_initial_position(self):
        s=small_scene();s['gripper']=dict(x=0,y=0,z=200);before=deepcopy(s)
        plan=plan_retrieval(s,'C1','slot:B3')
        self.assertEqual(s,before);self.assertFalse(plan['initialPositionAssumed'])
        self.assertEqual(plan['steps'][0]['emptyWaypoints'][0],s['gripper'])
        self.assertGreater(plan['emptyDistanceMm'],0)
        self.assertAlmostEqual(plan['totalDistanceMm'],plan['loadedDistanceMm']+plan['emptyDistanceMm'])
        self.assertAlmostEqual(plan['estimatedSeconds'],sum(x['estimatedSeconds'] for x in plan['steps']))
        for first,second in zip(plan['steps'],plan['steps'][1:]):
            self.assertEqual(second['emptyWaypoints'][0],top_position(s,first['waypoints'][-1]))
    def test_no_pick_before_empty_approach_finishes(self):
        s=small_scene();s['gripper']=dict(x=0,y=0,z=200)
        d.action(s,dict(action='retrieve',id='C1',destination='slot:B3'))
        m=s['mission'];d.tick(s,m['durationSeconds']*m['pickupProgress']*.5)
        self.assertEqual(next(v for v in s['containers'] if v['id']=='C3')['state'],'stored')
        d.action(s,dict(action='cancel'))
        self.assertNotEqual(s['gripper'],dict(x=0,y=0,z=200))
        self.assertIsNotNone(s['gripper'])
