#!/usr/bin/env bash
# Deploy the orders service to the staging Kubernetes cluster (Northwind Labs, fictional).
# The registry token comes from the vault: never paste it here.
set -euo pipefail

IMAGE="registry.example.com/northwind/orders:${1:?usage: deploy-staging.sh <tag>}"
REGISTRY_TOKEN="{{vault:platform/registry-token}}"

echo "$REGISTRY_TOKEN" | docker login registry.example.com -u deploy-bot --password-stdin
kubectl --context staging -n orders set image deploy/orders orders="$IMAGE"
kubectl --context staging -n orders rollout status deploy/orders --timeout=5m

# smoke tests against the staging API before announcing the deploy
curl -fsS https://staging-api.example.com/v1/health
echo "deployed $IMAGE to staging"
