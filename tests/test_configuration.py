from copy import deepcopy
import os
import unittest
from backend import domain as d,repository as r
from backend.configuration import impact,reconfigure


class ConfigurationTests(unittest.TestCase):
    def test_compatible_change_preserves_inventory(self):
        s=d.new_state();before=deepcopy(s);config={**s['config'],'width':600}
        self.assertTrue(impact(s,config)['possible']);new=reconfigure(s,config)
        self.assertEqual(s,before);self.assertEqual(new['containers'],s['containers']);self.assertEqual(new['config']['width'],600)
    def test_occupied_removed_level_and_capacity_refused(self):
        s=d.new_state()
        for changes in ({'levels':1},{'maxContainers':10},{'nx':2}):
            result=impact(s,{**s['config'],**changes});self.assertFalse(result['possible'])
            with self.assertRaises(ValueError):reconfigure(s,{**s['config'],**changes})
    def test_active_mission_refused(self):
        s=d.new_state();d.action(s,dict(action='move',id='C001',destination='slot:G7'))
        self.assertFalse(impact(s,{**s['config'],'width':600})['possible'])


@unittest.skipUnless(os.environ.get('TEST_DATABASE_URL'),'Base de tests nécessaire')
class ConfigurationPersistenceTests(unittest.TestCase):
    def test_new_configuration_preserves_and_archives(self):
        os.environ['DATABASE_URL']=os.environ['TEST_DATABASE_URL'];r.initialize()
        with r.connect() as db:
            r.lock(db);s=r.create_configuration(db,d.new_state());old=s['_config_id'];before=deepcopy(s['containers'])
            new=r.create_configuration(db,reconfigure(s,{**s['config'],'width':600}));new_id=new['_config_id']
        with r.connect() as db:
            s=r.load(db);self.assertEqual(s['containers'],before);self.assertEqual(s['_config_id'],new_id)
            self.assertFalse(db.execute('SELECT active FROM configurations WHERE id=%s',(old,)).fetchone()['active'])
            self.assertEqual(db.execute('SELECT count(*) AS n FROM conteneurs WHERE configuration_id=%s',(old,)).fetchone()['n'],24)
