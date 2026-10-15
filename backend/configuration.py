"""Claude-inspired impact check: retain inventory when activating a new plan."""
from copy import deepcopy
from . import domain as d


def impact(s,config):
    c=d.validate(dict(config));valid={p['id'] for p in d.slots(c)};blockers=[]
    if s['mission']:blockers.append('Une mission est active.')
    if len(s['containers'])>c['maxContainers']:blockers.append('La capacité est inférieure au nombre de conteneurs présents.')
    for v in s['containers']:
        if v['state']=='stored' and (v['slot'] not in valid or v['level']>c['levels']):blockers.append(f'{v["id"]} perdrait son emplacement {v["slot"]} / N{v["level"]}.')
        if v['state'] in ('transit','uncertain'):blockers.append(f'La position de {v["id"]} doit être confirmée.')
    if any(t['bay']>=c['bays'] for t in s['trucks']):blockers.append('Un poste occupé serait supprimé.')
    if s['trucks'] and any(c[k]!=s['config'][k] for k in ('containerLength','containerWidth','cabinLength')):
        blockers.append('Faites partir les camions avant de changer leurs dimensions.')
    return dict(possible=not blockers,blockers=blockers,containersPreserved=len(s['containers']),
                positionsChanged=c!=s['config'],storagePositions=c['nx']*c['ny'])


def reconfigure(s,config):
    result=impact(s,config)
    if not result['possible']:raise ValueError(' '.join(result['blockers']))
    new=d.new_state(config,seed=False)
    for k in ('containers','trucks','nextId','nextTruck'):new[k]=deepcopy(s[k])
    d.log(new,f'Nouvelle configuration activée ; {len(new["containers"])} conteneurs conservés.','configuration')
    return new
