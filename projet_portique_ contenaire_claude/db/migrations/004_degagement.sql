CREATE TABLE operation_degagement (
 id bigserial PRIMARY KEY, cible_id integer NOT NULL REFERENCES conteneur(id), destination_id integer NOT NULL REFERENCES emplacement(id),
 statut text NOT NULL DEFAULT 'EN_COURS' CHECK(statut IN ('EN_COURS','TERMINEE','INTERROMPUE','ANNULEE')),
 plan jsonb NOT NULL, indice integer NOT NULL DEFAULT 0, mission_id integer REFERENCES mission(id), cree_le timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX une_operation_degagement_active ON operation_degagement ((true)) WHERE statut='EN_COURS';
