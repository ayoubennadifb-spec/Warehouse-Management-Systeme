-- PostgreSQL 16+; first migration. Millimetres. No drop of existing user data.
CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS configurations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 params jsonb NOT NULL CHECK(jsonb_typeof(params)='object'),
 active boolean NOT NULL DEFAULT false,
 mode text NOT NULL DEFAULT 'simulation' CHECK(mode IN ('simulation','real')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_configuration ON configurations(active) WHERE active;
CREATE TABLE IF NOT EXISTS zones (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration_id bigint NOT NULL REFERENCES configurations(id),
 kind text NOT NULL CHECK(kind IN ('storage','transport')), x_mm double precision NOT NULL, y_mm double precision NOT NULL,
 length_mm double precision NOT NULL CHECK(length_mm>0), width_mm double precision NOT NULL CHECK(width_mm>0),
 UNIQUE(configuration_id,kind)
);
CREATE TABLE IF NOT EXISTS positions_sol (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, zone_id bigint NOT NULL REFERENCES zones(id), code text NOT NULL,
 column_index integer NOT NULL CHECK(column_index>=0), row_index integer NOT NULL CHECK(row_index>=0),
 x_mm double precision NOT NULL, y_mm double precision NOT NULL,
 UNIQUE(zone_id,code), UNIQUE(zone_id,column_index,row_index)
);
CREATE TABLE IF NOT EXISTS postes_transport (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, zone_id bigint NOT NULL REFERENCES zones(id), code text NOT NULL,
 bay_index integer NOT NULL CHECK(bay_index>=0), x_mm double precision NOT NULL, y_mm double precision NOT NULL,
 length_mm double precision NOT NULL CHECK(length_mm>0), width_mm double precision NOT NULL CHECK(width_mm>0),
 UNIQUE(zone_id,code), UNIQUE(zone_id,bay_index)
);
CREATE TABLE IF NOT EXISTS camions (
 id text PRIMARY KEY, cabin_length_mm double precision NOT NULL CHECK(cabin_length_mm>0),
 bed_length_mm double precision NOT NULL CHECK(bed_length_mm>0), width_mm double precision NOT NULL CHECK(width_mm>0)
);
CREATE TABLE IF NOT EXISTS visites_camions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration_id bigint NOT NULL REFERENCES configurations(id),
 truck_id text NOT NULL REFERENCES camions(id), bay_id bigint NOT NULL REFERENCES postes_transport(id),
 arrived_at timestamptz NOT NULL DEFAULT now(), departed_at timestamptz,
 CHECK(departed_at IS NULL OR departed_at>=arrived_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_truck_per_bay ON visites_camions(bay_id) WHERE departed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_visit_per_truck ON visites_camions(truck_id) WHERE departed_at IS NULL;
CREATE TABLE IF NOT EXISTS emplacements (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration_id bigint NOT NULL REFERENCES configurations(id),
 position_id bigint REFERENCES positions_sol(id), visit_id bigint REFERENCES visites_camions(id),
 level integer, z_base_mm double precision NOT NULL CHECK(z_base_mm>=0),
 CHECK((position_id IS NOT NULL AND visit_id IS NULL AND level IS NOT NULL AND level>=1) OR (position_id IS NULL AND visit_id IS NOT NULL AND level IS NULL)),
 UNIQUE(position_id,level), UNIQUE(visit_id)
);
CREATE TABLE IF NOT EXISTS types_conteneurs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration_id bigint NOT NULL UNIQUE REFERENCES configurations(id),
 length_mm double precision NOT NULL CHECK(length_mm>0), width_mm double precision NOT NULL CHECK(width_mm>0), height_mm double precision NOT NULL CHECK(height_mm>0)
);
CREATE TABLE IF NOT EXISTS conteneurs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration_id bigint NOT NULL REFERENCES configurations(id), code text NOT NULL,
 type_id bigint NOT NULL REFERENCES types_conteneurs(id), emplacement_id bigint REFERENCES emplacements(id),
 state text NOT NULL CHECK(state IN ('stored','truck','transit','uncertain','departed')),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(configuration_id,code), UNIQUE(emplacement_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((state IN ('stored','truck') AND emplacement_id IS NOT NULL) OR (state IN ('transit','uncertain','departed') AND emplacement_id IS NULL))
);
CREATE TABLE IF NOT EXISTS missions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration_id bigint NOT NULL REFERENCES configurations(id), code text NOT NULL,
 container_id bigint NOT NULL REFERENCES conteneurs(id), source_id bigint NOT NULL REFERENCES emplacements(id), destination_id bigint NOT NULL REFERENCES emplacements(id),
 status text NOT NULL CHECK(status IN ('running','paused','completed','cancelled','failed')),
 progress double precision NOT NULL DEFAULT 0 CHECK(progress>=0 AND progress<=1),
 route jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(configuration_id,code), CHECK(source_id<>destination_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_mission_per_container ON missions(container_id) WHERE status IN ('running','paused');
CREATE UNIQUE INDEX IF NOT EXISTS one_active_mission ON missions(configuration_id) WHERE status IN ('running','paused');
CREATE TABLE IF NOT EXISTS reservations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, mission_id bigint NOT NULL UNIQUE REFERENCES missions(id),
 emplacement_id bigint NOT NULL REFERENCES emplacements(id), created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_reservation_per_slot ON reservations(emplacement_id) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS evenements (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration_id bigint NOT NULL REFERENCES configurations(id),
 event_key text NOT NULL UNIQUE, at timestamptz NOT NULL, kind text NOT NULL, message text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_config_time ON evenements(configuration_id,at DESC);
-- Deferred cross-table checks: occupancy type, configuration, pile support, capacity.
CREATE OR REPLACE FUNCTION verify_container_location() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c conteneurs%ROWTYPE; e emplacements%ROWTYPE; cfg jsonb;
BEGIN
 SELECT * INTO c FROM conteneurs WHERE id=NEW.id;
 SELECT params INTO cfg FROM configurations WHERE id=c.configuration_id;
 IF (SELECT count(*) FROM conteneurs WHERE configuration_id=c.configuration_id AND state<>'departed') > (cfg->>'maxContainers')::integer THEN RAISE EXCEPTION 'Container capacity exceeded'; END IF;
 IF c.emplacement_id IS NOT NULL THEN
  SELECT * INTO e FROM emplacements WHERE id=c.emplacement_id;
  IF e.configuration_id<>c.configuration_id OR (c.state='stored' AND e.position_id IS NULL) OR (c.state='truck' AND e.visit_id IS NULL) THEN RAISE EXCEPTION 'Inconsistent location'; END IF;
  IF e.visit_id IS NOT NULL AND EXISTS(SELECT 1 FROM visites_camions WHERE id=e.visit_id AND departed_at IS NOT NULL) THEN RAISE EXCEPTION 'Truck already departed'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM conteneurs t JOIN emplacements l ON l.id=t.emplacement_id WHERE t.configuration_id=c.configuration_id AND l.position_id IS NOT NULL AND l.level>1 AND NOT EXISTS(SELECT 1 FROM emplacements below JOIN conteneurs support ON support.emplacement_id=below.id WHERE below.position_id=l.position_id AND below.level=l.level-1)) THEN RAISE EXCEPTION 'Unsupported stack'; END IF;
 RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS container_integrity ON conteneurs;
CREATE CONSTRAINT TRIGGER container_integrity AFTER INSERT OR UPDATE ON conteneurs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_container_location();
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
