"""Plan supported relocations top-down, followed by the requested target move."""
from copy import deepcopy
import hashlib
import json
import math
from functools import lru_cache
from .trajectory import plan_trajectory
from .motion import PROFILE,route_seconds,approach,top_position


def revision(s):
    data={k:s.get(k) for k in ('config','containers','trucks','mission','gripper')}
    return hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def _move(s,cid,dest,role):
    from . import domain as d
    v=next(v for v in s['containers'] if v['id']==cid)
    end=d.destination_position(s,v,dest)
    start=d.position(s,v)
    empty=approach(s,s['gripper'],top_position(s,start)) if s.get('gripper') else dict(waypoints=[top_position(s,start)],routeLengthMm=0)
    route=plan_trajectory(s['config'],start,end,d.trajectory_obstacles(s,cid),{'routeScore':route_seconds})
    step=dict(container=cid,destination=dest,role=role,source=v['slot'] or v['truck'],**route)
    step.update(emptyWaypoints=empty['waypoints'],emptyDistanceMm=empty['routeLengthMm'],estimatedSeconds=route_seconds(empty)+route_seconds(route)+PROFILE['pickSeconds']+PROFILE['placeSeconds'])
    s['gripper']=top_position(s,end)
    kind,_,target=dest.partition(':')
    if kind=='slot':v.update(state='stored',slot=target,level=round(end['z']/s['config']['containerHeight'])+1,truck=None)
    else:v.update(state='truck',slot=None,level=None,truck=target)
    return step


def plan_retrieval(s,cid,dest):
    data={k:s.get(k) for k in ('config','containers','trucks','mission','gripper')}
    return deepcopy(_cached_plan(json.dumps(data,sort_keys=True,separators=(',',':')),cid,dest))


@lru_cache(maxsize=16)
def _cached_plan(data,cid,dest):
    return _compute(json.loads(data),cid,dest)


def _compute(s,cid,dest):
    from . import domain as d
    if s['mission']:raise ValueError('Terminez la mission en cours avant de préparer un dégagement.')
    target=next((v for v in s['containers'] if v['id']==cid),None)
    if not target or target['state'] not in ('stored','truck'):raise ValueError('Conteneur cible indisponible.')
    d.destination_position(s,target,dest)
    blockers=[v['id'] for v in d.stack(s,target['slot']) if v['level']>target['level']] if target['state']=='stored' else []
    cells=d.slots(s['config'])
    excluded={target['slot'],dest.partition(':')[2] if dest.startswith('slot:') else None}
    candidates=[p for p in cells if p['id'] not in excluded]
    free=sum(s['config']['levels']-len(d.stack(s,p['id'])) for p in candidates)
    if free<len(blockers):raise ValueError('Pas assez d’emplacements libres et supportés pour dégager la cible.')
    # Exhaustive in the common one/two-blocker case; bounded beam for larger stacks.
    exact=len(blockers)<=2 and (len(blockers)<2 or len(candidates)<=50)
    frontier=[(0.0,deepcopy(s),[])]
    evaluated=0
    for blocker in blockers:
        expanded=[]
        for cost,current,steps in frontier:
            v=next(v for v in current['containers'] if v['id']==blocker)
            start=d.position(current,v)
            available=[p for p in candidates if len(d.stack(current,p['id']))<s['config']['levels']]
            available.sort(key=lambda p:(abs(start['x']-p['x'])+abs(start['y']-p['y']),p['id']))
            if not exact:available=available[:16]
            for p in available:
                after=deepcopy(current)
                try:step=_move(after,blocker,'slot:'+p['id'],'clearing')
                except ValueError:continue
                evaluated+=1
                expanded.append((cost+step['estimatedSeconds'],after,steps+[step]))
        if not expanded:raise ValueError('Aucun dégagement réalisable avec les obstacles connus.')
        expanded.sort(key=lambda item:(item[0],tuple(step['destination'] for step in item[2])))
        frontier=expanded if exact else expanded[:12]
    best=None
    for cost,current,steps in frontier:
        try:step=_move(current,cid,dest,'target')
        except ValueError:continue
        evaluated+=1
        total=cost+step['estimatedSeconds']
        if best is None or total<best[0]-1e-7:best=(total,steps+[step])
    if best is None:raise ValueError('La cible ne peut pas être transportée après dégagement.')
    return dict(target=cid,destination=dest,blockers=blockers,steps=best[1],totalDistanceMm=sum(x['routeLengthMm']+x['emptyDistanceMm'] for x in best[1]),loadedDistanceMm=sum(x['routeLengthMm'] for x in best[1]),emptyDistanceMm=sum(x['emptyDistanceMm'] for x in best[1]),estimatedSeconds=best[0],motionProfile=PROFILE,initialPositionAssumed=not bool(s.get('gripper')),
                optimization='exhaustive' if exact else 'bounded-beam',evaluatedRoutes=evaluated,
                objective='estimated-time',revision=revision(s))


def start_step(s):
    from . import domain as d
    op=s['operation'];step=op['steps'][op['nextIndex']]
    s['_dispatching_operation']=True
    try:d.action(s,dict(action='move',id=step['container'],destination=step['destination']))
    finally:s.pop('_dispatching_operation',None)
    s['mission'].update(emptyWaypoints=step['emptyWaypoints'],emptyDistanceMm=step['emptyDistanceMm'],estimatedSeconds=step['estimatedSeconds'],durationSeconds=step['estimatedSeconds'],pickupProgress=(route_seconds({'waypoints':step['emptyWaypoints']})+PROFILE['pickSeconds'])/step['estimatedSeconds'],operationId=op['id'],operationStep=op['nextIndex'],stepRole=step['role'])


def start_operation(s,cid,dest,expected_revision=None):
    from . import domain as d
    import uuid
    if expected_revision and expected_revision!=revision(s):raise ValueError('La scène a changé. Recalculez le plan avant de lancer.')
    plan=plan_retrieval(s,cid,dest)
    s['operation']={**plan,'id':'OP-'+str(uuid.uuid4()),'nextIndex':0,'status':'running'}
    d.log(s,f'Dégagement de {cid} : {len(plan["blockers"])} conteneur(s) à déplacer avant la cible.','operation_started')
    start_step(s)
