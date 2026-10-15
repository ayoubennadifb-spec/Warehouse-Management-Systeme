-- =====================================================================
-- 001 — Schéma relationnel de base du portique (mémoire du système)
-- Unité : millimètre. Repère : origine au coin (X min, Y min) de l'espace,
-- X = longueur, Y = largeur, Z vertical vers le haut.
-- (x, y) = centre de l'empreinte ; z = base (face inférieure) d'un conteneur.
-- =====================================================================

-- ---------- Référentiels de dimensions (lignes immuables, réutilisées) ----------
CREATE TABLE type_conteneur (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  longueur_mm   numeric(8,2) NOT NULL CHECK (longueur_mm > 0),
  largeur_mm    numeric(8,2) NOT NULL CHECK (largeur_mm > 0),
  hauteur_mm    numeric(8,2) NOT NULL CHECK (hauteur_mm > 0),
  cree_le       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (longueur_mm, largeur_mm, hauteur_mm)
);

CREATE TABLE type_camion (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                 text NOT NULL UNIQUE,
  cabine_longueur_mm   numeric(8,2) NOT NULL CHECK (cabine_longueur_mm > 0),
  cabine_largeur_mm    numeric(8,2) NOT NULL CHECK (cabine_largeur_mm > 0),
  cabine_hauteur_mm    numeric(8,2) NOT NULL CHECK (cabine_hauteur_mm > 0),
  plateau_longueur_mm  numeric(8,2) NOT NULL CHECK (plateau_longueur_mm > 0),
  plateau_largeur_mm   numeric(8,2) NOT NULL CHECK (plateau_largeur_mm > 0),
  plateau_hauteur_mm   numeric(8,2) NOT NULL CHECK (plateau_hauteur_mm > 0),
  hauteurs_illustratives boolean NOT NULL DEFAULT true,
  cree_le              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cabine_longueur_mm, cabine_largeur_mm, cabine_hauteur_mm,
          plateau_longueur_mm, plateau_largeur_mm, plateau_hauteur_mm)
);

-- ---------- Versions du plan (configuration) ----------
CREATE TABLE version_plan (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero                   integer NOT NULL UNIQUE CHECK (numero > 0),
  libelle                  text NOT NULL,
  statut                   text NOT NULL DEFAULT 'BROUILLON'
                           CHECK (statut IN ('BROUILLON','ACTIVE','ARCHIVEE')),
  espace_longueur_x_mm     numeric(8,2) NOT NULL CHECK (espace_longueur_x_mm > 0),
  espace_largeur_y_mm      numeric(8,2) NOT NULL CHECK (espace_largeur_y_mm > 0),
  transport_longueur_x_mm  numeric(8,2) NOT NULL CHECK (transport_longueur_x_mm > 0),
  transport_cote           text NOT NULL CHECK (transport_cote IN ('X_MIN','X_MAX')),
  nb_positions_x           smallint NOT NULL CHECK (nb_positions_x > 0),
  nb_positions_y           smallint NOT NULL CHECK (nb_positions_y > 0),
  nb_niveaux_max           smallint NOT NULL CHECK (nb_niveaux_max > 0),
  -- valeurs EFFECTIVES (calculées si la saisie était « automatique »)
  marge_x_mm               numeric(9,3) NOT NULL CHECK (marge_x_mm >= 0),
  espacement_x_mm          numeric(9,3) NOT NULL CHECK (espacement_x_mm >= 0),
  marge_y_mm               numeric(9,3) NOT NULL CHECK (marge_y_mm >= 0),
  espacement_y_mm          numeric(9,3) NOT NULL CHECK (espacement_y_mm >= 0),
  nb_conteneurs_max        integer NOT NULL CHECK (nb_conteneurs_max >= 0),
  perimetre_capacite       text NOT NULL CHECK (perimetre_capacite IN ('ZONE','STOCKAGE')),
  type_conteneur_id        integer NOT NULL REFERENCES type_conteneur(id),
  type_camion_id           integer NOT NULL REFERENCES type_camion(id),
  parametres               jsonb NOT NULL,          -- saisie complète, pour traçabilité
  commentaire              text,
  cree_le                  timestamptz NOT NULL DEFAULT now(),
  active_le                timestamptz,
  archivee_le              timestamptz,
  CHECK (transport_longueur_x_mm < espace_longueur_x_mm),
  CHECK ((statut = 'BROUILLON') = (active_le IS NULL)),
  CHECK ((statut = 'ARCHIVEE') = (archivee_le IS NOT NULL))
);
-- Une seule version active à la fois
CREATE UNIQUE INDEX version_plan_une_active ON version_plan ((true)) WHERE statut = 'ACTIVE';

CREATE TABLE zone (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_plan_id  integer NOT NULL REFERENCES version_plan(id) ON DELETE CASCADE,
  code             text NOT NULL CHECK (code IN ('STOCKAGE','TRANSPORT')),
  x_min_mm         numeric(8,2) NOT NULL,
  x_max_mm         numeric(8,2) NOT NULL,
  y_min_mm         numeric(8,2) NOT NULL,
  y_max_mm         numeric(8,2) NOT NULL,
  CHECK (x_max_mm > x_min_mm AND y_max_mm > y_min_mm),
  UNIQUE (version_plan_id, code),
  UNIQUE (id, version_plan_id)
);

-- Positions au sol de la zone de stockage (une pile possible par position)
CREATE TABLE position_sol (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_plan_id  integer NOT NULL REFERENCES version_plan(id) ON DELETE CASCADE,
  zone_id          integer NOT NULL,
  ix               smallint NOT NULL CHECK (ix > 0),
  iy               smallint NOT NULL CHECK (iy > 0),
  code             text NOT NULL,
  centre_x_mm      numeric(8,2) NOT NULL,
  centre_y_mm      numeric(8,2) NOT NULL,
  -- état opérationnel (modifiable même sur une version active)
  statut           text NOT NULL DEFAULT 'DISPONIBLE' CHECK (statut IN ('DISPONIBLE','BLOQUEE')),
  motif_blocage    text,
  CHECK ((statut = 'BLOQUEE') = (motif_blocage IS NOT NULL)),
  FOREIGN KEY (zone_id, version_plan_id) REFERENCES zone(id, version_plan_id) ON DELETE CASCADE,
  UNIQUE (version_plan_id, ix, iy),
  UNIQUE (version_plan_id, code),
  UNIQUE (id, version_plan_id)
);

-- Postes de stationnement des camions (zone transport)
CREATE TABLE poste_transport (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_plan_id  integer NOT NULL REFERENCES version_plan(id) ON DELETE CASCADE,
  zone_id          integer NOT NULL,
  code             text NOT NULL,
  centre_x_mm      numeric(8,2) NOT NULL,
  centre_y_mm      numeric(8,2) NOT NULL,
  longueur_x_mm    numeric(8,2) NOT NULL CHECK (longueur_x_mm > 0),
  largeur_y_mm     numeric(8,2) NOT NULL CHECK (largeur_y_mm > 0),
  cote_cabine      text NOT NULL CHECK (cote_cabine IN ('X_MIN','X_MAX')),
  statut           text NOT NULL DEFAULT 'DISPONIBLE' CHECK (statut IN ('DISPONIBLE','HORS_SERVICE')),
  motif_indisponibilite text,
  CHECK ((statut = 'HORS_SERVICE') = (motif_indisponibilite IS NOT NULL)),
  FOREIGN KEY (zone_id, version_plan_id) REFERENCES zone(id, version_plan_id) ON DELETE CASCADE,
  UNIQUE (version_plan_id, code)
);

-- ---------- Camions (entité stable : un camion fait plusieurs visites) ----------
CREATE TABLE camion (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             text NOT NULL UNIQUE,
  type_camion_id   integer NOT NULL REFERENCES type_camion(id),
  demo             boolean NOT NULL DEFAULT false,
  cree_le          timestamptz NOT NULL DEFAULT now()
);

-- ---------- Emplacements : table commune des lieux pouvant porter UN conteneur ----------
-- CASE    : case de stockage = position au sol × niveau (appartient à une version de plan)
-- PLATEAU : plateau d'un camion (lié au camion, utilisable seulement pendant une visite)
CREATE TABLE emplacement (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type             text NOT NULL CHECK (type IN ('CASE','PLATEAU')),
  code             text NOT NULL,
  version_plan_id  integer REFERENCES version_plan(id) ON DELETE CASCADE,
  position_sol_id  integer,
  niveau           smallint CHECK (niveau > 0),
  z_base_mm        numeric(8,2),
  camion_id        integer REFERENCES camion(id),
  CONSTRAINT emplacement_forme CHECK (
       (type = 'CASE' AND version_plan_id IS NOT NULL AND position_sol_id IS NOT NULL
                      AND niveau IS NOT NULL AND z_base_mm IS NOT NULL AND camion_id IS NULL)
    OR (type = 'PLATEAU' AND camion_id IS NOT NULL AND version_plan_id IS NULL
                      AND position_sol_id IS NULL AND niveau IS NULL AND z_base_mm IS NULL)),
  FOREIGN KEY (position_sol_id, version_plan_id) REFERENCES position_sol(id, version_plan_id) ON DELETE CASCADE,
  UNIQUE (position_sol_id, niveau),
  UNIQUE (camion_id)
);
CREATE UNIQUE INDEX emplacement_code_case ON emplacement (version_plan_id, code) WHERE type = 'CASE';
CREATE UNIQUE INDEX emplacement_code_plateau ON emplacement (code) WHERE type = 'PLATEAU';

-- ---------- Unité de manutention ABSTRAITE (mécanisme non choisi) ----------
CREATE TABLE unite_manutention (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             text NOT NULL UNIQUE,
  description      text NOT NULL,
  x_mm             numeric(8,2),
  y_mm             numeric(8,2),
  z_mm             numeric(8,2),
  position_le      timestamptz,
  source_position  text CHECK (source_position IN ('SIMULATION','MATERIEL','INCONNUE'))
);

-- ---------- Conteneurs et localisation courante ----------
CREATE TABLE conteneur (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                  text NOT NULL UNIQUE,
  type_conteneur_id     integer NOT NULL REFERENCES type_conteneur(id),
  etat                  text NOT NULL CHECK (etat IN ('EN_PLACE','EN_TRANSFERT','INCERTAINE','SORTI')),
  emplacement_id        bigint UNIQUE REFERENCES emplacement(id),      -- un seul conteneur par emplacement
  mission_transfert_id  integer UNIQUE,                                -- mission qui le porte
  derniere_x_mm         numeric(8,2),
  derniere_y_mm         numeric(8,2),
  derniere_z_mm         numeric(8,2),
  motif_incertitude     text,
  demo                  boolean NOT NULL DEFAULT false,
  cree_le               timestamptz NOT NULL DEFAULT now(),
  modifie_le            timestamptz NOT NULL DEFAULT now(),
  version_ligne         integer NOT NULL DEFAULT 1,
  -- Une localisation et une seule, cohérente avec l'état
  CONSTRAINT conteneur_etat_coherent CHECK (
       (etat = 'EN_PLACE'     AND emplacement_id IS NOT NULL AND mission_transfert_id IS NULL AND motif_incertitude IS NULL)
    OR (etat = 'EN_TRANSFERT' AND emplacement_id IS NULL AND mission_transfert_id IS NOT NULL AND motif_incertitude IS NULL)
    OR (etat = 'INCERTAINE'   AND emplacement_id IS NULL AND mission_transfert_id IS NULL AND motif_incertitude IS NOT NULL)
    OR (etat = 'SORTI'        AND emplacement_id IS NULL AND mission_transfert_id IS NULL AND motif_incertitude IS NULL))
);

-- ---------- Missions de déplacement ----------
CREATE TABLE mission (
  id                          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conteneur_id                integer NOT NULL REFERENCES conteneur(id),
  type                        text NOT NULL CHECK (type IN ('STOCKAGE_VERS_STOCKAGE','CAMION_VERS_STOCKAGE',
                                                            'STOCKAGE_VERS_CAMION','CAMION_VERS_CAMION')),
  source_emplacement_id       bigint NOT NULL REFERENCES emplacement(id),
  destination_emplacement_id  bigint NOT NULL REFERENCES emplacement(id),
  statut                      text NOT NULL DEFAULT 'EN_ATTENTE'
                              CHECK (statut IN ('EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE','TERMINEE','ANNULEE')),
  origine                     text NOT NULL DEFAULT 'OPERATEUR' CHECK (origine IN ('OPERATEUR','SYSTEME')),
  version_plan_id             integer NOT NULL REFERENCES version_plan(id),
  unite_manutention_id        integer REFERENCES unite_manutention(id),
  executant                   text CHECK (executant IN ('SIMULATION','MATERIEL')),
  demandee_le                 timestamptz NOT NULL DEFAULT now(),
  demarree_le                 timestamptz,
  prise_confirmee_le          timestamptz,
  depot_confirme_le           timestamptz,
  interrompue_le              timestamptz,
  terminee_le                 timestamptz,
  motif_fin                   text,
  CHECK (source_emplacement_id <> destination_emplacement_id),
  CHECK (statut <> 'EN_ATTENTE' OR demarree_le IS NULL),
  CHECK (prise_confirmee_le IS NULL OR demarree_le IS NOT NULL),
  CHECK (depot_confirme_le IS NULL OR prise_confirmee_le IS NOT NULL),
  CHECK ((statut = 'TERMINEE') = (depot_confirme_le IS NOT NULL)),
  CHECK ((statut IN ('TERMINEE','ANNULEE')) = (terminee_le IS NOT NULL)),
  CHECK (statut NOT IN ('EN_COURS','SUSPENDUE') OR unite_manutention_id IS NOT NULL)
);
-- Un conteneur ne peut être engagé que dans une seule mission non terminée
CREATE UNIQUE INDEX mission_une_active_par_conteneur ON mission (conteneur_id)
  WHERE statut IN ('EN_ATTENTE','EN_COURS','SUSPENDUE','INTERROMPUE');
-- Une unité de manutention n'exécute qu'une mission à la fois
CREATE UNIQUE INDEX mission_une_par_unite ON mission (unite_manutention_id)
  WHERE statut IN ('EN_COURS','SUSPENDUE');
CREATE INDEX mission_statut ON mission (statut, demandee_le);

ALTER TABLE conteneur ADD CONSTRAINT conteneur_mission_transfert_fk
  FOREIGN KEY (mission_transfert_id) REFERENCES mission(id);

-- ---------- Réservations d'emplacements par les missions ----------
CREATE TABLE reservation (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mission_id        integer NOT NULL REFERENCES mission(id),
  emplacement_id    bigint NOT NULL REFERENCES emplacement(id),
  role              text NOT NULL CHECK (role IN ('SOURCE','DESTINATION')),
  statut            text NOT NULL DEFAULT 'ACTIVE' CHECK (statut IN ('ACTIVE','LIBEREE')),
  creee_le          timestamptz NOT NULL DEFAULT now(),
  liberee_le        timestamptz,
  motif_liberation  text,
  CHECK ((statut = 'LIBEREE') = (liberee_le IS NOT NULL)),
  UNIQUE (mission_id, role)
);
-- Un emplacement ne peut porter qu'une réservation active (toutes missions confondues)
CREATE UNIQUE INDEX reservation_une_active_par_emplacement ON reservation (emplacement_id) WHERE statut = 'ACTIVE';

-- ---------- Visites de camions ----------
CREATE TABLE visite_camion (
  id                      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  camion_id               integer NOT NULL REFERENCES camion(id),
  poste_id                integer REFERENCES poste_transport(id),
  version_plan_id         integer NOT NULL REFERENCES version_plan(id),
  statut                  text NOT NULL CHECK (statut IN ('PRESENTE','PARTIE','REFUSEE')),
  arrivee_le              timestamptz NOT NULL DEFAULT now(),
  depart_le               timestamptz,
  code_conteneur_annonce  text,
  conteneur_arrivee_id    integer REFERENCES conteneur(id),
  conteneur_depart_id     integer REFERENCES conteneur(id),
  plateau_x_mm            numeric(8,2),
  plateau_y_mm            numeric(8,2),
  plateau_z_mm            numeric(8,2),
  motif_refus             text,
  CHECK ((statut = 'REFUSEE') = (motif_refus IS NOT NULL)),
  CHECK ((statut = 'REFUSEE') = (poste_id IS NULL)),
  CHECK ((statut = 'PARTIE') = (depart_le IS NOT NULL)),
  CHECK (statut = 'REFUSEE' OR (plateau_x_mm IS NOT NULL AND plateau_y_mm IS NOT NULL AND plateau_z_mm IS NOT NULL)),
  CHECK (depart_le IS NULL OR depart_le >= arrivee_le)
);
-- Un seul camion par poste occupé ; un camion n'est présent qu'une fois
CREATE UNIQUE INDEX visite_un_camion_par_poste ON visite_camion (poste_id) WHERE statut = 'PRESENTE';
CREATE UNIQUE INDEX visite_une_presente_par_camion ON visite_camion (camion_id) WHERE statut = 'PRESENTE';

-- ---------- Confirmations (simulées, physiques ou opérateur) ----------
CREATE TABLE confirmation (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source             text NOT NULL CHECK (source IN ('SIMULATION','MATERIEL','OPERATEUR')),
  cle_idempotence    text NOT NULL,
  type               text NOT NULL CHECK (type IN ('PRISE','DEPOT','POSITION_DECLAREE')),
  mission_id         integer REFERENCES mission(id),
  conteneur_id       integer REFERENCES conteneur(id),
  horodatage_source  timestamptz,
  recue_le           timestamptz NOT NULL DEFAULT now(),
  resultat           text NOT NULL CHECK (resultat IN ('APPLIQUEE','REJETEE')),
  motif_rejet        text,
  donnees            jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((resultat = 'REJETEE') = (motif_rejet IS NOT NULL)),
  UNIQUE (source, cle_idempotence)          -- anti double traitement
);

-- ---------- Journal des événements (append-only) ----------
CREATE TABLE evenement (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid               uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  type               text NOT NULL,
  horodatage         timestamptz NOT NULL DEFAULT clock_timestamp(),
  horodatage_source  timestamptz,
  source             text NOT NULL CHECK (source IN ('SIMULATION','MATERIEL','OPERATEUR','SYSTEME')),
  gravite            text NOT NULL DEFAULT 'INFO' CHECK (gravite IN ('INFO','AVERTISSEMENT','ALERTE')),
  message            text NOT NULL,
  version_plan_id    integer REFERENCES version_plan(id),
  conteneur_id       integer REFERENCES conteneur(id),
  mission_id         integer REFERENCES mission(id),
  visite_id          integer REFERENCES visite_camion(id),
  camion_id          integer REFERENCES camion(id),
  emplacement_id     bigint REFERENCES emplacement(id),
  confirmation_id    bigint REFERENCES confirmation(id),
  donnees            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX evenement_conteneur ON evenement (conteneur_id, id);
CREATE INDEX evenement_mission ON evenement (mission_id, id);

-- ---------- Historique temporel des localisations ----------
CREATE TABLE historique_localisation (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conteneur_id    integer NOT NULL REFERENCES conteneur(id),
  etat            text NOT NULL,
  emplacement_id  bigint REFERENCES emplacement(id),
  mission_id      integer REFERENCES mission(id),
  x_mm            numeric(8,2),
  y_mm            numeric(8,2),
  z_mm            numeric(8,2),
  debut           timestamptz NOT NULL,
  fin             timestamptz,
  CHECK (fin IS NULL OR fin >= debut)
);
CREATE UNIQUE INDEX historique_une_periode_ouverte ON historique_localisation (conteneur_id) WHERE fin IS NULL;
CREATE INDEX historique_emplacement ON historique_localisation (emplacement_id, debut);

-- ---------- Alertes ----------
CREATE TABLE alerte (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type            text NOT NULL,
  gravite         text NOT NULL CHECK (gravite IN ('INFO','AVERTISSEMENT','CRITIQUE')),
  message         text NOT NULL,
  statut          text NOT NULL DEFAULT 'OUVERTE' CHECK (statut IN ('OUVERTE','ACQUITTEE','RESOLUE')),
  ouverte_le      timestamptz NOT NULL DEFAULT now(),
  acquittee_le    timestamptz,
  resolue_le      timestamptz,
  mission_id      integer REFERENCES mission(id),
  conteneur_id    integer REFERENCES conteneur(id),
  observation_id  bigint,                       -- FK ajoutée en 003
  donnees         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((statut = 'RESOLUE') = (resolue_le IS NOT NULL))
);
CREATE INDEX alerte_ouverte ON alerte (statut) WHERE statut <> 'RESOLUE';
