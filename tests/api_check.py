"""Run against a dedicated database through TEST_DATABASE_URL. Requires httpx."""
import os, time
os.environ['DATABASE_URL']=os.environ['TEST_DATABASE_URL']
from fastapi.testclient import TestClient
from backend.app import app
from backend.domain import DEFAULT
with TestClient(app) as client:
 assert client.get('/api/health').json()['database']=='PostgreSQL'
 assert client.get('/api/health').json()['app']=='portique-lab'
 hardware=client.get('/api/hardware/status').json()
 assert hardware['physical_commands_enabled'] is False
 before=client.get('/api/state').json()
 checks=client.post('/api/hardware/self-test').json()
 assert checks['passed'] is True,checks
 assert checks['physical_commands_enabled'] is False
 assert client.get('/api/state').json()==before
 assert client.get('/').status_code==200
 c=client.post('/api/action',json={'action':'reset','config':DEFAULT});assert c.status_code==200,c.text
 s=client.post('/api/action',json={'action':'arrive','loaded':True}).json();v=next(v for v in s['containers'] if v['state']=='truck')
 response=client.post('/api/action',json={'action':'move','id':v['id'],'destination':'slot:G7'});assert response.status_code==200,response.text
 assert client.post('/api/action',json={'action':'depart','id':v['truck']}).status_code==409
 assert client.post('/api/action',json={'action':'speed','speed':4}).status_code==200
 deadline=time.monotonic()+12
 while time.monotonic()<deadline:
  s=client.get('/api/state').json()
  if not s['mission']:break
  time.sleep(.2)
 assert s['mission'] is None
 assert next(x for x in s['containers'] if x['id']==v['id'])['slot']=='G7'
 assert client.post('/api/action',json={'action':'arrive','loaded':True},headers={'Origin':'https://other.example'}).status_code==403
 assert client.post('/api/action',json={'action':'speed','speed':100}).status_code==409
 before=client.get('/api/state').json()
 preview=client.post('/api/preview-retrieval',json={'id':'C004','destination':'slot:G6'})
 assert preview.status_code==200,preview.text
 plan=preview.json()
 assert [step['container'] for step in plan['steps']]==['C006','C005','C004']
 assert client.get('/api/state').json()['containers']==before['containers']
 response=client.post('/api/action',json={'action':'retrieve','id':'C004','destination':'slot:G6','revision':plan['revision']})
 assert response.status_code==200,response.text
 deadline=time.monotonic()+max(30,plan["estimatedSeconds"]*2+10)
 while time.monotonic()<deadline:
  s=client.get('/api/state').json()
  if not s['mission']:break
  time.sleep(.2)
 assert s['operation']['status']=='completed',s['operation']
 assert next(v for v in s['containers'] if v['id']=='C004')['slot']=='G6'
 history=client.get('/api/history',params={'limit':2,'kind':'missions'}).json()
 assert len(history)==2,history
 older=client.get('/api/history',params={'limit':2,'kind':'missions','before':history[-1]['id']}).json()
 assert all(row['id']<history[-1]['id'] for row in older)
 impact=client.post('/api/preview-configuration',json={'config':s['config']})
 assert impact.status_code==200,impact.text
 assert impact.json()['possible'] is True
 print('API: health, static assets, PostgreSQL writes, animated transfer, conflict and origin guard passed.')
