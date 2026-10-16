resource "cloudflare_worker" "this" {
  for_each = var.workers

  account_id = var.account_id
  name       = each.key

  observability = {
    enabled = true
  }
}

locals {
  routes = merge([
    for worker, settings in var.workers : { for pattern in settings.routes : pattern => worker }
  ]...)
}

# Cloudflare refuses a route to a Worker with no deployed code, and wrangler deploys only after apply.
# The placeholder answers 503 until then; ignore_changes keeps OpenTofu from ever replacing wrangler's code.
resource "cloudflare_worker_version" "placeholder" {
  for_each = var.workers

  account_id         = var.account_id
  worker_id          = cloudflare_worker.this[each.key].id
  compatibility_date = "2025-01-01"
  main_module        = "placeholder.mjs"
  deploy             = true
  modules = [{
    name           = "placeholder.mjs"
    content_type   = "application/javascript+module"
    content_base64 = base64encode("export default { fetch: () => new Response(\"not deployed yet\", { status: 503 }) };")
  }]

  lifecycle {
    ignore_changes = all
  }
}

resource "cloudflare_workers_route" "this" {
  for_each = local.routes

  zone_id = var.zone_id
  pattern = each.key
  script  = cloudflare_worker.this[each.value].name

  depends_on = [cloudflare_worker_version.placeholder]
}

# Routes only match proxied hostnames; 100:: is the documented placeholder origin for Worker-only hostnames.
resource "cloudflare_dns_record" "this" {
  for_each = toset(var.hostnames)

  zone_id = var.zone_id
  name    = each.key
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

# Not proxied: the platform behind the CNAME issues the certificate and must see its own traffic.
resource "cloudflare_dns_record" "cname" {
  for_each = var.cnames

  zone_id = var.zone_id
  name    = each.key
  type    = "CNAME"
  content = each.value
  proxied = false
  ttl     = 1
}

# Staging and production only: the preview CI token has no Zone Settings Write.
resource "cloudflare_zone_setting" "always_use_https" {
  count = var.always_use_https ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zero_trust_access_service_token" "smoke" {
  count = var.access == null ? 0 : 1

  account_id = var.account_id
  name       = "${var.access.name}-smoke"
  duration   = "forever"
}

resource "cloudflare_zero_trust_access_policy" "people" {
  count = var.access == null ? 0 : 1

  account_id = var.account_id
  name       = "${var.access.name} people"
  decision   = "allow"
  include    = [for email in var.access.emails : { email = { email = email } }]
}

resource "cloudflare_zero_trust_access_policy" "smoke" {
  count = var.access == null ? 0 : 1

  account_id = var.account_id
  name       = "${var.access.name} smoke test"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.smoke[0].id } }]
}

resource "cloudflare_zero_trust_access_application" "this" {
  count = var.access == null ? 0 : 1

  account_id       = var.account_id
  name             = var.access.name
  type             = "self_hosted"
  domain           = var.access.domains[0]
  destinations     = [for domain in var.access.domains : { type = "public", uri = domain }]
  session_duration = "24h"
  policies = [
    { id = cloudflare_zero_trust_access_policy.smoke[0].id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.people[0].id, precedence = 2 },
  ]
}
