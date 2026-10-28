variable "team_id" {
  type = string
}

variable "projects" {
  type = map(object({
    domain      = string
    environment = map(string)
    private     = optional(bool, false)
  }))
}

# The CLI chooses each secret: one Vercel generates would appear in the resource's ID, which OpenTofu prints.
variable "bypass_secrets" {
  type      = map(string)
  sensitive = true
  default   = {}
}
