output "project_ids" {
  value = { for name, project in vercel_project.this : name => project.id }
}

output "protection_bypass" {
  value     = { for name, bypass in vercel_project_protection_bypass.this : name => bypass.secret }
  sensitive = true
}
