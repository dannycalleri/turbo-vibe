locals {
  own_project = var.parent_project_ref == null
  project_ref = local.own_project ? supabase_project.this[0].id : supabase_branch.this[0].database.id
}

resource "random_password" "database" {
  count = local.own_project ? 1 : 0

  length  = 40
  special = false
}

resource "supabase_project" "this" {
  count = local.own_project ? 1 : 0

  organization_id   = var.organization_id
  name              = var.name
  database_password = random_password.database[0].result
  region            = var.region
}

# An empty exposed-schema list is how Supabase represents a disabled Data API.
resource "supabase_settings" "this" {
  project_ref = local.project_ref
  api = jsonencode({
    db_schema = ""
  })
}

resource "supabase_branch" "this" {
  count = local.own_project ? 0 : 1

  parent_project_ref = var.parent_project_ref
  git_branch         = var.name
  persistent         = true
  region             = var.region
}

resource "random_password" "role" {
  for_each = toset(["migrator", "runtime"])

  length  = 40
  special = false
}

data "supabase_pooler" "this" {
  project_ref = local.project_ref
}
