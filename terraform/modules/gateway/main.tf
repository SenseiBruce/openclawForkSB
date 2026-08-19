variable "namespace" {
  type = string
}

variable "replicas" {
  type = number
}

variable "gateway_image" {
  type = string
}

variable "gateway_token" {
  type      = string
  sensitive = true
}

variable "storage_size" {
  type = string
}

resource "kubernetes_namespace" "openclaw" {
  metadata {
    name = var.namespace
    labels = {
      app = "openclaw"
    }
  }
}

resource "kubernetes_secret" "openclaw" {
  metadata {
    name      = "openclaw-secrets"
    namespace = kubernetes_namespace.openclaw.metadata[0].name
    labels = {
      app = "openclaw"
    }
  }

  type = "Opaque"
  data = {
    OPENCLAW_GATEWAY_TOKEN = var.gateway_token
  }
}

resource "kubernetes_config_map" "openclaw" {
  metadata {
    name      = "openclaw-config"
    namespace = kubernetes_namespace.openclaw.metadata[0].name
    labels = {
      app = "openclaw"
    }
  }

  data = {
    "openclaw.json" = jsonencode({
      gateway = {
        mode      = "local"
        bind      = "loopback"
        port      = 18789
        auth      = { mode = "token" }
        controlUi = { enabled = true }
      }
      agents = {
        defaults = { workspace = "~/.openclaw/workspace" }
      }
      cron = { enabled = false }
    })
  }
}

resource "kubernetes_persistent_volume_claim" "home" {
  metadata {
    name      = "openclaw-home-pvc"
    namespace = kubernetes_namespace.openclaw.metadata[0].name
    labels = {
      app = "openclaw"
    }
  }

  spec {
    access_modes = ["ReadWriteOnce"]
    resources {
      requests = {
        storage = var.storage_size
      }
    }
  }
}

resource "kubernetes_deployment" "gateway" {
  metadata {
    name      = "openclaw"
    namespace = kubernetes_namespace.openclaw.metadata[0].name
    labels = {
      app = "openclaw"
    }
  }

  spec {
    replicas = var.replicas

    selector {
      match_labels = {
        app = "openclaw"
      }
    }

    strategy {
      type = "Recreate"
    }

    template {
      metadata {
        labels = {
          app = "openclaw"
        }
      }

      spec {
        automount_service_account_token = false

        security_context {
          fs_group        = 1000
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 1000
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name              = "gateway"
          image             = var.gateway_image
          image_pull_policy = "IfNotPresent"

          command = ["node", "/app/dist/index.js", "gateway", "run"]

          port {
            name           = "gateway"
            container_port = 18789
            protocol       = "TCP"
          }

          env {
            name  = "HOME"
            value = "/home/node"
          }

          env {
            name  = "NODE_ENV"
            value = "production"
          }

          env {
            name = "OPENCLAW_GATEWAY_TOKEN"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.openclaw.metadata[0].name
                key  = "OPENCLAW_GATEWAY_TOKEN"
              }
            }
          }

          resources {
            requests = {
              cpu    = "250m"
              memory = "512Mi"
            }
            limits = {
              cpu    = "1"
              memory = "2Gi"
            }
          }

          security_context {
            run_as_non_root            = true
            run_as_user                = 1000
            run_as_group               = 1000
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            capabilities {
              drop = ["ALL"]
            }
          }

          liveness_probe {
            http_get {
              path = "/healthz"
              port = 18789
            }
            initial_delay_seconds = 60
            period_seconds        = 30
            timeout_seconds       = 10
          }

          readiness_probe {
            http_get {
              path = "/readyz"
              port = 18789
            }
            initial_delay_seconds = 15
            period_seconds        = 10
            timeout_seconds       = 5
          }

          volume_mount {
            name       = "openclaw-home"
            mount_path = "/home/node/.openclaw"
          }

          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }
        }

        volume {
          name = "openclaw-home"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim.home.metadata[0].name
          }
        }

        volume {
          name = "tmp"
          empty_dir {}
        }
      }
    }
  }
}

resource "kubernetes_service" "gateway" {
  metadata {
    name      = "openclaw"
    namespace = kubernetes_namespace.openclaw.metadata[0].name
    labels = {
      app = "openclaw"
    }
  }

  spec {
    type = "ClusterIP"
    selector = {
      app = "openclaw"
    }
    port {
      name        = "gateway"
      port        = 18789
      target_port = 18789
      protocol    = "TCP"
    }
  }
}

resource "kubernetes_network_policy" "gateway" {
  metadata {
    name      = "openclaw"
    namespace = kubernetes_namespace.openclaw.metadata[0].name
  }

  spec {
    pod_selector {
      match_labels = {
        app = "openclaw"
      }
    }

    policy_types = ["Ingress", "Egress"]

    ingress {
      ports {
        port     = "18789"
        protocol = "TCP"
      }
    }

    egress {
      to {
        ip_block {
          cidr = "0.0.0.0/0"
        }
      }
    }
  }
}

output "namespace" {
  value = kubernetes_namespace.openclaw.metadata[0].name
}

output "service_name" {
  value = kubernetes_service.gateway.metadata[0].name
}
