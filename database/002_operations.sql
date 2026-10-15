CREATE TABLE IF NOT EXISTS operations (
 id text PRIMARY KEY,
 configuration_id bigint NOT NULL REFERENCES configurations(id),
 target_container_id bigint NOT NULL REFERENCES conteneurs(id),
 destination text NOT NULL,
 status text NOT NULL CHECK(status IN ('running','paused','interrupted','completed','cancelled')),
 next_index integer NOT NULL CHECK(next_index>=0),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation ON operations(configuration_id) WHERE status IN ('running','paused','interrupted');
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
