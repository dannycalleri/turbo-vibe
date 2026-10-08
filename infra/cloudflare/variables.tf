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
