terraform {
  required_version = ">= 1.5.0"

  # Encrypted remote state lives in S3 + KMS with a DynamoDB lock table.
  # Partial backend config: pass `-backend-config=backend.hcl` in production.
  # CI uses `terraform init -backend=false` so validate can run without credentials.
  backend "s3" {
    bucket         = "openclaw-terraform-state"
    key            = "gateway/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    kms_key_id     = "alias/terraform-state"
    dynamodb_table = "openclaw-terraform-locks"
  }

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kube_context
  }
}

module "gateway" {
  source = "./modules/gateway"

  namespace     = var.namespace
  replicas      = var.replicas
  gateway_image = var.gateway_image
  gateway_token = var.gateway_token
  storage_size  = var.storage_size
}

module "flyio" {
  source = "./modules/flyio"

  app_name       = var.fly_app_name
  primary_region = var.fly_primary_region
  gateway_image  = var.gateway_image
}
