# OpenClaw Terraform

Infrastructure as code for the OpenClaw gateway. This mirrors the existing
Docker, Docker Compose, Fly.io (`fly.toml`), and Kubernetes manifests under
`scripts/k8s/manifests/`.

## Layout

- `modules/gateway` — Kubernetes namespace, secret, config, PVC, deployment, service, and network policy
- `modules/flyio` — Fly.io app contract matching `fly.toml`
- Helm chart alternative: `charts/openclaw`

## Usage

```bash
cd terraform
terraform fmt
terraform init -backend=false
terraform validate
terraform plan -input=false
```

Production remote state is encrypted in S3 + KMS. Copy `backend.hcl.example`
to `backend.hcl` and run:

```bash
terraform init -backend-config=backend.hcl
```

Never commit `*.tfstate`. CI runs `terraform fmt -check`, `terraform validate`,
tfsec, and checkov on every PR.
