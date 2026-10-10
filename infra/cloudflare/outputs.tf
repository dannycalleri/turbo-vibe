output "workers" {
  value = { for name, worker in cloudflare_worker.this : name => worker.id }
}
