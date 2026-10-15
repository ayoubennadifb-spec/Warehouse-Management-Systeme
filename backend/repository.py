"""PostgreSQL source of truth. Snapshots are projections, not a persisted blob."""
import os
from contextlib import contextmanager
from pathlib import Path
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from . import domain
ROOT=Path(__file__).resolve().parents[1]

@contextmanager
def connect():
    connection=psycopg.connect(os.environ.get('DATABASE_URL','postgresql://portique:portique_dev@localhost:5432/portique'),row_factory=dict_row,prepare_threshold=None)
    try:
        with connection:yield connection
    finally:
        connection.close()
def lock(db):db.execute('SELECT pg_advisory_xact_lock(741039)')
def initialize():
    with connect() as db:
        lock(db)
        exists=db.execute("SELECT to_regclass('public.schema_migrations') AS name").fetchone()['name']
        if not exists:db.execute((ROOT/'database/001_schema.sql').read_text(encoding='utf-8'))
        for migration in sorted((ROOT/'database').glob('*.sql')):
            version=int(migration.name.split('_',1)[0])
            if not db.execute('SELECT 1 FROM schema_migrations WHERE version=%s',(version,)).fetchone():
                db.execute(migration.read_text(encoding='utf-8'))
        active=db.execute('SELECT id,mode FROM configurations WHERE active').fetchone()
        mode=os.environ.get('APP_MODE','simulation')
        if active and active['mode']!=mode:
            raise ValueError('Le mode de la base diffère du serveur. Utilisez une base dédiée pour le matériel réel ; une simulation ne constitue pas une mesure.')
        if not active:create_configuration(db,domain.new_state(seed=mode!='real'))
        # A real interrupted move must be reconciled, while simulated moves may be resumed explicitly.
        db.execute("UPDATE missions SET status='paused' WHERE status='running'")
        db.execute("UPDATE operations SET status='paused' WHERE status='running'")

def create_configuration(db,s):
    if db.execute("SELECT id FROM missions WHERE status IN ('running','paused') LIMIT 1").fetchone():raise ValueError('Une mission est active. Configuration refusée.')
    db.execute('UPDATE configurations SET active=false WHERE active')
    db.execute('UPDATE visites_camions SET departed_at=now() WHERE departed_at IS NULL')
    c=s['config'];cfg=db.execute('INSERT INTO configurations(params,active,mode) VALUES(%s,true,%s) RETURNING id',(Jsonb(c),os.environ.get('APP_MODE','simulation'))).fetchone()['id'];s['_config_id']=cfg
    for kind,x,l in [('transport',0,c['transportLength']),('storage',c['transportLength'],c['length']-c['transportLength'])]:
        zone=db.execute('INSERT INTO zones(configuration_id,kind,x_mm,y_mm,length_mm,width_mm) VALUES(%s,%s,%s,0,%s,%s) RETURNING id',(cfg,kind,x,l,c['width'])).fetchone()['id']
        if kind=='storage':
            for i,cell in enumerate(domain.slots(c)):
                pid=db.execute('INSERT INTO positions_sol(zone_id,code,column_index,row_index,x_mm,y_mm) VALUES(%s,%s,%s,%s,%s,%s) RETURNING id',(zone,cell['id'],i%c['nx'],i//c['nx'],cell['x'],cell['y'])).fetchone()['id']
                for level in range(1,c['levels']+1):db.execute('INSERT INTO emplacements(configuration_id,position_id,level,z_base_mm) VALUES(%s,%s,%s,%s)',(cfg,pid,level,(level-1)*c['containerHeight']))
        else:
            for i in range(c['bays']):
                bp=domain.bay_position(c,i);db.execute('INSERT INTO postes_transport(zone_id,code,bay_index,x_mm,y_mm,length_mm,width_mm) VALUES(%s,%s,%s,%s,%s,%s,%s)',(zone,f'Q{i+1}',i,bp['x']-c['cabinLength'],bp['y'],c['cabinLength']+c['containerLength'],c['containerWidth']))
    db.execute('INSERT INTO types_conteneurs(configuration_id,length_mm,width_mm,height_mm) VALUES(%s,%s,%s,%s)',(cfg,c['containerLength'],c['containerWidth'],c['containerHeight']))
    save(db,s);return s

def load(db):
    row=db.execute('SELECT * FROM configurations WHERE active').fetchone()
    if not row:raise ValueError('Aucune configuration active.')
    cfg=row['id'];s=dict(version=1,config=row['params'],containers=[],trucks=[],events=[],mission=None,operation=None,completed=0,_config_id=cfg)
    rows=db.execute('''SELECT c.code,c.state,p.code AS slot,e.level,v.truck_id AS truck FROM conteneurs c LEFT JOIN emplacements e ON e.id=c.emplacement_id LEFT JOIN positions_sol p ON p.id=e.position_id LEFT JOIN visites_camions v ON v.id=e.visit_id WHERE c.configuration_id=%s AND c.state<>'departed' ORDER BY c.code''',(cfg,)).fetchall()
    s['containers']=[dict(id=r['code'],state=r['state'],slot=r['slot'],level=r['level'],truck=r['truck']) for r in rows]
    s['trucks']=[dict(id=r['truck_id'],bay=r['bay_index']) for r in db.execute('SELECT v.truck_id,b.bay_index FROM visites_camions v JOIN postes_transport b ON b.id=v.bay_id WHERE v.configuration_id=%s AND v.departed_at IS NULL ORDER BY b.bay_index',(cfg,))]
    s['events']=[dict(id=r['event_key'],at=r['at'].isoformat(),message=r['message'],kind=r['kind']) for r in db.execute('SELECT * FROM evenements WHERE configuration_id=%s ORDER BY at DESC,id DESC LIMIT 80',(cfg,))]
    m=db.execute("SELECT * FROM missions WHERE configuration_id=%s AND status IN ('running','paused')",(cfg,)).fetchone()
    if m:s['mission']={**m['route'],'progress':m['progress'],'paused':m['status']=='paused'}
    op=db.execute('SELECT * FROM operations WHERE configuration_id=%s ORDER BY created_at DESC LIMIT 1',(cfg,)).fetchone()
    if op:s['operation']={**op['details'],'id':op['id'],'status':op['status'],'nextIndex':op['next_index']}
    s['gripper']=row['gripper_position']
    s['completed']=db.execute("SELECT count(*) AS n FROM missions WHERE configuration_id=%s AND status='completed'",(cfg,)).fetchone()['n']
    codes=[r['code'] for r in db.execute('SELECT code FROM conteneurs WHERE configuration_id=%s',(cfg,))];s['nextId']=max([int(x[1:]) for x in codes if x[1:].isdigit()]+[0])+1
    ids=[r['id'] for r in db.execute('SELECT id FROM camions')];s['nextTruck']=max([int(x[1:]) for x in ids if x[1:].isdigit()]+[0])+1
    return s

def locations(db,cfg):
    result={}
    for r in db.execute('''SELECT e.id,e.level,p.code,v.truck_id,v.departed_at FROM emplacements e LEFT JOIN positions_sol p ON p.id=e.position_id LEFT JOIN visites_camions v ON v.id=e.visit_id WHERE e.configuration_id=%s''',(cfg,)):
        if r['code']:result[('slot',r['code'],r['level'])]=r['id']
        elif r['departed_at'] is None:result[('truck',r['truck_id'],None)]=r['id']
    return result

def save(db,s):
    cfg=s['_config_id'];c=s['config']
    db.execute('UPDATE configurations SET gripper_position=%s WHERE id=%s',(Jsonb(s['gripper']) if s.get('gripper') else None,cfg))
    active=db.execute('SELECT id,truck_id FROM visites_camions WHERE configuration_id=%s AND departed_at IS NULL',(cfg,)).fetchall();seen={x['id'] for x in s['trucks']}
    # An outgoing container is preserved with state departed; its visit remains in history.
    for r in active:
        if r['truck_id'] not in seen:
            db.execute("UPDATE conteneurs SET state='departed',emplacement_id=NULL,confirmed_at=now() WHERE emplacement_id IN (SELECT id FROM emplacements WHERE visit_id=%s)",(r['id'],));db.execute('UPDATE visites_camions SET departed_at=now() WHERE id=%s',(r['id'],))
    for t in s['trucks']:
        if any(r['truck_id']==t['id'] for r in active):continue
        db.execute('INSERT INTO camions(id,cabin_length_mm,bed_length_mm,width_mm) VALUES(%s,%s,%s,%s) ON CONFLICT(id) DO NOTHING',(t['id'],c['cabinLength'],c['containerLength'],c['containerWidth']))
        bay=db.execute('SELECT b.id FROM postes_transport b JOIN zones z ON z.id=b.zone_id WHERE z.configuration_id=%s AND b.bay_index=%s',(cfg,t['bay'])).fetchone()['id']
        visit=db.execute('INSERT INTO visites_camions(configuration_id,truck_id,bay_id) VALUES(%s,%s,%s) RETURNING id',(cfg,t['id'],bay)).fetchone()['id']
        db.execute('INSERT INTO emplacements(configuration_id,visit_id,z_base_mm) VALUES(%s,%s,0)',(cfg,visit))
    loc=locations(db,cfg);type_id=db.execute('SELECT id FROM types_conteneurs WHERE configuration_id=%s',(cfg,)).fetchone()['id']
    for v in s['containers']:
        lid=loc[('slot',v['slot'],v['level'])] if v['state']=='stored' else loc[('truck',v['truck'],None)] if v['state']=='truck' else None
        db.execute('''INSERT INTO conteneurs(configuration_id,code,type_id,emplacement_id,state) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(configuration_id,code) DO UPDATE SET emplacement_id=excluded.emplacement_id,state=excluded.state,confirmed_at=CASE WHEN conteneurs.emplacement_id IS DISTINCT FROM excluded.emplacement_id OR conteneurs.state<>excluded.state THEN now() ELSE conteneurs.confirmed_at END''',(cfg,v['id'],type_id,lid,v['state']))
    ended=s.get('_mission_end')
    if ended:
        done=db.execute("UPDATE missions SET status=%s,finished_at=now(),progress=CASE WHEN %s='completed' THEN 1 ELSE progress END WHERE configuration_id=%s AND code=%s AND status IN ('running','paused') RETURNING id",(ended['status'],ended['status'],cfg,ended['code'])).fetchall()
        for r in done:db.execute('UPDATE reservations SET released_at=now() WHERE mission_id=%s',(r['id'],))
    m=s['mission']
    if m:
        old=db.execute('SELECT id FROM missions WHERE configuration_id=%s AND code=%s',(cfg,m['id'])).fetchone()
        if old:db.execute('UPDATE missions SET progress=%s,status=%s,route=%s WHERE id=%s',(m['progress'],'paused' if m['paused'] else 'running',Jsonb(m),old['id']))
        else:
            cr=db.execute('SELECT id,emplacement_id FROM conteneurs WHERE configuration_id=%s AND code=%s',(cfg,m['container'])).fetchone();dest=loc[('slot',m['target'],round(m['end']['z']/c['containerHeight'])+1)] if m['kind']=='slot' else loc[('truck',m['target'],None)]
            mid=db.execute("INSERT INTO missions(configuration_id,code,container_id,source_id,destination_id,status,route) VALUES(%s,%s,%s,%s,%s,'running',%s) RETURNING id",(cfg,m['id'],cr['id'],cr['emplacement_id'],dest,Jsonb(m))).fetchone()['id'];db.execute('INSERT INTO reservations(mission_id,emplacement_id) VALUES(%s,%s)',(mid,dest))
    op=s.get('operation')
    if op:
        cid=db.execute('SELECT id FROM conteneurs WHERE configuration_id=%s AND code=%s',(cfg,op['target'])).fetchone()['id']
        db.execute('''INSERT INTO operations(id,configuration_id,target_container_id,destination,status,next_index,details,finished_at)
          VALUES(%s,%s,%s,%s,%s,%s,%s,CASE WHEN %s IN ('completed','cancelled') THEN now() ELSE NULL END)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status,next_index=excluded.next_index,details=excluded.details,
          finished_at=COALESCE(operations.finished_at,excluded.finished_at)''',
          (op['id'],cfg,cid,op['destination'],op['status'],op['nextIndex'],Jsonb(op),op['status']))
    for e in s['events']:db.execute('INSERT INTO evenements(configuration_id,event_key,at,kind,message) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(event_key) DO NOTHING',(cfg,str(e['id']),e['at'],e.get('kind','simulation'),e['message']))

def public(s):return {k:v for k,v in s.items() if not k.startswith('_')}
