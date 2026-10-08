package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

func healthHandler(buildID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]string{"build_id": buildID})
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/health", healthHandler(os.Getenv("BUILD_ID")))
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
