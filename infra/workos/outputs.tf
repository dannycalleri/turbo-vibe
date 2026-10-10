output "redirect_uris" {
  value = [for redirect in workos_redirect_uri.this : redirect.uri]
}
