variable "app_name" {
  type        = string
  description = "Fly.io app name. Must match fly.toml."
}

variable "primary_region" {
  type        = string
  description = "Fly.io primary region."
}

variable "gateway_image" {
  type        = string
  description = "Container image deployed to Fly.io."
}

locals {
  fly_app = {
    app            = var.app_name
    primary_region = var.primary_region
    dockerfile     = "Dockerfile"
    internal_port  = 3000
    vm_size        = "shared-cpu-2x"
    memory         = "2048mb"
    image          = var.gateway_image
    env = {
      NODE_ENV             = "production"
      OPENCLAW_PREFER_PNPM = "1"
      OPENCLAW_STATE_DIR   = "/data"
    }
  }
}

resource "terraform_data" "fly_app" {
  input = local.fly_app

  lifecycle {
    prevent_destroy = false
  }
}

output "app_name" {
  value = var.app_name
}

output "app_url" {
  value = "https://${var.app_name}.fly.dev"
}

output "fly_config" {
  value     = local.fly_app
  sensitive = false
}
