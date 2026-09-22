#!/bin/sh
# Opt-in host maintenance: default Docker builder cache is shared across projects.
# Never removes containers, volumes, tagged rollback images, or application files.
set -eu
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
exec 9>/run/lock/waterloo-mcp-disk.lock
flock -n 9 || exit 0

docker buildx prune --builder default --all --force --max-used-space 1GB --min-free-space 5GB
# Only untagged Waterloo images older than a week; Docker protects in-use images.
docker image prune --force --filter label=org.waterloo-mcp.component=gateway --filter until=168h

free_kb=$(df -Pk / | awk 'NR == 2 {print $4}')
case "$free_kb" in
  ''|*[!0-9]*) echo 'DISK_CHECK_FAILED: could not read free space' >&2; exit 1 ;;
esac
if [ "$free_kb" -lt 5242880 ]; then
  echo "DISK_SPACE_LOW: less than 5 GiB free; inspect disk usage before building. User data was not removed." >&2
  exit 1
fi
echo "DISK_MAINTENANCE_OK: ${free_kb} KiB free"
