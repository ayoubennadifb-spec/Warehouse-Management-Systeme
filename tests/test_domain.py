import unittest
from backend import domain as d
class DomainTests(unittest.TestCase):
 def test_geometry(self):
  cells=d.slots(d.DEFAULT);self.assertEqual(len(cells),49);self.assertEqual(cells[0]['gx'],12.5)
 def test_truck_cycle(self):
  s=d.new_state();d.action(s,dict(action='arrive',loaded=True));t=s['trucks'][0];v=next(v for v in s['containers'] if v['truck']==t['id']);d.action(s,dict(action='move',id=v['id'],destination='slot:G7'))
  with self.assertRaises(ValueError):d.action(s,dict(action='depart',id=t['id']))
  d.tick(s,8);self.assertEqual(v['slot'],'G7');d.action(s,dict(action='move',id=v['id'],destination='truck:'+t['id']));d.tick(s,8);self.assertEqual(v['truck'],t['id']);d.action(s,dict(action='depart',id=t['id']));self.assertNotIn(v,s['containers'])
 def test_blocked_stack(self):
  s=d.new_state(seed=False);s['containers']=[dict(id='C001',slot='A1',level=1,state='stored',truck=None),dict(id='C002',slot='A1',level=2,state='stored',truck=None)]
  with self.assertRaises(ValueError):d.action(s,dict(action='move',id='C001',destination='slot:A2'))
 def test_limits(self):
  s=d.new_state();s['config']['maxContainers']=len(s['containers'])
  with self.assertRaises(ValueError):d.action(s,dict(action='arrive',loaded=True))
  with self.assertRaises(ValueError):d.validate({**d.DEFAULT,'nx':8})
 def test_pause(self):
  s=d.new_state();v=s['containers'][0];d.action(s,dict(action='move',id=v['id'],destination='slot:G7'));d.action(s,dict(action='pause'));d.tick(s,100);self.assertEqual(s['mission']['progress'],0)
if __name__=='__main__':unittest.main()
