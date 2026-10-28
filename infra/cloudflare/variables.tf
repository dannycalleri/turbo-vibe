variable "account_id" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "workers" {
  type = map(object({
    routes = list(string)
  }))
}

variable "hostnames" {
  type = list(string)
}

variable "cnames" {
  type    = map(string)
  default = {}
}

variable "always_use_https" {
  type    = bool
  default = false
}

variable "access" {
  type = object({
    name             = string
    domains          = list(string)
    emails           = list(string)
    public_paths     = list(string)
    on_account       = optional(bool, false)
    preflight_bypass = optional(bool, false)
  })
  default = null
}

variable "analytics_host" {
  type    = string
  default = null
}
