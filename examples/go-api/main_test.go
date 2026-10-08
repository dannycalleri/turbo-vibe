package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthReportsBuildID(t *testing.T) {
	recorder := httptest.NewRecorder()
	healthHandler("abc123").ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["build_id"] != "abc123" {
		t.Fatalf("build_id = %q, want abc123", body["build_id"])
	}
}
