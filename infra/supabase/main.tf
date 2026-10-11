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

# Each role's SCRAM salt is random but kept across migrates: Supabase's pooler caches the verifier, so a new
# salt on every run locks the role out. It must not derive from the password, since SCRAM hands it to any client.
resource "random_bytes" "salt" {
  for_each = toset(["migrator", "runtime"])

  length = 16

  lifecycle {
    replace_triggered_by = [random_password.role[each.key]]
  }
}

data "supabase_pooler" "this" {
  project_ref = local.project_ref
}
