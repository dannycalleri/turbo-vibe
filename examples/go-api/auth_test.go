package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const callbackURL = "https://staging-example.turbovibe.ai/api/auth/callback"

func fakeWorkOS(t *testing.T, email string) (*httptest.Server, *map[string]string) {
	t.Helper()
	received := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/user_management/authenticate" {
			http.NotFound(w, r)
			return
		}
		json.NewDecoder(r.Body).Decode(&received)
		if received["code"] != "good-code" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"user": map[string]string{"email": email}})
	}))
	t.Cleanup(server.Close)
	return server, &received
}

func serve(a *auth, request *http.Request) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	a.routes(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

func cookie(recorder *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range recorder.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestLoginRedirectsToAuthKitWithTheStagingCallback(t *testing.T) {
	a := newAuth("client_123", "sk_test", callbackURL, "https://api.workos.com")
	recorder := serve(a, httptest.NewRequest(http.MethodGet, "/api/auth/login", nil))

	if recorder.Code != http.StatusFound {
		t.Fatalf("status = %d", recorder.Code)
	}
	location, _ := url.Parse(recorder.Header().Get("Location"))
	query := location.Query()
	if location.Host != "api.workos.com" || location.Path != "/user_management/authorize" ||
		query.Get("client_id") != "client_123" || query.Get("redirect_uri") != callbackURL ||
		query.Get("provider") != "authkit" || query.Get("response_type") != "code" {
		t.Fatalf("location = %s", location)
	}
	state := cookie(recorder, stateCookie)
	if state == nil || state.Value != query.Get("state") || !state.HttpOnly || !state.Secure {
		t.Fatalf("state cookie = %+v", state)
	}
	if strings.Contains(location.String(), "sk_test") {
		t.Fatal("the API key leaked into the redirect")
	}
}

func TestCallbackExchangesTheCodeAndSignsTheUserIn(t *testing.T) {
	workos, received := fakeWorkOS(t, "ada@example.com")
	a := newAuth("client_123", "sk_test", callbackURL, workos.URL)

	request := httptest.NewRequest(http.MethodGet, "/api/auth/callback?code=good-code&state=s1", nil)
	request.AddCookie(&http.Cookie{Name: stateCookie, Value: "s1"})
	recorder := serve(a, request)

	if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != "/" {
		t.Fatalf("status = %d, location = %q", recorder.Code, recorder.Header().Get("Location"))
	}
	if (*received)["client_secret"] != "sk_test" || (*received)["grant_type"] != "authorization_code" || (*received)["client_id"] != "client_123" {
		t.Fatalf("token request = %v", *received)
	}
	session := cookie(recorder, sessionCookie)
	if session == nil || !session.HttpOnly || !session.Secure {
		t.Fatalf("session cookie = %+v", session)
	}

	me := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	me.AddCookie(session)
	response := serve(a, me)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"email":"ada@example.com"`) {
		t.Fatalf("me = %d %s", response.Code, response.Body)
	}
}

func TestCallbackRejectsAMismatchedState(t *testing.T) {
	workos, received := fakeWorkOS(t, "ada@example.com")
	a := newAuth("client_123", "sk_test", callbackURL, workos.URL)

	request := httptest.NewRequest(http.MethodGet, "/api/auth/callback?code=good-code&state=forged", nil)
	request.AddCookie(&http.Cookie{Name: stateCookie, Value: "s1"})
	recorder := serve(a, request)

	if recorder.Code != http.StatusBadRequest || cookie(recorder, sessionCookie) != nil || len(*received) != 0 {
		t.Fatalf("status = %d, token request = %v", recorder.Code, *received)
	}
}

func TestCallbackFailsWhenWorkOSRejectsTheCode(t *testing.T) {
	workos, _ := fakeWorkOS(t, "ada@example.com")
	a := newAuth("client_123", "sk_test", callbackURL, workos.URL)

	request := httptest.NewRequest(http.MethodGet, "/api/auth/callback?code=bad-code&state=s1", nil)
	request.AddCookie(&http.Cookie{Name: stateCookie, Value: "s1"})
	recorder := serve(a, request)

	if recorder.Code != http.StatusBadGateway || cookie(recorder, sessionCookie) != nil {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestMeRejectsATamperedOrExpiredSession(t *testing.T) {
	a := newAuth("client_123", "sk_test", callbackURL, "https://api.workos.com")
	valid := a.sign("ada@example.com")
	tampered := strings.Replace(valid, valid[:4], "ZXZl", 1)

	later := newAuth("client_123", "sk_test", callbackURL, "https://api.workos.com")
	later.now = func() time.Time { return time.Now().Add(sessionLength + time.Hour) }

	for name, check := range map[string]struct {
		a     *auth
		value string
	}{
		"tampered": {a, tampered},
		"expired":  {later, valid},
		"foreign":  {newAuth("client_123", "sk_other", callbackURL, ""), valid},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/me", nil)
		request.AddCookie(&http.Cookie{Name: sessionCookie, Value: check.value})
		if response := serve(check.a, request); response.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d", name, response.Code)
		}
	}
}
