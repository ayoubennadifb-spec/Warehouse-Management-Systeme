#!/bin/sh
set -e
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo 'Installez et démarrez Docker avant de continuer.'; exit 1; }
echo 'Interface : http://localhost:8080. Arrêt : Ctrl+C. Les données sont conservées.'
docker compose up --build
