"""Explicit provisional simulation motion profile, seconds and mm."""
import math
import json
from functools import lru_cache
from .trajectory import plan_trajectory
PROFILE=dict(horizontalSpeedMmS=100,verticalSpeedMmS=50,horizontalAccelerationMmS2=200,verticalAccelerationMmS2=100,pickSeconds=1,placeSeconds=1)

def route_seconds(route):
    total=0
    for a,b in zip(route['waypoints'],route['waypoints'][1:]):
        for axis in ('x','y','z'):
            distance=abs(a[axis]-b[axis])
            vertical=axis=='z'
            speed=PROFILE['verticalSpeedMmS' if vertical else 'horizontalSpeedMmS']
            acceleration=PROFILE['verticalAccelerationMmS2' if vertical else 'horizontalAccelerationMmS2']
            total+=2*math.sqrt(distance/acceleration) if distance<=speed*speed/acceleration else distance/speed+speed/acceleration
    return total

def approach(s,start,end):
    from .domain import trajectory_obstacles
    # Conservative empty envelope: retains the load footprint, measured at its top.
    from copy import deepcopy
    return deepcopy(_approach(json.dumps([s['config'],start,end,trajectory_obstacles(s,None)],sort_keys=True)))

@lru_cache(maxsize=2048)
def _approach(data):
    config,start,end,obstacles=json.loads(data)
    return plan_trajectory(config,start,end,obstacles,{'routeScore':route_seconds})

def top_position(s,p):return {**p,'z':p['z']+s['config']['containerHeight']}

def along(points,fraction):
    distances=[sum(abs(a[k]-b[k]) for k in ('x','y','z')) for a,b in zip(points,points[1:])]
    remaining=max(0,min(1,fraction))*sum(distances)
    for a,b,length in zip(points,points[1:],distances):
        if remaining<=length and length:
            return {k:a[k]+(b[k]-a[k])*remaining/length for k in ('x','y','z')}
        remaining-=length
    return dict(points[-1])
