-- =====================================================================
-- 003 — Extensions pour la vision, les obstacles et les trajets.
-- Les trajets sont DÉJÀ utilisés par la simulation (algorithme
-- « SIMULATION_LINEAIRE », non optimisé). Caméras et obstacles : structures
-- prêtes, aucune donnée réelle produite dans cette version.
-- =====================================================================

CREATE TABLE camera (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL UNIQUE,
  description         text,
  modele              text,
  resolution_largeur_px integer CHECK (resolution_largeur_px > 0),
  resolution_hauteur_px integer CHECK (resolution_hauteur_px > 0),
  active              boolean NOT NULL DEFAULT true,
  cree_le             timestamptz NOT NULL DEFAULT now()
);

-- Calibration intrinsèque + pose de la caméra dans le repère de la maquette (mm)
CREATE TABLE calibration_camera (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  camera_id                integer NOT NULL REFERENCES camera(id),
  version                  integer NOT NULL CHECK (version > 0),
  statut                   text NOT NULL DEFAULT 'BROUILLON' CHECK (statut IN ('BROUILLON','VALIDE','OBSOLETE')),
  matrice_intrinseque      jsonb NOT NULL,          -- 3×3
  coefficients_distorsion  jsonb,
  rotation                 jsonb NOT NULL,          -- matrice 3×3 ou quaternion
  translation_mm           jsonb NOT NULL,          -- [x, y, z] dans le repère maquette
  erreur_reprojection_px   numeric(8,4),
  methode                  text,
  realisee_le              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (camera_id, version)
);
CREATE UNIQUE INDEX calibration_une_valide ON calibration_camera (camera_id) WHERE statut = 'VALIDE';

-- Observations d'obstacles (objets ou humains), boîte englobante alignée sur les axes
CREATE TABLE observation_obstacle (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source            text NOT NULL CHECK (source IN ('VISION','MANUELLE','SIMULATION')),
  camera_id         integer REFERENCES camera(id),
  calibration_id    integer REFERENCES calibration_camera(id),
  observee_le       timestamptz NOT NULL,
  recue_le          timestamptz NOT NULL DEFAULT now(),
  classe            text NOT NULL CHECK (classe IN ('HUMAIN','OBJET','INCONNU')),
  confiance         numeric(4,3) CHECK (confiance BETWEEN 0 AND 1),
  suivi_id          text,                          -- identifiant de suivi entre images
  x_min_mm numeric(8,2), x_max_mm numeric(8,2),
  y_min_mm numeric(8,2), y_max_mm numeric(8,2),
  z_min_mm numeric(8,2), z_max_mm numeric(8,2),
  modele_ia         text,
  version_modele    text,
  donnees           jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (x_max_mm >= x_min_mm AND y_max_mm >= y_min_mm AND z_max_mm >= z_min_mm)
);
CREATE INDEX observation_recente ON observation_obstacle (observee_le DESC);

ALTER TABLE alerte ADD CONSTRAINT alerte_observation_fk
  FOREIGN KEY (observation_id) REFERENCES observation_obstacle(id);

-- Trajets d'une mission, versionnés (recalcul après interruption ou obstacle)
CREATE TABLE trajet (
  id                         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mission_id                 integer NOT NULL REFERENCES mission(id),
  version                    integer NOT NULL CHECK (version > 0),
  algorithme                 text NOT NULL,
  optimise                   boolean NOT NULL DEFAULT false,
  critere_optimisation       text,
  statut                     text NOT NULL DEFAULT 'PLANIFIE'
                             CHECK (statut IN ('PLANIFIE','EN_COURS','REMPLACE','TERMINE','ABANDONNE')),
  motif_calcul               text,
  observation_declenchante_id bigint REFERENCES observation_obstacle(id),
  remplace_trajet_id         integer REFERENCES trajet(id),
  longueur_mm                numeric(10,2),
  duree_estimee_s            numeric(10,2),
  calcule_le                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mission_id, version)
);
CREATE UNIQUE INDEX trajet_un_courant ON trajet (mission_id) WHERE statut IN ('PLANIFIE','EN_COURS');

CREATE TABLE point_trajet (
  trajet_id   integer NOT NULL REFERENCES trajet(id) ON DELETE CASCADE,
  ordre       integer NOT NULL CHECK (ordre >= 0),
  x_mm        numeric(8,2) NOT NULL,
  y_mm        numeric(8,2) NOT NULL,
  z_mm        numeric(8,2) NOT NULL,
  type        text NOT NULL CHECK (type IN ('DEPART','PASSAGE','PRISE','DEPOT','FIN')),
  PRIMARY KEY (trajet_id, ordre)
);
