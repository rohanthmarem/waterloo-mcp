# Keep disk use bounded

MCP and Racket containers rotate compressed logs at 10 MB per file, with three
files per container. Existing containers need to be recreated for this setting
to apply. `docker compose up -d --no-build` applies the change without rebuilding
the image or deleting saved school logins.

Browser dependencies make the running image several GB. Repeated builds can
also accumulate many GB of cache. Application state is separate from that cache.
Check both before removing anything:

```sh
df -h /
docker system df
sudo du -xhd1 /var/lib/waterloo-mcp
```

## Optional Linux host maintenance

This is intended for a dedicated MCP server. It prunes the **host-wide default
Docker builder cache**, so builds of other projects on the same Docker daemon
can become slower. It needs a recent Buildx supporting `--max-used-space` and
`--min-free-space`; unsupported flags cause a visible service failure.

It targets 1 GB of removable cache and 5 GB free space. Active or shared image
layers can prevent those targets from being reached: this is not a filesystem
quota. Every six hours it also removes untagged Waterloo gateway images older
than seven days. Docker protects images used by containers; tagged rollback
images remain available. It never prunes volumes or containers, or deletes
school logins, approvals, downloads, transcripts, models, or Racket workspaces.

The exe.dev deployment command refuses to start a new image build with less
than 8 GiB free, before uploading code or stopping the service. This reserves
working space for a replacement image; large builds can still need more.

From the repository root, on the host:

```sh
sudo install -m 755 scripts/disk-maintenance.sh /usr/local/sbin/waterloo-mcp-disk-maintenance
sudo install -m 644 deploy/waterloo-mcp-disk.service deploy/waterloo-mcp-disk.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now waterloo-mcp-disk.timer
sudo systemctl start waterloo-mcp-disk.service
sudo systemctl status waterloo-mcp-disk.service waterloo-mcp-disk.timer
```

If less than 5 GiB remains after cleanup, the service fails with `DISK_SPACE_LOW`.
Inspect `journalctl -u waterloo-mcp-disk.service`; this does not send external
notifications. Retained user data and tagged images still need operator review.
Do not use `docker system prune --volumes` to fix disk pressure.

Disable scheduled cleanup with `sudo systemctl disable --now waterloo-mcp-disk.timer`.
