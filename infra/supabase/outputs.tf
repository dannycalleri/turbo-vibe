output "project_ref" {
  value = local.project_ref
}

output "connection" {
  value = {
    project_ref       = local.project_ref
    pooler_urls       = data.supabase_pooler.this.url
    postgres_password = local.own_project ? random_password.database[0].result : supabase_branch.this[0].database.password
    migrator_password = random_password.role["migrator"].result
    runtime_password  = random_password.role["runtime"].result
    migrator_salt     = random_bytes.salt["migrator"].base64
    runtime_salt      = random_bytes.salt["runtime"].base64
  }
  sensitive = true
}
