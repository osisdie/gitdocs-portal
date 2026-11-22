---
name: dev-environment
description: Laptop, VPN, Kubernetes access and local tests for engineers.
---
# Developer environment setup

## VPN

Import the profile from the IT portal. The shared key for the office VPN is {{vault:handbook/vpn-shared-key}}
(rotated every quarter; ask in #it if it stops working).

## Kubernetes access

```bash
nw login --sso
kubectl config use-context staging
kubectl get pods -n orders
```

Production access needs a reviewed request (see the access policy). Staging access is granted on day 1.

## Running tests

```bash
make test          # unit tests, ~2 minutes
make test-e2e      # end-to-end tests against the staging API
```

Coverage must stay above 80%; the CI pipeline fails below that.
