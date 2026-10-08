package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func get(t *testing.T, handler http.Handler) map[string]any {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestHealthReportsBuildIDAndGreeting(t *testing.T) {
	body := get(t, healthHandler("abc123", func(context.Context) (string, error) {
		return "hello from postgres", nil
	}))
	if body["build_id"] != "abc123" || body["database"] != "hello from postgres" {
		t.Fatalf("body = %v", body)
	}
}

func TestHealthStillReportsBuildIDWithoutDatabase(t *testing.T) {
	body := get(t, healthHandler("abc123", nil))
	if body["build_id"] != "abc123" || body["database"] != nil {
		t.Fatalf("body = %v", body)
	}
}

func TestHealthStillReportsBuildIDWhenDatabaseFails(t *testing.T) {
	body := get(t, healthHandler("abc123", func(context.Context) (string, error) {
		return "", errors.New("connection refused")
	}))
	if body["build_id"] != "abc123" || body["database"] != nil {
		t.Fatalf("body = %v", body)
	}
}
