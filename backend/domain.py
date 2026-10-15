"""Pure domain model. All dimensions in mm; no hardware commands."""
import math, uuid
from datetime import datetime, timezone
from .trajectory import CABIN_TOP_MM, plan_trajectory
DEFAULT = dict(length=1000,width=500,transportLength=200,nx=7,ny=7,levels=3,maxContainers=60,containerLength=100,containerWidth=50,containerHeight=50,cabinLength=50,bays=3)
def validate(c):
    if set(c)!=set(DEFAULT): raise ValueError('Paramètres manquants ou inconnus.')
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0 for v in c.values()): raise ValueError('Les paramètres doivent être positifs et finis.')
    for k in ('nx','ny','levels','maxContainers','bays'):
        if c[k]!=int(c[k]): raise ValueError('Les quantités doivent être entières.')
        c[k]=int(c[k])
    if c['nx']>20 or c['ny']>20 or c['levels']>10 or c['bays']>8 or c['maxContainers']>1000: raise ValueError('Limites du simulateur dépassées.')
    if c['transportLength']>=c['length'] or c['nx']*c['containerLength']>=c['length']-c['transportLength'] or c['ny']*c['containerWidth']>=c['width']: raise ValueError('La grille ne tient pas dans la zone de stockage.')
    if c['cabinLength']+c['containerLength']>c['transportLength'] or c['bays']*c['containerWidth']>=c['width']: raise ValueError('Les camions ne tiennent pas dans la zone de transport.')
    return c

def slots(c):
    gx=(c['length']-c['transportLength']-c['nx']*c['containerLength'])/(c['nx']+1); gy=(c['width']-c['ny']*c['containerWidth'])/(c['ny']+1)
    return [dict(id=chr(65+j)+str(i+1),x=c['transportLength']+gx+i*(c['containerLength']+gx),y=gy+j*(c['containerWidth']+gy),gx=gx,gy=gy) for j in range(c['ny']) for i in range(c['nx'])]
def log(s,msg,kind='simulation'):
    s['events'].insert(0,dict(id=str(uuid.uuid4()),at=datetime.now(timezone.utc).isoformat(),message=msg,kind=kind)); s['events']=s['events'][:80]
def stack(s,slot): return sorted([v for v in s['containers'] if v['slot']==slot and v['state']=='stored'],key=lambda v:v['level'],reverse=True)
def new_state(c=None,seed=True):
    c=validate(dict(c or DEFAULT)); s=dict(version=1,config=c,containers=[],trucks=[],events=[],mission=None,operation=None,gripper=None,completed=0,nextId=1,nextTruck=1)
    if seed:
        cells=slots(c);cells=[x[1] for x in sorted(enumerate(cells),key=lambda p:(p[0]*17)%len(cells))]
        for j,cell in enumerate(cells):
            for level in range(1,min(c['levels'],1+j%3)+1):
                if len(s['containers'])>=min(24,c['maxContainers']):break
                s['containers'].append(dict(id=f'C{s["nextId"]:03}',slot=cell['id'],level=level,state='stored',truck=None));s['nextId']+=1
        log(s,'Configuration de démonstration chargée.')
    return s
def bay_position(c,bay): return dict(x=(c['transportLength']-c['containerLength']-c['cabinLength'])/2+c['cabinLength'],y=(bay+.5)*c['width']/c['bays']-c['containerWidth']/2,z=0)
def position(s,v):
    if v['state']=='truck': return bay_position(s['config'],next(t['bay'] for t in s['trucks'] if t['id']==v['truck']))
    cell=next(x for x in slots(s['config']) if x['id']==v['slot']);return dict(x=cell['x'],y=cell['y'],z=(v['level']-1)*s['config']['containerHeight'])

def trajectory_obstacles(s, moving_id):
    """Known stationary footprints, excluding the container being carried."""
    c=s['config']; footprints={}
    for v in s['containers']:
        if v['id']==moving_id or v['state'] not in ('stored','truck'):continue
        p=position(s,v); key=(p['x'],p['y'])
        top=p['z']+c['containerHeight']
        if key not in footprints or top>footprints[key]['top']:
            footprints[key]=dict(x=p['x'],y=p['y'],length=c['containerLength'],width=c['containerWidth'],top=top)
    result=list(footprints.values())
    for t in s['trucks']:
        p=bay_position(c,t['bay'])
        result.append(dict(x=p['x']-c['cabinLength'],y=p['y'],length=c['cabinLength'],width=c['containerWidth'],top=CABIN_TOP_MM))
    return result
def tick(s,dt,speed=1):
    m=s['mission']
    if not m or m['paused']: return
    m['progress']=min(1,m['progress']+dt*speed/m.get('durationSeconds',7));v=next(x for x in s['containers'] if x['id']==m['container'])
    if m.get('emptyWaypoints') and m['progress']<m.get('pickupProgress',.15):
        from .motion import along
        s['gripper']=along(m['emptyWaypoints'],m['progress']/m['pickupProgress'])
    if m['progress']>=m.get('pickupProgress',.15) and v['state']!='transit':
        v.update(state='transit',slot=None,level=None,truck=None);log(s,f'{m["id"]} · prise confirmée en simulation.','picked')
    if m['progress']>=1:
        if m['kind']=='slot':v.update(state='stored',slot=m['target'],level=round(m['end']['z']/s['config']['containerHeight'])+1,truck=None)
        else:v.update(state='truck',truck=m['target'],slot=None,level=None)
        location=f'case {v["slot"]}, niveau {v["level"]}' if v['state']=='stored' else f'camion {v["truck"]}'
        s['completed']+=1;log(s,f'{m["id"]} terminée · position de {v["id"]} mise à jour : {location} (dépôt confirmé en simulation).','deposited');s['mission']=None
        s['_mission_end']=dict(code=m['id'],status='completed')
        from .motion import top_position
        s['gripper']=top_position(s,m['end'])
        op=s.get('operation')
        if op and op['status']=='running' and m.get('operationId')==op['id']:
            op['nextIndex']+=1
            if op['nextIndex']<len(op['steps']):
                from .retrieval import start_step
                start_step(s)
            else:
                op['status']='completed';log(s,f'Cible {op["target"]} déplacée ; dégagement terminé.','operation_completed')

def destination_position(s,v,dest):
    if not isinstance(dest,str):raise ValueError('Destination invalide.')
    kind,_,target=dest.partition(':')
    if kind=='slot':
        p=next((x for x in slots(s['config']) if x['id']==target),None);pile=stack(s,target)
        if not p or target==v['slot'] or len(pile)>=s['config']['levels']:raise ValueError('Destination invalide ou pleine.')
        return dict(x=p['x'],y=p['y'],z=len(pile)*s['config']['containerHeight'])
    if kind=='truck':
        t=next((t for t in s['trucks'] if t['id']==target),None)
        if not t or any(x['truck']==target for x in s['containers']):raise ValueError('Camion absent ou déjà chargé.')
        return bay_position(s['config'],t['bay'])
    raise ValueError('Type de destination inconnu.')

def action(s,a):
    name=a.get('action')
    if name in ('cancel','incident'):
        m=s['mission']
        if not m:raise ValueError('Aucune mission active.')
        v=next(v for v in s['containers'] if v['id']==m['container'])
        op=s.get('operation')
        if v['state'] in ('transit','uncertain'):
            v.update(state='uncertain',slot=None,level=None,truck=None)
            m.update(paused=True,interrupted=True)
            if op and op['status'] in ('running','paused'):op['status']='interrupted'
            log(s,f'{m["id"]} interrompue après prise : position de {v["id"]} à confirmer.','alert')
        else:
            s['_mission_end']=dict(code=m['id'],status='cancelled');s['mission']=None
            if op and op['status'] in ('running','paused'):op['status']='cancelled'
            log(s,f'{m["id"]} annulée avant prise ; déplacements déjà terminés conservés.','mission_cancelled')
        return
    if name=='resolve':
        m=s['mission']
        if not m or not m.get('interrupted'):raise ValueError('Aucune position incertaine à confirmer.')
        v=next(v for v in s['containers'] if v['id']==m['container'])
        dest=a.get('destination');end=destination_position(s,v,dest);kind,_,target=dest.partition(':')
        if kind=='slot':v.update(state='stored',slot=target,level=round(end['z']/s['config']['containerHeight'])+1,truck=None)
        else:v.update(state='truck',slot=None,level=None,truck=target)
        s['_mission_end']=dict(code=m['id'],status='failed');s['mission']=None
        from .motion import top_position
        s['gripper']=top_position(s,end)
        if s.get('operation'):s['operation']['status']='cancelled'
        log(s,f'Position de {v["id"]} confirmée en simulation : {dest}. Mission interrompue clôturée.','reconciled')
        return
    if name=='pause':
        if not s['mission']: raise ValueError('Aucune mission active.')
        if s['mission'].get('interrupted'):raise ValueError('Confirmez la position du conteneur avant une nouvelle mission.')
        s['mission']['paused']=not s['mission']['paused']
        if s.get('operation') and s['operation']['status'] in ('running','paused'):
            s['operation']['status']='paused' if s['mission']['paused'] else 'running'
        return
    if s['mission']:raise ValueError('Terminez la mission en cours.')
    if name=='retrieve':
        from .retrieval import start_operation
        start_operation(s,a.get('id'),a.get('destination'),a.get('revision'));return
    if name=='arrive':
        if not isinstance(a.get('loaded'),bool):raise ValueError('loaded doit être un booléen.')
        if len(s['trucks'])>=s['config']['bays']:raise ValueError('Tous les postes sont occupés.')
        if a['loaded'] and len(s['containers'])>=s['config']['maxContainers']:raise ValueError('Capacité maximale atteinte.')
        bay=next(i for i in range(s['config']['bays']) if not any(t['bay']==i for t in s['trucks']));t=dict(id=f'T{s["nextTruck"]:02}',bay=bay);s['nextTruck']+=1;s['trucks'].append(t)
        if a['loaded']:s['containers'].append(dict(id=f'C{s["nextId"]:03}',slot=None,level=None,state='truck',truck=t['id']));s['nextId']+=1
        log(s,f'{t["id"]} arrivé au poste Q{bay+1}.','truck_arrived');return
    if name=='depart':
        tid=a.get('id')
        if not any(t['id']==tid for t in s['trucks']):raise ValueError('Camion absent.')
        s['containers']=[v for v in s['containers'] if v['truck']!=tid];s['trucks']=[t for t in s['trucks'] if t['id']!=tid];log(s,f'{tid} a quitté la zone.','truck_departed');return
    if name!='move':raise ValueError('Action inconnue.')
    v=next((v for v in s['containers'] if v['id']==a.get('id')),None)
    if not v or v['state'] not in ('stored','truck'):raise ValueError('Conteneur indisponible.')
    if v['state']=='stored' and stack(s,v['slot'])[0]['id']!=v['id']:raise ValueError('Déplacez d’abord les conteneurs supérieurs.')
    dest=a.get('destination','');end=destination_position(s,v,dest);kind,_,target=dest.partition(':')
    m=dict(id=f'M{s["completed"]+1:03}-{uuid.uuid4().hex[:8]}',container=v['id'],source=f'{v["slot"]} N{v["level"]}' if v['slot'] else v['truck'],target=target,destination=dest,kind=kind,start=position(s,v),end=end,progress=0,paused=False)
    m.update(plan_trajectory(s['config'],m['start'],end,trajectory_obstacles(s,v['id'])))
    s['mission']=m;log(s,f'{m["id"]} · {v["id"]} : {m["source"]} → {target}.','mission_started')
