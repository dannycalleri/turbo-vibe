package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func request(handler http.Handler, method, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/api/health", nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, r)
	return recorder
}

var ok = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

func TestTheListedFrontendIsAllowedWithCredentials(t *testing.T) {
	handler := withAllowedOrigins([]string{"https://staging-example.turbovibe.ai"}, ok)
	response := request(handler, http.MethodGet, "https://staging-example.turbovibe.ai")
	if response.Code != http.StatusOK ||
		response.Header().Get("Access-Control-Allow-Origin") != "https://staging-example.turbovibe.ai" ||
		response.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("status = %d, headers = %v", response.Code, response.Header())
	}
}

func TestAnUnlistedOriginIsRejected(t *testing.T) {
	handler := withAllowedOrigins([]string{"https://staging-example.turbovibe.ai"}, ok)
	for _, origin := range []string{"https://evil.example", "https://example.turbovibe.ai", "null"} {
		response := request(handler, http.MethodGet, origin)
		if response.Code != http.StatusForbidden || response.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("%s: status = %d, allow-origin = %q", origin, response.Code, response.Header().Get("Access-Control-Allow-Origin"))
		}
	}
}

func TestAPreflightFromTheFrontendIsAnswered(t *testing.T) {
	handler := withAllowedOrigins([]string{"https://staging-example.turbovibe.ai"}, ok)
	response := request(handler, http.MethodOptions, "https://staging-example.turbovibe.ai")
	if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestSameOriginServingSetsNoCrossOriginRules(t *testing.T) {
	response := request(withAllowedOrigins(nil, ok), http.MethodGet, "https://anything.example")
	if response.Code != http.StatusOK || response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("status = %d", response.Code)
	}
}
