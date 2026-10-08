variable "team_id" {
  type = string
}

variable "projects" {
  type = map(object({
    domain = string
  }))
}
