resource "workos_redirect_uri" "this" {
  for_each = toset(var.redirect_uris)

  uri = each.key
}
