ALTER TABLE configurations ADD COLUMN gripper_position jsonb;
UPDATE configurations c SET gripper_position=(SELECT jsonb_build_object('x',(m.route->'end'->>'x')::float,'y',(m.route->'end'->>'y')::float,'z',(m.route->'end'->>'z')::float+(c.params->>'containerHeight')::float) FROM missions m WHERE m.configuration_id=c.id AND m.status='completed' ORDER BY m.finished_at DESC,m.id DESC LIMIT 1);
INSERT INTO schema_migrations(version) VALUES(3);
