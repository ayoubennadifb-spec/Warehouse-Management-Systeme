import os, unittest
from unittest.mock import patch
from backend import repository as r, domain as d
@unittest.skipUnless(os.environ.get('TEST_DATABASE_URL'),'Définir TEST_DATABASE_URL vers une base de test dédiée')
class RepositoryTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  os.environ['DATABASE_URL']=os.environ['TEST_DATABASE_URL'];r.initialize()
 def test_01_complete_truck_roundtrip_and_persistence(self):
  with r.connect() as db:r.lock(db);s=r.create_configuration(db,d.new_state());cfg=s['_config_id']
  with r.connect() as db:
   s=r.load(db);self.assertEqual(len(s['containers']),24);self.assertEqual(db.execute('SELECT count(*) AS n FROM emplacements WHERE configuration_id=%s',(cfg,)).fetchone()['n'],147)
   d.action(s,dict(action='arrive',loaded=True));r.save(db,s);tid=s['trucks'][0]['id'];cid=next(v['id'] for v in s['containers'] if v['truck']==tid)
  with r.connect() as db:
   s=r.load(db);d.action(s,dict(action='move',id=cid,destination='slot:G7'));r.save(db,s)
  with r.connect() as db:
   s=r.load(db);d.tick(s,2);r.save(db,s)
  with r.connect() as db:
   s=r.load(db);self.assertEqual(next(v['state'] for v in s['containers'] if v['id']==cid),'transit');d.tick(s,7);r.save(db,s)
  with r.connect() as db:
   s=r.load(db);self.assertEqual(s['completed'],1);d.action(s,dict(action='move',id=cid,destination='truck:'+tid));r.save(db,s)
  with r.connect() as db:
   s=r.load(db);d.tick(s,8);r.save(db,s)
  with r.connect() as db:
   s=r.load(db);self.assertEqual(s['completed'],2);d.action(s,dict(action='depart',id=tid));r.save(db,s)
  with r.connect() as db:
   s=r.load(db);self.assertEqual(len(s['containers']),24);self.assertEqual(len(s['trucks']),0);self.assertEqual(db.execute('SELECT count(*) AS n FROM reservations WHERE released_at IS NULL').fetchone()['n'],0)
   self.assertEqual(db.execute("SELECT state FROM conteneurs WHERE configuration_id=%s AND code=%s",(cfg,cid)).fetchone()['state'],'departed')
 def test_02_constraints_and_rollback(self):
  with r.connect() as db:r.lock(db);s=r.create_configuration(db,d.new_state());cfg=s['_config_id']
  with self.assertRaises(r.psycopg.IntegrityError):
   with r.connect() as db:
    rows=db.execute('SELECT id,emplacement_id FROM conteneurs WHERE configuration_id=%s ORDER BY id LIMIT 2',(cfg,)).fetchall();db.execute('UPDATE conteneurs SET emplacement_id=%s WHERE id=%s',(rows[0]['emplacement_id'],rows[1]['id']))
  with r.connect() as db:self.assertEqual(len(r.load(db)['containers']),24)
 def test_03_restart_pauses_mission(self):
  with r.connect() as db:
   r.lock(db);s=r.create_configuration(db,d.new_state());d.action(s,dict(action='move',id=s['containers'][0]['id'],destination='slot:G7'));r.save(db,s)
  r.initialize()
  with r.connect() as db:
   s=r.load(db);self.assertTrue(s['mission']['paused']);s['mission']['paused']=False;d.tick(s,8);r.save(db,s)
 def test_04_archives_configuration(self):
  with r.connect() as db:
   r.lock(db);old=r.load(db)['_config_id'];s=r.create_configuration(db,d.new_state({**d.DEFAULT,'nx':6}));new=s['_config_id']
  with r.connect() as db:
   self.assertNotEqual(old,new);self.assertFalse(db.execute('SELECT active FROM configurations WHERE id=%s',(old,)).fetchone()['active']);self.assertEqual(db.execute('SELECT count(*) AS n FROM emplacements WHERE configuration_id=%s',(new,)).fetchone()['n'],126)
 def test_05_simulation_cannot_be_relabelled_real(self):
  with patch.dict(os.environ,{'APP_MODE':'real'}):
   with self.assertRaises(ValueError):r.initialize()
  with r.connect() as db:self.assertEqual(db.execute('SELECT mode FROM configurations WHERE active').fetchone()['mode'],'simulation')
