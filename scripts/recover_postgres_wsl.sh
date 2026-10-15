#!/bin/bash
# Recover on an isolated copy, then migrate through a logical dump.
set -euo pipefail
src='/mnt/c/Users/ayoub/Emines/S7/Robotique/projet__portique_chatgpt/.local/postgres'
work='/var/lib/postgresql/portique-recovery'
bin='/usr/lib/postgresql/16/bin'
test ! -e "$src/postmaster.pid"
test ! -e "$work/migration-complete"
if [ ! -d "$work" ]; then
  install -d -o postgres -g postgres -m 700 "$work"
  cp -a "$src/." "$work/"
fi
sed -i "s/dynamic_shared_memory_type = windows/dynamic_shared_memory_type = posix/" "$work/postgresql.conf"
chown -R postgres:postgres "$work"
chmod 700 "$work"
install -d -o postgres -g postgres -m 700 /var/lib/postgresql/portique-socket
printf 'local all all trust\n' > "$work/recovery_hba.conf"
chown postgres:postgres "$work/recovery_hba.conf"
runuser -u postgres -- "$bin/pg_ctl" -D "$work" -l "$work/recovery.log" -o "-c listen_addresses='' -c port=55433 -c unix_socket_directories=/var/lib/postgresql/portique-socket -c hba_file=$work/recovery_hba.conf" -w start
trap 'runuser -u postgres -- "$bin/pg_ctl" -D "$work" -m fast -w stop' EXIT
runuser -u postgres -- "$bin/psql" -h /var/lib/postgresql/portique-socket -p 55433 -U portique_admin -d portique_claude -Atc 'select count(*) from conteneur'
runuser -u postgres -- bash -c 'umask 077; /usr/lib/postgresql/16/bin/pg_dumpall -h /var/lib/postgresql/portique-socket -p 55433 -U portique_admin > /var/lib/postgresql/portique-recovery/export.sql'
pg_ctlcluster 16 main start || pg_ctlcluster 16 main status
runuser -u postgres -- "$bin/psql" -v ON_ERROR_STOP=1 -f "$work/export.sql" > "$work/restore.log" 2>&1
runuser -u postgres -- "$bin/psql" -d portique_claude -Atc 'select count(*) from conteneur'
touch "$work/migration-complete"
echo 'Logical migration complete'
