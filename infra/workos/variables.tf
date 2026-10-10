variable "redirect_uris" {
  description = "Only URIs this module created or that do not exist yet; ones registered by hand are left out so they are never removed."
  type        = list(string)
}
