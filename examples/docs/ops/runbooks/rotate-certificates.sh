#!/usr/bin/env bash
# Rotate the TLS certificates of the public endpoints (Northwind Labs, fictional).
# Runs monthly from the ops pipeline; safe to run by hand during an incident.
set -euo pipefail

for host in api.example.com status.example.com admin.example.com; do
  echo "renewing TLS certificate for $host"
  nw certs renew "$host" --min-days 30
done

kubectl -n ingress rollout restart deploy/edge
# verify the new certificate chain before closing the ticket
for host in api.example.com status.example.com; do
  echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null | openssl x509 -noout -enddate
done
