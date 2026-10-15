-- =====================================================================
-- 002 — Règles d'intégrité garanties PAR LA BASE (dernier rempart)
-- Les services métier vérifient d'abord et expliquent les refus ;
-- ces déclencheurs empêchent tout état incohérent, même en écriture directe.
-- Codes d'erreur personnalisés : PT001…PT009
-- =====================================================================

-- ---------- Coordonnées d'un emplacement (centre XY, base Z) ----------
CREATE FUNCTION coord_emplacement(p_id bigint, OUT x numeric, OUT y numeric, OUT z numeric)
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN e.type = 'CASE' THEN p.centre_x_mm ELSE v.plateau_x_mm END,
         CASE WHEN e.type = 'CASE' THEN p.centre_y_mm ELSE v.plateau_y_mm END,
         CASE WHEN e.type = 'CASE' THEN e.z_base_mm  ELSE v.plateau_z_mm END
  FROM emplacement e
  LEFT JOIN position_sol p ON p.id = e.position_sol_id
  LEFT JOIN visite_camion v ON v.camion_id = e.camion_id AND v.statut = 'PRESENTE'
  WHERE e.id = p_id
$$;

-- Pile continue : les niveaux occupés d'une position sont exactement 1..n (pas de conteneur sans support)
CREATE FUNCTION pile_continue(p_position integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(max(e.niveau), 0) = count(*)
  FROM conteneur c JOIN emplacement e ON e.id = c.emplacement_id
  WHERE e.position_sol_id = p_position
$$;

-- ---------- Journal append-only + notification temps réel ----------
CREATE FUNCTION interdire_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'PT007',
    MESSAGE = format('La table %s est en ajout seul : modification ou suppression interdite.', TG_TABLE_NAME);
END $$;

CREATE TRIGGER evenement_append_only BEFORE UPDATE OR DELETE ON evenement
  FOR EACH ROW EXECUTE FUNCTION interdire_modification();
CREATE TRIGGER confirmation_append_only BEFORE UPDATE OR DELETE ON confirmation
  FOR EACH ROW EXECUTE FUNCTION interdire_modification();

CREATE FUNCTION notifier_evenement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('portique_evenements', NEW.id::text);   -- délivré seulement après COMMIT
  RETURN NEW;
END $$;
CREATE TRIGGER evenement_notifier AFTER INSERT ON evenement
  FOR EACH ROW EXECUTE FUNCTION notifier_evenement();

-- ---------- Conteneur : horodatage, compteur de version, historique ----------
CREATE FUNCTION conteneur_avant_maj() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.modifie_le := now();
  NEW.version_ligne := OLD.version_ligne + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER conteneur_avant_maj BEFORE UPDATE ON conteneur
  FOR EACH ROW EXECUTE FUNCTION conteneur_avant_maj();

CREATE FUNCTION conteneur_historiser() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cx numeric; cy numeric; cz numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.etat = OLD.etat
     AND NEW.emplacement_id IS NOT DISTINCT FROM OLD.emplacement_id
     AND NEW.mission_transfert_id IS NOT DISTINCT FROM OLD.mission_transfert_id THEN
    RETURN NEW;
  END IF;
  IF NEW.emplacement_id IS NOT NULL THEN
    SELECT x, y, z INTO cx, cy, cz FROM coord_emplacement(NEW.emplacement_id);
  ELSIF NEW.etat = 'INCERTAINE' THEN
    cx := NEW.derniere_x_mm; cy := NEW.derniere_y_mm; cz := NEW.derniere_z_mm;
  END IF;
  UPDATE historique_localisation SET fin = clock_timestamp()
   WHERE conteneur_id = NEW.id AND fin IS NULL;
  INSERT INTO historique_localisation (conteneur_id, etat, emplacement_id, mission_id, x_mm, y_mm, z_mm, debut)
  VALUES (NEW.id, NEW.etat, NEW.emplacement_id, NEW.mission_transfert_id, cx, cy, cz, clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER conteneur_historiser AFTER INSERT OR UPDATE ON conteneur
  FOR EACH ROW EXECUTE FUNCTION conteneur_historiser();

-- ---------- Conteneur : empilement, plan actif, plateau, capacité (vérifiés au COMMIT) ----------
CREATE FUNCTION conteneur_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c   conteneur%ROWTYPE;
  e   emplacement%ROWTYPE;
  vp  version_plan%ROWTYPE;
  n   integer;
BEGIN
  SELECT * INTO c FROM conteneur WHERE id = NEW.id;   -- état final de la transaction
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF c.emplacement_id IS NOT NULL THEN
    SELECT * INTO e FROM emplacement WHERE id = c.emplacement_id;
    IF e.type = 'CASE' THEN
      IF NOT EXISTS (SELECT 1 FROM version_plan WHERE id = e.version_plan_id AND statut = 'ACTIVE') THEN
        RAISE EXCEPTION USING ERRCODE = 'PT002',
          MESSAGE = format('Conteneur %s : l''emplacement %s n''appartient pas au plan actif.', c.code, e.code);
      END IF;
      IF NOT pile_continue(e.position_sol_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'PT001',
          MESSAGE = format('Empilement sans support à la position de %s (conteneur %s).', e.code, c.code);
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM visite_camion WHERE camion_id = e.camion_id AND statut = 'PRESENTE') THEN
        RAISE EXCEPTION USING ERRCODE = 'PT003',
          MESSAGE = format('Conteneur %s sur le plateau %s alors que le camion n''est pas présent.', c.code, e.code);
      END IF;
    END IF;
  END IF;

  -- L'ancienne pile ne doit pas laisser de conteneur « en l'air »
  IF TG_OP = 'UPDATE' AND OLD.emplacement_id IS NOT NULL
     AND OLD.emplacement_id IS DISTINCT FROM c.emplacement_id THEN
    SELECT * INTO e FROM emplacement WHERE id = OLD.emplacement_id;
    IF e.type = 'CASE' AND NOT pile_continue(e.position_sol_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'PT001',
        MESSAGE = format('Retrait de %s impossible : un conteneur au-dessus resterait sans support.', c.code);
    END IF;
  END IF;

  -- Capacité configurée (plan actif)
  SELECT * INTO vp FROM version_plan WHERE statut = 'ACTIVE';
  IF FOUND THEN
    IF vp.perimetre_capacite = 'ZONE' THEN
      SELECT count(*) INTO n FROM conteneur WHERE etat <> 'SORTI';
    ELSE
      SELECT count(*) INTO n FROM conteneur x JOIN emplacement em ON em.id = x.emplacement_id WHERE em.type = 'CASE';
    END IF;
    IF n > vp.nb_conteneurs_max THEN
      RAISE EXCEPTION USING ERRCODE = 'PT004',
        MESSAGE = format('Capacité dépassée : %s conteneurs pour un maximum de %s (périmètre %s).', n, vp.nb_conteneurs_max, vp.perimetre_capacite);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER conteneur_verifier
  AFTER INSERT OR UPDATE OF etat, emplacement_id ON conteneur
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION conteneur_verifier();

-- ---------- Départ d'un camion : plateau vide et aucun transfert actif ----------
CREATE FUNCTION visite_verifier_depart() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pl bigint;
BEGIN
  IF NEW.statut <> 'PARTIE' THEN RETURN NULL; END IF;
  SELECT id INTO pl FROM emplacement WHERE camion_id = NEW.camion_id;
  IF pl IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM reservation WHERE emplacement_id = pl AND statut = 'ACTIVE') THEN
    RAISE EXCEPTION USING ERRCODE = 'PT005',
      MESSAGE = 'Départ impossible : le camion est impliqué dans un transfert actif.';
  END IF;
  IF EXISTS (SELECT 1 FROM conteneur WHERE emplacement_id = pl) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT005',
      MESSAGE = 'Départ incohérent : un conteneur est encore enregistré sur le plateau.';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER visite_verifier_depart
  AFTER UPDATE OF statut ON visite_camion
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION visite_verifier_depart();

-- ---------- Réservation cohérente avec la mission ----------
CREATE FUNCTION reservation_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m mission%ROWTYPE;
BEGIN
  SELECT * INTO m FROM mission WHERE id = NEW.mission_id;
  IF (NEW.role = 'SOURCE' AND NEW.emplacement_id <> m.source_emplacement_id)
     OR (NEW.role = 'DESTINATION' AND NEW.emplacement_id <> m.destination_emplacement_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT008',
      MESSAGE = 'Réservation incohérente avec la source ou la destination de la mission.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_verifier BEFORE INSERT OR UPDATE OF emplacement_id, role ON reservation
  FOR EACH ROW EXECUTE FUNCTION reservation_verifier();

-- ---------- Immutabilité des versions de plan non brouillon ----------
CREATE FUNCTION version_plan_proteger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE libres text[] := ARRAY['statut','active_le','archivee_le','commentaire'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut <> 'BROUILLON' THEN
      RAISE EXCEPTION USING ERRCODE = 'PT006', MESSAGE = 'Une version de plan activée ne peut pas être supprimée (historique).';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.statut <> 'BROUILLON' AND (to_jsonb(NEW) - libres) <> (to_jsonb(OLD) - libres) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT006', MESSAGE = 'Une version de plan activée est immuable : créez une nouvelle version.';
  END IF;
  IF NOT ((OLD.statut = NEW.statut)
       OR (OLD.statut = 'BROUILLON' AND NEW.statut = 'ACTIVE')
       OR (OLD.statut = 'ACTIVE' AND NEW.statut = 'ARCHIVEE')) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT006', MESSAGE = format('Transition de version interdite : %s → %s.', OLD.statut, NEW.statut);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER version_plan_proteger BEFORE UPDATE OR DELETE ON version_plan
  FOR EACH ROW EXECUTE FUNCTION version_plan_proteger();

-- Géométrie des éléments d'un plan non brouillon : seules les colonnes « opérationnelles » changent
CREATE FUNCTION geometrie_proteger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  libres text[] := coalesce(TG_ARGV, ARRAY[]::text[]);
  vid integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_plan_id ELSE NEW.version_plan_id END;
BEGIN
  IF vid IS NULL OR NOT EXISTS (SELECT 1 FROM version_plan WHERE id = vid AND statut <> 'BROUILLON') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - libres) <> (to_jsonb(OLD) - libres) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT006',
      MESSAGE = format('Géométrie figée (%s) : la version de plan %s n''est plus un brouillon.', TG_TABLE_NAME, vid);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zone_proteger BEFORE UPDATE OR DELETE ON zone
  FOR EACH ROW EXECUTE FUNCTION geometrie_proteger();
CREATE TRIGGER position_sol_proteger BEFORE UPDATE OR DELETE ON position_sol
  FOR EACH ROW EXECUTE FUNCTION geometrie_proteger('statut', 'motif_blocage');
CREATE TRIGGER poste_proteger BEFORE UPDATE OR DELETE ON poste_transport
  FOR EACH ROW EXECUTE FUNCTION geometrie_proteger('statut', 'motif_indisponibilite');
CREATE TRIGGER emplacement_proteger BEFORE UPDATE OR DELETE ON emplacement
  FOR EACH ROW EXECUTE FUNCTION geometrie_proteger();

-- ---------- Vues de lecture ----------
CREATE VIEW v_capacite_plan AS
SELECT v.id AS version_plan_id, v.numero, v.statut, v.nb_conteneurs_max,
       (SELECT count(*) FROM position_sol p WHERE p.version_plan_id = v.id) AS nb_positions_sol,
       (SELECT count(*) FROM emplacement e WHERE e.version_plan_id = v.id) AS nb_emplacements,
       (SELECT count(*) FROM poste_transport t WHERE t.version_plan_id = v.id) AS nb_postes
FROM version_plan v;

CREATE VIEW v_conteneur_localisation AS
SELECT c.id, c.code, c.etat, c.demo,
       e.id AS emplacement_id, e.type AS type_emplacement, e.code AS code_emplacement,
       p.code AS code_position, e.niveau, cam.code AS code_camion, pt.code AS code_poste,
       coalesce(k.x, c.derniere_x_mm) AS x_mm,
       coalesce(k.y, c.derniere_y_mm) AS y_mm,
       coalesce(k.z, c.derniere_z_mm) AS z_mm,
       c.mission_transfert_id, c.motif_incertitude, c.modifie_le
FROM conteneur c
LEFT JOIN emplacement e ON e.id = c.emplacement_id
LEFT JOIN position_sol p ON p.id = e.position_sol_id
LEFT JOIN camion cam ON cam.id = e.camion_id
LEFT JOIN visite_camion vc ON vc.camion_id = e.camion_id AND vc.statut = 'PRESENTE'
LEFT JOIN poste_transport pt ON pt.id = vc.poste_id
LEFT JOIN LATERAL coord_emplacement(e.id) k ON e.id IS NOT NULL;
