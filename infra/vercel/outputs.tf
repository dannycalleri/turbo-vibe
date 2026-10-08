output "project_ids" {
  value = { for name, project in vercel_project.this : name => project.id }
}
