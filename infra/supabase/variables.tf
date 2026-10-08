variable "organization_id" {
  type = string
}

variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "parent_project_ref" {
  description = "When set, the environment runs as a persistent branch of this project instead of its own project."
  type        = string
  default     = null
}
