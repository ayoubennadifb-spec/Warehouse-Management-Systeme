"""Verify graceful stop/start retains the current idle working scene."""
import json
import urllib.request
from local_runtime import runtime_lock,start,stop,health,URL

def snapshot():
    with urllib.request.urlopen(URL+'/api/state',timeout=5) as response:
        data=json.load(response);data.pop('genere_le',None);return data

with runtime_lock():
    start(True)
    before=snapshot()
    if any(m['statut'] in ('EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE') for m in before['missions']):
        raise SystemExit('Attendez la fin de la mission avant cet essai de redémarrage.')
    instance=health()['instance']
    start(True)
    assert health()['instance']==instance, 'Le deuxième lancement a créé un autre serveur.'
    try:
        stop()
    finally:
        start(True)
    assert health()['instance']!=instance
    assert snapshot()==before, 'La scène diffère après redémarrage.'
    print('Redémarrage vérifié : positions, camions et historique conservés ; lancement répété sans doublon.')
