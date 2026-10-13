package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type greetingReader func(ctx context.Context) (string, error)

type health struct {
	BuildID  string  `json:"build_id"`
	Database *string `json:"database"`
}

func healthHandler(buildID string, readGreeting greetingReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body := health{BuildID: buildID}
		if readGreeting != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			defer cancel()
			if message, err := readGreeting(ctx); err == nil {
				body.Database = &message
			} else {
				log.Printf("read greeting: %v", err)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(body)
	}
}

func poolReader(pool *pgxpool.Pool) greetingReader {
	return func(ctx context.Context) (string, error) {
		var message string
		err := pool.QueryRow(ctx, "select message from greeting where id = 1").Scan(&message)
		return message, err
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	var readGreeting greetingReader
	if url := os.Getenv("DATABASE_URL"); url != "" {
		pool, err := pgxpool.New(context.Background(), url)
		if err != nil {
			log.Fatalf("database: %v", err)
		}
		defer pool.Close()
		readGreeting = poolReader(pool)
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/health", healthHandler(os.Getenv("BUILD_ID"), readGreeting))
	if clientID := os.Getenv("WORKOS_CLIENT_ID"); clientID != "" {
		apiBase := os.Getenv("WORKOS_API_BASE")
		if apiBase == "" {
			apiBase = "https://api.workos.com"
		}
		a := newAuth(clientID, os.Getenv("WORKOS_API_KEY"), os.Getenv("WORKOS_REDIRECT_URI"), apiBase)
		if frontend := os.Getenv("FRONTEND_URL"); frontend != "" {
			a.afterSignIn = frontend
		}
		a.routes(mux)
	}
	log.Fatal(http.ListenAndServe(":"+port, withAllowedOrigins(splitOrigins(os.Getenv("ALLOWED_ORIGINS")), mux)))
}
