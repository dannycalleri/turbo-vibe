terraform {
  required_version = ">= 1.10"

  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "1.11.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }
}
