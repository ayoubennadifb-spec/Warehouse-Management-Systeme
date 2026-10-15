from copy import deepcopy
import os
import unittest
from backend import domain as d,repository as r
from backend.retrieval import plan_retrieval,revision


def small_scene():
    s=d.new_state({**d.DEFAULT,'nx':3,'ny':2},seed=False)
    s['containers']=[dict(id=f'C{i}',state='stored',slot='A1',level=i,truck=None) for i in (1,2,3)]
    return s


class RetrievalTests(unittest.TestCase):
    def test_two_blockers_then_target_with_preview_without_mutation(self):
        s=small_scene();before=deepcopy(s);plan=plan_retrieval(s,'C1','slot:B3')
        self.assertEqual(s,before);self.assertEqual(plan['optimization'],'exhaustive')
        self.assertEqual([x['container'] for x in plan['steps']],['C3','C2','C1'])
        self.assertTrue(all(x['destination'] not in ('slot:A1','slot:B3') for x in plan['steps'][:-1]))
        d.action(s,dict(action='retrieve',id='C1',destination='slot:B3',revision=plan['revision']))
        for expected in ('C3','C2','C1'):
            self.assertEqual(s['mission']['container'],expected)
            d.tick(s,1000)
            for slot in d.slots(s['config']):
                self.assertEqual(sorted(v['level'] for v in d.stack(s,slot['id'])),list(range(1,len(d.stack(s,slot['id']))+1)))
        self.assertIsNone(s['mission']);self.assertEqual(s['operation']['status'],'completed')
        self.assertEqual(next(v for v in s['containers'] if v['id']=='C1')['slot'],'B3')

    def test_optimized_plan_beats_a_deliberately_distant_relocation(self):
        s=small_scene();s['containers']=s['containers'][:2]
        plan=plan_retrieval(s,'C1','slot:B3')
        alternate=deepcopy(s);cost=0
        from backend.retrieval import _move
        for cid,dest in [('C2','slot:A3'),('C1','slot:B3')]:cost+=_move(alternate,cid,dest,'test')['estimatedSeconds']
        self.assertLessEqual(plan['estimatedSeconds'],cost)

    def test_stale_preview_and_insufficient_space_refused(self):
        s=small_scene();plan=plan_retrieval(s,'C1','slot:B3');s['containers'][2]['slot']='A2';s['containers'][2]['level']=1
        with self.assertRaises(ValueError):d.action(s,dict(action='retrieve',id='C1',destination='slot:B3',revision=plan['revision']))
        s=small_scene();s['config']['nx']=1;s['config']['ny']=1
        d.action(s,dict(action='arrive',loaded=False))
        with self.assertRaisesRegex(ValueError,'Pas assez'):plan_retrieval(s,'C1','truck:T01')

    def test_cancel_before_pick_preserves_positions(self):
        s=small_scene();before=deepcopy(s['containers'])
        d.action(s,dict(action='retrieve',id='C1',destination='slot:B3'));d.action(s,dict(action='cancel'))
        self.assertEqual(s['containers'],before);self.assertIsNone(s['mission']);self.assertEqual(s['operation']['status'],'cancelled')

    def test_incident_after_pick_requires_location_confirmation(self):
        s=small_scene();d.action(s,dict(action='retrieve',id='C1',destination='slot:B3'));d.tick(s,2)
        d.action(s,dict(action='incident'));v=next(v for v in s['containers'] if v['id']=='C3')
        self.assertEqual(v['state'],'uncertain');self.assertIsNone(v['slot'])
        with self.assertRaises(ValueError):d.action(s,dict(action='pause'))
        d.action(s,dict(action='resolve',destination='slot:A2'))
        self.assertEqual(v['slot'],'A2');self.assertIsNone(s['mission']);self.assertEqual(s['completed'],0)


@unittest.skipUnless(os.environ.get('TEST_DATABASE_URL'),'Base de tests nécessaire')
class RetrievalPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ['DATABASE_URL']=os.environ['TEST_DATABASE_URL'];r.initialize()

    def test_queue_survives_restart_and_finishes_in_order(self):
        with r.connect() as db:
            r.lock(db);s=r.create_configuration(db,small_scene());d.action(s,dict(action='retrieve',id='C1',destination='slot:B3'));r.save(db,s)
        with r.connect() as db:
            s=r.load(db);d.tick(s,1000);r.save(db,s)
        with r.connect() as db:
            s=r.load(db)
            first=s['operation']['steps'][0]
            moved=next(v for v in s['containers'] if v['id']=='C3')
            self.assertEqual(moved['state'],'stored')
            self.assertEqual(moved['slot'],first['destination'].split(':')[1])
            self.assertEqual(moved['level'],round(first['waypoints'][-1]['z']/s['config']['containerHeight'])+1)
            self.assertEqual(s['mission']['container'],'C2')
            self.assertEqual(next(v for v in s['containers'] if v['id']=='C1')['slot'],'A1')
        r.initialize()
        with r.connect() as db:
            s=r.load(db);self.assertEqual(s['operation']['nextIndex'],1);self.assertEqual(s['operation']['status'],'paused');self.assertTrue(s['mission']['paused'])
            d.action(s,dict(action='pause'));d.tick(s,1000);r.save(db,s)
        with r.connect() as db:
            s=r.load(db)
            second=s['operation']['steps'][1]
            self.assertEqual(next(v for v in s['containers'] if v['id']=='C2')['slot'],second['destination'].split(':')[1])
            self.assertEqual(s['mission']['container'],'C1')
            d.tick(s,1000);r.save(db,s)
        with r.connect() as db:
            s=r.load(db);self.assertEqual(s['operation']['status'],'completed');self.assertEqual(s['completed'],3)
            self.assertEqual(db.execute('SELECT count(*) AS n FROM reservations WHERE released_at IS NULL').fetchone()['n'],0)

    def test_interruption_persists_without_fictitious_return_and_can_reconcile(self):
        with r.connect() as db:
            r.lock(db);s=r.create_configuration(db,small_scene());d.action(s,dict(action='retrieve',id='C1',destination='slot:B3'));r.save(db,s)
        with r.connect() as db:s=r.load(db);d.tick(s,2);d.action(s,dict(action='incident'));r.save(db,s)
        with r.connect() as db:
            s=r.load(db);self.assertEqual(next(v for v in s['containers'] if v['id']=='C3')['state'],'uncertain');self.assertTrue(s['mission']['interrupted'])
            self.assertEqual(db.execute('SELECT count(*) AS n FROM reservations WHERE released_at IS NULL').fetchone()['n'],1)
            d.action(s,dict(action='resolve',destination='slot:A2'));r.save(db,s)
        with r.connect() as db:
            s=r.load(db);self.assertIsNone(s['mission']);self.assertEqual(s['operation']['status'],'cancelled')
            self.assertEqual(db.execute('SELECT count(*) AS n FROM reservations WHERE released_at IS NULL').fetchone()['n'],0)
