resource "vercel_project" "this" {
  for_each = var.projects

  team_id = var.team_id
  name    = each.key
}

resource "vercel_project_domain" "this" {
  for_each = var.projects

  team_id    = var.team_id
  project_id = vercel_project.this[each.key].id
  domain     = each.value.domain
}

locals {
  variables = merge([
    for project, settings in var.projects : {
      for key, value in settings.environment : "${project}/${key}" => { project = project, key = key, value = value }
    }
  ]...)
}

resource "vercel_project_environment_variable" "this" {
  for_each = local.variables

  team_id    = var.team_id
  project_id = vercel_project.this[each.value.project].id
  key        = each.value.key
  value      = each.value.value
  target     = ["production"]
  sensitive  = false
}
