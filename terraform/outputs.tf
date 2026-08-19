output "namespace" {
  description = "Kubernetes namespace that hosts the gateway."
  value       = module.gateway.namespace
}

output "gateway_service" {
  description = "ClusterIP service name for the gateway."
  value       = module.gateway.service_name
}

output "fly_app_name" {
  description = "Fly.io application name."
  value       = module.flyio.app_name
}

output "fly_app_url" {
  description = "Public Fly.io URL for the gateway."
  value       = module.flyio.app_url
}
