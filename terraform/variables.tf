variable "kubeconfig_path" {
  type        = string
  description = "Path to kubeconfig used to manage the gateway namespace."
  default     = "~/.kube/config"
}

variable "kube_context" {
  type        = string
  description = "Optional kubeconfig context. Empty uses the current context."
  default     = null
}

variable "namespace" {
  type        = string
  description = "Kubernetes namespace for the OpenClaw gateway."
  default     = "openclaw"
}

variable "replicas" {
  type        = number
  description = "Gateway replica count. Keep 1 unless session storage is shared."
  default     = 1
}

variable "gateway_image" {
  type        = string
  description = "Container image for the OpenClaw gateway."
  default     = "ghcr.io/openclaw/openclaw:slim"
}

variable "gateway_token" {
  type        = string
  description = "Gateway bearer token stored in a Kubernetes secret."
  sensitive   = true
  default     = ""
}

variable "storage_size" {
  type        = string
  description = "Persistent volume size for gateway state."
  default     = "10Gi"
}

variable "fly_app_name" {
  type        = string
  description = "Fly.io app name matching fly.toml."
  default     = "openclaw"
}

variable "fly_primary_region" {
  type        = string
  description = "Fly.io primary region matching fly.toml."
  default     = "iad"
}
