output "workers" {
  value = { for name, worker in cloudflare_worker.this : name => worker.id }
}

output "access_on_account" {
  value = local.access_on_account
}

output "access_client_id" {
  value = local.access_on_account ? cloudflare_zero_trust_access_service_token.smoke[0].client_id : null
}

output "access_client_secret" {
  value     = local.access_on_account ? cloudflare_zero_trust_access_service_token.smoke[0].client_secret : null
  sensitive = true
}

output "analytics_token" {
  value = var.analytics_host == null ? null : cloudflare_web_analytics_site.this[0].site_token
}
