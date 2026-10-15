"""Adapt native Claude geometry to the reusable simulation planner."""
import json,sys
from backend import domain as d
from backend import motion
from backend.retrieval import plan_retrieval,_move
from backend.trajectory import plan_trajectory

def run(b):
 if b['mode']=='hardware-test':
  from backend.hardware import self_test
  return self_test()
 if b['mode']=='hardware-status':
  from backend.hardware import HardwareGuard
  return HardwareGuard().status()
 e=b['state'];p=e['plan']['parametres'];g=e['plan']['geometrie'];h=p['conteneur']['hauteur_mm'];L=p['conteneur']['longueur_mm'];W=p['conteneur']['largeur_mm']
 c=dict(d.DEFAULT,length=p['espace']['longueur_x_mm'],width=p['espace']['largeur_y_mm'],containerLength=L,containerWidth=W,containerHeight=h,levels=p['grille']['nb_niveaux_max'])
 cells=[dict(id=x['code'],x=x['centre_x_mm']-L/2,y=x['centre_y_mm']-W/2) for x in g['positions']]
 allowed=[x for x in cells if next(y for y in g['positions'] if y['code']==x['id'])['statut']=='DISPONIBLE']
 d.slots=lambda _:allowed
 trucks={x['camion_code']:x for x in e['visites']}
 d.bay_position=lambda _,bay:dict(x=trucks[bay]['plateau_x_mm']-L/2,y=trucks[bay]['plateau_y_mm']-W/2,z=trucks[bay]['plateau_z_mm'])
 def pos(s,v):
  if v['state']=='truck':return d.bay_position(c,v['truck'])
  cell=next(x for x in cells if x['id']==v['slot']);return dict(x=cell['x'],y=cell['y'],z=(v['level']-1)*h)
 d.position=pos
 def obstacles(s,cid):
  boxes=[]
  for v in s['containers']:
   if v['id']==cid or v['state'] not in ('stored','truck'):continue
   z=pos(s,v);boxes.append(dict(x=z['x'],y=z['y'],length=L,width=W,top=z['z']+h))
  for t in trucks.values():
   # Native plateau center and cabin direction, including cabin dimensions.
   sign=-1 if t['cote_cabine']=='X_MIN' else 1
   center=t['plateau_x_mm']+sign*(t['plateau_longueur_mm']+t['cabine_longueur_mm'])/2
   boxes.append(dict(x=center-t['cabine_longueur_mm']/2,y=t['plateau_y_mm']-t['cabine_largeur_mm']/2,length=t['cabine_longueur_mm'],width=t['cabine_largeur_mm'],top=t['cabine_hauteur_mm']))
  return boxes
 d.trajectory_obstacles=obstacles
 s=dict(config=c,containers=[dict(id=v['code'],slot=v['code_position'],level=v['niveau'] if v['type_emplacement']=='CASE' else None,truck=v['code_camion'],state='stored' if v['type_emplacement']=='CASE' else 'truck') for v in e['conteneurs'] if v['etat']=='EN_PLACE'],trucks=[dict(id=k,bay=k) for k in trucks],mission=None,gripper=None)
 u=b.get('position') or e.get('unite')
 if u and u.get('x_mm') is not None:s['gripper']=dict(x=u['x_mm']-L/2,y=u['y_mm']-W/2,z=u['z_mm']+h)
 if b['mode']=='retrieval':r=plan_retrieval(s,b['container'],b['destination'])
 elif b['mode']=='resume':
  route=plan_trajectory(c,b['start'],b['end'],obstacles(s,None),{'routeScore':motion.route_seconds});r=dict(steps=[dict(**route,emptyWaypoints=[],estimatedSeconds=motion.route_seconds(route)+motion.PROFILE['placeSeconds'])])
 else:
  step=_move(s,b['container'],b['destination'],'target');r=dict(steps=[step])
 for step in r['steps']:
  step['loadedSegmentSeconds']=[motion.route_seconds({'waypoints':[a,q]}) for a,q in zip(step['waypoints'],step['waypoints'][1:])]
  step['emptySegmentSeconds']=[motion.route_seconds({'waypoints':[a,q]}) for a,q in zip(step['emptyWaypoints'],step['emptyWaypoints'][1:])]
  # All native positions denote load center/base; empty gripper uses this same convention.
  step['waypoints']=[dict(x=q['x']+L/2,y=q['y']+W/2,z=q['z']) for q in step['waypoints']]
  step['emptyWaypoints']=[dict(x=q['x']+L/2,y=q['y']+W/2,z=q['z']-h) for q in step['emptyWaypoints']]
 return r
try:print(json.dumps(run(json.load(sys.stdin)),ensure_ascii=False))
except Exception as e:print(json.dumps({'error':str(e)}));sys.exit(1)
