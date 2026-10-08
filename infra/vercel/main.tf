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
