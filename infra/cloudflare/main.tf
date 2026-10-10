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

resource "cloudflare_workers_route" "this" {
  for_each = local.routes

  zone_id = var.zone_id
  pattern = each.key
  script  = cloudflare_worker.this[each.value].name
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
