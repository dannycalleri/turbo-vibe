package main

import (
	"net/http"
	"strings"
)

func withAllowedOrigins(allowed []string, next http.Handler) http.Handler {
	if len(allowed) == 0 {
		return next
	}
	permitted := map[string]bool{}
	for _, origin := range allowed {
		permitted[strings.TrimSpace(origin)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		if !permitted[origin] {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Add("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func splitOrigins(value string) []string {
	if value == "" {
		return nil
	}
	return strings.Split(value, ",")
}
