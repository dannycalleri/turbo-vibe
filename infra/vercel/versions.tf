terraform {
  required_version = ">= 1.10"

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "5.21.0"
    }
  }
}
